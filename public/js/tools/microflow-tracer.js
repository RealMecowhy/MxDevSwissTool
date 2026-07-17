// Microflow Tracer - Mendix MicroflowEngine log analyzer (wave 3)
// Rebuilds microflow executions from DEBUG (Starting/Finished → durations) and
// TRACE (Executing activity → steps + call tree) records produced by the shared
// parser (mendix-log-parser.js). Works on both the Studio Pro CSV export and the
// Mendix Cloud live log.

let mftExecutions = [];
let mftFlows = [];
let mftLastFiltered = [];
let mftWorker = null;
let mftRawText = null; // kept for the LQE cross-link hand-off (same file, one load)
const MFT_WORKER_THRESHOLD = 2 * 1024 * 1024;
const MFT_RENDER_CAP = 2000; // DOM rows; 69 MB logs produce >11k executions

// DEBUG: [corrId] Starting|Finished execution of microflow 'Module.Name'
const MFT_EXEC_RE = /^\[([^\]\s]+)\]\s+(Starting|Finished) execution of microflow '([^']+)'\s*$/;
// TRACE: [corrId] Executing activity: {"current_activity":{...},"name":"Module.Name",...}
const MFT_ACT_RE = /^\[([^\]\s]+)\]\s+Executing activity:\s*(\{[\s\S]*)$/;

// Timestamp → epoch ms (fractional). Handles both formats the shared parser emits:
// live log ISO with microseconds (2026-07-17T06:05:24.802593) and the Studio Pro
// CSV export (07/11/2026 21:21:29). No timezone in either — deltas within one file
// are what matters, absolute offsets are irrelevant here.
function mftTsToMs(ts) {
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

// `Module.Flow.nested.<guid>` is how the engine names anonymous nested flows
function mftDisplayName(name) {
  const i = name.indexOf('.nested.');
  return i === -1 ? name : name.substring(0, i) + ' (nested)';
}

// Pure extraction over shared-parser records — no DOM, testable in Node.
// Executions nest via a per-correlation-ID stack: Starting pushes, Finished pops.
// Activities attach to the innermost open execution of their correlation ID; a
// step's duration is the delta to the next engine event on the same corrId.
function mftExtractExecutions(records) {
  const executions = [];
  const stacks = new Map();      // corrId -> array of open executions (call stack)
  const pendingStep = new Map(); // corrId -> last activity awaiting its duration
  let orphanFinished = 0;
  let activityRecords = 0;
  const corrIds = new Set();

  for (let ri = 0; ri < records.length; ri++) {
    const rec = records[ri];
    if (rec.logNode !== 'MicroflowEngine') continue;
    const msg = rec.message;

    let m = msg.match(MFT_EXEC_RE);
    if (m) {
      const corrId = m[1];
      const name = m[3];
      const ms = mftTsToMs(rec.timestamp);
      corrIds.add(corrId);
      let stack = stacks.get(corrId);
      if (!stack) { stack = []; stacks.set(corrId, stack); }

      // Any activity still open on this corrId ends at this boundary
      const pend = pendingStep.get(corrId);
      if (pend && !isNaN(ms) && !isNaN(pend.ms)) { pend.durationMs = ms - pend.ms; }
      pendingStep.delete(corrId);

      if (m[2] === 'Starting') {
        const exec = {
          id: executions.length,
          corrId: corrId,
          name: name,
          displayName: mftDisplayName(name),
          startTs: rec.timestamp,
          startMs: ms,
          endTs: null,
          durationMs: null,
          finished: false,
          steps: [],
          children: [],
          parentId: stack.length ? stack[stack.length - 1].id : null,
          depth: stack.length,
          recursive: stack.some(e => e.name === name),
          _idx: ri
        };
        if (stack.length) stack[stack.length - 1].children.push(exec);
        executions.push(exec);
        stack.push(exec);
      } else {
        // Finished — normally matches the top of the stack; on a name mismatch
        // (log window cut mid-execution) unwind to the matching frame, marking
        // everything above it as unfinished.
        let found = -1;
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].name === name) { found = i; break; }
        }
        if (found === -1) { orphanFinished++; continue; }
        stack.splice(found + 1);
        const exec = stack.pop();
        exec.endTs = rec.timestamp;
        exec.finished = true;
        if (!isNaN(ms) && !isNaN(exec.startMs)) exec.durationMs = ms - exec.startMs;
      }
      continue;
    }

    m = msg.match(MFT_ACT_RE);
    if (m) {
      const corrId = m[1];
      const ms = mftTsToMs(rec.timestamp);
      corrIds.add(corrId);
      activityRecords++;

      const pend = pendingStep.get(corrId);
      if (pend && !isNaN(ms) && !isNaN(pend.ms)) { pend.durationMs = ms - pend.ms; }

      const stack = stacks.get(corrId);
      if (!stack || stack.length === 0) { pendingStep.delete(corrId); continue; } // TRACE without DEBUG context

      let type = '?';
      let caption = '';
      try {
        const j = JSON.parse(m[2]);
        if (j.current_activity) {
          type = j.current_activity.type || '?';
          caption = j.current_activity.caption || '';
        }
      } catch (e) { /* truncated JSON — keep placeholders */ }

      const step = { ts: rec.timestamp, ms: ms, type: type, caption: caption, durationMs: null };
      stack[stack.length - 1].steps.push(step);
      pendingStep.set(corrId, step);
    }
  }

  // Aggregate per microflow (nested variants collapse into their parent flow name)
  const flowMap = new Map();
  for (const e of executions) {
    const key = e.displayName;
    let f = flowMap.get(key);
    if (!f) {
      f = { name: key, count: 0, finishedCount: 0, totalMs: 0, maxMs: -1, maxExecId: null, steps: 0, recursions: 0, unfinished: 0 };
      flowMap.set(key, f);
    }
    f.count++;
    f.steps += e.steps.length;
    if (e.recursive) f.recursions++;
    if (e.finished && e.durationMs !== null && !isNaN(e.durationMs)) {
      f.finishedCount++;
      f.totalMs += e.durationMs;
      if (e.durationMs > f.maxMs) { f.maxMs = e.durationMs; f.maxExecId = e.id; }
    } else if (!e.finished) {
      f.unfinished++;
    }
  }
  const flows = Array.from(flowMap.values());
  flows.sort((a, b) => b.totalMs - a.totalMs);

  return {
    executions: executions,
    flows: flows,
    stats: { orphanFinished: orphanFinished, activityRecords: activityRecords, corrIds: corrIds.size }
  };
}

// Expose the pure parts for Node tests (scripts/parser-test.js) and other tools
(typeof window !== 'undefined' ? window : self).mftExtractExecutions = mftExtractExecutions;
(typeof window !== 'undefined' ? window : self).mftTsToMs = mftTsToMs;

// ── UI: load / parse ─────────────────────────────────────────────────────────

window.mftHandleDrop = function(e) {
  e.preventDefault();
  const zone = document.getElementById('mft-list');
  if (zone) zone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files).filter(f => {
    const fn = f.name.toLowerCase();
    return fn.endsWith('.log') || fn.endsWith('.txt') || fn.endsWith('.csv') || f.type === 'text/plain' || f.type === 'text/csv' || f.type === '';
  });
  if (files.length) window.mftLoadFile(files);
};

window.mftLoadFile = function(files) {
  if (!files || files.length === 0) return;
  const reader = new FileReader();
  if (window.showLoader) window.showLoader('Reading log file...');
  reader.onload = function(e) {
    const text = e.target.result;
    setTimeout(() => mftParseText(text), 50);
  };
  reader.readAsText(files[0]);
};

function mftParseText(text) {
  if (window.showLoader) window.showLoader('Parsing microflow events...', 5);
  mftRawText = text;
  if (text.length >= MFT_WORKER_THRESHOLD && typeof Worker !== 'undefined' && window.createMendixLogParser) {
    mftParseInWorker(text);
  } else {
    setTimeout(() => {
      try {
        mftApplyParseResult(window.createMendixLogParser().parse(text));
      } catch (err) {
        console.error('MFT parse failed:', err);
        if (window.hideLoader) window.hideLoader();
        alert('Could not parse this log: ' + err.message);
      }
    }, 20);
  }
}

// Same worker technique as LQE: the shared parser factory is self-contained, so its
// .toString() is a complete worker program. Falls back to the main thread on error.
function mftParseInWorker(text) {
  if (mftWorker) { mftWorker.terminate(); mftWorker = null; }
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
    mftWorker = worker;
  } catch (err) {
    console.warn('MFT worker unavailable, parsing on main thread:', err);
    mftApplyParseResult(window.createMendixLogParser().parse(text));
    return;
  }
  worker.onmessage = function(msg) {
    const d = msg.data;
    if (d.type === 'progress') {
      if (window.showLoader) window.showLoader(d.phase || ('Parsing… ' + d.progress + '%'), d.progress);
    } else if (d.type === 'complete') {
      worker.terminate();
      if (mftWorker === worker) mftWorker = null;
      if (window.showLoader) window.showLoader('Rebuilding executions…', 99);
      setTimeout(() => mftApplyParseResult({ records: d.records }), 20);
    }
  };
  worker.onerror = function(err) {
    console.warn('MFT worker error, parsing on main thread:', err.message || err);
    worker.terminate();
    if (mftWorker === worker) mftWorker = null;
    mftApplyParseResult(window.createMendixLogParser().parse(text));
  };
  worker.postMessage({ text: text });
}

function mftApplyParseResult(res) {
  const out = mftExtractExecutions(res.records);
  mftExecutions = out.executions;
  mftFlows = out.flows;
  window._mftStats = out.stats;

  const noteEl = document.getElementById('mft-note');
  if (noteEl) {
    if (mftExecutions.length === 0) {
      noteEl.style.display = '';
      noteEl.textContent = ' · no MicroflowEngine records';
      noteEl.title = 'The log has no MicroflowEngine DEBUG/TRACE lines. Set the MicroflowEngine log node to DEBUG (execution times) or TRACE (activity steps + call tree) and reproduce the scenario.';
    } else if (out.stats.activityRecords === 0) {
      noteEl.style.display = '';
      noteEl.textContent = ' · DEBUG only';
      noteEl.title = 'Executions and durations were found, but no "Executing activity" TRACE records — set MicroflowEngine to TRACE to get activity steps and step timings.';
    } else {
      noteEl.style.display = 'none';
      noteEl.textContent = '';
    }
  }

  window.mftFilter();
  if (window.hideLoader) window.hideLoader();
}

// ── UI: filtering / sorting / stats ──────────────────────────────────────────

let mftView = 'exec'; // 'exec' (individual executions) | 'flows' (aggregate per microflow)
let mftSortKey = null;
let mftSortDir = -1;

const MFT_SORT_ACCESSORS = {
  time: e => e._idx,
  duration: e => (e.durationMs !== null && !isNaN(e.durationMs) ? e.durationMs : -1),
  steps: e => e.steps.length,
  sub: e => e.children.length
};

const MFT_FLOW_SORT_ACCESSORS = {
  calls: f => f.count,
  total: f => f.totalMs,
  avg: f => (f.finishedCount ? f.totalMs / f.finishedCount : -1),
  max: f => f.maxMs
};

window.mftSort = function(key) {
  if (mftSortKey === key) {
    mftSortDir = -mftSortDir;
  } else {
    mftSortKey = key;
    mftSortDir = key === 'time' ? 1 : -1;
  }
  document.querySelectorAll('#panel-microflow-tracer [data-sort-key]').forEach(el => {
    const arrow = el.querySelector('.mft-sort-arrow');
    if (!arrow) return;
    arrow.textContent = (el.getAttribute('data-sort-key') === mftSortKey) ? (mftSortDir === 1 ? ' ▲' : ' ▼') : '';
  });
  window.mftFilter();
};

window.mftSetView = function(view, btn) {
  mftView = view;
  const group = document.getElementById('mft-view-toggle');
  if (group) group.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
  document.getElementById('mft-exec-header').style.display = view === 'exec' ? 'grid' : 'none';
  document.getElementById('mft-flow-header').style.display = view === 'flows' ? 'grid' : 'none';
  mftSortKey = null;
  mftSortDir = -1;
  document.querySelectorAll('#panel-microflow-tracer .mft-sort-arrow').forEach(a => a.textContent = '');
  window.mftFilter();
};

window.mftFilter = function() {
  const searchEl = document.getElementById('mft-search');
  const search = searchEl ? searchEl.value.toLowerCase() : '';
  const slowOnlyEl = document.getElementById('mft-slow-only');
  const slowOnly = slowOnlyEl ? slowOnlyEl.checked : false;
  const slowMsEl = document.getElementById('mft-slow-ms');
  const slowMs = slowMsEl ? (parseFloat(slowMsEl.value) || 0) : 0;
  const topOnlyEl = document.getElementById('mft-top-only');
  const topOnly = topOnlyEl ? topOnlyEl.checked : false;

  if (mftView === 'flows') {
    let flows = mftFlows.filter(f => !search || f.name.toLowerCase().includes(search));
    if (slowOnly) flows = flows.filter(f => f.maxMs > slowMs);
    if (mftSortKey && MFT_FLOW_SORT_ACCESSORS[mftSortKey]) {
      const acc = MFT_FLOW_SORT_ACCESSORS[mftSortKey];
      flows = flows.slice().sort((a, b) => (acc(a) - acc(b)) * mftSortDir);
    }
    const countEl = document.getElementById('mft-count');
    if (countEl) countEl.textContent = flows.length + ' flows';
    mftLastFiltered = flows;
    mftUpdateStats(null);
    mftRenderFlowList(flows);
    return;
  }

  const filtered = mftExecutions.filter(e => {
    if (topOnly && e.depth !== 0) return false;
    if (slowOnly) {
      if (e.durationMs === null || isNaN(e.durationMs) || e.durationMs <= slowMs) return false;
    }
    if (search) {
      if (!e.name.toLowerCase().includes(search) && !e.corrId.toLowerCase().includes(search)) return false;
    }
    return true;
  });

  if (mftSortKey && MFT_SORT_ACCESSORS[mftSortKey]) {
    const acc = MFT_SORT_ACCESSORS[mftSortKey];
    filtered.sort((a, b) => (acc(a) - acc(b)) * mftSortDir);
  }

  const countEl = document.getElementById('mft-count');
  if (countEl) countEl.textContent = filtered.length + ' executions';
  mftLastFiltered = filtered;
  mftUpdateStats(filtered);
  mftRenderExecList(filtered);
};

function mftFmtMs(ms) {
  if (ms === null || isNaN(ms)) return '-';
  if (ms >= 10000) return (ms / 1000).toFixed(1) + ' s';
  if (ms >= 100) return Math.round(ms) + ' ms';
  return ms.toFixed(2) + ' ms';
}

function mftUpdateStats(filtered) {
  const bar = document.getElementById('mft-stats');
  if (!bar) return;
  if (mftExecutions.length === 0) { bar.style.display = 'none'; window._mftSlowestId = null; return; }
  bar.style.display = 'flex';

  const list = filtered || mftExecutions;
  let sum = 0, timed = 0, slowest = null, slowestMs = -1, unfinished = 0;
  const names = new Set();
  for (const e of list) {
    names.add(e.displayName);
    if (!e.finished) unfinished++;
    if (e.durationMs !== null && !isNaN(e.durationMs)) {
      sum += e.durationMs;
      timed++;
      if (e.durationMs > slowestMs) { slowestMs = e.durationMs; slowest = e; }
    }
  }
  document.getElementById('mft-stat-total').textContent = list.length;
  document.getElementById('mft-stat-flows').textContent = names.size;
  document.getElementById('mft-stat-sum').textContent = timed ? mftFmtMs(sum) : '–';
  document.getElementById('mft-stat-avg').textContent = timed ? mftFmtMs(sum / timed) : '–';
  document.getElementById('mft-stat-slowest').textContent = slowest ? mftFmtMs(slowestMs) : '–';
  document.getElementById('mft-stat-unfinished').textContent = unfinished;
  window._mftSlowestId = slowest ? slowest.id : null;
}

window.mftSelectSlowest = function() {
  if (window._mftSlowestId === null || window._mftSlowestId === undefined) return;
  const el = document.querySelector('#mft-list .mft-list-item[data-execid="' + window._mftSlowestId + '"]');
  if (el) { el.scrollIntoView({ block: 'center' }); el.click(); return; }
  // Row may be outside the render cap — select directly
  const exec = mftExecutions[window._mftSlowestId];
  if (exec) mftSelectExecution(exec);
};

// ── UI: list rendering ───────────────────────────────────────────────────────

function mftEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function mftRenderExecList(list) {
  const container = document.getElementById('mft-list');
  if (!container) return;
  container.innerHTML = '';
  if (list.length === 0) {
    container.innerHTML = '<div style="padding:var(--sp-5); text-align:center; color:var(--text-muted); font-size:0.85rem;">No microflow executions match the criteria.</div>';
    return;
  }

  const capped = list.length > MFT_RENDER_CAP;
  const visible = capped ? list.slice(0, MFT_RENDER_CAP) : list;

  visible.forEach(e => {
    const el = document.createElement('div');
    el.className = 'mft-list-item';
    el.dataset.execid = e.id;
    el.style.cssText = 'display:grid; grid-template-columns:118px 1fr 84px 56px 48px; padding:var(--sp-2) var(--sp-3); border-bottom:1px solid var(--border); font-size:0.8rem; cursor:pointer; color:var(--text); align-items:center;';

    const timeShort = e.startTs.length > 11 ? e.startTs.substring(11, 23) : e.startTs;
    const indent = e.depth ? '<span style="color:var(--text-muted)">' + '&nbsp;&nbsp;'.repeat(Math.min(e.depth, 6)) + '└ </span>' : '';
    const recBadge = e.recursive ? '<span title="This microflow was already on the call stack when this execution started (recursion)" style="margin-left:4px;font-size:0.7rem;font-weight:700;color:var(--warning);background:var(--warning-subtle);padding:0 4px;border-radius:var(--r-sm)">REC</span>' : '';
    const unfBadge = !e.finished ? '<span title="No Finished record — the log window probably ends mid-execution" style="margin-left:4px;font-size:0.7rem;font-weight:700;color:var(--danger);background:var(--danger-subtle);padding:0 4px;border-radius:var(--r-sm)">…</span>' : '';

    el.innerHTML =
      '<div style="color:var(--text-muted); font-family:var(--font-mono); font-size:0.72rem">' + mftEsc(timeShort) + '</div>' +
      '<div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="' + mftEsc(e.name) + ' [' + mftEsc(e.corrId) + ']">' + indent + mftEsc(e.displayName) + recBadge + unfBadge + '</div>' +
      '<div style="color:var(--accent); font-weight:600;">' + mftFmtMs(e.durationMs) + '</div>' +
      '<div style="color:var(--text-muted); text-align:right;">' + e.steps.length + '</div>' +
      '<div style="color:var(--text-muted); text-align:right;">' + (e.children.length || '') + '</div>';

    el.onmouseenter = () => { if (el !== window._mftActiveEl) el.style.background = 'var(--bg-hover)'; };
    el.onmouseleave = () => { if (el !== window._mftActiveEl) el.style.background = 'transparent'; };
    el.onclick = () => {
      document.querySelectorAll('.mft-list-item').forEach(i => i.style.background = 'transparent');
      el.style.background = 'var(--bg-active)';
      window._mftActiveEl = el;
      mftSelectExecution(e);
    };
    container.appendChild(el);
  });

  if (capped) {
    const note = document.createElement('div');
    note.style.cssText = 'padding:var(--sp-3); text-align:center; color:var(--text-muted); font-size:0.78rem;';
    note.textContent = 'Showing first ' + MFT_RENDER_CAP.toLocaleString() + ' of ' + list.length.toLocaleString() + ' executions — narrow down with the filters above.';
    container.appendChild(note);
  }
}

function mftRenderFlowList(flows) {
  const container = document.getElementById('mft-list');
  if (!container) return;
  container.innerHTML = '';
  if (flows.length === 0) {
    container.innerHTML = '<div style="padding:var(--sp-5); text-align:center; color:var(--text-muted); font-size:0.85rem;">No microflows match the criteria.</div>';
    return;
  }
  flows.forEach(f => {
    const el = document.createElement('div');
    el.className = 'mft-list-item';
    el.style.cssText = 'display:grid; grid-template-columns:1fr 62px 84px 84px 84px; padding:var(--sp-2) var(--sp-3); border-bottom:1px solid var(--border); font-size:0.8rem; cursor:pointer; color:var(--text); align-items:center;';
    const recBadge = f.recursions ? '<span title="' + f.recursions + ' recursive execution(s)" style="margin-left:4px;font-size:0.7rem;font-weight:700;color:var(--warning);background:var(--warning-subtle);padding:0 4px;border-radius:var(--r-sm)">REC</span>' : '';
    el.innerHTML =
      '<div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="' + mftEsc(f.name) + '">' + mftEsc(f.name) + recBadge + '</div>' +
      '<div style="text-align:right; color:var(--text-muted);">' + f.count + '</div>' +
      '<div style="text-align:right; color:var(--accent); font-weight:600;">' + (f.finishedCount ? mftFmtMs(f.totalMs) : '–') + '</div>' +
      '<div style="text-align:right;">' + (f.finishedCount ? mftFmtMs(f.totalMs / f.finishedCount) : '–') + '</div>' +
      '<div style="text-align:right;">' + (f.maxMs >= 0 ? mftFmtMs(f.maxMs) : '–') + '</div>';
    el.onmouseenter = () => { el.style.background = 'var(--bg-hover)'; };
    el.onmouseleave = () => { el.style.background = 'transparent'; };
    // Drill down: switch to executions view filtered to this flow
    el.onclick = () => {
      const searchEl = document.getElementById('mft-search');
      if (searchEl) searchEl.value = f.name.replace(' (nested)', '');
      const toggle = document.getElementById('mft-view-toggle');
      if (toggle) window.mftSetView('exec', toggle.querySelector('button'));
    };
    container.appendChild(el);
  });
}

// ── UI: detail panel ─────────────────────────────────────────────────────────

window.mftSetTab = function(tabId, btn) {
  const container = document.getElementById('panel-microflow-tracer');
  container.querySelectorAll('.tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
  btn.classList.add('active');
  btn.setAttribute('aria-selected', 'true');
  container.querySelectorAll('#mft-tab-timeline, #mft-tab-tree, #mft-tab-raw').forEach(el => { el.style.display = 'none'; });
  document.getElementById(tabId).style.display = 'flex';
};

function mftSelectExecution(e) {
  window._mftSelectedExec = e;

  const head = document.getElementById('mft-detail-head');
  if (head) {
    head.innerHTML =
      '<div style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="' + mftEsc(e.name) + '">' + mftEsc(e.displayName) + '</div>' +
      '<div style="font-size:0.72rem; color:var(--text-muted); font-family:var(--font-mono);">' +
        mftEsc(e.startTs) + (e.endTs ? ' → ' + mftEsc(e.endTs.length > 11 ? e.endTs.substring(11) : e.endTs) : ' → (unfinished)') +
        ' · corr ' + mftEsc(e.corrId) + ' · <strong style="color:var(--accent)">' + mftFmtMs(e.durationMs) + '</strong>' +
      '</div>';
  }

  // Timeline: this execution's own steps (sub-flow steps live in their own executions)
  const tbody = document.getElementById('mft-timeline-body');
  if (tbody) {
    tbody.innerHTML = '';
    if (e.steps.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="padding:var(--sp-3); color:var(--text-muted); text-align:center;">No activity steps (TRACE level required for MicroflowEngine).</td></tr>';
    } else {
      const maxStep = Math.max.apply(null, e.steps.map(s => s.durationMs || 0));
      e.steps.forEach((s, i) => {
        const off = (!isNaN(s.ms) && !isNaN(e.startMs)) ? s.ms - e.startMs : NaN;
        const pct = maxStep > 0 && s.durationMs ? Math.max(2, (s.durationMs / maxStep) * 100) : 0;
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--border)';
        tr.innerHTML =
          '<td style="padding:var(--sp-1) var(--sp-2); color:var(--text-muted);">' + (i + 1) + '</td>' +
          '<td style="padding:var(--sp-1) var(--sp-2); font-family:var(--font-mono); font-size:0.72rem; color:var(--text-muted);">+' + (isNaN(off) ? '?' : mftFmtMs(off)) + '</td>' +
          '<td style="padding:var(--sp-1) var(--sp-2); font-weight:600;">' + mftEsc(s.type) + '</td>' +
          '<td style="padding:var(--sp-1) var(--sp-2); overflow:hidden; text-overflow:ellipsis; max-width:260px;" title="' + mftEsc(s.caption) + '">' + mftEsc(s.caption) + '</td>' +
          '<td style="padding:var(--sp-1) var(--sp-2); white-space:nowrap;"><span style="display:inline-block; width:60px; text-align:right; margin-right:6px;">' + mftFmtMs(s.durationMs) + '</span><span style="display:inline-block; height:8px; width:' + pct + 'px; max-width:100px; background:var(--accent); border-radius:2px; vertical-align:middle;"></span></td>';
        tbody.appendChild(tr);
      });
    }
  }

  // Call tree
  const treeEl = document.getElementById('mft-tree-content');
  if (treeEl) {
    treeEl.innerHTML = '';
    let root = e;
    while (root.parentId !== null && mftExecutions[root.parentId]) root = mftExecutions[root.parentId];
    mftRenderTreeNode(treeEl, root, 0, e.id);
  }

  // Raw engine events reconstructed for copy/inspection
  const rawEl = document.getElementById('mft-raw-content');
  if (rawEl) {
    const lines = [];
    lines.push(e.startTs + '  Starting execution of microflow \'' + e.name + '\'  [' + e.corrId + ']');
    e.steps.forEach(s => {
      lines.push(s.ts + '  Executing activity: ' + s.type + (s.caption ? ' — ' + s.caption : ''));
    });
    if (e.endTs) lines.push(e.endTs + '  Finished execution of microflow \'' + e.name + '\'');
    rawEl.textContent = lines.join('\n');
  }
}

function mftRenderTreeNode(container, exec, depth, selectedId) {
  const el = document.createElement('div');
  const isSel = exec.id === selectedId;
  el.style.cssText = 'padding:2px var(--sp-2) 2px ' + (8 + depth * 18) + 'px; cursor:pointer; border-radius:var(--r-sm); font-size:0.8rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;' + (isSel ? 'background:var(--bg-active); font-weight:600;' : '');
  el.title = exec.name;
  el.innerHTML = (depth ? '└ ' : '') + mftEsc(exec.displayName) +
    ' <span style="color:var(--accent)">' + mftFmtMs(exec.durationMs) + '</span>' +
    ' <span style="color:var(--text-muted); font-size:0.72rem;">(' + exec.steps.length + ' steps)</span>' +
    (exec.recursive ? ' <span style="color:var(--warning); font-size:0.7rem; font-weight:700;">REC</span>' : '');
  if (!isSel) {
    el.onmouseenter = () => { el.style.background = 'var(--bg-hover)'; };
    el.onmouseleave = () => { el.style.background = 'transparent'; };
  }
  el.onclick = () => mftSelectExecution(exec);
  container.appendChild(el);
  exec.children.forEach(c => mftRenderTreeNode(container, c, depth + 1, selectedId));
}

// ── Cross-link: show the SQL queries that ran inside this execution's window ──
// MicroflowEngine lines carry no Tx-Conn, so the correlation is purely temporal:
// LQE gets a [start, end] timestamp window. If LQE has no data yet, the raw text
// loaded here is handed over so one file load powers both tools.
window.mftShowInLqe = function() {
  const e = window._mftSelectedExec;
  if (!e) { alert('Select a microflow execution first.'); return; }
  if (!e.endTs) { alert('This execution has no Finished record — no time window to correlate.'); return; }
  window.navigateWithReturn('log-query-extractor');
  if (window.lqeSetTimeWindow) {
    window.lqeSetTimeWindow(e.startTs, e.endTs, e.displayName);
  }
  const hasQueries = document.getElementById('lqe-count') && document.getElementById('lqe-count').textContent !== '0';
  if (!hasQueries && mftRawText && window.lqeLoadText) {
    window.lqeLoadText(mftRawText);
  }
};

// ── Export (currently filtered executions) ───────────────────────────────────

const MFT_EXPORT_HEADER = ['Microflow', 'Start', 'Duration (ms)', 'Steps', 'Sub-flows', 'Depth', 'Corr ID', 'Status'];

function mftExportRows() {
  if (mftView === 'flows') {
    return mftLastFiltered.map(f => [
      f.name, '', f.finishedCount ? Math.round(f.totalMs) : '', f.steps, '', '', '',
      f.count + ' calls' + (f.unfinished ? ', ' + f.unfinished + ' unfinished' : '')
    ]);
  }
  return mftLastFiltered.map(e => [
    e.displayName,
    e.startTs,
    (e.durationMs !== null && !isNaN(e.durationMs)) ? +e.durationMs.toFixed(3) : '',
    e.steps.length,
    e.children.length,
    e.depth,
    e.corrId,
    e.finished ? 'finished' : 'unfinished'
  ]);
}

window.mftExportCsv = function() {
  if (mftLastFiltered.length === 0) { alert('Nothing to export — load a log first (and check the active filters).'); return; }
  const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
  const lines = [MFT_EXPORT_HEADER.map(esc).join(',')];
  for (const row of mftExportRows()) lines.push(row.map(esc).join(','));
  window.downloadText(lines.join('\n'), 'microflow-executions.csv');
};

window.mftCopyMarkdown = function(btn) {
  if (mftLastFiltered.length === 0) { alert('Nothing to copy — load a log first (and check the active filters).'); return; }
  const esc = v => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '| ' + MFT_EXPORT_HEADER.join(' | ') + ' |',
    '|' + MFT_EXPORT_HEADER.map(() => '---').join('|') + '|'
  ];
  for (const row of mftExportRows()) lines.push('| ' + row.map(esc).join(' | ') + ' |');
  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    const oldHtml = btn.innerHTML;
    btn.innerHTML = 'Copied!';
    setTimeout(() => btn.innerHTML = oldHtml, 2000);
  });
};

window.mftCopyContent = function(elementId, btn) {
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

window.mftClear = function() {
  mftExecutions = [];
  mftFlows = [];
  mftLastFiltered = [];
  mftRawText = null;
  window._mftSelectedExec = null;
  window._mftSlowestId = null;
  const statsBar = document.getElementById('mft-stats');
  if (statsBar) statsBar.style.display = 'none';
  const noteEl = document.getElementById('mft-note');
  if (noteEl) { noteEl.style.display = 'none'; noteEl.textContent = ''; }
  document.getElementById('mft-list').innerHTML =
    '<div style="padding:var(--sp-5); text-align:center; color:var(--text-muted); font-size:0.85rem;">' +
    'Drop a log file here or use &ldquo;Load Log&rdquo;:<br>' +
    'MicroflowEngine at DEBUG &mdash; execution times &bull; at TRACE &mdash; activity steps &amp; call tree.</div>';
  document.getElementById('mft-count').textContent = '0 executions';
  document.getElementById('mft-detail-head').innerHTML = '<div style="color:var(--text-muted); font-size:0.85rem;">Select an execution to see its activity timeline and call tree.</div>';
  document.getElementById('mft-timeline-body').innerHTML = '';
  document.getElementById('mft-tree-content').innerHTML = '';
  document.getElementById('mft-raw-content').textContent = '';
  const fileInput = document.getElementById('mft-file-input');
  if (fileInput) fileInput.value = '';
};
