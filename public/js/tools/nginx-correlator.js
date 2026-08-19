// NGINX (rtr) ↔ APPLICATION LOG TIMELINE CORRELATOR
// ============================================================
// Companion to nginx.js — Fala 25, "Timeline Correlator" tab in the Nginx panel.
//
// Ten real apps' rtr_* files were checked field by field before writing this:
// the Mendix Cloud rtr log carries request/status/timing/UA fields and NOTHING
// that identifies a request across logs (no x-request-id, no echoed [corrId]).
// So a request can only be linked to application runtime activity by TIME
// PROXIMITY, never by identity. Every label here says "matched within ±Nms",
// never "this is the request that triggered it" — do not silently upgrade
// that wording later; it is the whole trust argument for the feature.
//
// Runtime-side events come from TWO sources, not one:
//  1. Correlation-ID groups from window.logExtractCorrelations (log-viewer.js,
//     Fala 20) — spans with flow/node/error context, built from the runtime's
//     own [corrId] marker. Rich, but only present on TRACE/DEBUG records.
//  2. Bare ERROR/WARNING/CRITICAL log lines that carry no [corrId] at all.
// (2) is not a fallback for rare cases — it is the NORM: checked against all
// ten apps in the NewLogs corpus, and every single one runs INFO-and-above
// only, so none of them ever emits a [corrId] anywhere. Building the runtime
// lane from corrId groups alone would make this feature empty-state on every
// real log this tool has ever seen. The two real, verified matches that led
// to this design: an rtr 404 for /wp-login.php at 00:02:55.142369 paired with
// the app log's "404 - file not found for file: wp-login.php" ERROR at
// 00:02:55.139200 (3.2ms apart) — a plain ERROR line, no correlation ID.

window.nxCorrAppLogText = null;
window.nxCorrAppLogFilename = null;
window.nxCorrAppLogRecords = [];
window.nxCorrResult = null;

// ── Pure ──────────────────────────────────────────────────────────────────

// Both the rtr log and the application log write ISO timestamps with
// microsecond fractions and no offset (2026-08-10T00:00:04.812837) — same
// clock, treated as UTC, matching logTsToMs's assumption in log-viewer.js.
function nxCorrTsToMs(ts) {
  if (!ts) return NaN;
  const m = String(ts).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?/);
  if (!m) return NaN;
  const base = Date.parse(m[1] + 'T' + m[2] + 'Z');
  const frac = m[3] ? parseFloat('0.' + m[3]) * 1000 : 0;
  return base + frac;
}

// A [corrId] bracket at the start of the message — same shape log-viewer.js's
// LOG_CORRID_MSG reads. Used only to avoid double-counting: a record already
// summarized inside a corrId group (source 1 below) is not also added as its
// own bare point (source 2).
const NXC_CORRID_MSG = /^\[([^\]\s]{4,64})\]\s/;

// Pure. appLogRecords: window.createMendixLogParser().parse(text).records
// ({level, timestamp, logNode, message}). corrGroups: the .groups array from
// window.logExtractCorrelations(appLogRecords). Returns one flat list of
// runtime "events" to correlate rtr requests against — see the file header
// for why both sources are needed.
function nxCorrBuildRuntimeEvents(appLogRecords, corrGroups) {
  const events = [];

  (corrGroups || []).forEach(function (g) {
    if (isNaN(g.firstMs) || isNaN(g.lastMs)) return;
    events.push({
      kind: 'flow', ms: g.firstMs, msEnd: g.lastMs,
      id: g.id, flow: g.flow, nodes: g.nodes || [], errors: g.errors, warnings: g.warnings, count: g.count
    });
  });

  (appLogRecords || []).forEach(function (r) {
    const level = String(r.level || '').toUpperCase();
    if (level !== 'ERROR' && level !== 'WARN' && level !== 'CRITICAL') return;
    if (NXC_CORRID_MSG.test(String(r.message || ''))) return; // already represented by its group above
    const ms = nxCorrTsToMs(r.timestamp);
    if (isNaN(ms)) return;
    events.push({
      kind: 'entry', ms: ms, msEnd: ms,
      level: level, node: r.logNode || '', message: String(r.message || '').split('\n')[0]
    });
  });

  return events;
}

// Pure. rtrRecords: nginxParseLine() output — needs .rawLine for sub-second
// precision (only the Mendix Cloud KV branch sets it); records without it are
// skipped rather than guessed at. events: nxCorrBuildRuntimeEvents(...) output.
// windowMs: how close in time counts as a match. Each rtr request links to at
// most its nearest event within the window; an event may end up linked from
// more than one request, left visible rather than resolved — resolving it
// would be inventing certainty the data doesn't have.
function nxCorrelate(rtrRecords, events, windowMs) {
  windowMs = typeof windowMs === 'number' && windowMs > 0 ? windowMs : 3000;

  const requests = [];
  (rtrRecords || []).forEach(function (r, i) {
    const ms = nxCorrTsToMs(r.rawLine || r.date);
    if (isNaN(ms)) return;
    requests.push({ ms: ms, status: r.status, method: r.method, url: r.url, time: r.time, ip: r.ip, index: i });
  });
  requests.sort(function (a, b) { return a.ms - b.ms; });

  const evs = (events || []).filter(function (e) { return !isNaN(e.ms) && !isNaN(e.msEnd); });

  const links = [];
  requests.forEach(function (req) {
    let bestIdx = -1, bestDist = Infinity;
    evs.forEach(function (e, i) {
      const dist = (req.ms >= e.ms && req.ms <= e.msEnd) ? 0
        : Math.min(Math.abs(req.ms - e.ms), Math.abs(req.ms - e.msEnd));
      if (dist <= windowMs && dist < bestDist) { bestDist = dist; bestIdx = i; }
    });
    if (bestIdx !== -1) links.push({ reqIndex: req.index, eventIndex: bestIdx, distMs: bestDist });
  });

  return { requests: requests, events: evs, links: links, windowMs: windowMs };
}

window.nxCorrTsToMs = nxCorrTsToMs;
window.nxCorrBuildRuntimeEvents = nxCorrBuildRuntimeEvents;
window.nxCorrelate = nxCorrelate;

// ── DOM: app log input ───────────────────────────────────────────────────

function nxCorrHandleAppLogDrop(e) {
  e.preventDefault();
  const card = document.getElementById('nx-corr-input-card');
  if (card) card.classList.remove('drag-over');
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) nxCorrLoadAppLogFiles(files);
}

function nxCorrLoadAppLogFiles(files) {
  const file = files && files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (ev) { nxCorrLoadAppLogText(String(ev.target.result || ''), file.name); };
  reader.onerror = function () { window.mtToast('Failed to read the file.', 'error'); };
  reader.readAsText(file);
}

function nxCorrLoadAppLogText(text, filename) {
  window.nxCorrAppLogText = text;
  window.nxCorrAppLogFilename = filename || 'app.log';
  const input = document.getElementById('nx-corr-app-log-input');
  if (input) {
    input.value = '[File loaded: ' + window.nxCorrAppLogFilename + ']\nSize: ' +
      (text.length / 1024 / 1024).toFixed(2) + ' MB\n\nClick Correlate to run.';
  }
  window.mtToast('Application log loaded (' + window.nxCorrAppLogFilename + ').', 'success');
}

window.nxCorrHandleAppLogDrop = nxCorrHandleAppLogDrop;
window.nxCorrLoadAppLogFiles = nxCorrLoadAppLogFiles;

// ── DOM: run + render ────────────────────────────────────────────────────

function nxCorrJsAttr(s) {
  // Two-stage escape (JS string literal, then the HTML attribute it sits
  // inside) — the same shape as logInsightsAttr in log-viewer.js, added
  // there after a raw quote from SQL broke an onclick attribute (Fala 15).
  return "'" + String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') + "'";
}

function nxCorrStatusClass(status) {
  if (status >= 500) return 'nxc-dot-5xx';
  if (status >= 400) return 'nxc-dot-4xx';
  if (status >= 300) return 'nxc-dot-3xx';
  return 'nxc-dot-2xx';
}

function nxCorrEventLabel(e) {
  if (e.kind === 'flow') {
    return e.id + (e.flow ? ' — ' + e.flow : '') + ' · ' + e.count + ' entries · ' + e.errors + ' errors, ' + e.warnings + ' warnings';
  }
  return '[' + e.level + '] ' + (e.node ? e.node + ': ' : '') + e.message;
}

function nxCorrRun() {
  const rtr = window.nginxParsedLogs || [];
  if (!rtr.length) {
    window.mtToast('Load and analyze an rtr (access) log in the Access Log tab first.', 'warning');
    return;
  }

  const input = document.getElementById('nx-corr-app-log-input');
  if (input && input.value && !input.value.startsWith('[File loaded:') && input.value.trim()) {
    window.nxCorrAppLogText = input.value;
    if (!window.nxCorrAppLogFilename) window.nxCorrAppLogFilename = 'pasted.log';
  }
  const appText = window.nxCorrAppLogText;
  if (!appText || !appText.trim()) {
    window.mtToast('Paste or load an application runtime log to correlate against.', 'warning');
    return;
  }
  if (!window.createMendixLogParser || !window.logExtractCorrelations) {
    window.mtToast('Correlator dependencies did not load. Reload the page.', 'error');
    return;
  }

  showLoader('Correlating...');
  setTimeout(function () {
    try {
      const parsed = window.createMendixLogParser().parse(appText);
      window.nxCorrAppLogRecords = parsed.records || [];
      const corr = window.logExtractCorrelations(window.nxCorrAppLogRecords);
      const events = nxCorrBuildRuntimeEvents(window.nxCorrAppLogRecords, corr.groups);
      const windowInput = document.getElementById('nx-corr-window-ms');
      const windowMs = windowInput ? (parseInt(windowInput.value, 10) || 3000) : 3000;
      const result = nxCorrelate(rtr, events, windowMs);
      window.nxCorrResult = result;
      nxCorrRender(result);
    } catch (e) {
      console.error('Correlation failed', e);
      window.mtToast('Correlation failed: ' + e.message, 'error');
    } finally {
      hideLoader();
    }
  }, 50);
}

function nxCorrClear() {
  window.nxCorrAppLogText = null;
  window.nxCorrAppLogFilename = null;
  window.nxCorrAppLogRecords = [];
  window.nxCorrResult = null;
  const input = document.getElementById('nx-corr-app-log-input');
  if (input) input.value = '';
  const out = document.getElementById('nx-corr-output');
  if (out) out.innerHTML = '';
  const summary = document.getElementById('nx-corr-summary');
  if (summary) summary.style.display = 'none';
}

// Data-driven: nothing loaded → no swimlane shell, only a message that says
// what is missing and how to fix it (project rule — no empty tables/charts).
function nxCorrRender(result) {
  const summary = document.getElementById('nx-corr-summary');
  const out = document.getElementById('nx-corr-output');
  if (!out) return;

  if (!result.requests.length) {
    if (summary) summary.style.display = 'none';
    out.innerHTML = '<div style="padding:var(--sp-4);color:var(--warning);font-size:0.85rem">No rtr requests had a parseable timestamp. This needs the Mendix Cloud rtr format loaded in the Access Log tab (the classic combined-log format has no sub-second timestamp to correlate with).</div>';
    return;
  }
  if (!result.events.length) {
    if (summary) summary.style.display = 'none';
    out.innerHTML = '<div style="padding:var(--sp-4);color:var(--warning);font-size:0.85rem">No ERROR/WARNING lines or correlation IDs found in the application log — nothing to place on the runtime lane. Check the log level and that this is a Cloud runtime log rather than an access log.</div>';
    return;
  }

  const matchedReqIdx = {};
  const matchedEventIdx = {};
  result.links.forEach(function (l) { matchedReqIdx[l.reqIndex] = true; matchedEventIdx[l.eventIndex] = true; });

  if (summary) {
    summary.style.display = 'flex';
    summary.innerHTML =
      '<div class="stat-item stat-item-info"><div class="stat-label">rtr requests (timed)</div><div class="stat-value">' + result.requests.length + '</div></div>' +
      '<div class="stat-item stat-item-accent"><div class="stat-label">Runtime events (flows + errors/warnings)</div><div class="stat-value">' + result.events.length + '</div></div>' +
      '<div class="stat-item stat-item-success"><div class="stat-label">Matched within &plusmn;' + result.windowMs + 'ms</div><div class="stat-value">' + result.links.length + '</div></div>';
  }

  if (!result.links.length) {
    out.innerHTML = '<div style="padding:var(--sp-4);color:var(--warning);font-size:0.85rem">Found ' + result.requests.length + ' rtr requests and ' + result.events.length +
      ' runtime events, but none fell within &plusmn;' + result.windowMs +
      'ms of each other. Widen the match window, or check that the two files actually cover overlapping time (same dates, same clock).</div>';
    return;
  }

  const allMs = result.requests.map(function (r) { return r.ms; })
    .concat(result.events.map(function (e) { return e.ms; }))
    .concat(result.events.map(function (e) { return e.msEnd; }));
  const t0 = Math.min.apply(null, allMs);
  const t1 = Math.max.apply(null, allMs);
  const span = Math.max(t1 - t0, 1);
  const pct = function (ms) { return ((ms - t0) / span) * 100; };

  let html = '<div class="nxc-swimlane">';
  html += '<div class="nxc-lane-label">rtr requests</div><div class="nxc-lane">';
  result.requests.forEach(function (r) {
    const matched = !!matchedReqIdx[r.index];
    html += '<div class="nxc-dot ' + nxCorrStatusClass(r.status) + (matched ? ' nxc-matched' : '') +
      '" style="left:' + pct(r.ms).toFixed(3) + '%" title="' +
      escHtml(new Date(r.ms).toISOString().slice(11, 23) + '  ' + r.method + ' ' + r.url + ' -> ' + r.status + (matched ? ' (matched)' : ' (no match in window)')) + '"></div>';
  });
  html += '</div>';

  html += '<div class="nxc-lane-label">Runtime activity (flows + errors/warnings)</div><div class="nxc-lane">';
  result.events.forEach(function (e, i) {
    const matched = !!matchedEventIdx[i];
    const left = pct(e.ms);
    const title = escHtml(nxCorrEventLabel(e) + (matched ? ' (matched)' : ' (no rtr match in window)'));
    if (e.kind === 'flow') {
      const width = Math.max(pct(e.msEnd) - left, 0.3);
      const cls = e.errors ? 'nxc-bar-err' : (e.warnings ? 'nxc-bar-warn' : 'nxc-bar-ok');
      html += '<div class="nxc-bar ' + cls + (matched ? ' nxc-matched' : '') +
        '" style="left:' + left.toFixed(3) + '%;width:' + width.toFixed(3) + '%" title="' + title + '"></div>';
    } else {
      const cls = e.level === 'ERROR' || e.level === 'CRITICAL' ? 'nxc-dot-5xx' : 'nxc-dot-4xx';
      html += '<div class="nxc-dot ' + cls + (matched ? ' nxc-matched' : '') +
        '" style="left:' + left.toFixed(3) + '%" title="' + title + '"></div>';
    }
  });
  html += '</div></div>';

  html += '<div class="card" style="margin-top:var(--sp-4)"><div class="card-header"><span style="font-weight:600">Matches — closest in time first</span></div>' +
    '<div class="card-body" style="padding:0;overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:0.8rem">' +
    '<thead style="background:var(--bg-elevated);border-bottom:1px solid var(--border);text-align:left"><tr>' +
    '<th style="padding:var(--sp-2)">rtr request</th><th style="padding:var(--sp-2)">Status</th>' +
    '<th style="padding:var(--sp-2)">Runtime event</th><th style="padding:var(--sp-2)">&Delta;t</th><th style="padding:var(--sp-2)"></th>' +
    '</tr></thead><tbody>';

  const rows = result.links.slice().sort(function (a, b) { return a.distMs - b.distMs; }).slice(0, 500);
  rows.forEach(function (l) {
    const req = result.requests[l.reqIndex];
    const e = result.events[l.eventIndex];
    if (!req || !e) return;
    const shortUrl = req.url.length > 48 ? req.url.slice(0, 48) + '…' : req.url;
    const openBtn = e.kind === 'flow'
      ? '<button class="btn btn-secondary btn-sm" onclick="window.nxCorrOpenInLogViewer(' + nxCorrJsAttr(e.id) + ')">View in Log Viewer</button>'
      : '<button class="btn btn-secondary btn-sm" onclick="window.nxCorrOpenInLogViewer(' + nxCorrJsAttr(e.message) + ')">View in Log Viewer</button>';
    html += '<tr>' +
      '<td style="padding:var(--sp-2)" title="' + escHtml(req.url) + '">' + escHtml(req.method) + ' ' + escHtml(shortUrl) + '</td>' +
      '<td style="padding:var(--sp-2)"><span class="' + nxCorrStatusClass(req.status) + '" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px"></span>' + req.status + '</td>' +
      '<td style="padding:var(--sp-2)" title="' + escHtml(nxCorrEventLabel(e)) + '">' + escHtml(nxCorrEventLabel(e).length > 60 ? nxCorrEventLabel(e).slice(0, 60) + '…' : nxCorrEventLabel(e)) + '</td>' +
      '<td style="padding:var(--sp-2)">' + l.distMs + 'ms</td>' +
      '<td style="padding:var(--sp-2)">' + openBtn + '</td>' +
      '</tr>';
  });
  html += '</tbody></table></div></div>';

  out.innerHTML = html;
}

window.nxCorrRun = nxCorrRun;
window.nxCorrClear = nxCorrClear;

// Pushes the app log currently loaded in the correlator into the Log Viewer
// (it may not already have it) and jumps there, filtered to a search term —
// a corrId for a flow event, or the log line's own message for a bare
// error/warning entry (there is no corrId to filter by). Same "Open in Log
// Viewer" idiom as error-decoder.js / microflow-tracer.js / ws-rest-extractor.js,
// made self-sufficient instead of assuming the Log Viewer already has data.
window.nxCorrOpenInLogViewer = function (searchTerm) {
  if (window.nxCorrAppLogText && window.logLoadText) {
    window.logLoadText(window.nxCorrAppLogText, window.nxCorrAppLogFilename || 'app.log');
  }
  if (window.navigateWithReturn) window.navigateWithReturn('log-viewer');
  if (window.logInsightFilter) window.logInsightFilter('', '', searchTerm);
};
