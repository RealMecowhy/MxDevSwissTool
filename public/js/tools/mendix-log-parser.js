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
    var CSV_HEADER = ['Type', 'TimeStamp', 'LogNode', 'Message'];
    var PROGRESS_EVERY = 512 * 1024; // report progress roughly every 512 KB of input

    function normLevel(l) {
      l = (l || '').toUpperCase();
      if (l === 'WARNING') return 'WARN';
      if (l === 'ERR' || l === 'FATAL') return 'ERROR';
      return l;
    }

    // A row is the CSV header if its first four fields are exactly the column names.
    function isHeaderRow(fields) {
      for (var i = 0; i < 4; i++) {
        if ((fields[i] || '') !== CSV_HEADER[i]) return false;
      }
      return true;
    }

    // Peek at the first non-empty lines to tell the two formats apart.
    function detectFormat(text) {
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
        if (LOG_PAT_CLOUD.test(line)) return 'live';
      }
      return 'csv';
    }

    // Single-pass RFC4180 state machine. Emits { records, skipped }.
    // Line endings are normalized to \n so a quoted field spanning CRLF lines matches
    // the historical two-pass behaviour exactly.
    function parseCsv(text, onProgress) {
      if (text.indexOf('\r') !== -1) text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      var records = [];
      var skipped = 0;
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
        if (rowStarted) {
          if (!isHeaderRow(fields)) {
            if (fields.length < 4) {
              if (rowHasContent) skipped++;
            } else {
              records.push({
                level: normLevel(fields[0]),
                timestamp: (fields[1] || '').trim(),
                logNode: (fields[2] || '').trim(),
                message: fields[3] || '',
                cause: fields[4] || ''
              });
            }
          }
        }
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
          if (current) current.message += '\n' + line;
          else skipped++; // preamble/garbage before the first recognized log line
        }

        if (onProgress && end >= nextProgress) {
          nextProgress += PROGRESS_EVERY;
          onProgress(Math.round((end / len) * 100), 'Parsing log… ' + Math.round((end / len) * 100) + '%');
        }
        if (isLast) break;
      }

      return { records: records, skipped: skipped };
    }

    // text → { format, records, skipped }. onProgress(percent, phase) is optional.
    function parse(text, onProgress) {
      var format = detectFormat(text);
      var res = format === 'csv' ? parseCsv(text, onProgress) : parseLive(text, onProgress);
      return { format: format, records: res.records, skipped: res.skipped };
    }

    return { detectFormat: detectFormat, parse: parse, parseCsv: parseCsv, parseLive: parseLive };
  }

  // Attach to the ambient global — window on the main thread, the worker global inside
  // a Worker, and (via global.self = global) the Node process during tests.
  self.createMendixLogParser = createMendixLogParser;
})();
