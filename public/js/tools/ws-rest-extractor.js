// REST & Web Service Extractor - Mendix integration log analyzer (wave 4)
// Rebuilds outgoing and incoming HTTP/SOAP calls from `REST Consume`,
// `REST Publish` and `WebServices` TRACE records produced by the shared parser
// (mendix-log-parser.js). Requests and responses are paired FIFO per
// (log node + method + URL); overlapping in-flight calls with the same key get
// an `uncertain` flag because FIFO is an assumption, not a logged fact.
// A `CallRest`/`CallWebservice` MicroflowEngine TRACE activity logged just
// before a consume block anchors the call to its correlation ID and microflow —
// that is what links a REST call back to the Microflow Tracer and, via the time
// window, to the SQL in the Log Query Extractor.

let wsreCalls = [];
let wsreLastFiltered = [];
let wsreWorker = null;
let wsreVList = null;
let wsreRawText = null; // kept for the MFT/LQE cross-link hand-off (same file, one load)
const WSRE_WORKER_THRESHOLD = 2 * 1024 * 1024;

// RFC 7230 token characters — a continuation line is a header only if it looks
// like `Name: value` with a space-free token name (JSON/XML/prose lines don't).
const WSRE_HEADER_RE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):\s?(.*)$/;
const WSRE_ANCHOR_WINDOW_MS = 10000; // CallRest fires ~2 ms before the block; 10 s drops stale anchors

// Timestamp → epoch ms (same two formats the shared parser emits; local copy so
// the extractor stays self-contained for Node tests and has no load-order dependency).
function wsreTsToMs(ts) {
  if (!ts) return NaN;
  let m = ts.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (m) {
    const base = Date.parse(m[1] + 'T' + m[2] + ':' + m[3] + ':' + m[4] + 'Z');
    const frac = m[5] ? parseFloat('0.' + m[5]) * 1000 : 0;
    return base + frac;
  }
  m = ts.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    return Date.parse(m[3] + '-' + m[1] + '-' + m[2] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + 'Z');
  }
  return NaN;
}

// Continuation lines of a Request/Response record → { status, statusText, headers, body }.
// The live-log parser drops blank lines, so the header/body boundary is detected by
// shape: the first line that doesn't look like `Name: value` starts the body.
function wsreParseHttpBlock(lines, start, expectStatus) {
  let i = start;
  while (i < lines.length && !lines[i].trim()) i++;
  let status = null;
  let statusText = '';
  if (expectStatus && i < lines.length) {
    const sm = lines[i].match(/^HTTP\/[\d.]+\s+(\d{3})\s*(.*)$/);
    if (sm) { status = parseInt(sm[1], 10); statusText = sm[2].trim(); i++; }
  }
  const headers = [];
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; break; } // explicit separator (CSV export keeps blank lines)
    const hm = line.match(WSRE_HEADER_RE);
    if (!hm) break;
    headers.push({ name: hm[1], value: hm[2] });
    i++;
  }
  return { status: status, statusText: statusText, headers: headers, body: lines.slice(i).join('\n').trim() };
}

function wsreNewCall(rec, ri, node, direction, kind) {
  return {
    id: 0,
    node: node,
    direction: direction, // 'out' = app calls external service, 'in' = external client calls app
    kind: kind,           // 'rest' | 'soap'
    method: '',
    url: '',
    service: null,        // WS publish: published service name
    operation: null,      // publish: matched operation; SOAP: SOAPAction / response operation
    clientIp: null,
    status: null,
    statusText: '',
    requestHeaders: [],
    responseHeaders: [],
    requestBody: '',
    responseBody: '',
    timeoutSec: null,
    startTs: rec.timestamp,
    startMs: wsreTsToMs(rec.timestamp),
    endTs: null,
    durationMs: null,
    uncertain: false,
    timeoutSuspect: false,
    corrId: null,
    microflow: null,
    _recIdx: ri
  };
}

// Pure extraction over shared-parser records — no DOM, testable in Node.
function wsreExtractCalls(records) {
  const calls = [];
  const pendingOut = new Map();    // node|method|url -> FIFO of consume calls awaiting a response
  const openPublish = [];          // REST Publish incoming awaiting Outgoing response / 404 (FIFO)
  const openWsIn = [];             // WebServices incoming awaiting Finished (FIFO)
  const anchors = { rest: [], soap: [] }; // CallRest / CallWebservice activities not yet claimed
  const clientTimeouts = new Map();       // node|host -> timeout seconds from "Creating http client"

  for (let ri = 0; ri < records.length; ri++) {
    const rec = records[ri];
    const node = rec.logNode;
    const msg = rec.message;

    if (node === 'MicroflowEngine') {
      const isRest = msg.indexOf('"type":"CallRest"') !== -1;
      if (!isRest && msg.indexOf('"type":"CallWebservice"') === -1) continue;
      const am = msg.match(/^\[([^\]\s]+)\]\s+Executing activity:\s*(\{[\s\S]*)$/);
      if (!am) continue;
      let name = null;
      try { name = JSON.parse(am[2]).name || null; } catch (e) { /* truncated JSON */ }
      anchors[isRest ? 'rest' : 'soap'].push({ corrId: am[1], microflow: name, ms: wsreTsToMs(rec.timestamp) });
      continue;
    }

    if (node !== 'REST Consume' && node !== 'REST Publish' && node !== 'WebServices') continue;

    const lines = msg.split('\n');
    const first = lines[0];
    let m;

    // ── Outgoing (consume) side: REST Consume + WebServices client calls ──────
    m = first.match(/^Creating http client for (\S+) with timeout = (\d+)s/);
    if (m) {
      clientTimeouts.set(node + '|' + m[1], parseInt(m[2], 10));
      continue;
    }

    m = first.match(/^Request content for (\S+) request to (\S+?)(?:\s+HTTP\/[\d.]+)?$/);
    if (m) {
      const call = wsreNewCall(rec, ri, node, 'out', node === 'WebServices' ? 'soap' : 'rest');
      call.method = m[1];
      call.url = m[2];
      const parsed = wsreParseHttpBlock(lines, 1, false);
      call.requestHeaders = parsed.headers;
      call.requestBody = parsed.body;
      const soapAction = parsed.headers.find(h => h.name.toLowerCase() === 'soapaction');
      if (soapAction) call.operation = soapAction.value.replace(/^"|"$/g, '').replace(/^urn:/, '');
      const hostMatch = call.url.match(/^[a-z][a-z0-9+.-]*:\/\/([^\/:?#]+)/i);
      if (hostMatch && clientTimeouts.has(node + '|' + hostMatch[1])) {
        call.timeoutSec = clientTimeouts.get(node + '|' + hostMatch[1]);
      }
      // Claim the oldest fresh CallRest/CallWebservice anchor (FIFO — one anchor, one call)
      const aq = anchors[call.kind];
      while (aq.length && !isNaN(call.startMs) && call.startMs - aq[0].ms > WSRE_ANCHOR_WINDOW_MS) aq.shift();
      if (aq.length && aq[0].ms <= call.startMs) {
        const a = aq.shift();
        call.corrId = a.corrId;
        call.microflow = a.microflow;
      }
      const qk = node + '|' + call.method + '|' + call.url;
      let q = pendingOut.get(qk);
      if (!q) { q = []; pendingOut.set(qk, q); }
      if (q.length) { call.uncertain = true; q.forEach(c => { c.uncertain = true; }); }
      q.push(call);
      calls.push(call);
      continue;
    }

    m = first.match(/^Response content for (\S+) request to (\S+)$/);
    if (m) {
      const q = pendingOut.get(node + '|' + m[1] + '|' + m[2]);
      if (q && q.length) {
        const call = q.shift();
        const parsed = wsreParseHttpBlock(lines, 1, true);
        call.status = parsed.status;
        call.statusText = parsed.statusText;
        call.responseHeaders = parsed.headers;
        call.responseBody = parsed.body;
        call.endTs = rec.timestamp;
        const endMs = wsreTsToMs(rec.timestamp);
        if (!isNaN(endMs) && !isNaN(call.startMs)) call.durationMs = endMs - call.startMs;
      }
      continue;
    }

    // ── Incoming (publish) side: REST Publish ─────────────────────────────────
    if (node === 'REST Publish') {
      m = first.match(/^Incoming request from (\S+): (\S+) (\S+)$/);
      if (m) {
        const call = wsreNewCall(rec, ri, node, 'in', 'rest');
        call.clientIp = m[1];
        call.method = m[2];
        call.url = m[3];
        const parsed = wsreParseHttpBlock(lines, 1, false);
        call.requestHeaders = parsed.headers;
        call.requestBody = parsed.body;
        if (openPublish.length) { call.uncertain = true; openPublish.forEach(c => { c.uncertain = true; }); }
        openPublish.push(call);
        calls.push(call);
        continue;
      }
      m = first.match(/^Executing operation (\S+)\s+(\S+)$/);
      if (m) {
        const call = openPublish.find(c => !c.operation);
        if (call) call.operation = m[2];
        continue;
      }
      m = first.match(/^Responding with (\d{3})\s*([^,]*), because no operation matches (\S+)/);
      if (m) {
        const idx = openPublish.findIndex(c => c.url === m[3]);
        if (idx !== -1) {
          const call = openPublish.splice(idx, 1)[0];
          call.status = parseInt(m[1], 10);
          call.statusText = m[2].trim();
          call.responseBody = first;
          call.endTs = rec.timestamp;
          const endMs = wsreTsToMs(rec.timestamp);
          if (!isNaN(endMs) && !isNaN(call.startMs)) call.durationMs = endMs - call.startMs;
        }
        continue;
      }
      if (/^Outgoing response:/.test(first)) {
        const call = openPublish.shift();
        if (call) {
          const parsed = wsreParseHttpBlock(lines, 1, true);
          call.status = parsed.status;
          call.statusText = parsed.statusText;
          call.responseHeaders = parsed.headers;
          call.responseBody = parsed.body;
          call.endTs = rec.timestamp;
          const endMs = wsreTsToMs(rec.timestamp);
          if (!isNaN(endMs) && !isNaN(call.startMs)) call.durationMs = endMs - call.startMs;
        }
        continue;
      }
      continue; // routing/query-parameter noise
    }

    // ── Incoming (publish) side: WebServices (SOAP) ───────────────────────────
    if (node === 'WebServices') {
      m = first.match(/^Incoming web service request from (\S+) for service '([^']+)'/);
      if (m) {
        const call = wsreNewCall(rec, ri, node, 'in', 'soap');
        call.clientIp = m[1];
        call.method = 'POST';
        call.service = m[2];
        if (openWsIn.length) { call.uncertain = true; openWsIn.forEach(c => { c.uncertain = true; }); }
        openWsIn.push(call);
        calls.push(call);
        continue;
      }
      m = msg.match(/^Incoming web service request data:\s*([\s\S]*)$/);
      if (m) {
        const call = openWsIn[openWsIn.length - 1]; // data record immediately follows its Incoming record
        if (call && !call.requestBody) call.requestBody = m[1].trim();
        continue;
      }
      m = msg.match(/^Header ([!#$%&'*+.^_`|~0-9A-Za-z-]+):\s?([\s\S]*)$/);
      if (m) {
        const call = openWsIn[openWsIn.length - 1];
        if (call) call.requestHeaders.push({ name: m[1], value: m[2] });
        continue;
      }
      m = msg.match(/^\[(\S+) chunk: \d+\]\s*([\s\S]*)$/);
      if (m) {
        const call = openWsIn[0]; // responses stream for the oldest in-flight request
        if (call) {
          if (!call.operation) call.operation = m[1];
          call.responseBody += m[2];
        }
        continue;
      }
      m = first.match(/^Finished handling web service request for service '([^']+)'/);
      if (m) {
        const idx = openWsIn.findIndex(c => c.service === m[1]);
        if (idx !== -1) {
          const call = openWsIn.splice(idx, 1)[0];
          call.endTs = rec.timestamp;
          const endMs = wsreTsToMs(rec.timestamp);
          if (!isNaN(endMs) && !isNaN(call.startMs)) call.durationMs = endMs - call.startMs;
          call.statusText = /:Fault>|<Fault>/i.test(call.responseBody) ? 'SOAP Fault' : 'OK';
        }
        continue;
      }
      continue;
    }
  }

  // Post-pass: unanswered calls — an outgoing request with a known client timeout
  // and no logged response is the classic client-timeout signature.
  let uncertain = 0;
  let unanswered = 0;
  let errors = 0;
  for (const call of calls) {
    if (call.uncertain) uncertain++;
    if (call.endTs === null) {
      unanswered++;
      if (call.direction === 'out' && call.timeoutSec !== null) call.timeoutSuspect = true;
    }
    if ((call.status !== null && call.status >= 400) || call.statusText === 'SOAP Fault') errors++;
  }

  let sum = 0, timed = 0, maxMs = -1, maxId = null;
  for (const call of calls) {
    if (call.durationMs !== null && !isNaN(call.durationMs)) {
      sum += call.durationMs;
      timed++;
      if (call.durationMs > maxMs) { maxMs = call.durationMs; maxId = call.id; }
    }
  }

  calls.forEach((c, i) => { c.id = i; });
  if (maxId !== null) maxId = calls.findIndex(c => c.durationMs === maxMs);

  return {
    calls: calls,
    stats: {
      total: calls.length,
      uncertain: uncertain,
      unanswered: unanswered,
      errors: errors,
      timedCount: timed,
      totalMs: sum,
      maxMs: maxMs,
      maxId: maxId
    }
  };
}

// Expose the pure parts for Node tests (scripts/parser-test.js)
(typeof window !== 'undefined' ? window : self).wsreExtractCalls = wsreExtractCalls;

// ── UI: load / parse ─────────────────────────────────────────────────────────

window.wsreHandleDrop = function(e) {
  e.preventDefault();
  const zone = document.getElementById('wsre-call-list');
  if (zone) zone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files).filter(f => {
    const fn = f.name.toLowerCase();
    return fn.endsWith('.log') || fn.endsWith('.txt') || fn.endsWith('.csv') || f.type === 'text/plain' || f.type === 'text/csv' || f.type === '';
  });
  if (files.length) window.wsreLoadFile(files);
};

window.wsreLoadFile = function(files) {
  if (!files || files.length === 0) return;
  const reader = new FileReader();
  if (window.showLoader) window.showLoader('Reading log file...');
  reader.onload = function(e) {
    const text = e.target.result;
    setTimeout(() => wsreParseText(text), 50);
  };
  reader.readAsText(files[0]);
};

window.wsreLoadText = function(text) {
  wsreParseText(text);
};

function wsreParseText(text) {
  if (window.showLoader) window.showLoader('Parsing REST/WS calls...', 5);
  wsreRawText = text;
  if (text.length >= WSRE_WORKER_THRESHOLD && typeof Worker !== 'undefined' && window.createMendixLogParser) {
    wsreParseInWorker(text);
  } else {
    setTimeout(() => {
      try {
        wsreApplyParseResult(window.createMendixLogParser().parse(text));
      } catch (err) {
        console.error('WSRE parse failed:', err);
        if (window.hideLoader) window.hideLoader();
        alert('Could not parse this log: ' + err.message);
      }
    }, 20);
  }
}

// Same worker technique as LQE/MFT: the shared parser factory is self-contained,
// so its .toString() is a complete worker program. Falls back to the main thread.
function wsreParseInWorker(text) {
  if (wsreWorker) { wsreWorker.terminate(); wsreWorker = null; }
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
    wsreWorker = worker;
  } catch (err) {
    console.warn('WSRE worker unavailable, parsing on main thread:', err);
    wsreApplyParseResult(window.createMendixLogParser().parse(text));
    return;
  }
  worker.onmessage = function(msg) {
    const d = msg.data;
    if (d.type === 'progress') {
      if (window.showLoader) window.showLoader(d.phase || ('Parsing… ' + d.progress + '%'), d.progress);
    } else if (d.type === 'complete') {
      worker.terminate();
      if (wsreWorker === worker) wsreWorker = null;
      if (window.showLoader) window.showLoader('Pairing requests…', 99);
      setTimeout(() => wsreApplyParseResult({ records: d.records }), 20);
    }
  };
  worker.onerror = function(err) {
    console.warn('WSRE worker error, parsing on main thread:', err.message || err);
    worker.terminate();
    if (wsreWorker === worker) wsreWorker = null;
    wsreApplyParseResult(window.createMendixLogParser().parse(text));
  };
  worker.postMessage({ text: text });
}

function wsreApplyParseResult(res) {
  const out = wsreExtractCalls(res.records);
  wsreCalls = out.calls;
  window._wsreStats = out.stats;

  const noteEl = document.getElementById('wsre-note');
  if (noteEl) {
    if (wsreCalls.length === 0) {
      noteEl.style.display = '';
      noteEl.textContent = ' · no REST/WS records';
      noteEl.title = 'The log has no REST Consume / REST Publish / WebServices TRACE lines. Set those log nodes to TRACE and reproduce the scenario.';
    } else {
      noteEl.style.display = 'none';
      noteEl.textContent = '';
    }
  }

  window.wsreFilter();
  if (window.hideLoader) window.hideLoader();
}

// ── UI: filtering / sorting / stats ──────────────────────────────────────────

let wsreSortKey = null;
let wsreSortDir = -1;

const WSRE_SORT_ACCESSORS = {
  time: c => c._recIdx,
  duration: c => (c.durationMs !== null && !isNaN(c.durationMs) ? c.durationMs : -1),
  status: c => (c.status !== null ? c.status : -1)
};

window.wsreSort = function(key) {
  if (wsreSortKey === key) {
    wsreSortDir = -wsreSortDir;
  } else {
    wsreSortKey = key;
    wsreSortDir = key === 'time' ? 1 : -1;
  }
  document.querySelectorAll('#wsre-list-header [data-sort-key]').forEach(el => {
    const arrow = el.querySelector('.wsre-sort-arrow');
    if (!arrow) return;
    arrow.textContent = (el.getAttribute('data-sort-key') === wsreSortKey) ? (wsreSortDir === 1 ? ' ▲' : ' ▼') : '';
  });
  window.wsreFilter();
};

function wsreIsError(c) {
  return (c.status !== null && c.status >= 400) || c.statusText === 'SOAP Fault';
}

// Human label for the endpoint cell: URL for HTTP calls, service (operation) for WS publish
function wsreEndpoint(c) {
  if (c.service) return c.service + (c.operation ? ' → ' + c.operation : '');
  return c.url || '';
}

window.wsreFilter = function() {
  const searchEl = document.getElementById('wsre-search');
  const search = searchEl ? searchEl.value.toLowerCase() : '';
  const typeFilterEl = document.getElementById('wsre-type-filter');
  const typeFilter = typeFilterEl ? typeFilterEl.value : 'ALL';
  const slowOnlyEl = document.getElementById('wsre-slow-only');
  const slowOnly = slowOnlyEl ? slowOnlyEl.checked : false;
  const slowMsEl = document.getElementById('wsre-slow-ms');
  const slowMs = slowMsEl ? (parseFloat(slowMsEl.value) || 0) : 0;

  const filtered = wsreCalls.filter(c => {
    if (typeFilter === 'OUT' && c.direction !== 'out') return false;
    if (typeFilter === 'IN' && c.direction !== 'in') return false;
    if (typeFilter === 'REST' && c.kind !== 'rest') return false;
    if (typeFilter === 'SOAP' && c.kind !== 'soap') return false;
    if (typeFilter === 'ERR' && !wsreIsError(c) && c.endTs !== null) return false;
    if (typeFilter === 'UNC' && !c.uncertain) return false;
    if (slowOnly) {
      const d = c.durationMs !== null ? c.durationMs : NaN;
      if (isNaN(d) || d <= slowMs) return false;
    }
    if (search) {
      const hay = (wsreEndpoint(c) + ' ' + c.method + ' ' + (c.microflow || '') + ' ' + (c.corrId || '') + ' ' + (c.status || '')).toLowerCase();
      if (hay.indexOf(search) === -1) return false;
    }
    return true;
  });

  if (wsreSortKey && WSRE_SORT_ACCESSORS[wsreSortKey]) {
    const acc = WSRE_SORT_ACCESSORS[wsreSortKey];
    filtered.sort((a, b) => (acc(a) - acc(b)) * wsreSortDir);
  }

  const countEl = document.getElementById('wsre-count');
  if (countEl) countEl.textContent = filtered.length;
  wsreLastFiltered = filtered;
  wsreUpdateStats(filtered);
  wsreRenderList(filtered);
};

function wsreFmtMs(ms) {
  if (ms >= 10000) return (ms / 1000).toFixed(1) + ' s';
  if (ms >= 100) return Math.round(ms) + ' ms';
  return ms.toFixed(2) + ' ms';
}

function wsreUpdateStats(filtered) {
  const bar = document.getElementById('wsre-stats');
  if (!bar) return;
  if (wsreCalls.length === 0) {
    bar.style.display = 'none';
    window._wsreSlowestId = null;
    return;
  }
  bar.style.display = 'flex';

  let sum = 0, timed = 0, slowest = null, slowestMs = -1, errors = 0, unanswered = 0, uncertain = 0;
  for (const c of filtered) {
    if (c.durationMs !== null && !isNaN(c.durationMs)) {
      sum += c.durationMs;
      timed++;
      if (c.durationMs > slowestMs) { slowestMs = c.durationMs; slowest = c; }
    }
    if (wsreIsError(c)) errors++;
    if (c.endTs === null) unanswered++;
    if (c.uncertain) uncertain++;
  }

  document.getElementById('wsre-stat-total').textContent = filtered.length;
  document.getElementById('wsre-stat-avg').textContent = timed ? wsreFmtMs(sum / timed) : '–';
  document.getElementById('wsre-stat-slowest').textContent = slowest ? wsreFmtMs(slowestMs) : '–';
  document.getElementById('wsre-stat-errors').textContent = errors;
  document.getElementById('wsre-stat-unanswered').textContent = unanswered;
  document.getElementById('wsre-stat-uncertain').textContent = uncertain;
  window._wsreSlowestId = slowest ? slowest.id : null;
}

window.wsreSelectSlowest = function() {
  if (window._wsreSlowestId === null || !wsreVList) return;
  const idx = wsreVList.indexOf(c => c.id === window._wsreSlowestId);
  if (idx < 0) return;
  window._wsreActiveId = window._wsreSlowestId;
  wsreVList.scrollToIndex(idx, 'center');
  wsreVList.refresh();
  wsreSelectCall(wsreVList.itemAt(idx));
};

// ── UI: list rendering (virtual list, same component as LQE) ─────────────────

const WSRE_NODE_BADGES = {
  'rest|out': { label: 'REST →', color: '#3498db', title: 'REST Consume — this app calling an external REST API' },
  'rest|in':  { label: 'REST ←', color: '#2ecc71', title: 'REST Publish — an external client calling this app' },
  'soap|out': { label: 'SOAP →', color: '#9b59b6', title: 'WebServices — this app calling an external SOAP service' },
  'soap|in':  { label: 'SOAP ←', color: '#e67e22', title: 'WebServices — an external client calling a published SOAP service' }
};

function wsreRowSelected(c) {
  return window._wsreActiveId != null && c.id === window._wsreActiveId;
}

function wsreStatusHtml(c) {
  if (c.status !== null) {
    let color = 'var(--success)';
    if (c.status >= 500) color = 'var(--danger)';
    else if (c.status >= 400) color = 'var(--warning)';
    else if (c.status >= 300) color = 'var(--info)';
    return '<span style="color:' + color + '; font-weight:600;">' + c.status + '</span>';
  }
  if (c.statusText === 'SOAP Fault') return '<span style="color:var(--danger); font-weight:600;">Fault</span>';
  if (c.statusText === 'OK') return '<span style="color:var(--success); font-weight:600;">OK</span>';
  return '<span style="color:var(--text-muted);" title="No response found in the log for this request">…</span>';
}

function wsreRenderRow(c) {
  const el = document.createElement('div');
  el.className = 'wsre-list-item';
  el.dataset.callid = c.id;
  el.style.display = 'grid';
  el.style.gridTemplateColumns = '96px 76px 62px 56px 76px 1fr';
  el.style.padding = 'var(--sp-2) var(--sp-3)';
  el.style.borderBottom = '1px solid var(--border)';
  el.style.fontSize = '0.8rem';
  el.style.cursor = 'pointer';
  el.style.color = 'var(--text)';
  el.style.background = wsreRowSelected(c) ? 'var(--bg-active)' : 'transparent';

  const badge = WSRE_NODE_BADGES[c.kind + '|' + c.direction];
  const timeShort = (c.startTs || '').replace(/^[^T]*T/, '').substring(0, 12);
  const uncBadge = c.uncertain
    ? '<span title="Another call to the same endpoint was in flight at the same time — request/response pairing is FIFO-based and may be uncertain" style="margin-left:4px;color:var(--warning);cursor:help">⇅</span>'
    : '';
  const toBadge = c.timeoutSuspect
    ? '<span title="No response logged and a client timeout of ' + c.timeoutSec + 's was configured — possible client timeout" style="margin-left:4px;color:var(--danger);cursor:help">⏱</span>'
    : '';
  const endpoint = wsreEndpoint(c);

  el.innerHTML =
    '<div style="color:var(--text-muted); font-family:var(--font-mono); font-size:0.75rem;" title="' + (c.startTs || '') + '">' + timeShort + '</div>' +
    '<div style="font-weight:600; color:' + badge.color + '; white-space:nowrap;" title="' + badge.title + '">' + badge.label + '</div>' +
    '<div style="font-weight:600;">' + c.method + uncBadge + toBadge + '</div>' +
    '<div>' + wsreStatusHtml(c) + '</div>' +
    '<div style="color:var(--accent); font-weight:600;">' + (c.durationMs !== null ? wsreFmtMs(c.durationMs) : '-') + '</div>' +
    '<div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="' + endpoint.replace(/"/g, '&quot;') + '">' + endpoint + '</div>';

  el.onmouseenter = () => { if (!wsreRowSelected(c)) el.style.background = 'var(--bg-hover)'; };
  el.onmouseleave = () => { if (!wsreRowSelected(c)) el.style.background = 'transparent'; };
  el.onclick = () => {
    window._wsreActiveId = c.id;
    if (wsreVList) wsreVList.refresh();
    wsreSelectCall(c);
  };
  return el;
}

function wsreRenderList(list) {
  const container = document.getElementById('wsre-call-list');
  if (!container) return;
  if (list.length === 0) {
    if (wsreVList) { wsreVList.destroy(); wsreVList = null; }
    container.innerHTML = '<div style="padding:var(--sp-5); text-align:center; color:var(--text-muted); font-size:0.85rem;">No calls found matching criteria.</div>';
    return;
  }
  if (!wsreVList) {
    wsreVList = window.createVirtualList({ container: container, renderRow: wsreRenderRow });
  }
  wsreVList.setItems(list);
}

// ── UI: details pane ─────────────────────────────────────────────────────────

window.wsreSetTab = function(tabId, btn) {
  const container = document.getElementById('panel-ws-rest-extractor');
  container.querySelectorAll('.tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
  btn.classList.add('active');
  btn.setAttribute('aria-selected', 'true');
  container.querySelectorAll('#wsre-tab-overview, #wsre-tab-headers, #wsre-tab-request, #wsre-tab-response').forEach(el => {
    el.style.display = 'none';
  });
  document.getElementById(tabId).style.display = 'block';
};

// Pretty-print a payload: JSON via JSON.parse/stringify, XML via the XML
// Formatter's pure serializer (serializeXmlPretty). Falls back to the raw text.
function wsrePretty(text) {
  if (!text) return '';
  const t = text.trim();
  if (t[0] === '{' || t[0] === '[') {
    try { return JSON.stringify(JSON.parse(t), null, 2); } catch (e) { return text; }
  }
  if (t[0] === '<' && typeof DOMParser !== 'undefined' && window.serializeXmlPretty) {
    try {
      const prologMatch = t.match(/^<\?xml[^?]*\?>/i);
      const xml = prologMatch ? t.substring(prologMatch[0].length).trim() : t;
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      if (!doc.querySelector('parsererror')) {
        return (prologMatch ? prologMatch[0] + '\n' : '') + window.serializeXmlPretty(doc.documentElement, 0);
      }
    } catch (e) { /* keep raw */ }
  }
  return text;
}

function wsreHeadersRows(tbodyId, headers) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  if (!headers || headers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="2" style="padding:var(--sp-3); color:var(--text-muted); text-align:center;">No headers logged</td></tr>';
    return;
  }
  tbody.innerHTML = headers.map(h =>
    '<tr style="border-bottom:1px solid var(--border);">' +
    '<td style="padding:var(--sp-2); border-right:1px solid var(--border); font-family:var(--font-mono); white-space:nowrap;">' + window.escHtml(h.name) + '</td>' +
    '<td style="padding:var(--sp-2); font-family:var(--font-mono); word-break:break-all;">' + window.escHtml(h.value) + '</td></tr>'
  ).join('');
}

function wsreSelectCall(c) {
  window._wsreSelectedCall = c;
  const esc = window.escHtml;
  const badge = WSRE_NODE_BADGES[c.kind + '|' + c.direction];

  const rows = [];
  rows.push(['Call', '<span style="font-weight:600; color:' + badge.color + '">' + badge.label + '</span> ' + esc(badge.title)]);
  rows.push(['Method', '<strong>' + esc(c.method) + '</strong>']);
  if (c.url) rows.push(['URL', '<span style="font-family:var(--font-mono); word-break:break-all;">' + esc(c.url) + '</span>']);
  if (c.service) rows.push(['Service', esc(c.service)]);
  if (c.operation) rows.push(['Operation', esc(c.operation)]);
  rows.push(['Status', wsreStatusHtml(c) + (c.statusText && c.statusText !== 'OK' ? ' ' + esc(c.statusText) : '')]);
  rows.push(['Duration', c.durationMs !== null ? '<strong>' + wsreFmtMs(c.durationMs) + '</strong> (request → response timestamp delta)' : '<span style="color:var(--text-muted)">no response found in the log</span>']);
  if (c.timeoutSec !== null) rows.push(['Client timeout', c.timeoutSec + ' s' + (c.timeoutSuspect ? ' — <span style="color:var(--danger)">no response logged, possible client timeout</span>' : '')]);
  if (c.clientIp) rows.push(['Client IP', esc(c.clientIp)]);
  rows.push(['Started', '<span style="font-family:var(--font-mono)">' + esc(c.startTs || '') + '</span>']);
  if (c.endTs) rows.push(['Responded', '<span style="font-family:var(--font-mono)">' + esc(c.endTs) + '</span>']);
  if (c.uncertain) rows.push(['Pairing', '<span style="color:var(--warning)">⇅ uncertain</span> — another call to the same endpoint was in flight; FIFO pairing assumed']);
  if (c.microflow) rows.push(['Microflow', '<span style="font-family:var(--font-mono)">' + esc(c.microflow) + '</span> <span style="color:var(--text-muted)">[' + esc(c.corrId || '') + ']</span> — from the CallRest/CallWebservice activity just before this call']);

  document.getElementById('wsre-overview-content').innerHTML =
    '<table style="width:100%; border-collapse:collapse; font-size:0.85rem;">' +
    rows.map(r =>
      '<tr style="border-bottom:1px solid var(--border);">' +
      '<td style="padding:var(--sp-2); color:var(--text-muted); white-space:nowrap; vertical-align:top; width:120px;">' + r[0] + '</td>' +
      '<td style="padding:var(--sp-2);">' + r[1] + '</td></tr>'
    ).join('') + '</table>';

  const mftBtn = document.getElementById('wsre-btn-mft');
  if (mftBtn) mftBtn.disabled = !c.microflow;
  const lqeBtn = document.getElementById('wsre-btn-lqe');
  if (lqeBtn) lqeBtn.disabled = !c.endTs;

  wsreHeadersRows('wsre-req-headers-body', c.requestHeaders);
  wsreHeadersRows('wsre-resp-headers-body', c.responseHeaders);

  document.getElementById('wsre-request-content').textContent =
    c.requestBody ? wsrePretty(c.requestBody) : 'No request body logged.';
  document.getElementById('wsre-response-content').textContent =
    c.responseBody ? wsrePretty(c.responseBody) : (c.endTs ? 'No response body logged.' : 'No response found in the log for this request.');
}

// ── Cross-links: the microflow → REST → SQL chain ────────────────────────────
// The CallRest/CallWebservice anchor gives the correlation ID + microflow name,
// so a call can jump to its microflow in the Tracer; the [start, end] window
// jumps to the SQL that ran meanwhile in the Log Query Extractor. If the target
// tool is empty, the raw text loaded here is handed over — one file, three tools.

window.wsreShowInMft = function() {
  const c = window._wsreSelectedCall;
  if (!c) { alert('Select a call first.'); return; }
  if (!c.microflow) { alert('This call has no CallRest/CallWebservice anchor — enable MicroflowEngine TRACE to link calls to microflows.'); return; }
  window.navigateWithReturn('microflow-tracer');
  const search = document.getElementById('mft-search');
  if (search) search.value = c.microflow;
  const countEl = document.getElementById('mft-count');
  const hasExecs = countEl && countEl.textContent !== '0 executions';
  if (!hasExecs && wsreRawText && window.mftLoadText) {
    window.mftLoadText(wsreRawText);
  } else if (window.mftFilter) {
    window.mftFilter();
  }
};

window.wsreShowInLqe = function() {
  const c = window._wsreSelectedCall;
  if (!c) { alert('Select a call first.'); return; }
  if (!c.endTs) { alert('This call has no response record — no time window to correlate.'); return; }
  window.navigateWithReturn('log-query-extractor');
  if (window.lqeSetTimeWindow) {
    window.lqeSetTimeWindow(c.startTs, c.endTs, c.method + ' ' + (c.operation || c.service || c.url || ''));
  }
  const countEl = document.getElementById('lqe-count');
  const hasQueries = countEl && countEl.textContent !== '0';
  if (!hasQueries && wsreRawText && window.lqeLoadText) {
    window.lqeLoadText(wsreRawText);
  }
};

// ── Export (currently filtered calls) ────────────────────────────────────────

const WSRE_EXPORT_HEADER = ['Time', 'Node', 'Direction', 'Method', 'Status', 'Duration (ms)', 'Endpoint', 'Microflow', 'Corr ID', 'Flags'];

function wsreExportRows() {
  return wsreLastFiltered.map(c => [
    c.startTs,
    c.node,
    c.direction === 'out' ? 'outgoing' : 'incoming',
    c.method,
    c.status !== null ? c.status : c.statusText,
    (c.durationMs !== null && !isNaN(c.durationMs)) ? +c.durationMs.toFixed(3) : '',
    wsreEndpoint(c),
    c.microflow || '',
    c.corrId || '',
    [c.uncertain ? 'uncertain-pairing' : '', c.timeoutSuspect ? 'timeout-suspect' : ''].filter(Boolean).join(' ')
  ]);
}

window.wsreExportCsv = function() {
  if (wsreLastFiltered.length === 0) { alert('Nothing to export — load a log first (and check the active filters).'); return; }
  const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
  const lines = [WSRE_EXPORT_HEADER.map(esc).join(',')];
  for (const row of wsreExportRows()) lines.push(row.map(esc).join(','));
  window.downloadText(lines.join('\n'), 'rest-ws-calls.csv');
};

window.wsreCopyMarkdown = function(btn) {
  if (wsreLastFiltered.length === 0) { alert('Nothing to copy — load a log first (and check the active filters).'); return; }
  const esc = v => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '| ' + WSRE_EXPORT_HEADER.join(' | ') + ' |',
    '|' + WSRE_EXPORT_HEADER.map(() => '---').join('|') + '|'
  ];
  for (const row of wsreExportRows()) lines.push('| ' + row.map(esc).join(' | ') + ' |');
  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    const oldHtml = btn.innerHTML;
    btn.innerHTML = 'Copied!';
    setTimeout(() => btn.innerHTML = oldHtml, 2000);
  });
};

window.wsreCopyContent = function(elementId, btn) {
  const el = document.getElementById(elementId);
  const text = el ? (el.textContent || el.innerText) : '';
  if (text) {
    navigator.clipboard.writeText(text).then(() => {
      const oldHtml = btn.innerHTML;
      btn.innerHTML = 'Copied!';
      setTimeout(() => btn.innerHTML = oldHtml, 2000);
    });
  }
};

window.wsreClear = function() {
  wsreCalls = [];
  wsreLastFiltered = [];
  wsreRawText = null;
  window._wsreSelectedCall = null;
  window._wsreActiveId = null;
  window._wsreSlowestId = null;
  if (wsreVList) { wsreVList.destroy(); wsreVList = null; }
  const statsBar = document.getElementById('wsre-stats');
  if (statsBar) statsBar.style.display = 'none';
  const noteEl = document.getElementById('wsre-note');
  if (noteEl) { noteEl.style.display = 'none'; noteEl.textContent = ''; }
  document.getElementById('wsre-call-list').innerHTML =
    '<div style="padding:var(--sp-5); text-align:center; color:var(--text-muted); font-size:0.85rem;">' +
    'Drop a log file here or use &ldquo;Load TRACE Log&rdquo;:<br>' +
    '<code>REST Consume</code> / <code>REST Publish</code> / <code>WebServices</code> at TRACE &mdash; paired request/response calls with headers, payloads and timings.</div>';
  document.getElementById('wsre-count').textContent = '0';
  document.getElementById('wsre-overview-content').innerHTML = '<span style="color:var(--text-muted); font-size:0.85rem;">Select a call to see its overview, headers and payloads.</span>';
  wsreHeadersRows('wsre-req-headers-body', []);
  wsreHeadersRows('wsre-resp-headers-body', []);
  document.getElementById('wsre-request-content').textContent = 'Select a call to view its request payload...';
  document.getElementById('wsre-response-content').textContent = 'Select a call to view its response payload...';
  const fileInput = document.getElementById('wsre-file-input');
  if (fileInput) fileInput.value = '';
};
