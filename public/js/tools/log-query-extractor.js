// Log Query Extractor - Mendix TRACE Log Parser
// Extracts SQL queries, XPath/OQL sources, Query Plans, parameters and results

let extractedQueries = [];
let lqeLastFiltered = [];
let lqeSkippedLines = 0;
let lqeSourceFormat = null; // 'csv' (Studio Pro export) | 'live' (Mendix Cloud download)
let lqeWorker = null;
let lqeVList = null;        // reusable virtual list bound to #lqe-query-list
let lqeTimeWindow = null;   // {from, to, label} — set by the Microflow Tracer cross-link
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
      chip.title = 'Showing only queries between ' + from + ' and ' + to + ' (from Microflow Tracer). Click × to remove.';
      chip.onclick = () => window.lqeSetTimeWindow(null, null);
    } else {
      chip.style.display = 'none';
      chip.innerHTML = '';
    }
  }
  window.lqeFilter();
};

window.lqeLoadText = function(text) {
  parseLogContent(text);
};

window.lqeClear = function() {
  extractedQueries = [];
  lqeLastFiltered = [];
  lqeSkippedLines = 0;
  lqeSourceFormat = null;
  window._lqeSlowestId = null;
  window._lqeActiveSqlId = null;
  if (lqeVList) { lqeVList.destroy(); lqeVList = null; }
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
        alert('Could not parse this log: ' + err.message);
      }
    }, 20);
  }
}

function lqeApplyParseResult(res) {
  lqeSourceFormat = res.format;
  lqeSkippedLines = res.skipped || 0;
  extractQueriesFromRecords(res.records);
}

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
    let sqlMatch = msg.match(/^SQL@([a-f0-9]+)\((T\d+-C[a-f0-9]+)\):\s*(.*)/is); // jshint ignore:line
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
    if (content.match(/^(Select|Update|Insert|Delete) params/i)) {
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

function splitParams(str) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '"') {
      inQuotes = !inQuotes;
      current += c;
    } else if (c === ',' && !inQuotes) {
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

window.lqeSort = function(key) {
  if (lqeSortKey === key) {
    lqeSortDir = -lqeSortDir;
  } else {
    lqeSortKey = key;
    lqeSortDir = key === 'time' ? 1 : -1;
  }
  // Update header arrows
  document.querySelectorAll('#lqe-list-header [data-sort-key]').forEach(el => {
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

  const countEl = document.getElementById('lqe-count');
  if (countEl) countEl.textContent = filtered.length;
  lqeLastFiltered = filtered;
  lqeUpdateStats(filtered);
  renderQueryList(filtered);
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
  if (!window._lqeSlowestId || !lqeVList) return;
  const idx = lqeVList.indexOf(q => q.sqlId === window._lqeSlowestId);
  if (idx < 0) return;
  window._lqeActiveSqlId = window._lqeSlowestId;
  lqeVList.scrollToIndex(idx, 'center');
  lqeVList.refresh();
  selectQuery(lqeVList.itemAt(idx));
};

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

// Builds one query row. Passed to the virtual list, which positions it and only
// keeps the visible window in the DOM — so a 2 000-query result stays responsive.
function lqeRenderRow(q) {
  const el = document.createElement('div');
  el.className = 'lqe-list-item';
  el.dataset.sqlid = q.sqlId;
  el.style.display = 'grid';
  el.style.gridTemplateColumns = '96px 92px 112px 70px 60px 1fr 60px';
  el.style.padding = 'var(--sp-2) var(--sp-3)';
  el.style.borderBottom = '1px solid var(--border)';
  el.style.fontSize = '0.8rem';
  el.style.cursor = 'pointer';
  el.style.color = 'var(--text)';
  el.style.background = lqeRowSelected(q) ? 'var(--bg-active)' : 'transparent';

  let summary = q.sql.substring(0, 100);
  if (q.sql.length > 100) summary += '...';

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
    <div style="font-weight:600; color:${typeColor}; white-space:nowrap; overflow:hidden">${q.type}${dupBadge}${slowBadge}</div>
    <div style="color:var(--text-muted); font-family:var(--font-mono); font-size:0.75rem">${q.txConn}</div>
    <div style="color:var(--text-muted)">${q.timestamp}</div>
    <div style="color:var(--accent); font-weight:600;">${q.duration || '-'}</div>
    <div style="color:var(--text-muted)">${q.cost || '-'}</div>
    <div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${q.sql.replace(/"/g, '&quot;')}">${summary}</div>
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

function renderQueryList(list) {
  const container = document.getElementById('lqe-query-list');
  if (!container) return;

  if (list.length === 0) {
    if (lqeVList) { lqeVList.destroy(); lqeVList = null; }
    container.innerHTML = '<div style="padding:var(--sp-5); text-align:center; color:var(--text-muted); font-size:0.85rem;">No queries found matching criteria.</div>';
    return;
  }

  if (!lqeVList) {
    lqeVList = window.createVirtualList({ container: container, renderRow: lqeRenderRow });
  }
  lqeVList.setItems(list);
}

function selectQuery(q) {
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
  
  runnableSql = runnableSql.replace(/ FROM /gi, '\nFROM ')
                           .replace(/ WHERE /gi, '\nWHERE ')
                           .replace(/ INNER JOIN /gi, '\nINNER JOIN ')
                           .replace(/ LEFT JOIN /gi, '\nLEFT JOIN ')
                           .replace(/ ORDER BY /gi, '\nORDER BY ')
                           .replace(/ GROUP BY /gi, '\nGROUP BY ')
                           .replace(/ LIMIT /gi, '\nLIMIT ')
                           .replace(/ SET /gi, '\nSET ')
                           .replace(/ VALUES /gi, '\nVALUES ');
                           
  const sqlEl = document.getElementById('lqe-sql-content');
  if (window.sqlHighlight) {
    sqlEl.innerHTML = window.sqlHighlight(runnableSql);
  } else {
    sqlEl.textContent = runnableSql;
  }
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
    alert('Select a query that has a logged Query Plan first.');
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
  if (!q || !sql) { alert('Select a query first.'); return; }
  if (q.type && q.type !== 'SELECT') {
    alert('EXPLAIN live runs only on SELECT queries (read-only). This one is a ' + q.type + ' — copy it and analyze it manually.');
    return;
  }
  if (!window.mtDb || !window.mtDb.isConnected()) {
    const bar = document.getElementById('lqe-livedb-bar');
    if (bar) bar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    alert('Connect a live database first — use the "Live database" panel below the plan. Without a connection you can still copy the query and paste its plan into SQL Explain.');
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
      alert('EXPLAIN live failed: ' + ((data && data.message) || 'no plan returned') +
            '\n\nTip: queries with parameter placeholders can\'t be planned directly — copy the query and substitute values, or paste an EXPLAIN plan manually.');
      return;
    }
    window.navigateWithReturn('query-intelligence');
    const tabBtn = document.querySelector('#panel-query-intelligence .tab[data-help-key="query-intelligence-explain"]');
    if (tabBtn && window.qiSetTab) window.qiSetTab('explain', tabBtn);
    const input = document.getElementById('sql-explain-input');
    if (input) input.value = data.plan;
    if (window.visualizeSqlExplain) window.visualizeSqlExplain();
  } catch (e) {
    alert('EXPLAIN live failed: ' + e.message);
  } finally {
    if (btn && oldHtml !== null) { btn.disabled = false; btn.innerHTML = oldHtml; }
  }
};

// ── Export of the currently filtered list ──────────────────
// Columns: Type, Tx-Conn, Timestamp, Duration, Cost, Rows, Dup, SQL (truncated)
function lqeExportRows(sqlMaxLen) {
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

// Exports go through the shared helper (window.mtExport) so quoting/escaping and
// the self-contained HTML template live in one place across tools.
window.lqeExportCsv = function() {
  if (lqeLastFiltered.length === 0) {
    alert('Nothing to export — load a log first (and check the active filters).');
    return;
  }
  window.mtExport.downloadCsv('extracted-queries.csv', LQE_EXPORT_HEADER, lqeExportRows(300));
};

window.lqeCopyMarkdown = function(btn) {
  if (lqeLastFiltered.length === 0) {
    alert('Nothing to copy — load a log first (and check the active filters).');
    return;
  }
  window.mtExport.copyMarkdown(LQE_EXPORT_HEADER, lqeExportRows(120), btn);
};

window.lqeExportHtml = function() {
  if (lqeLastFiltered.length === 0) {
    alert('Nothing to export — load a log first (and check the active filters).');
    return;
  }
  const rows = lqeExportRows(2000);
  window.mtExport.downloadHtml('extracted-queries.html', {
    title: 'Extracted SQL Queries',
    subtitle: 'MxDev Swiss Tool — Log Query Extractor',
    meta: [
      { label: 'Source', value: lqeSourceFormat === 'live' ? 'Mendix Cloud live log' : (lqeSourceFormat === 'csv' ? 'Studio Pro CSV export' : 'log') },
      { label: 'Queries', value: rows.length }
    ],
    columns: LQE_EXPORT_HEADER,
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
  const rows = inWin.map(function (q) {
    const ms = tsToMs(q.timestamp);
    if (!isNaN(ms)) { if (ms < firstMs) firstMs = ms; if (ms > lastMs) lastMs = ms; }
    let sql = q.sql.replace(/\s+/g, ' ').trim();
    if (sql.length > 2000) sql = sql.substring(0, 2000) + '…';
    return [
      q.type + (q.slowWarning ? ' (SLOW warning)' : ''), q.txConn, q.timestamp,
      q.duration ? parseFloat(q.duration) : '',
      (q.cost !== null && q.cost !== undefined) ? q.cost : '',
      q.rows !== '-' ? q.rows : '', q.dupCount > 1 ? '×' + q.dupCount : '', sql
    ];
  });
  return {
    id: 'log-query-extractor', title: 'Log Query Extractor — SQL queries',
    subtitle: rows.length + ' quer' + (rows.length === 1 ? 'y' : 'ies') + (lqeSourceFormat === 'live' ? ' (Mendix Cloud live log)' : (lqeSourceFormat === 'csv' ? ' (Studio Pro CSV)' : '')),
    columns: LQE_EXPORT_HEADER, rows: rows, total: rows.length,
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

// Expose the pure extractor for unit tests (Node points `window` at the global).
(typeof window !== 'undefined' ? window : self).lqeExtractQueries = lqeExtractQueries;
