// Log Query Extractor - Mendix TRACE Log Parser
// Extracts SQL queries, XPath/OQL sources, Query Plans, parameters and results

let extractedQueries = [];
let lqeLastFiltered = [];
let lqeSkippedLines = 0;
let lqeSourceFormat = null; // 'csv' (Studio Pro export) | 'live' (Mendix Cloud download)
let lqeWorker = null;
let lqeVList = null;        // reusable virtual list bound to #lqe-query-list
let lqeVListMode = null;    // which row renderer the live list was built with ('exec' | 'stmt')
let lqeView = 'exec';       // 'exec' = one row per execution · 'stmt' = one row per distinct statement
let lqeLastStatements = []; // the aggregate behind the "By statement" view, for exports/report
let lqeTimeWindow = null;   // {from, to, label} — set by the Microflow Tracer cross-link
// The file currently being parsed, published to the Data Hub once the record
// count is known. Only set for user-loaded files: text arriving through a
// cross-link or the Hub itself already has an owner, so it must not re-register.
let lqePendingFile = null;
const LQE_WORKER_THRESHOLD = 2 * 1024 * 1024; // parse in a Web Worker above 2 MB

// ConnectionBus_Queries WARNING — logged at default log levels when a query exceeds
// the runtime slow-query threshold, so it works on production without TRACE.
const LQE_SLOW_QUERY = /^Query executed in (?:(\d+) seconds? and )?(\d+) milliseconds?:\s*([\s\S]+)/i;

window.lqeSetTab = function(tabId, btn) {
  const container = document.getElementById('panel-log-query-extractor');
  container.querySelectorAll('.tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
  btn.classList.add('active');
  btn.setAttribute('aria-selected', 'true');
  
  container.querySelectorAll('#lqe-tab-sql, #lqe-tab-source, #lqe-tab-params, #lqe-tab-result, #lqe-tab-plan').forEach(el => {
    el.style.display = 'none';
  });
  
  document.getElementById(tabId).style.display = 'block';
};

// A window bound arrives either as a log timestamp (Microflow Tracer, WS/REST
// Extractor pass the record's own string) or as an epoch (the Nginx analyzer
// resolves its access-log date itself). Render both readably — the tooltip is the
// only place the raw bound is shown, and a bare epoch tells the user nothing.
function lqeWindowBound(v) {
  if (typeof v !== 'number') return String(v);
  return isFinite(v) ? new Date(v).toISOString().replace('T', ' ').replace('Z', '') : '?';
}

// Cross-link entry points used by the Microflow Tracer: constrain the visible
// queries to an execution's [start, end] window (shown as a dismissible chip),
// and load raw log text directly so one file load powers both tools.
window.lqeSetTimeWindow = function(from, to, label) {
  lqeTimeWindow = from && to ? { from: from, to: to, label: label || '' } : null;
  const chip = document.getElementById('lqe-timewindow');
  if (chip) {
    if (lqeTimeWindow) {
      chip.style.display = '';
      chip.innerHTML = '⧉ ' + (label ? String(label).replace(/</g, '&lt;') + ' ' : '') + '<span style="text-decoration:underline; cursor:pointer;">×</span>';
      chip.title = 'Showing only queries between ' + lqeWindowBound(from) + ' and ' + lqeWindowBound(to) + '. Click × to remove.';
      chip.onclick = () => window.lqeSetTimeWindow(null, null);
    } else {
      chip.style.display = 'none';
      chip.innerHTML = '';
    }
  }
  window.lqeFilter();
};

window.lqeLoadText = function(text) {
  lqePendingFile = null;   // the caller (cross-link / Data Hub) owns this text
  parseLogContent(text);
};

window.lqeClear = function() {
  extractedQueries = [];
  lqeLastFiltered = [];
  lqeLastStatements = [];
  lqeSkippedLines = 0;
  lqeSourceFormat = null;
  window._lqeSlowestId = null;
  window._lqeActiveSqlId = null;
  lqeCompareSelection = [];
  const compareBtn = document.getElementById('lqe-compare-btn');
  if (compareBtn) compareBtn.disabled = true;
  const compareCount = document.getElementById('lqe-compare-count');
  if (compareCount) compareCount.textContent = '(0/2)';
  if (lqeVList) { lqeVList.destroy(); lqeVList = null; }
  lqeVListMode = null;
  if (lqeTimeWindow) window.lqeSetTimeWindow(null, null);
  const statsBar = document.getElementById('lqe-stats');
  if (statsBar) statsBar.style.display = 'none';
  const skippedEl = document.getElementById('lqe-skipped');
  if (skippedEl) { skippedEl.style.display = 'none'; skippedEl.textContent = ''; }
  document.getElementById('lqe-query-list').innerHTML =
    '<div style="padding:var(--sp-5); text-align:center; color:var(--text-muted); font-size:0.85rem;">' +
    'Drop a log file here or use &ldquo;Load TRACE Log&rdquo;:<br>' +
    'Studio Pro CSV export (TRACE) &mdash; full SQL, params &amp; plans &bull; Mendix Cloud live log (.txt/.log) &mdash; slow-query warnings.' +
    '<div class="data-req"><span class="data-req-title">How to get this data</span>Raise <b>ConnectionBus_Retrieve</b> (and <b>DataStorage_QueryPlan</b> for query plans) to <b>TRACE</b> &mdash; Studio Pro: <em>Console &rarr; Advanced &rarr; Set Log Levels</em>; Mendix Cloud: <em>Environment &rarr; Details &rarr; Log Levels</em>. Reproduce the scenario, then export the console log (CSV) or download the live log (.txt/.log/.gz).</div></div>';
  document.getElementById('lqe-count').textContent = '0';
  document.getElementById('lqe-sql-content').textContent = 'Select a query to view its runnable SQL...';
  document.getElementById('lqe-source-content').textContent = 'No source available (XPath/OQL) for this query.';
  document.getElementById('lqe-params-body').innerHTML = '<tr><td colspan="2" style="padding:var(--sp-3); color:var(--text-muted); text-align:center;">No parameters</td></tr>';
  document.getElementById('lqe-result-content').textContent = 'No result output logged.';
  document.getElementById('lqe-plan-content').textContent = 'No execution plan found for this query.';
  const fileInput = document.getElementById('lqe-file-input');
  if (fileInput) fileInput.value = '';
};

window.lqeHandleDrop = function(e) {
  e.preventDefault();
  const zone = document.getElementById('lqe-query-list');
  if (zone) zone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files).filter(f => {
    const fn = f.name.toLowerCase();
    return fn.endsWith('.log') || fn.endsWith('.txt') || fn.endsWith('.csv') || f.type === 'text/plain' || f.type === 'text/csv' || f.type === '';
  });
  if (files.length) window.lqeLoadFile(files);
};

window.lqeLoadFile = function(files) {
  if (!files || files.length === 0) return;
  const file = files[0];
  lqePendingFile = { name: file.name, size: file.size };
  const reader = new FileReader();
  if (window.showLoader) window.showLoader('Reading log file...');
  
  reader.onload = function(e) {
    const text = e.target.result;
    setTimeout(() => parseLogContent(text), 50);
  };
  
  reader.readAsText(file);
};

// Parsing pipeline (wave 2). Both the Studio Pro CSV export and the Mendix Cloud live log
// are normalized to a common record model by the shared parser (mendix-log-parser.js).
// Files above the threshold parse in a Web Worker so the UI never freezes on large TRACE
// logs; smaller ones parse inline to skip the worker spin-up cost.
function parseLogContent(text) {
  if (window.showLoader) window.showLoader('Parsing queries...', 5);
  lqeSkippedLines = 0;
  if (lqePendingFile) lqePendingFile.text = text;

  if (text.length >= LQE_WORKER_THRESHOLD && typeof Worker !== 'undefined' && window.createMendixLogParser) {
    lqeParseInWorker(text);
  } else {
    // Defer so the loader paints before a synchronous parse blocks the thread
    setTimeout(() => {
      try {
        lqeApplyParseResult(window.createMendixLogParser().parse(text));
      } catch (err) {
        console.error('LQE parse failed:', err);
        if (window.hideLoader) window.hideLoader();
        window.mtToast('Could not parse this log: ' + err.message, 'error');
      }
    }, 20);
  }
}

function lqeApplyParseResult(res) {
  lqeSourceFormat = res.format;
  lqeSkippedLines = res.skipped || 0;
  extractQueriesFromRecords(res.records);
  lqePublishToHub(res);
}

// Registers the just-parsed file with the Data Hub so the other log tools can
// pick it up without a second load. No-op when the text came from elsewhere.
function lqePublishToHub(res) {
  if (window.mtHub) window.mtHub.publishFromParse(lqePendingFile, lqePendingFile && lqePendingFile.text, res, 'log-query-extractor');
  lqePendingFile = null;
}

// Data Hub: does this tool currently show something of its own? Used to warn
// before a one-click hand-off from another tool silently replaces it.
window.lqeHasData = function () { return extractedQueries.length > 0; };

// Builds a Web Worker straight from the shared parser's own source. createMendixLogParser
// is a self-contained factory, so .toString() is a complete, serializable program — no
// bundler/worker-file plumbing needed (works in the single-file production build too).
// Falls back to the main thread if the worker can't start or errors mid-parse.
function lqeParseInWorker(text) {
  if (lqeWorker) { lqeWorker.terminate(); lqeWorker = null; }
  let worker;
  try {
    const code = window.createMendixLogParser.toString() + '\n' +
      'self.onmessage = function(e) {\n' +
      '  var parser = createMendixLogParser();\n' +
      '  var res = parser.parse(e.data.text, function(pct, phase) {\n' +
      '    self.postMessage({ type: "progress", progress: pct, phase: phase });\n' +
      '  });\n' +
      '  self.postMessage({ type: "complete", format: res.format, records: res.records, skipped: res.skipped });\n' +
      '};';
    const blob = new Blob([code], { type: 'application/javascript' });
    worker = new Worker(URL.createObjectURL(blob));
    lqeWorker = worker;
  } catch (err) {
    console.warn('LQE worker unavailable, parsing on main thread:', err);
    lqeApplyParseResult(window.createMendixLogParser().parse(text));
    return;
  }
  worker.onmessage = function(msg) {
    const d = msg.data;
    if (d.type === 'progress') {
      if (window.showLoader) window.showLoader(d.phase || ('Parsing… ' + d.progress + '%'), d.progress);
    } else if (d.type === 'complete') {
      worker.terminate();
      if (lqeWorker === worker) lqeWorker = null;
      if (window.showLoader) window.showLoader('Extracting queries…', 99);
      // Defer so the loader repaints before extraction runs on the main thread
      setTimeout(() => lqeApplyParseResult({ format: d.format, records: d.records, skipped: d.skipped }), 20);
    }
  };
  worker.onerror = function(err) {
    console.warn('LQE worker error, parsing on main thread:', err.message || err);
    worker.terminate();
    if (lqeWorker === worker) lqeWorker = null;
    lqeApplyParseResult(window.createMendixLogParser().parse(text));
  };
  worker.postMessage({ text: text });
}

// Detects the statement type from the leading SQL keyword
function lqeSqlType(sql) {
  const upper = sql.toUpperCase();
  if (upper.startsWith('SELECT') || upper.startsWith('COUNT')) return 'SELECT';
  if (upper.startsWith('UPDATE')) return 'UPDATE';
  if (upper.startsWith('INSERT')) return 'INSERT';
  if (upper.startsWith('DELETE')) return 'DELETE';
  return 'OTHER';
}

// Pure extraction + aggregation: records -> array of query objects (with signatures,
// duplicate counts, linked plans and parsed params). No DOM, no module state, so it's
// unit-testable in Node (attached to window/self at the bottom of this file, like MFT).
function lqeExtractQueries(records) {
  const queryMap = new Map();    // sqlId -> query object
  const xpathMap = new Map();    // xpathId -> { xpath, oql }
  const planMap = new Map();     // xpathId -> plan JSON string
  const unlinkedPlans = [];      // plans without xpathId, in order
  const slowQueries = [];        // ConnectionBus_Queries WARNING entries (slow query log)

  // First pass: collect XPath sources, OQL translations, Query Plans and slow-query warnings
  for (let ri = 0; ri < records.length; ri++) {
    const rec = records[ri];
    const msg = rec.message;

    // Slow query warning: full SQL + duration at default log levels (no TRACE needed)
    if (rec.logNode === 'ConnectionBus_Queries') {
      const sm = msg.match(LQE_SLOW_QUERY);
      if (sm) {
        const durationMs = (sm[1] ? parseInt(sm[1], 10) * 1000 : 0) + parseInt(sm[2], 10);
        const sql = sm[3].trim();
        slowQueries.push({
          sqlId: 'slow-' + ri,
          txConn: '-',
          timestamp: rec.timestamp,
          sql: sql,
          type: lqeSqlType(sql),
          params: [],
          paramsString: '',
          status: 'SLOW (warning)',
          rows: '-',
          xpathId: null,
          xpathContent: '',
          resultData: '',
          queryPlan: '',
          duration: durationMs + ' ms',
          cost: null,
          slowWarning: true,
          _recIdx: ri
        });
      }
      continue;
    }

    // XPath incoming
    let xpathMatch = msg.match(/^Incoming query of type (XPath|OQL):\s*\[([a-f0-9-]+)\]\s*(.*)/is); // jshint ignore:line
    if (xpathMatch) {
      const id = xpathMatch[2];
      if (!xpathMap.has(id)) xpathMap.set(id, { xpath: '', oql: '' });
      xpathMap.get(id).xpath = xpathMatch[1] + ': ' + xpathMatch[3].trim();
      continue;
    }
    
    // OQL QueryParseResult
    let oqlMatch = msg.match(/^OQL:\s*\[([a-f0-9-]+)\]\s*QueryParseResult\((.*)\)/is); // jshint ignore:line
    if (oqlMatch) {
      const id = oqlMatch[1];
      let oqlContent = oqlMatch[2].trim();
      // Remove trailing Mendix metadata
      oqlContent = oqlContent.replace(/,com\.mendix\.connectionbus\..*$/s, ''); // jshint ignore:line
      if (!xpathMap.has(id)) xpathMap.set(id, { xpath: '', oql: '' });
      xpathMap.get(id).oql = oqlContent;
      continue;
    }
    
    // Query Plan from DataStorage_QueryPlan
    if (rec.logNode === 'DataStorage_QueryPlan') {
      let planMatch = msg.match(/^Query Plan:\s*(?:\[([a-f0-9-]+)\]\s*)?([\s\S]*)/i);
      if (planMatch) {
        const xpathId = planMatch[1] || null;
        const planJson = planMatch[2].trim();
        if (xpathId) {
          planMap.set(xpathId, planJson);
        } else {
          unlinkedPlans.push(planJson);
        }
      }
      continue;
    }
  }
  
  // Second pass: extract SQL queries and correlate everything
  let lastSqlId = null;
  let unlinkedPlanIdx = 0;

  for (let ri = 0; ri < records.length; ri++) {
    const rec = records[ri];
    const msg = rec.message;

    // SQL line: SQL@SQLID(TX-CONN): content
    // The colon is optional: when the runtime spills the remaining bound values
    // onto their own line it writes `SQL@id(TX-Cxx) Update param 3: …` without
    // one, and requiring it dropped that line — and with it a parameter, so the
    // rebuilt statement kept a bare `?`.
    let sqlMatch = msg.match(/^SQL@([a-f0-9]+)\((T\d+-C[a-f0-9]+)\):?\s*(.*)/is); // jshint ignore:line
    if (!sqlMatch) continue;

    const sqlId = sqlMatch[1];
    const txConn = sqlMatch[2];
    const content = sqlMatch[3].trim();

    if (!queryMap.has(sqlId)) {
      queryMap.set(sqlId, {
        sqlId: sqlId,
        txConn: txConn,
        timestamp: rec.timestamp,
        sql: '',
        type: 'OTHER',
        params: [],
        paramsString: '',
        status: 'Pending',
        rows: '-',
        xpathId: null,
        xpathContent: '',
        resultData: '',
        queryPlan: '',
        duration: null,
        cost: null,
        _recIdx: ri
      });
    }

    const q = queryMap.get(sqlId);
    lastSqlId = sqlId;
    
    // Determine content type
    // IMPORTANT: Check params BEFORE SQL keywords because "Select params..." starts with "SELECT"
    // `params 1-2:` for a batch, `param 3:` for a value spilled onto its own line.
    if (content.match(/^(Select|Update|Insert|Delete) params?\b/i)) {
      const paramStr = content.substring(content.indexOf(':') + 1).trim();
      q.paramsString = (q.paramsString ? q.paramsString + ', ' : '') + paramStr;
    }
    else if (content.startsWith('Success:')) {
      q.status = 'Success';
    }
    else if (content.match(/^\[([a-f0-9-]+)\]\s*Data table/)) {
      // Result line with xpathId link — this is the KEY correlation!
      let m = content.match(/^\[([a-f0-9-]+)\]\s*(.*)/is); // jshint ignore:line
      q.xpathId = m[1];
      
      // Link XPath/OQL source
      if (xpathMap.has(q.xpathId)) {
        const src = xpathMap.get(q.xpathId);
        let parts = [];
        if (src.xpath) parts.push(src.xpath);
        if (src.oql) parts.push('\nTranslated OQL:\n' + src.oql);
        q.xpathContent = parts.join('\n');
      }
      
      // Link Query Plan
      if (planMap.has(q.xpathId)) {
        q.queryPlan = planMap.get(q.xpathId);
      }
      
      let rowMatch = m[2].match(/\((\d+)\s*row\(s\)\)/);
      if (rowMatch) q.rows = rowMatch[1];
      
      q.resultData += m[2] + '\n';
    }
    else if (content.startsWith('Data table')) {
      let rowMatch = content.match(/\((\d+)\s*row\(s\)\)/);
      if (rowMatch) q.rows = rowMatch[1];
      q.resultData += content + '\n';
    }
    else if (content.startsWith('Row ')) {
      q.resultData += content + '\n';
    }
    else {
      // SQL statement detection (must be last because all other patterns start with known prefixes)
      const upperContent = content.toUpperCase();
      if (upperContent.startsWith('SELECT ') || upperContent.startsWith('UPDATE ') || 
          upperContent.startsWith('INSERT ') || upperContent.startsWith('DELETE ') || 
          upperContent.startsWith('COUNT(')) {
        q.sql = content;
        if (upperContent.startsWith('SELECT')) q.type = 'SELECT';
        else if (upperContent.startsWith('UPDATE')) q.type = 'UPDATE';
        else if (upperContent.startsWith('INSERT')) q.type = 'INSERT';
        else if (upperContent.startsWith('DELETE')) q.type = 'DELETE';
        else if (upperContent.startsWith('COUNT')) q.type = 'SELECT';
      }
    }
  }
  
  // Build final list; slow-query warnings are merged in chronological (record) order
  const queries = Array.from(queryMap.values()).filter(q => q.sql.length > 0)
    .concat(slowQueries)
    .sort((a, b) => a._recIdx - b._recIdx);

  // Duplicate detection (N+1): identical statements differ only in bound values,
  // so a normalized signature groups them together.
  const sigCounts = new Map();
  queries.forEach((q, i) => {
    q._idx = i;
    q.signature = q.sql.replace(/\s+/g, ' ').replace(/\b\d+\b/g, '?').trim().toLowerCase();
    sigCounts.set(q.signature, (sigCounts.get(q.signature) || 0) + 1);
  });
  queries.forEach(q => { q.dupCount = sigCounts.get(q.signature) || 1; });

  // Post-process: parse params, extract duration/cost from query plans
  for (let q of queries) {
    // For queries without an xpathId, try to assign an unlinked plan
    // (slow-query warnings never have a logged plan — don't consume one)
    if (!q.queryPlan && unlinkedPlanIdx < unlinkedPlans.length && !q.xpathId && !q.slowWarning) {
      q.queryPlan = unlinkedPlans[unlinkedPlanIdx++];
    }
    
    // Parse query plan JSON to extract duration and cost
    if (q.queryPlan) {
      try {
        const p = JSON.parse(q.queryPlan);
        if (p && p.length > 0 && p[0]) {
          // Execution Time is at the top level of the plan array element
          if (p[0]['Execution Time'] !== undefined) {
            q.duration = parseFloat(p[0]['Execution Time']).toFixed(3) + ' ms';
          } else if (p[0].Plan && p[0].Plan['Actual Total Time'] !== undefined) {
            q.duration = parseFloat(p[0].Plan['Actual Total Time']).toFixed(3) + ' ms';
          }
          if (p[0].Plan && p[0].Plan['Total Cost'] !== undefined) {
            q.cost = p[0].Plan['Total Cost'];
          }
          // Also extract Planning Time
          if (p[0]['Planning Time'] !== undefined) {
            q.planningTime = parseFloat(p[0]['Planning Time']).toFixed(3) + ' ms';
          }
        }
      } catch(e) {
        // Plan JSON wasn't valid — keep raw text
      }
    }
    
    // Parse params string
    if (q.paramsString) {
      if (q.paramsString.endsWith(',')) q.paramsString = q.paramsString.slice(0, -1);
      q.params = splitParams(q.paramsString);
    }
  }

  return queries;
}

// ── "By statement" aggregate ─────────────────────────────────────────────────
// Every other view here is per-execution, which answers "which single query was
// slowest" — and the Slowest stat already answers that. On a real TRACE log the
// expensive statement is usually the cheap one executed thousands of times:
// 4 000 × 3 ms outweighs one 400 ms query by an order of magnitude and is
// invisible when every row is one execution. This folds the executions onto the
// signature the duplicate detector already computes, so no new parsing.
//
// Durations exist only where the log carries them (a logged query plan, or a
// slow-query warning that states its own duration), so timedCount travels with
// every group: a total summed from 3 of 400 executions must not be presented as
// the cost of all 400. Groups with nothing timed report null, not 0.
function lqeAggregateByStatement(queries) {
  const map = new Map();
  (queries || []).forEach(function (q) {
    const key = q.signature || String(q.sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
    let g = map.get(key);
    if (!g) {
      g = { signature: key, sample: q, worst: null, count: 0, timedCount: 0,
            sumMs: 0, avgMs: null, maxMs: null, slowCount: 0 };
      map.set(key, g);
    }
    g.count++;
    if (q.slowWarning) g.slowCount++;
    const d = q.duration ? parseFloat(q.duration) : NaN;
    if (!isNaN(d)) {
      g.timedCount++;
      g.sumMs += d;
      if (g.maxMs === null || d > g.maxMs) { g.maxMs = d; g.worst = q; }
    }
  });

  const groups = Array.from(map.values());
  groups.forEach(function (g) {
    g.avgMs = g.timedCount ? g.sumMs / g.timedCount : null;
    if (!g.timedCount) g.sumMs = null;
    if (!g.worst) g.worst = g.sample; // nothing timed — the first execution represents the group
  });
  // Default order is the question this view exists to answer: total cost first,
  // then sheer volume for the groups the log never timed.
  groups.sort(function (a, b) {
    const d = (b.sumMs || 0) - (a.sumMs || 0);
    return d !== 0 ? d : b.count - a.count;
  });
  return groups;
}

// UI wrapper: run the pure extraction, then refresh the module state and the view.
function extractQueriesFromRecords(records) {
  extractedQueries = lqeExtractQueries(records);
  lqeUpdateSkippedNote();
  window.lqeFilter();
  if (window.hideLoader) window.hideLoader();
}

// Non-invasive note next to the query counter: malformed CSV rows lost during parsing,
// or a hint that a live log only yields slow-query warnings for now
function lqeUpdateSkippedNote() {
  const el = document.getElementById('lqe-skipped');
  if (!el) return;
  const parts = [];
  if (lqeSourceFormat === 'live') parts.push('live log');
  if (lqeSkippedLines > 0) parts.push(lqeSkippedLines + ' line' + (lqeSkippedLines === 1 ? '' : 's') + ' skipped');
  if (parts.length === 0) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  el.style.display = '';
  el.textContent = ' · ' + parts.join(' · ');
  el.title =
    (lqeSourceFormat === 'live'
      ? 'Mendix Cloud live-log format detected — SQL is extracted where the log has it (ConnectionBus_Retrieve) along with slow-query warnings (ConnectionBus_Queries). A Studio Pro CSV export with TRACE levels gives the fullest detail. '
      : '') +
    (lqeSkippedLines > 0
      ? lqeSkippedLines + ' malformed row(s) with fewer than 4 fields were ignored — usually a truncated or hand-edited export.'
      : '');
}

// Splits the logged parameter list on its top-level commas. Besides double
// quotes it tracks {} / [] nesting, because a single bound value is regularly a
// whole JSON document whose internal commas must not end it — a real log line
// reads `Update params 1-2: 2026-07-14 18:37:11.793, {"body":{"changes":{…}}}`,
// and splitting that naively turned two parameters into dozens of fragments.
function splitParams(str) {
  const result = [];
  let current = '';
  let inQuotes = false;
  let depth = 0;

  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inQuotes && c === '\\') {
      // \" inside a JSON string is content, not the end of the string
      current += c;
      i++;
      if (i < str.length) current += str[i];
    } else if (c === '"') {
      inQuotes = !inQuotes;
      current += c;
    } else if (!inQuotes && (c === '{' || c === '[')) {
      depth++;
      current += c;
    } else if (!inQuotes && (c === '}' || c === ']')) {
      if (depth > 0) depth--;
      current += c;
    } else if (c === ',' && !inQuotes && depth === 0) {
      result.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  if (current) result.push(current.trim());
  return result;
}

let lqeSortKey = null;
let lqeSortDir = -1; // -1 = descending (slowest/most expensive first)

const LQE_SORT_ACCESSORS = {
  time: q => q._idx,
  duration: q => (q.duration ? parseFloat(q.duration) : -1),
  cost: q => (q.cost !== null && q.cost !== undefined ? parseFloat(q.cost) : -1),
  rows: q => (q.rows !== '-' ? parseInt(q.rows, 10) : -1)
};

// Statement-view sort keys. Disjoint from the execution keys above, so one
// lqeSortKey can serve both views without either reading the other's accessor.
// Un-timed groups sort to the bottom (-1) instead of pretending to be 0 ms.
const LQE_STMT_SORT_ACCESSORS = {
  count: g => g.count,
  total: g => (g.sumMs === null ? -1 : g.sumMs),
  avg: g => (g.avgMs === null ? -1 : g.avgMs),
  max: g => (g.maxMs === null ? -1 : g.maxMs)
};

// Switches between one row per execution and one row per distinct statement.
// The filters above the list keep applying — the aggregate is built from
// whatever the filters left visible, so "By statement" of a time window or a
// search stays meaningful. Sorting resets because the two views share the
// header arrows but not the columns.
window.lqeSetView = function(view, btn) {
  lqeView = view;
  const group = document.getElementById('lqe-view-toggle');
  if (group) {
    const active = btn || group.querySelector('button[data-view="' + view + '"]');
    group.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === active));
  }
  const execHeader = document.getElementById('lqe-list-header');
  if (execHeader) execHeader.style.display = view === 'stmt' ? 'none' : 'grid';
  const stmtHeader = document.getElementById('lqe-list-header-stmt');
  if (stmtHeader) stmtHeader.style.display = view === 'stmt' ? 'grid' : 'none';
  lqeSortKey = null;
  lqeSortDir = -1;
  document.querySelectorAll('#panel-log-query-extractor .lqe-sort-arrow').forEach(a => a.textContent = '');
  window.lqeFilter();
};

window.lqeSort = function(key) {
  if (lqeSortKey === key) {
    lqeSortDir = -lqeSortDir;
  } else {
    lqeSortKey = key;
    lqeSortDir = key === 'time' ? 1 : -1;
  }
  // Update header arrows (both view headers live in this panel; only one is visible)
  document.querySelectorAll('#panel-log-query-extractor [data-sort-key]').forEach(el => {
    const arrow = el.querySelector('.lqe-sort-arrow');
    if (!arrow) return;
    arrow.textContent = (el.getAttribute('data-sort-key') === lqeSortKey) ? (lqeSortDir === 1 ? ' ▲' : ' ▼') : '';
  });
  window.lqeFilter();
};

window.lqeFilter = function() {
  const searchEl = document.getElementById('lqe-search');
  const search = searchEl ? searchEl.value.toLowerCase() : '';
  const typeFilterEl = document.getElementById('lqe-type-filter');
  const typeFilter = typeFilterEl ? typeFilterEl.value : 'ALL';
  const slowOnlyEl = document.getElementById('lqe-slow-only');
  const slowOnly = slowOnlyEl ? slowOnlyEl.checked : false;
  const slowMsEl = document.getElementById('lqe-slow-ms');
  const slowMs = slowMsEl ? (parseFloat(slowMsEl.value) || 0) : 0;

  // Time window from the Microflow Tracer cross-link — numeric comparison via the
  // shared timestamp parser so live (ISO) and CSV (US date) formats both work
  const twFrom = lqeTimeWindow && window.mftTsToMs ? window.mftTsToMs(lqeTimeWindow.from) : NaN;
  const twTo = lqeTimeWindow && window.mftTsToMs ? window.mftTsToMs(lqeTimeWindow.to) : NaN;

  const filtered = extractedQueries.filter(q => {
    if (!isNaN(twFrom) && !isNaN(twTo)) {
      const t = window.mftTsToMs(q.timestamp);
      if (isNaN(t) || t < twFrom || t > twTo) return false;
    }
    if (typeFilter === 'DUP') {
      if (q.dupCount < 2) return false;
    } else if (typeFilter !== 'ALL' && q.type !== typeFilter) {
      return false;
    }
    if (slowOnly) {
      // Queries without a measured duration can't pass a duration threshold
      const d = q.duration ? parseFloat(q.duration) : NaN;
      if (isNaN(d) || d <= slowMs) return false;
    }
    if (search) {
      if (!q.sql.toLowerCase().includes(search) &&
          !q.txConn.toLowerCase().includes(search) &&
          !q.type.toLowerCase().includes(search) &&
          !(q.xpathContent && q.xpathContent.toLowerCase().includes(search))) {
        return false;
      }
    }
    return true;
  });

  if (lqeSortKey && LQE_SORT_ACCESSORS[lqeSortKey]) {
    const acc = LQE_SORT_ACCESSORS[lqeSortKey];
    filtered.sort((a, b) => (acc(a) - acc(b)) * lqeSortDir);
  }

  lqeLastFiltered = filtered;
  lqeUpdateStats(filtered);

  // The stats bar keeps describing executions in both views — it answers
  // "how much SQL is in this window", which the aggregate doesn't change.
  const countEl = document.getElementById('lqe-count');
  const unitEl = document.getElementById('lqe-count-unit');

  if (lqeView === 'stmt') {
    const groups = lqeAggregateByStatement(filtered);
    if (lqeSortKey && LQE_STMT_SORT_ACCESSORS[lqeSortKey]) {
      const acc = LQE_STMT_SORT_ACCESSORS[lqeSortKey];
      groups.sort((a, b) => (acc(a) - acc(b)) * lqeSortDir);
    }
    lqeLastStatements = groups;
    if (countEl) countEl.textContent = groups.length;
    if (unitEl) unitEl.textContent = groups.length === 1 ? 'statement' : 'statements';
    renderList(groups, lqeRenderStmtRow, 'stmt');
  } else {
    lqeLastStatements = [];
    if (countEl) countEl.textContent = filtered.length;
    if (unitEl) unitEl.textContent = filtered.length === 1 ? 'query' : 'queries';
    renderList(filtered, lqeRenderRow, 'exec');
  }
};

function lqeFmtMs(ms) {
  if (ms >= 10000) return (ms / 1000).toFixed(1) + ' s';
  if (ms >= 100) return Math.round(ms) + ' ms';
  return ms.toFixed(2) + ' ms';
}

// Stats bar above the query list — always computed on the currently visible (filtered) set
function lqeUpdateStats(filtered) {
  const bar = document.getElementById('lqe-stats');
  if (!bar) return;
  if (extractedQueries.length === 0) {
    bar.style.display = 'none';
    window._lqeSlowestId = null;
    return;
  }
  bar.style.display = 'flex';

  let sum = 0, timedCount = 0, slowest = null, slowestMs = -1;
  for (const q of filtered) {
    const d = q.duration ? parseFloat(q.duration) : NaN;
    if (!isNaN(d)) {
      sum += d;
      timedCount++;
      if (d > slowestMs) { slowestMs = d; slowest = q; }
    }
  }
  const dupStatements = new Set(filtered.filter(q => q.dupCount > 1).map(q => q.signature)).size;

  document.getElementById('lqe-stat-total').textContent = filtered.length;
  document.getElementById('lqe-stat-sum').textContent = timedCount ? lqeFmtMs(sum) : '–';
  document.getElementById('lqe-stat-avg').textContent = timedCount ? lqeFmtMs(sum / timedCount) : '–';
  document.getElementById('lqe-stat-slowest').textContent = slowest ? lqeFmtMs(slowestMs) : '–';
  document.getElementById('lqe-stat-dups').textContent = dupStatements;
  const sumEl = document.getElementById('lqe-stat-sum');
  sumEl.parentElement.title = 'Sum of measured durations across visible queries (' + timedCount + ' of ' + filtered.length + ' have a duration)';
  window._lqeSlowestId = slowest ? slowest.sqlId : null;
}

// Click on the "Slowest" stat selects that query in the list. The target row may be
// virtualized out of the DOM, so drive it through the virtual list by index.
window.lqeSelectSlowest = function() {
  if (!window._lqeSlowestId) return;
  // The stat points at one execution, which the statement view has no row for —
  // switch back rather than doing nothing on a click that looks actionable.
  if (lqeView !== 'exec') window.lqeSetView('exec');
  if (!lqeVList) return;
  const idx = lqeVList.indexOf(q => q.sqlId === window._lqeSlowestId);
  if (idx < 0) return;
  window._lqeActiveSqlId = window._lqeSlowestId;
  lqeVList.scrollToIndex(idx, 'center');
  lqeVList.refresh();
  selectQuery(lqeVList.itemAt(idx));
};

// Exposed on window so other tools (REST & WS Extractor) can reuse the same
// JSON highlighting for payload previews instead of duplicating the regex.
function highlightJsonSimple(json) {
  if (typeof json != 'string') json = JSON.stringify(json, undefined, 2);
  json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
    let cls = 'jt-num';
    if (/^"/.test(match)) {
      if (/:$/.test(match)) cls = 'jt-key';
      else cls = 'jt-str';
    } else if (/true|false/.test(match)) cls = 'jt-bool';
    else if (/null/.test(match)) cls = 'jt-null';
    return '<span class="' + cls + '">' + match + '</span>';
  });
}

// True when a query is the currently selected row. Selection is tracked by sqlId
// (not a DOM node) because the virtual list recycles rows as they scroll in and out.
function lqeRowSelected(q) {
  return window._lqeActiveSqlId != null && q.sqlId === window._lqeActiveSqlId;
}

// ── "Compare" — pick two rows, diff their SQL side-by-side in Text Diff ──
let lqeCompareSelection = []; // up to 2 sqlIds

function lqeRowCompareChecked(q) {
  return lqeCompareSelection.indexOf(q.sqlId) !== -1;
}

window.lqeToggleCompare = function (sqlId, checkbox) {
  if (checkbox.checked) {
    if (lqeCompareSelection.length >= 2) { checkbox.checked = false; return; }
    lqeCompareSelection.push(sqlId);
  } else {
    lqeCompareSelection = lqeCompareSelection.filter(id => id !== sqlId);
  }
  const btn = document.getElementById('lqe-compare-btn');
  const count = document.getElementById('lqe-compare-count');
  if (btn) btn.disabled = lqeCompareSelection.length !== 2;
  if (count) count.textContent = '(' + lqeCompareSelection.length + '/2)';
};

window.lqeCompareSelected = function () {
  if (lqeCompareSelection.length !== 2) return;
  const qa = extractedQueries.find(q => q.sqlId === lqeCompareSelection[0]);
  const qb = extractedQueries.find(q => q.sqlId === lqeCompareSelection[1]);
  if (!qa || !qb) return;
  window.navigateWithReturn('text-diff');
  const a = document.getElementById('diff-a'), b = document.getElementById('diff-b');
  if (a) a.value = lqeBuildRunnableSql(qa);
  if (b) b.value = lqeBuildRunnableSql(qb);
  if (window.diffCompare) window.diffCompare();
};

// Best-effort "table + operation" label so a long SQL blob scans in one glance
// (e.g. "SELECT customers$order"). Falls back to just the operation when the
// statement doesn't match a plain single-table shape (subselects, no FROM, etc.)
// rather than guessing — an unlabeled row is honest, a wrong label isn't.
function lqeSmartLabel(q) {
  const sql = q.sql || '';
  let m = null;
  if (q.type === 'UPDATE') m = sql.match(/^UPDATE\s+"?([A-Za-z0-9_.$]+)"?/i);
  else if (q.type === 'INSERT') m = sql.match(/^INSERT\s+INTO\s+"?([A-Za-z0-9_.$]+)"?/i);
  else m = sql.match(/\bFROM\s+"?([A-Za-z0-9_.$]+)"?/i); // SELECT and DELETE both use FROM
  if (!m) return q.type;
  const table = m[1].replace(/^public\./i, '');
  // With a domain model loaded, say `SELECT eShop.Order` instead of
  // `SELECT eshop$order` — same label, in the names the developer works in.
  const entity = window.mxEntityForTable ? window.mxEntityForTable(table) : null;
  return q.type + ' ' + (entity || table);
}

// Duration heat-map: fixed bands (not relative to the visible set, so the same
// number always means the same color as filters change) — <100ms fine, <1s
// worth a look, otherwise slow.
function lqeDurationColor(duration) {
  if (!duration) return null;
  const ms = parseFloat(duration);
  if (isNaN(ms)) return null;
  if (ms < 100) return 'var(--success)';
  if (ms < 1000) return 'var(--warning)';
  return 'var(--danger)';
}

// Builds one query row. Passed to the virtual list, which positions it and only
// keeps the visible window in the DOM — so a 2 000-query result stays responsive.
function lqeRenderRow(q) {
  const el = document.createElement('div');
  el.className = 'lqe-list-item';
  el.dataset.sqlid = q.sqlId;
  el.style.display = 'grid';
  el.style.gridTemplateColumns = '22px 96px 92px 112px 70px 60px 1fr 60px';
  el.style.padding = 'var(--sp-2) var(--sp-3)';
  el.style.borderBottom = '1px solid var(--border)';
  el.style.fontSize = '0.8rem';
  el.style.cursor = 'pointer';
  el.style.color = 'var(--text)';
  el.style.background = lqeRowSelected(q) ? 'var(--bg-active)' : 'transparent';

  let summary = q.sql.substring(0, 100);
  if (q.sql.length > 100) summary += '...';
  const durColor = lqeDurationColor(q.duration) || 'var(--accent)';

  let typeColor = 'var(--text)';
  if (q.type === 'SELECT') typeColor = '#3498db';
  if (q.type === 'UPDATE') typeColor = '#f39c12';
  if (q.type === 'INSERT') typeColor = '#2ecc71';
  if (q.type === 'DELETE') typeColor = '#e74c3c';

  const dupBadge = q.dupCount > 1
    ? `<span title="This statement was executed ${q.dupCount}× with different parameters — possible N+1 pattern" style="margin-left:4px;font-size:0.7rem;font-weight:700;color:${q.dupCount >= 10 ? 'var(--danger)' : 'var(--warning)'};background:${q.dupCount >= 10 ? 'var(--danger-subtle)' : 'var(--warning-subtle)'};padding:0 4px;border-radius:var(--r-sm)">×${q.dupCount}</span>`
    : '';

  const slowBadge = q.slowWarning
    ? `<span title="Slow-query warning logged by ConnectionBus_Queries — the runtime flagged this query as slow (available at default log levels, no TRACE needed)" style="margin-left:4px;color:var(--warning);cursor:help">⚠</span>`
    : '';

  el.innerHTML = `
    <div style="display:flex;align-items:center" onclick="event.stopPropagation()">
      <input type="checkbox" title="Select for Compare (max 2)" ${lqeRowCompareChecked(q) ? 'checked' : ''} onchange="window.lqeToggleCompare('${q.sqlId}', this)">
    </div>
    <div style="font-weight:600; color:${typeColor}; white-space:nowrap; overflow:hidden">${q.type}${dupBadge}${slowBadge}</div>
    <div style="color:var(--text-muted); font-family:var(--font-mono); font-size:0.75rem">${q.txConn}</div>
    <div style="color:var(--text-muted)">${q.timestamp}</div>
    <div style="color:${durColor}; font-weight:600;">${q.duration || '-'}</div>
    <div style="color:var(--text-muted)">${q.cost || '-'}</div>
    <div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${q.sql.replace(/"/g, '&quot;')}"><span style="font-weight:600">${lqeSmartLabel(q)}</span> <span style="color:var(--text-muted)">— ${summary}</span></div>
    <div style="text-align:right">${q.rows}</div>
  `;

  el.onmouseenter = () => { if (!lqeRowSelected(q)) el.style.background = 'var(--bg-hover)'; };
  el.onmouseleave = () => { if (!lqeRowSelected(q)) el.style.background = 'transparent'; };

  el.onclick = () => {
    window._lqeActiveSqlId = q.sqlId;
    if (lqeVList) lqeVList.refresh(); // restyle the visible window so only this row is active
    selectQuery(q);
  };

  return el;
}

// One row per distinct statement. Same grid as #lqe-list-header-stmt.
// A group is "timed" only if the log measured at least one of its executions;
// where it didn't, the cells read "–" rather than 0 ms, and the tooltip says how
// many of the executions the totals actually cover.
function lqeRenderStmtRow(g) {
  const el = document.createElement('div');
  el.className = 'lqe-list-item';
  el.style.display = 'grid';
  el.style.gridTemplateColumns = '74px 92px 92px 92px 1fr';
  el.style.padding = 'var(--sp-2) var(--sp-3)';
  el.style.borderBottom = '1px solid var(--border)';
  el.style.fontSize = '0.8rem';
  el.style.cursor = 'pointer';
  el.style.color = 'var(--text)';

  const selected = window._lqeActiveSqlId != null && g.worst && g.worst.sqlId === window._lqeActiveSqlId;
  el.style.background = selected ? 'var(--bg-active)' : 'transparent';

  // Same thresholds as the ×N badge in the execution view, so a count means the
  // same thing in both places.
  const countColor = g.count >= 10 ? 'var(--danger)' : (g.count > 1 ? 'var(--warning)' : 'var(--text)');
  const slowBadge = g.slowCount
    ? `<span title="${g.slowCount} of these executions were logged as slow-query warnings by ConnectionBus_Queries" style="margin-left:4px;color:var(--warning);cursor:help">⚠</span>`
    : '';

  let summary = g.sample.sql.substring(0, 100);
  if (g.sample.sql.length > 100) summary += '...';

  const coverage = g.timedCount
    ? g.timedCount + ' of ' + g.count + ' execution(s) have a measured duration'
    : 'None of these executions has a measured duration — the log carries no query plan or slow-query warning for them';

  el.innerHTML = `
    <div style="font-weight:600; color:${countColor}">×${g.count}${slowBadge}</div>
    <div style="font-weight:600; color:${g.sumMs === null ? 'var(--text-muted)' : 'var(--accent)'}" title="${coverage}">${g.sumMs === null ? '–' : lqeFmtMs(g.sumMs)}</div>
    <div style="color:${g.avgMs === null ? 'var(--text-muted)' : (lqeDurationColor(g.avgMs) || 'var(--text)')}">${g.avgMs === null ? '–' : lqeFmtMs(g.avgMs)}</div>
    <div style="color:${g.maxMs === null ? 'var(--text-muted)' : (lqeDurationColor(g.maxMs) || 'var(--text)')}">${g.maxMs === null ? '–' : lqeFmtMs(g.maxMs)}</div>
    <div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${g.sample.sql.replace(/"/g, '&quot;')}"><span style="font-weight:600">${lqeSmartLabel(g.sample)}</span> <span style="color:var(--text-muted)">— ${summary}</span></div>
  `;

  el.onmouseenter = () => { if (!selected) el.style.background = 'var(--bg-hover)'; };
  el.onmouseleave = () => { if (!selected) el.style.background = 'transparent'; };

  // Clicking a statement opens its slowest execution in the detail pane, so the
  // SQL / params / plan tabs keep working exactly as in the execution view.
  el.onclick = () => {
    window._lqeActiveSqlId = g.worst ? g.worst.sqlId : null;
    if (lqeVList) lqeVList.refresh();
    if (g.worst) selectQuery(g.worst);
  };

  return el;
}

// Both views share the virtual list. The row renderer is fixed at creation, so
// switching views rebuilds it rather than repainting rows of the wrong shape.
function renderList(list, renderRow, mode) {
  const container = document.getElementById('lqe-query-list');
  if (!container) return;

  if (lqeVList && lqeVListMode !== mode) { lqeVList.destroy(); lqeVList = null; }
  lqeVListMode = mode;

  if (list.length === 0) {
    if (lqeVList) { lqeVList.destroy(); lqeVList = null; }
    container.innerHTML = '<div style="padding:var(--sp-5); text-align:center; color:var(--text-muted); font-size:0.85rem;">No queries found matching criteria.</div>';
    return;
  }

  if (!lqeVList) {
    lqeVList = window.createVirtualList({ container: container, renderRow: renderRow });
  }
  lqeVList.setItems(list);
}

// Substitutes bound params into the logged SQL, then lays it out with the SQL
// Formatter's own engine — same clause breaks, indentation and keyword case the
// user gets in that tool. It replaces a private chain of regex replacements that
// knew about nine keywords and applied them blindly, so ` FROM ` inside a string
// literal was broken onto a new line too.
// Shared by the SQL tab, Copy, Copy for EXPLAIN and Compare, so all four agree.
function lqeBuildRunnableSql(q) {
  let runnableSql = q.sql;
  if (q.params && q.params.length > 0) {
    let paramIndex = 0;
    runnableSql = runnableSql.replace(/\?/g, function() {
      if (paramIndex < q.params.length) {
        let val = q.params[paramIndex++];
        if (val === 'true' || val === 'false' || val === 'null' || (!isNaN(Number(val)) && val.trim() !== '')) {
           return val;
        } else {
           return "'" + val.replace(/'/g, "''") + "'";
        }
      }
      return '?';
    });
  }

  return window.prettifySQL(runnableSql);
}

function selectQuery(q) {
  const runnableSql = lqeBuildRunnableSql(q);
  // fvRender, not innerHTML: it also binds the bracket hover-matching the SQL
  // Formatter has, so the pane behaves the same way and not just looks it.
  window.fvRender('lqe-sql-content', window.sqlHighlight(runnableSql));
  window._currentRunnableSql = runnableSql;
  
  const sourceEl = document.getElementById('lqe-source-content');
  if (q.xpathContent) {
    if (window.sqlHighlight) {
      sourceEl.innerHTML = window.sqlHighlight(q.xpathContent);
    } else {
      sourceEl.textContent = q.xpathContent;
    }
  } else {
    sourceEl.textContent = 'No source available (XPath/OQL) for this query.';
  }
  
  const tbody = document.getElementById('lqe-params-body');
  tbody.innerHTML = '';
  if (q.params && q.params.length > 0) {
    q.params.forEach((p, i) => {
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid var(--border)';
      tr.innerHTML = `
        <td style="padding:var(--sp-2); border-right:1px solid var(--border);">${i+1}</td>
        <td style="padding:var(--sp-2); font-family:var(--font-mono); color:var(--accent);">${p}</td>
      `;
      tbody.appendChild(tr);
    });
  } else {
    tbody.innerHTML = '<tr><td colspan="2" style="padding:var(--sp-3); color:var(--text-muted); text-align:center;">No parameters</td></tr>';
  }
  
  if (q.resultData) {
    document.getElementById('lqe-result-content').textContent = q.resultData.trim();
  } else {
    document.getElementById('lqe-result-content').textContent = 'No result output logged. (Might be a DML query or trace level too low)';
  }
  
  if (q.queryPlan) {
    // Try to pretty-print the JSON plan
    try {
      const planObj = JSON.parse(q.queryPlan);
      let prefix = '';
      if (q.duration) prefix += 'Execution Time: ' + q.duration + '\n';
      if (q.planningTime) prefix += 'Planning Time: ' + q.planningTime + '\n';
      if (q.duration || q.planningTime) prefix += '\n';
      
      const planEl = document.getElementById('lqe-plan-content');
      planEl.innerHTML = (window.escHtml ? window.escHtml(prefix) : prefix) + highlightJsonSimple(planObj);
    } catch(e) {
      document.getElementById('lqe-plan-content').textContent = q.queryPlan.trim();
    }
  } else {
    document.getElementById('lqe-plan-content').textContent = 'No execution plan found for this query.';
  }
  
  window._currentSelectedQuery = q;
}

window.lqeCopySql = function() {
  if (window._currentRunnableSql) {
    navigator.clipboard.writeText(window._currentRunnableSql).then(() => {
       const btn = document.querySelector('#lqe-tab-sql button:first-child');
       const oldHtml = btn.innerHTML;
       btn.innerHTML = 'Copied!';
       setTimeout(() => btn.innerHTML = oldHtml, 2000);
    });
  }
};

window.lqeCopyExplain = function() {
  if (window._currentRunnableSql) {
    const explainSql = 'EXPLAIN (ANALYZE, COSTS, VERBOSE, BUFFERS, FORMAT TEXT)\n' + window._currentRunnableSql;
    navigator.clipboard.writeText(explainSql).then(() => {
       const btn = document.querySelector('#lqe-tab-sql button:last-child');
       const oldHtml = btn.innerHTML;
       btn.innerHTML = 'Copied!';
       setTimeout(() => btn.innerHTML = oldHtml, 2000);
    });
  }
};

// Converts a PostgreSQL JSON plan node into the text EXPLAIN format
// understood by the Query Intelligence Explain visualizer.
function lqePlanNodeToText(node, depth) {
  const indent = '  '.repeat(depth);
  const arrow = depth > 0 ? '->  ' : '';
  let head = node['Node Type'] || 'Node';
  if (node['Relation Name']) head += ' on ' + node['Relation Name'];
  if (node['Index Name']) head += ' using ' + node['Index Name'];
  let metrics = '';
  if (node['Startup Cost'] !== undefined) {
    metrics += 'cost=' + node['Startup Cost'] + '..' + node['Total Cost'] + ' rows=' + (node['Plan Rows'] !== undefined ? node['Plan Rows'] : '?');
  }
  if (node['Actual Total Time'] !== undefined) {
    metrics += (metrics ? ' ' : '') + 'actual time=' + node['Actual Startup Time'] + '..' + node['Actual Total Time'] + ' rows=' + (node['Actual Rows'] !== undefined ? node['Actual Rows'] : '?');
  }
  let text = indent + arrow + head + (metrics ? '  (' + metrics + ')' : '') + '\n';
  if (node.Filter) text += indent + '      Filter: (' + node.Filter + ')\n';
  if (node['Index Cond']) text += indent + '      Index Cond: (' + node['Index Cond'] + ')\n';
  if (node['Sort Key']) text += indent + '      Sort Key: ' + [].concat(node['Sort Key']).join(', ') + '\n';
  (node.Plans || []).forEach(child => { text += lqePlanNodeToText(child, depth + 1); });
  return text;
}

window.lqeVisualizePlan = function() {
  const q = window._currentSelectedQuery;
  if (!q || !q.queryPlan) {
    window.mtToast('Select a query that has a logged Query Plan first.', 'warning');
    return;
  }
  let text = q.queryPlan;
  try {
    const arr = JSON.parse(q.queryPlan);
    if (arr && arr[0] && arr[0].Plan) {
      text = lqePlanNodeToText(arr[0].Plan, 0);
      if (arr[0]['Planning Time'] !== undefined) text += 'Planning Time: ' + arr[0]['Planning Time'] + ' ms\n';
      if (arr[0]['Execution Time'] !== undefined) text += 'Execution Time: ' + arr[0]['Execution Time'] + ' ms\n';
    }
  } catch (e) {
    // Plan was already plain text — pass it through unchanged
  }
  window.navigateWithReturn('query-intelligence');
  const tabBtn = document.querySelector('#panel-query-intelligence .tab[data-help-key="query-intelligence-explain"]');
  if (tabBtn && window.qiSetTab) window.qiSetTab('explain', tabBtn);
  const input = document.getElementById('sql-explain-input');
  if (input) input.value = text;
  if (window.visualizeSqlExplain) window.visualizeSqlExplain();
};

// EXPLAIN live: run the selected query against a connected read-only database
// through the Bridge, then hand the plan text to the same SQL Explain visualizer
// as lqeVisualizePlan(). Progressive enhancement — with no connection this does
// nothing but point the user at the connection bar; the logged-plan flow above
// and manual paste in SQL Explain are unaffected.
window.lqeExplainLive = async function(btn) {
  const q = window._currentSelectedQuery;
  const sql = window._currentRunnableSql;
  if (!q || !sql) { window.mtToast('Select a query first.', 'warning'); return; }
  if (q.type && q.type !== 'SELECT') {
    window.mtToast('EXPLAIN live runs only on SELECT queries (read-only). This one is a ' + q.type + ' — copy it and analyze it manually.', 'warning');
    return;
  }
  if (!window.mtDb || !window.mtDb.isConnected()) {
    const bar = document.getElementById('lqe-livedb-bar');
    if (bar) bar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    window.mtToast('Connect a live database first — use the "Live database" panel below the plan. Without a connection you can still copy the query and paste its plan into SQL Explain.', 'warning');
    return;
  }
  const oldHtml = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = 'Running…'; }
  try {
    const resp = await fetch('http://localhost:9999/livedb/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, window.mtDb.getConfig(), { sql: sql }))
    });
    const data = await resp.json();
    if (!data || data.error || typeof data.plan !== 'string') {
      window.mtToast('EXPLAIN live failed: ' + ((data && data.message) || 'no plan returned') +
            '\n\nTip: queries with parameter placeholders can\'t be planned directly — copy the query and substitute values, or paste an EXPLAIN plan manually.', 'error');
      return;
    }
    window.navigateWithReturn('query-intelligence');
    const tabBtn = document.querySelector('#panel-query-intelligence .tab[data-help-key="query-intelligence-explain"]');
    if (tabBtn && window.qiSetTab) window.qiSetTab('explain', tabBtn);
    const input = document.getElementById('sql-explain-input');
    if (input) input.value = data.plan;
    if (window.visualizeSqlExplain) window.visualizeSqlExplain();
  } catch (e) {
    window.mtToast('EXPLAIN live failed: ' + e.message, 'error');
  } finally {
    if (btn && oldHtml !== null) { btn.disabled = false; btn.innerHTML = oldHtml; }
  }
};

// ── Export of the currently filtered list ──────────────────
// Columns: Type, Tx-Conn, Timestamp, Duration, Cost, Rows, Dup, SQL (truncated)
// Statements are a different shape from executions, so the export follows the
// active view instead of forcing an aggregate into the execution columns —
// the same rule the Microflow Tracer applies to its background-run view.
function lqeStmtExportRows(groups, sqlMaxLen) {
  return groups.map(g => {
    let sql = g.sample.sql.replace(/\s+/g, ' ').trim();
    if (sql.length > sqlMaxLen) sql = sql.substring(0, sqlMaxLen) + '…';
    return [
      g.count,
      g.sumMs === null ? '' : +g.sumMs.toFixed(3),
      g.avgMs === null ? '' : +g.avgMs.toFixed(3),
      g.maxMs === null ? '' : +g.maxMs.toFixed(3),
      g.timedCount,
      g.slowCount || '',
      sql
    ];
  });
}

function lqeExportRows(sqlMaxLen) {
  if (lqeView === 'stmt') return lqeStmtExportRows(lqeLastStatements, sqlMaxLen);
  return lqeLastFiltered.map(q => {
    let sql = q.sql.replace(/\s+/g, ' ').trim();
    if (sql.length > sqlMaxLen) sql = sql.substring(0, sqlMaxLen) + '…';
    return [
      q.type + (q.slowWarning ? ' (SLOW warning)' : ''),
      q.txConn,
      q.timestamp,
      q.duration ? parseFloat(q.duration) : '',
      (q.cost !== null && q.cost !== undefined) ? q.cost : '',
      q.rows !== '-' ? q.rows : '',
      q.dupCount > 1 ? '×' + q.dupCount : '',
      sql
    ];
  });
}

const LQE_EXPORT_HEADER = ['Type', 'Tx-Conn', 'Timestamp', 'Duration (ms)', 'Cost', 'Rows', 'Dup', 'SQL'];
// "Timed" is carried into the export on purpose: a total summed from 3 of 400
// executions is a different number from one summed from all 400, and outside the
// UI there is no tooltip to say so.
const LQE_STMT_EXPORT_HEADER = ['Executions', 'Total (ms)', 'Avg (ms)', 'Max (ms)', 'Timed', 'Slow warnings', 'SQL'];

function lqeExportHeader() { return lqeView === 'stmt' ? LQE_STMT_EXPORT_HEADER : LQE_EXPORT_HEADER; }

// Exports go through the shared helper (window.mtExport) so quoting/escaping and
// the self-contained HTML template live in one place across tools.
window.lqeExportCsv = function() {
  if (lqeLastFiltered.length === 0) {
    window.mtToast('Nothing to export — load a log first (and check the active filters).', 'warning');
    return;
  }
  window.mtExport.downloadCsv('extracted-queries.csv', lqeExportHeader(), lqeExportRows(300));
};

window.lqeCopyMarkdown = function(btn) {
  if (lqeLastFiltered.length === 0) {
    window.mtToast('Nothing to copy — load a log first (and check the active filters).', 'warning');
    return;
  }
  window.mtExport.copyMarkdown(lqeExportHeader(), lqeExportRows(120), btn);
};

window.lqeExportHtml = function() {
  if (lqeLastFiltered.length === 0) {
    window.mtToast('Nothing to export — load a log first (and check the active filters).', 'warning');
    return;
  }
  const rows = lqeExportRows(2000);
  window.mtExport.downloadHtml('extracted-queries.html', {
    title: lqeView === 'stmt' ? 'Extracted SQL Queries — by statement' : 'Extracted SQL Queries',
    subtitle: 'MxDev Swiss Tool — Log Query Extractor',
    meta: [
      { label: 'Source', value: lqeSourceFormat === 'live' ? 'Mendix Cloud live log' : (lqeSourceFormat === 'csv' ? 'Studio Pro CSV export' : 'log') },
      { label: lqeView === 'stmt' ? 'Statements' : 'Queries', value: rows.length }
    ].concat(lqeView === 'stmt' ? [{ label: 'Executions', value: lqeLastFiltered.length }] : []),
    columns: lqeExportHeader(),
    rows: rows
  });
};

// Incident Report source: the currently filtered queries, optionally narrowed to
// [fromMs, toMs]. Reuses the tool's own filter state, so the report reflects what
// the user is looking at. Returns null when empty (data-driven rule).
window.lqeReportSection = function(fromMs, toMs) {
  if (!lqeLastFiltered.length) return null;
  const tsToMs = window.mftTsToMs || function () { return NaN; };
  const inWin = lqeLastFiltered.filter(function (q) {
    const ms = tsToMs(q.timestamp);
    if (fromMs != null && !isNaN(ms) && ms < fromMs) return false;
    if (toMs != null && !isNaN(ms) && ms > toMs) return false;
    return true;
  });
  if (!inWin.length) return null;

  let firstMs = Infinity, lastMs = -Infinity;
  inWin.forEach(function (q) {
    const ms = tsToMs(q.timestamp);
    if (!isNaN(ms)) { if (ms < firstMs) firstMs = ms; if (ms > lastMs) lastMs = ms; }
  });

  const src = lqeSourceFormat === 'live' ? ' (Mendix Cloud live log)' : (lqeSourceFormat === 'csv' ? ' (Studio Pro CSV)' : '');

  // The report follows the active view, like the exports do: a reader who is
  // looking at total cost per statement needs that table in the report, not
  // several thousand individual executions to add up by hand.
  const rows = lqeView === 'stmt'
    ? lqeStmtExportRows(lqeAggregateByStatement(inWin), 2000)
    : inWin.map(function (q) {
        let sql = q.sql.replace(/\s+/g, ' ').trim();
        if (sql.length > 2000) sql = sql.substring(0, 2000) + '…';
        return [
          q.type + (q.slowWarning ? ' (SLOW warning)' : ''), q.txConn, q.timestamp,
          q.duration ? parseFloat(q.duration) : '',
          (q.cost !== null && q.cost !== undefined) ? q.cost : '',
          q.rows !== '-' ? q.rows : '', q.dupCount > 1 ? '×' + q.dupCount : '', sql
        ];
      });

  const subtitle = lqeView === 'stmt'
    ? rows.length + ' distinct statement' + (rows.length === 1 ? '' : 's') + ' from ' + inWin.length + ' execution' + (inWin.length === 1 ? '' : 's') + src
    : rows.length + ' quer' + (rows.length === 1 ? 'y' : 'ies') + src;

  return {
    id: 'log-query-extractor',
    title: 'Log Query Extractor — SQL queries' + (lqeView === 'stmt' ? ' (by statement)' : ''),
    subtitle: subtitle,
    columns: lqeView === 'stmt' ? LQE_STMT_EXPORT_HEADER : LQE_EXPORT_HEADER,
    rows: rows, total: rows.length,
    firstMs: firstMs === Infinity ? null : firstMs, lastMs: lastMs === -Infinity ? null : lastMs
  };
};

window.lqeCopyContent = function(elementId, btn) {
  let textToCopy = '';
  
  if (elementId === 'lqe-params-table') {
    if (window._currentSelectedQuery && window._currentSelectedQuery.params && window._currentSelectedQuery.params.length > 0) {
      textToCopy = JSON.stringify(window._currentSelectedQuery.params, null, 2);
    } else {
      textToCopy = '[]';
    }
  } else {
    const el = document.getElementById(elementId);
    if (el) {
      textToCopy = el.textContent || el.innerText;
    }
  }

  if (textToCopy) {
    navigator.clipboard.writeText(textToCopy).then(() => {
      const oldHtml = btn.innerHTML;
      btn.innerHTML = 'Copied!';
      setTimeout(() => btn.innerHTML = oldHtml, 2000);
    });
  }
};

// Expose the pure extractor and aggregator for unit tests (Node points `window` at the global).
(typeof window !== 'undefined' ? window : self).lqeExtractQueries = lqeExtractQueries;
(typeof window !== 'undefined' ? window : self).lqeAggregateByStatement = lqeAggregateByStatement;
window.highlightJsonSimple = highlightJsonSimple;
