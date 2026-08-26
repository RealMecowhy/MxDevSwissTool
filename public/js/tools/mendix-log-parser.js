// Shared Mendix log parser (wave 2).
//
// Normalizes the two on-disk log formats to ONE record model:
//   { level, timestamp, logNode, message }
//   - Studio Pro CSV export:  Type,TimeStamp,LogNode,Message  (RFC4180, multiline quoted fields)
//   - Mendix Cloud live log:  TIMESTAMP [runtime-container/pod] LEVEL - Node: message
//                             (+ continuation lines: stack traces, multiline JSON query plans)
//
// Design constraints — this stays a self-contained factory with ZERO external references,
// because the same source runs in three places:
//   1. the main thread  (side-effect ESM import in core.js → attaches to window)
//   2. a Web Worker     (log-query-extractor serializes createMendixLogParser.toString())
//   3. Node             (scripts/parser-test.js sets global.self = global, then require()s this)
//
// The CSV parser is a single, stateful, character-by-character pass (no per-line quote
// counting + re-split), which also closes the old "multiple passes over the data" concern.
(function () {
  function createMendixLogParser() {
    // Live-log line (single line; continuations are handled separately):
    //   2026-07-01T14:51:09.591808 [runtime-container/v7f5t]  ERROR - Connector: message
    var LOG_PAT_CLOUD = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+\[[^\]]+\]\s+(TRACE|DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL)\s+-\s+([^:\n]+?):\s*(.*)$/i;
    // Foreign log lines: a library bundled with the app (opensaml, the AWS SDK, Xerces) logs
    // through its own framework straight to stdout, so the line lands in the middle of the
    // Mendix log WITHOUT the Mendix prefix. Two shapes occur in real cloud logs:
    //   [JettyServer-13962] INFO org.opensaml.xmlsec.algorithm.AlgorithmSupport - Mapping from …
    //   WARNING: Supplied DOM uses namespaces, but is not created as namespace-aware
    // These are NOT continuations. Appending them to the open record corrupted its message —
    // and when that record was a ConnectionBus_Queries slow-query warning, the foreign text
    // ended up inside the SQL the Log Query Extractor reads back out of it.
    var LOG_PAT_FOREIGN = /^\[([^\]\n]+)\]\s+(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\s+([\w$]+(?:\.[\w$]+)+)\s+-\s+(.*)$/;
    // The java.util.logging ladder only. ERROR/WARN/FATAL are deliberately absent: a PostgreSQL
    // detail line inside a Java stack trace legitimately starts with "ERROR:", and that one IS
    // a continuation of the record above it.
    var LOG_PAT_FOREIGN_JUL = /^(SEVERE|WARNING|INFO|CONFIG|FINE|FINER|FINEST):(.*)$/;
    // Grafana exports are an ENVELOPE, not a log format: the Mendix line sits in one
    // column and Grafana's own timestamp columns sit in front of it. One shape per
    // download button (grafana/grafana, inspector/utils/download.ts + logs/utils.ts):
    //   TXT  → <epoch ms> \t <ISO> \t <line>   — hard-coded in downloadLogsModelAsTxt,
    //                                            optionally preceded by meta lines
    //   JSON → [{ line, timestamp: <epoch ns>, date: <ISO>, fields: {…} }]
    //   CSV  → a data frame; an ISO "Date" column is prepended, labels are dropped
    // None of the three can be talked into emitting the native Mendix shape, so the
    // envelope is stripped here and the body is parsed on its own.
    var GRAFANA_TXT = /^(\d{13,})\t(\d{4}-\d{2}-\d{2}T[^\t]*)\t([\s\S]*)$/;
    // The collector strips the Mendix timestamp prefix before shipping to Loki, so the
    // body starts at the level and the time comes from the column: "WARNING - TaskQueue: …"
    // or java.util.logging's "INFO: MENDIX-LOGGING-HEARTBEAT: …".
    var GRAFANA_BODY_LEVEL = /^(TRACE|DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL|SEVERE)\s*[-:]\s*(.*)$/i;
    // A Mendix log node never contains whitespace. Without that guard an ordinary
    // message like "Error: could not connect" would be read as a node named "Error".
    var GRAFANA_BODY_NODE = /^([\w.$-]{1,60}):\s*(.*)$/;
    var CSV_HEADER = ['Type', 'TimeStamp', 'LogNode', 'Message'];
    var PROGRESS_EVERY = 512 * 1024; // report progress roughly every 512 KB of input

    function normLevel(l) {
      l = (l || '').toUpperCase();
      if (l === 'WARNING') return 'WARN';
      if (l === 'ERR' || l === 'FATAL' || l === 'SEVERE') return 'ERROR';
      if (l === 'CONFIG' || l === 'FINE' || l === 'FINER' || l === 'FINEST') return 'DEBUG';
      return l;
    }

    // A foreign log line -> its own record; anything else -> null (a genuine continuation).
    // The timestamp is inherited from the record the line interrupted: a foreign line carries
    // none of its own, and an empty one would drop it out of every time-window filter.
    function foreignRecord(line, inheritedTs) {
      var m = line.match(LOG_PAT_FOREIGN);
      if (m) {
        return {
          level: normLevel(m[2]),
          timestamp: inheritedTs,
          logNode: m[3],
          message: '[' + m[1] + '] ' + m[4],
          cause: ''
        };
      }
      m = line.match(LOG_PAT_FOREIGN_JUL);
      if (m) {
        return {
          level: normLevel(m[1]),
          timestamp: inheritedTs,
          logNode: 'External',
          message: m[2].trim(),
          cause: ''
        };
      }
      return null;
    }

    // Loki stores a stack trace as one log line per frame, so each frame arrives as its
    // own export row. They belong to the record above, exactly like a continuation line
    // in a raw live log.
    function isStackLine(s) {
      if (/^\s/.test(s)) return true;
      s = s.trim();
      return /^(at |Caused by:)/.test(s) || /^\.\.\. \d+ more/.test(s) ||
             /^(java|javax|scala|com|org|sun|net)\./.test(s);
    }

    // One export row (envelope already stripped) → one record. `fallbackLevel` is the
    // export's own severity column, used only when the body carries no level of its own.
    function grafanaRecord(body, ts, fallbackLevel) {
      // Some collectors ship the raw line untouched, prefix and all.
      var m = body.match(LOG_PAT_CLOUD);
      if (m) {
        return { level: normLevel(m[2]), timestamp: m[1], logNode: m[3].trim(), message: m[4], cause: '' };
      }
      var level = normLevel(fallbackLevel || 'INFO') || 'INFO';
      var node = 'Runtime';
      var rest = body;
      m = body.match(GRAFANA_BODY_LEVEL);
      if (m) {
        level = normLevel(m[1]);
        rest = m[2];
        // Only once a level is confirmed is the next token safe to read as a log node.
        var n = rest.match(GRAFANA_BODY_NODE);
        if (n) { node = n[1]; rest = n[2]; }
      }
      return { level: level, timestamp: ts, logNode: node, message: rest, cause: '' };
    }

    // Grafana's JSON rows carry epoch nanoseconds; `date` is preferred when present.
    function nsToIso(ns) {
      if (!ns) return '';
      var ms = Number(String(ns).slice(0, -6));
      return isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '';
    }

    // A row is the CSV header if its first four fields are exactly the column names.
    function isHeaderRow(fields) {
      for (var i = 0; i < 4; i++) {
        if ((fields[i] || '') !== CSV_HEADER[i]) return false;
      }
      return true;
    }

    // A Grafana CSV header names a body column and a time column; the order and the
    // exact names depend on the datasource (Loki: Date,Time,Line,tsNs,id).
    function isGrafanaCsvHeader(line) {
      return /(^|,)"?(Line|body)"?(,|$)/.test(line) &&
             /(^|,)"?(Date|Time|timestamp)"?(,|$)/i.test(line);
    }

    // Peek at the first non-empty lines to tell the formats apart.
    function detectFormat(text) {
      var head = text.substring(0, 4096).replace(/^\uFEFF/, '').replace(/^\s+/, '');
      if (head.charAt(0) === '[' && /"line"\s*:/.test(head) && /"(date|timestamp)"\s*:/.test(head)) {
        return 'grafana-json';
      }
      var start = 0;
      var seen = 0;
      while (start < text.length && seen < 50) {
        var nl = text.indexOf('\n', start);
        var end = nl === -1 ? text.length : nl;
        var line = text.substring(start, end).replace(/\r$/, '');
        start = nl === -1 ? text.length : nl + 1;
        if (!line.trim()) continue;
        seen++;
        if (line.indexOf('Type,TimeStamp,LogNode,Message') === 0 ||
            line.indexOf('"Type","TimeStamp","LogNode","Message"') === 0) return 'csv';
        if (seen === 1 && isGrafanaCsvHeader(line)) return 'grafana-csv';
        if (GRAFANA_TXT.test(line)) return 'grafana-txt';
        if (LOG_PAT_CLOUD.test(line)) return 'live';
      }
      return 'csv';
    }

    // Single-pass RFC4180 state machine. Calls onRow(fields, hasContent) for every row;
    // what a row MEANS is the caller's business, because two exports share this scanner
    // with different columns (Studio Pro's four, Grafana's named data-frame ones).
    // Line endings are normalized to \n so a quoted field spanning CRLF lines matches
    // the historical two-pass behaviour exactly.
    function forEachCsvRow(text, onProgress, onRow) {
      if (text.indexOf('\r') !== -1) text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      var fields = [];
      var field = '';
      var inQuotes = false;
      var rowStarted = false;      // any character consumed since the last row break
      var rowHasContent = false;   // any non-whitespace character in the row (≈ row.trim() truthy)
      var nextProgress = PROGRESS_EVERY;
      var len = text.length;

      function endRow() {
        fields.push(field);
        field = '';
        if (rowStarted) onRow(fields, rowHasContent);
        fields = [];
        rowStarted = false;
        rowHasContent = false;
      }

      for (var i = 0; i < len; i++) {
        var c = text[i];
        // Track row "startedness" and non-whitespace content (≈ old row.trim() truthiness).
        // A newline is a row break, never content; space/tab start a row but aren't content.
        if (c === '\n') { /* row break, handled in the state machine below */ }
        else if (c === ' ' || c === '\t') { rowStarted = true; }
        else { rowStarted = true; rowHasContent = true; }

        if (inQuotes) {
          if (c === '"') {
            if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
            else inQuotes = false;                          // closing quote
          } else {
            field += c;
          }
        } else if (c === '"') {
          inQuotes = true;
        } else if (c === ',') {
          fields.push(field);
          field = '';
        } else if (c === '\n') {
          endRow();
        } else {
          field += c;
        }

        if (onProgress && i >= nextProgress) {
          nextProgress += PROGRESS_EVERY;
          onProgress(Math.round((i / len) * 100), 'Parsing CSV… ' + Math.round((i / len) * 100) + '%');
        }
      }
      // Trailing row without a final newline
      if (rowStarted || field !== '' || fields.length) endRow();
    }

    // Studio Pro export: fixed column order, header row skipped.
    function parseCsv(text, onProgress) {
      var records = [];
      var skipped = 0;
      forEachCsvRow(text, onProgress, function (fields, hasContent) {
        if (isHeaderRow(fields)) return;
        if (fields.length < 4) {
          if (hasContent) skipped++;
          return;
        }
        records.push({
          level: normLevel(fields[0]),
          timestamp: (fields[1] || '').trim(),
          logNode: (fields[2] || '').trim(),
          message: fields[3] || '',
          cause: fields[4] || ''
        });
      });
      return { records: records, skipped: skipped };
    }

    // Grafana CSV: a data-frame dump whose column ORDER depends on the datasource, so the
    // header names the columns and everything is read by name. Reading it positionally as
    // a Studio Pro export put the whole log line in the LogNode column and a nanosecond
    // count in the message — and reported success while doing it.
    function parseGrafanaCsv(text, onProgress) {
      var records = [];
      var skipped = 0;
      var current = null;
      var iTime = -1, iBody = -1, iLevel = -1;
      var haveHeader = false;

      function pick(idx, names) {
        for (var i = 0; i < names.length; i++) {
          if (idx[names[i]] !== undefined) return idx[names[i]];
        }
        return -1;
      }

      forEachCsvRow(text, onProgress, function (fields, hasContent) {
        if (!haveHeader) {
          haveHeader = true;
          var idx = {};
          for (var i = 0; i < fields.length; i++) idx[fields[i].trim().toLowerCase()] = i;
          iBody = pick(idx, ['line', 'body']);
          iTime = pick(idx, ['date', 'time', 'timestamp']);
          iLevel = pick(idx, ['severity', 'level', 'detected_level']);
          return;
        }
        if (iBody < 0 || fields.length <= iBody) {
          if (hasContent) skipped++;
          return;
        }
        var body = fields[iBody] || '';
        if (current && isStackLine(body)) {
          current.message += '\n' + body.trim();
          return;
        }
        var ts = iTime >= 0 ? (fields[iTime] || '').trim() : '';
        current = grafanaRecord(body, ts, iLevel >= 0 ? (fields[iLevel] || '').trim() : '');
        records.push(current);
      });
      return { records: records, skipped: skipped };
    }

    // Live logs: one record per LOG_PAT_CLOUD line; any other non-blank line is a
    // continuation (stack trace, multiline plan JSON, wrapped slow-query SQL) appended
    // to the current record's message.
    function parseLive(text, onProgress) {
      if (text.indexOf('\r') !== -1) text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      var records = [];
      var skipped = 0;
      var current = null;
      var start = 0;
      var len = text.length;
      var nextProgress = PROGRESS_EVERY;

      while (start <= len) {
        var nl = text.indexOf('\n', start);
        var end = nl === -1 ? len : nl;
        var line = text.substring(start, end);
        var isLast = nl === -1;
        start = end + 1;

        var m = line.match(LOG_PAT_CLOUD);
        if (m) {
          current = {
            level: normLevel(m[2]),
            timestamp: m[1],
            logNode: m[3].trim(),
            message: m[4],
            cause: ''
          };
          records.push(current);
        } else if (line.trim()) {
          var foreign = foreignRecord(line, current ? current.timestamp : '');
          if (foreign) {
            // Own record, and it becomes the open one: a stack trace printed after a
            // foreign line belongs to that line, not to the Mendix record before it.
            records.push(foreign);
            current = foreign;
          } else if (current) {
            current.message += '\n' + line;
          } else {
            skipped++; // preamble/garbage before the first recognized log line
          }
        }

        if (onProgress && end >= nextProgress) {
          nextProgress += PROGRESS_EVERY;
          onProgress(Math.round((end / len) * 100), 'Parsing log… ' + Math.round((end / len) * 100) + '%');
        }
        if (isLast) break;
      }

      return { records: records, skipped: skipped };
    }

    // Grafana "Download → TXT": every row is `<epoch ms> \t <ISO> \t <line>`. A line that
    // does NOT match is either the meta preamble Grafana writes above the first row, or a
    // newline embedded in a single Loki entry — the first is dropped, the second belongs
    // to the record above it.
    function parseGrafanaTxt(text, onProgress) {
      if (text.indexOf('\r') !== -1) text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      var records = [];
      var skipped = 0;
      var current = null;
      var start = 0;
      var len = text.length;
      var nextProgress = PROGRESS_EVERY;

      while (start <= len) {
        var nl = text.indexOf('\n', start);
        var end = nl === -1 ? len : nl;
        var line = text.substring(start, end);
        var isLast = nl === -1;
        start = end + 1;

        var m = line.match(GRAFANA_TXT);
        if (m) {
          var body = m[3];
          if (current && isStackLine(body)) {
            current.message += '\n' + body.trim();
          } else {
            current = grafanaRecord(body, m[2], '');
            records.push(current);
          }
        } else if (line.trim()) {
          if (current) current.message += '\n' + line;
          else skipped++;
        }

        if (onProgress && end >= nextProgress) {
          nextProgress += PROGRESS_EVERY;
          onProgress(Math.round((end / len) * 100), 'Parsing log… ' + Math.round((end / len) * 100) + '%');
        }
        if (isLast) break;
      }

      return { records: records, skipped: skipped };
    }

    // Grafana "Download → JSON": one array of { line, timestamp (epoch ns), date, fields }.
    function parseGrafanaJson(text) {
      var rows;
      try { rows = JSON.parse(text); } catch (e) { return { records: [], skipped: 1 }; }
      if (!rows || typeof rows.length !== 'number') return { records: [], skipped: 1 };
      var records = [];
      var skipped = 0;
      var current = null;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (!r || typeof r.line !== 'string') { skipped++; continue; }
        if (current && isStackLine(r.line)) {
          current.message += '\n' + r.line.trim();
          continue;
        }
        var f = r.fields || {};
        current = grafanaRecord(r.line, r.date || nsToIso(r.timestamp),
                                f.level || f.severity || f.detected_level || '');
        records.push(current);
      }
      return { records: records, skipped: skipped };
    }

    // text → { format, records, skipped }. onProgress(percent, phase) is optional.
    function parse(text, onProgress) {
      var format = detectFormat(text);
      var res;
      if (format === 'grafana-txt') res = parseGrafanaTxt(text, onProgress);
      else if (format === 'grafana-json') res = parseGrafanaJson(text);
      else if (format === 'grafana-csv') res = parseGrafanaCsv(text, onProgress);
      else if (format === 'csv') res = parseCsv(text, onProgress);
      else res = parseLive(text, onProgress);
      return { format: format, records: res.records, skipped: res.skipped };
    }

    return {
      detectFormat: detectFormat, parse: parse, parseCsv: parseCsv, parseLive: parseLive,
      parseGrafanaTxt: parseGrafanaTxt, parseGrafanaJson: parseGrafanaJson,
      parseGrafanaCsv: parseGrafanaCsv, foreignRecord: foreignRecord
    };
  }

  // Attach to the ambient global — window on the main thread, the worker global inside
  // a Worker, and (via global.self = global) the Node process during tests.
  self.createMendixLogParser = createMendixLogParser;
})();
