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
// Name/size of a user-loaded file, published to the Data Hub once parsed.
let mftPendingFile = null;
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

// ── N+1 detector ─────────────────────────────────────────────────────────────
// Scans executions for the classic Mendix N+1 anti-pattern: a database retrieve
// firing N times because it sits inside a list iteration (`ListLoop`) instead of
// one batch retrieve before the loop.
//
// Two shapes occur in real Mendix TRACE logs, and both must be caught:
//
//   A. Retrieve directly in the loop body — the repeated retrieves are steps of
//      the SAME execution, separated by the `ListLoop` marker.
//   B. Loop body calls a sub-microflow that retrieves — by far the most common
//      shape. Each iteration's sub-microflow is a SEPARATE child execution (same
//      correlation id) holding one retrieve, so the repetition is only visible
//      when you look at the loop owner's whole subtree, not its own steps.
//
// Detection — for every execution:
//
// 1. **Loop-aware subtree pass**: if this microflow contains a loop step, tally
//    DB retrieves by (type, caption) across its own steps AND every descendant
//    execution (covers shape B). ≥ threshold repetitions of the same retrieve → N+1.
//
// 2. **Consecutive-run pass** over this execution's own steps (covers shape A even
//    when the loop iterator is logged below TRACE). Loop markers don't break a run.
//
// Results are de-duplicated (same type+caption kept at the higher count) and
// attributed to the loop-owning execution. Threshold: MFT_N1_THRESHOLD (default 3).
//
// NB: real Mendix logs emit `ListLoop` (not `LoopedActivity`); both are accepted.

const MFT_N1_THRESHOLD = 3;
// The canonical N+1 is a per-row database retrieve. Aggregate-in-loop is a weaker,
// noisier signal (and often unavoidable), so it is deliberately excluded here.
const MFT_N1_DB_TYPES = new Set(['RetrieveByXPath', 'RetrieveByAssociation']);
const MFT_LOOP_TYPES = new Set(['ListLoop', 'LoopedActivity']);

// Tally DB retrieves by (type, caption) across an execution's own steps plus all
// descendant executions (recursively). Mutates `tally` (Map key "type\tcaption").
function mftTallyRetrievesDeep(exec, tally) {
  for (const s of exec.steps) {
    if (MFT_N1_DB_TYPES.has(s.type)) {
      const key = s.type + '\t' + s.caption;
      let t = tally.get(key);
      if (!t) { t = { type: s.type, caption: s.caption, count: 0, totalMs: 0 }; tally.set(key, t); }
      t.count++;
      if (s.durationMs !== null && !isNaN(s.durationMs)) t.totalMs += s.durationMs;
    }
  }
  for (const child of exec.children) mftTallyRetrievesDeep(child, tally);
}

function mftDetectNPlusOne(executions) {
  let totalDetections = 0;
  for (const exec of executions) {
    exec.nPlusOne = [];

    const found = new Map(); // key "type\tcaption" → {type, caption, count, totalMs}
    const addHit = function(hit) {
      const key = hit.type + '\t' + hit.caption;
      const prev = found.get(key);
      if (!prev || hit.count > prev.count) {
        found.set(key, { type: hit.type, caption: hit.caption, count: hit.count, totalMs: hit.totalMs });
      }
    };

    // Pass 1: loop-aware subtree tally (shape B — retrieve in a called sub-microflow)
    const hasLoop = exec.steps.some(function(s) { return MFT_LOOP_TYPES.has(s.type); });
    if (hasLoop) {
      const tally = new Map();
      mftTallyRetrievesDeep(exec, tally);
      for (const t of tally.values()) {
        if (t.count >= MFT_N1_THRESHOLD) addHit(t);
      }
    }

    // Pass 2: consecutive-run within this execution's own steps (shape A).
    // Loop markers sit between iterations and must not break the run.
    let runType = null, runCaption = null, runCount = 0, runMs = 0;
    const flushRun = function() {
      if (runCount >= MFT_N1_THRESHOLD && runType) {
        addHit({ type: runType, caption: runCaption, count: runCount, totalMs: runMs });
      }
      runCount = 0; runMs = 0;
    };
    for (const s of exec.steps) {
      if (MFT_N1_DB_TYPES.has(s.type)) {
        if (s.type === runType && s.caption === runCaption) {
          runCount++;
          if (s.durationMs !== null && !isNaN(s.durationMs)) runMs += s.durationMs;
        } else {
          flushRun();
          runType = s.type; runCaption = s.caption; runCount = 1;
          runMs = (s.durationMs !== null && !isNaN(s.durationMs)) ? s.durationMs : 0;
        }
      } else if (MFT_LOOP_TYPES.has(s.type)) {
        continue; // loop marker doesn't break a run
      } else {
        flushRun();
        runType = null; runCaption = null;
      }
    }
    flushRun();

    exec.nPlusOne = Array.from(found.values());
    exec.nPlusOne.sort(function(a, b) { return b.count - a.count; }); // worst offender first
    totalDetections += exec.nPlusOne.length;
  }
  return totalDetections;
}

// ── Scheduled events & background work ───────────────────────────────────────
// The runtime keys its correlation IDs by origin: an HTTP request gets a numeric
// counter (`1784268324436-46`), while anything the runtime starts itself — a
// scheduled event, a task-queue worker, an after-startup flow — gets a UUID.
// That is the only marker in the log; there is no "scheduled event" label on the
// MicroflowEngine lines themselves (confirmed on a 69 MB production log where
// General.Clean_ScheduledEventLog runs under a UUID at 03:00 sharp).
//
// A "run" is a depth-0 execution on a background correlation ID; sub-microflows
// belong to their run, not next to it.

const MFT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Below this many timed runs a duration trend is noise, not a trend.
const MFT_TREND_MIN_RUNS = 4;
// Median has to move by more than this for the trend to be called at all.
const MFT_TREND_PCT = 20;
// Log nodes that carry background failures when MicroflowEngine is silent.
const MFT_BG_NODE_RE = /taskqueue|scheduler|scheduledevent|background|queue/i;
const MFT_BG_MSG_RE = /scheduled event/i;
const MFT_BG_ERROR_LEVELS = { ERROR: 1, CRITICAL: 1, FATAL: 1 };

function mftIsBackgroundCorrId(corrId) {
  return MFT_UUID_RE.test(String(corrId || ''));
}

function mftMedian(sortedNumbers) {
  const n = sortedNumbers.length;
  if (!n) return null;
  const mid = n >> 1;
  return n % 2 ? sortedNumbers[mid] : (sortedNumbers[mid - 1] + sortedNumbers[mid]) / 2;
}

// Duration trend across a run series: median of the first half vs the second.
// Halves (not first-vs-last run) so one cold start or one outlier cannot flip it.
function mftRunTrend(runsInOrder) {
  const timed = runsInOrder.filter(r => r.durationMs !== null && !isNaN(r.durationMs));
  if (timed.length < MFT_TREND_MIN_RUNS) return null;
  const half = Math.floor(timed.length / 2);
  const a = timed.slice(0, half).map(r => r.durationMs).sort((x, y) => x - y);
  const b = timed.slice(timed.length - half).map(r => r.durationMs).sort((x, y) => x - y);
  const m1 = mftMedian(a), m2 = mftMedian(b);
  if (m1 === null || m2 === null || m1 <= 0) return null;
  const pct = ((m2 - m1) / m1) * 100;
  return {
    firstHalfMs: m1,
    secondHalfMs: m2,
    pct: pct,
    dir: pct > MFT_TREND_PCT ? 'up' : (pct < -MFT_TREND_PCT ? 'down' : 'flat')
  };
}

// Background failures for logs that carry no MicroflowEngine records — the common
// case, since INFO+ is what production runs at. Grouped per log node; the full
// task × queue breakdown lives in Log Viewer → Insights and is not repeated here.
function mftExtractBackgroundErrors(records) {
  const byNode = new Map();
  for (const rec of (records || [])) {
    const level = String(rec.level || '').toUpperCase();
    if (!MFT_BG_ERROR_LEVELS[level]) continue;
    const node = rec.logNode || rec.node || '';
    if (!MFT_BG_NODE_RE.test(node) && !MFT_BG_MSG_RE.test(rec.message || '')) continue;
    let g = byNode.get(node);
    if (!g) { g = { node: node, count: 0, firstTs: rec.timestamp, lastTs: rec.timestamp, sample: (rec.message || '').split('\n')[0] }; byNode.set(node, g); }
    g.count++;
    g.lastTs = rec.timestamp;
  }
  return Array.from(byNode.values()).sort((a, b) => b.count - a.count);
}

// Pure aggregation for the Background view. `records` is optional — without it the
// view still works off executions, it just cannot show the no-engine-data fallback.
function mftBuildBackgroundView(executions, records) {
  const byName = new Map();
  let requestRuns = 0;

  for (const e of (executions || [])) {
    if (e.depth !== 0) continue;
    if (!mftIsBackgroundCorrId(e.corrId)) { requestRuns++; continue; }
    let ev = byName.get(e.displayName);
    if (!ev) {
      ev = { name: e.displayName, runs: [], count: 0, unfinished: 0, execIds: [] };
      byName.set(e.displayName, ev);
    }
    ev.count++;
    ev.execIds.push(e.id);
    if (!e.finished) ev.unfinished++;
    ev.runs.push({
      execId: e.id, corrId: e.corrId, startTs: e.startTs, startMs: e.startMs,
      endMs: (e.finished && !isNaN(e.startMs) && e.durationMs !== null && !isNaN(e.durationMs)) ? e.startMs + e.durationMs : null,
      durationMs: (e.durationMs !== null && !isNaN(e.durationMs)) ? e.durationMs : null,
      finished: e.finished
    });
  }

  const events = [];
  let overlapCount = 0, unfinished = 0, runTotal = 0;

  for (const ev of byName.values()) {
    ev.runs.sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
    const durations = ev.runs.map(r => r.durationMs).filter(d => d !== null).sort((a, b) => a - b);

    // Start-to-start intervals: a scheduled event every 5 minutes shows up here as
    // a stable median, which is what makes a missed or drifting run visible.
    const intervals = [];
    for (let i = 1; i < ev.runs.length; i++) {
      const d = ev.runs[i].startMs - ev.runs[i - 1].startMs;
      if (!isNaN(d) && d >= 0) intervals.push(d);
    }
    intervals.sort((a, b) => a - b);

    // Overlap sweep: a run that starts while an earlier run of the same event is
    // still open. For a scheduled event that means the previous run overran its
    // interval; for a task-queue worker it is ordinary parallelism, so the finding
    // is reported neutrally and left for the user to judge.
    const overlaps = [];
    let openUntil = -Infinity, openRun = null;
    for (const r of ev.runs) {
      if (!isNaN(r.startMs) && r.startMs < openUntil && openRun) {
        overlaps.push({ startTs: r.startTs, withStartTs: openRun.startTs, overlapMs: openUntil - r.startMs });
      }
      if (r.endMs !== null && r.endMs > openUntil) { openUntil = r.endMs; openRun = r; }
    }

    const first = ev.runs[0], last = ev.runs[ev.runs.length - 1];
    events.push({
      name: ev.name,
      runs: ev.count,
      unfinished: ev.unfinished,
      execIds: ev.execIds,
      minMs: durations.length ? durations[0] : null,
      medianMs: mftMedian(durations),
      maxMs: durations.length ? durations[durations.length - 1] : null,
      totalMs: durations.reduce((s, d) => s + d, 0),
      firstTs: first ? first.startTs : null,
      lastTs: last ? last.startTs : null,
      medianIntervalMs: mftMedian(intervals),
      trend: mftRunTrend(ev.runs),
      overlaps: overlaps,
      overlapCount: overlaps.length
    });
    overlapCount += overlaps.length;
    unfinished += ev.unfinished;
    runTotal += ev.count;
  }

  events.sort((a, b) => b.runs - a.runs || (b.totalMs - a.totalMs));

  return {
    events: events,
    runs: runTotal,
    requestRuns: requestRuns,
    unfinished: unfinished,
    overlapCount: overlapCount,
    hasEngineData: !!(executions && executions.length),
    errors: mftExtractBackgroundErrors(records)
  };
}

// Expose the pure parts for Node tests (scripts/parser-test.js) and other tools
(typeof window !== 'undefined' ? window : self).mftExtractExecutions = mftExtractExecutions;
(typeof window !== 'undefined' ? window : self).mftDetectNPlusOne = mftDetectNPlusOne;
(typeof window !== 'undefined' ? window : self).mftBuildBackgroundView = mftBuildBackgroundView;
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
  mftPendingFile = { name: files[0].name, size: files[0].size };
  const reader = new FileReader();
  if (window.showLoader) window.showLoader('Reading log file...');
  reader.onload = function(e) {
    const text = e.target.result;
    setTimeout(() => mftParseText(text), 50);
  };
  reader.readAsText(files[0]);
};

// Cross-link entry point (REST & WS Extractor → MFT): load raw log text directly
// so one file load powers all the log tools, mirroring lqeLoadText.
window.mftLoadText = function(text) {
  mftPendingFile = null;   // the caller (cross-link / Data Hub) owns this text
  mftParseText(text);
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

  // N+1 detection pass (requires TRACE-level activity steps)
  const n1Count = mftDetectNPlusOne(mftExecutions);
  window._mftStats.nPlusOneDetections = n1Count;

  // Background view needs the raw records too — its fallback reads failures from
  // log nodes the engine never touches (TaskQueue & co).
  mftBackground = mftBuildBackgroundView(mftExecutions, res.records);

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
  mftPublishToHub(res);
}

// Registers the just-parsed file with the Data Hub so the other log tools can
// pick it up without a second load. No-op when the text came from elsewhere
// (a cross-link or the Hub itself already owns that source).
function mftPublishToHub(res) {
  if (window.mtHub) window.mtHub.publishFromParse(mftPendingFile, mftRawText, res, 'microflow-tracer');
  mftPendingFile = null;
}

// Data Hub: does this tool currently show something of its own? Used to warn
// before a one-click hand-off from another tool silently replaces it.
window.mftHasData = function () { return mftExecutions.length > 0; };

// ── UI: filtering / sorting / stats ──────────────────────────────────────────

let mftView = 'exec'; // 'exec' (individual executions) | 'flows' (per microflow) | 'background' (per scheduled event)
let mftSortKey = null;
let mftSortDir = -1;
let mftBackground = null; // last built background view (rebuilt on every parse)

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

const MFT_BG_SORT_ACCESSORS = {
  runs: e => e.runs,
  median: e => (e.medianMs === null ? -1 : e.medianMs),
  max: e => (e.maxMs === null ? -1 : e.maxMs),
  every: e => (e.medianIntervalMs === null ? -1 : e.medianIntervalMs)
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
  const bgHeader = document.getElementById('mft-bg-header');
  if (bgHeader) bgHeader.style.display = view === 'background' ? 'grid' : 'none';
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

  if (mftView === 'background') {
    const view = mftBackground || { events: [], errors: [], hasEngineData: false, runs: 0, requestRuns: 0, overlapCount: 0, unfinished: 0 };
    let events = view.events.filter(e => !search || e.name.toLowerCase().includes(search));
    if (slowOnly) events = events.filter(e => e.maxMs !== null && e.maxMs > slowMs);
    if (mftSortKey && MFT_BG_SORT_ACCESSORS[mftSortKey]) {
      const acc = MFT_BG_SORT_ACCESSORS[mftSortKey];
      events = events.slice().sort((a, b) => (acc(a) - acc(b)) * mftSortDir);
    }
    const bgCountEl = document.getElementById('mft-count');
    if (bgCountEl) bgCountEl.textContent = events.length + (events.length === 1 ? ' event' : ' events');
    mftLastFiltered = events;
    mftUpdateStats(null);
    mftRenderBackgroundList(view, events);
    return;
  }

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
  // The background view counts runs, not executions, and carries its own summary
  // strip — showing both side by side would read as two contradicting totals.
  if (mftView === 'background') { bar.style.display = 'none'; window._mftSlowestId = null; return; }
  if (mftExecutions.length === 0) { bar.style.display = 'none'; window._mftSlowestId = null; return; }
  bar.style.display = 'flex';

  const list = filtered || mftExecutions;
  let sum = 0, timed = 0, slowest = null, slowestMs = -1, unfinished = 0, n1Execs = 0;
  const names = new Set();
  for (const e of list) {
    names.add(e.displayName);
    if (!e.finished) unfinished++;
    if (e.nPlusOne && e.nPlusOne.length) n1Execs++;
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
  const n1El = document.getElementById('mft-stat-n1');
  if (n1El) {
    n1El.textContent = n1Execs;
    const n1Stat = n1El.closest('.log-stat');
    if (n1Stat) n1Stat.style.display = n1Execs > 0 ? '' : 'none';
  }
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
    const n1Badge = (e.nPlusOne && e.nPlusOne.length) ? '<span title="N+1 detected: ' + e.nPlusOne.map(function(d) { return d.type + ' ×' + d.count; }).join(', ') + '" style="margin-left:4px;font-size:0.7rem;font-weight:700;color:#e65100;background:#fff3e0;padding:0 4px;border-radius:var(--r-sm)">N+1</span>' : '';

    el.innerHTML =
      '<div style="color:var(--text-muted); font-family:var(--font-mono); font-size:0.72rem">' + mftEsc(timeShort) + '</div>' +
      '<div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="' + mftEsc(e.name) + ' [' + mftEsc(e.corrId) + ']">' + indent + mftEsc(e.displayName) + recBadge + unfBadge + n1Badge + '</div>' +
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

// Schedules read better in their own unit than in milliseconds: an event every
// five minutes should say "5m", not "300054 ms".
function mftFmtInterval(ms) {
  if (ms === null || isNaN(ms)) return '–';
  // One decimal below 10 units, but not a bare ".0" — a five-minute schedule
  // should read "5m", while a drifting one still shows "5.4m".
  const fmt = (v, unit) => (v < 10 ? String(+v.toFixed(1)) : String(Math.round(v))) + unit;
  const s = ms / 1000;
  if (s < 90) return fmt(s, 's');
  const m = s / 60;
  return m < 90 ? fmt(m, 'm') : fmt(m / 60, 'h');
}

function mftRenderBackgroundList(view, events) {
  const container = document.getElementById('mft-list');
  if (!container) return;
  container.innerHTML = '';
  // Nothing loaded yet is not the same as "no background work in this log".
  if (!mftBackground) {
    container.innerHTML = '<div style="padding:var(--sp-5); text-align:center; color:var(--text-muted); font-size:0.85rem;">' +
      'Drop a log file here or use &ldquo;Load Log&rdquo; to see scheduled events and other background work.</div>';
    return;
  }

  // No MicroflowEngine records at all: say what is missing and how to get it,
  // but still show whatever background failures the log does carry.
  if (!view.hasEngineData) {
    const errHtml = view.errors.length ? mftRenderBackgroundErrors(view.errors) : '';
    container.innerHTML =
      '<div style="padding:var(--sp-5); text-align:center; color:var(--text-muted); font-size:0.85rem;">' +
      (view.errors.length
        ? 'No MicroflowEngine records — run statistics are unavailable, but this log does contain background failures.'
        : 'No MicroflowEngine records in this log.') +
      '<div class="data-req"><span class="data-req-title">How to get run statistics</span>Scheduled events and queue workers are ordinary microflows &mdash; raise <b>MicroflowEngine</b> to <b>DEBUG</b> (run times) or <b>TRACE</b> (activity steps) and let the schedule fire at least once. Studio Pro: <em>Console &rarr; Advanced &rarr; Set Log Levels</em>; Mendix Cloud: <em>Environment &rarr; Details &rarr; Log Levels</em>.</div></div>' +
      errHtml;
    return;
  }

  if (events.length === 0) {
    const why = view.runs === 0
      ? 'No background work in this log — all ' + view.requestRuns.toLocaleString() + ' execution(s) ran on request correlation IDs. Scheduled events and queue workers use a UUID correlation ID; none appear here.'
      : 'No background events match the criteria.';
    container.innerHTML = '<div style="padding:var(--sp-5); text-align:center; color:var(--text-muted); font-size:0.85rem;">' + why + '</div>' +
      (view.errors.length ? mftRenderBackgroundErrors(view.errors) : '');
    return;
  }

  // Summary strip — only the facts that exist in this log
  const bits = [
    '<strong>' + view.runs.toLocaleString() + '</strong> background run' + (view.runs === 1 ? '' : 's'),
    '<strong>' + view.events.length + '</strong> event' + (view.events.length === 1 ? '' : 's')
  ];
  if (view.requestRuns) bits.push(view.requestRuns.toLocaleString() + ' request-driven (not shown)');
  if (view.overlapCount) bits.push('<strong style="color:var(--warning)">' + view.overlapCount + '</strong> overlapping');
  if (view.unfinished) bits.push('<strong style="color:var(--danger)">' + view.unfinished + '</strong> unfinished');
  const summary = document.createElement('div');
  summary.style.cssText = 'padding:var(--sp-2) var(--sp-3); border-bottom:1px solid var(--border); font-size:0.75rem; color:var(--text-secondary); background:var(--bg-elevated);';
  summary.innerHTML = bits.join(' &middot; ');
  container.appendChild(summary);

  events.forEach(ev => {
    const el = document.createElement('div');
    el.className = 'mft-list-item';
    el.dataset.bgevent = ev.name;
    el.style.cssText = 'display:grid; grid-template-columns:1fr 52px 78px 78px 74px 62px; padding:var(--sp-2) var(--sp-3); border-bottom:1px solid var(--border); font-size:0.8rem; cursor:pointer; color:var(--text); align-items:center;';

    // The generic explanation stays first; up to 5 concrete instances are appended
    // so the tooltip alone answers "which runs, exactly" without a trip to Executions.
    const ovlInstances = (ev.overlaps || []).slice(0, 5).map(function (o) {
      return mftEsc(o.startTs) + ' overlapped a run still open from ' + mftEsc(o.withStartTs) + ' (by ' + mftFmtMs(o.overlapMs) + ')';
    }).join('\n');
    const ovlMore = (ev.overlaps || []).length > 5 ? '\n… and ' + (ev.overlaps.length - 5) + ' more' : '';
    const ovlBadge = ev.overlapCount
      ? '<span title="' + mftEsc(ev.overlapCount + ' run(s) started while a previous run was still open. For a scheduled event that means the run overran its interval; for a queue worker it is ordinary parallelism.' + (ovlInstances ? '\n\n' + ovlInstances + ovlMore : '')) + '" style="margin-left:4px;font-size:0.7rem;font-weight:700;color:var(--warning);background:var(--warning-subtle);padding:0 4px;border-radius:var(--r-sm)">⇉ ' + ev.overlapCount + '</span>'
      : '';
    const unfBadge = ev.unfinished
      ? '<span title="' + ev.unfinished + ' run(s) without a Finished record — the log window ends mid-run, or the run failed" style="margin-left:4px;font-size:0.7rem;font-weight:700;color:var(--danger);background:var(--danger-subtle);padding:0 4px;border-radius:var(--r-sm)">…' + ev.unfinished + '</span>'
      : '';

    let trendCell = '<span style="color:var(--text-muted)" title="Needs at least 4 timed runs">–</span>';
    if (ev.trend) {
      const pct = Math.round(Math.abs(ev.trend.pct));
      const tip = 'First half median ' + mftFmtMs(ev.trend.firstHalfMs) + ' → second half ' + mftFmtMs(ev.trend.secondHalfMs);
      if (ev.trend.dir === 'up') trendCell = '<span style="color:var(--warning); font-weight:600;" title="' + mftEsc(tip) + '">↑ ' + pct + '%</span>';
      else if (ev.trend.dir === 'down') trendCell = '<span style="color:var(--success); font-weight:600;" title="' + mftEsc(tip) + '">↓ ' + pct + '%</span>';
      else trendCell = '<span style="color:var(--text-muted)" title="' + mftEsc(tip) + '">≈</span>';
    }

    el.innerHTML =
      '<div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="' + mftEsc(ev.name) + ' — first run ' + mftEsc(ev.firstTs || '?') + ', last run ' + mftEsc(ev.lastTs || '?') + '">' + mftEsc(ev.name) + ovlBadge + unfBadge + '</div>' +
      '<div style="text-align:right; color:var(--text-muted);">' + ev.runs + '</div>' +
      '<div style="text-align:right; color:var(--accent); font-weight:600;">' + mftFmtMs(ev.medianMs) + '</div>' +
      '<div style="text-align:right;">' + mftFmtMs(ev.maxMs) + '</div>' +
      '<div style="text-align:right; color:var(--text-muted);">' + mftFmtInterval(ev.medianIntervalMs) + '</div>' +
      '<div style="text-align:right;">' + trendCell + '</div>';

    el.onmouseenter = () => { el.style.background = 'var(--bg-hover)'; };
    el.onmouseleave = () => { el.style.background = 'transparent'; };
    // Drill down to the individual runs of this event
    el.onclick = () => {
      const searchEl = document.getElementById('mft-search');
      if (searchEl) searchEl.value = ev.name.replace(' (nested)', '');
      const toggle = document.getElementById('mft-view-toggle');
      if (toggle) window.mftSetView('exec', toggle.querySelector('button'));
    };
    container.appendChild(el);
  });

  if (view.errors.length) container.insertAdjacentHTML('beforeend', mftRenderBackgroundErrors(view.errors));
}

// Compact per-node failure strip. The full task × queue breakdown lives in
// Log Viewer → Insights; this only tells the user that background work is failing.
function mftRenderBackgroundErrors(errors) {
  const rows = errors.map(e =>
    '<div style="display:flex; gap:var(--sp-2); align-items:baseline; padding:2px 0;">' +
      '<strong style="min-width:150px;">' + mftEsc(e.node) + '</strong>' +
      '<span style="color:var(--danger); font-weight:600;">' + e.count + '</span>' +
      '<span style="color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="' + mftEsc(e.sample) + '">' + mftEsc(e.sample) + '</span>' +
    '</div>').join('');
  return '<div style="margin:var(--sp-3); padding:var(--sp-3); border:1px solid var(--border); border-radius:var(--r-md); background:var(--bg-elevated); font-size:0.78rem;">' +
    '<div style="font-weight:700; margin-bottom:var(--sp-2);">Background failures in this log</div>' + rows +
    '<div style="margin-top:var(--sp-2); color:var(--text-muted);">Full task &times; queue breakdown: Log Viewer &rarr; Insights.</div></div>';
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
  const n1Panel = document.getElementById('mft-timeline-n1');
  if (n1Panel) {
    if (e.nPlusOne && e.nPlusOne.length) {
      n1Panel.style.display = 'block';
      let html = '<div style="font-weight:700; margin-bottom:4px; display:flex; align-items:center; gap:6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg> N+1 Anti-Pattern Detected</div>';
      html += '<div style="margin-bottom:6px;">A database retrieve inside a loop is executing N times. This usually degrades performance severely. Consider pulling the data outside the loop with a single batch retrieve.</div>';
      html += '<ul style="margin:0; padding-left:20px; list-style-type:disc;">';
      e.nPlusOne.forEach(function(d) {
        html += '<li><strong>' + mftEsc(d.caption || d.type) + '</strong> (' + mftEsc(d.type) + ') executed <strong>' + d.count + ' times</strong> taking ' + mftFmtMs(d.totalMs) + ' in total.</li>';
      });
      html += '</ul>';
      n1Panel.innerHTML = html;
    } else {
      n1Panel.style.display = 'none';
      n1Panel.innerHTML = '';
    }
  }

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

const MFT_EXPORT_HEADER = ['Microflow', 'Start', 'Duration (ms)', 'Steps', 'Sub-flows', 'Depth', 'Corr ID', 'Status', 'N+1 Issues'];

// Background runs are a different shape from executions, so the export follows the
// active view instead of forcing them into the execution columns.
const MFT_BG_EXPORT_HEADER = ['Event', 'Runs', 'Median (ms)', 'Min (ms)', 'Max (ms)', 'Every (ms)', 'Trend', 'Overlapping', 'Unfinished', 'First run', 'Last run'];

function mftExportHeader() {
  return mftView === 'background' ? MFT_BG_EXPORT_HEADER : MFT_EXPORT_HEADER;
}

function mftExportRows() {
  if (mftView === 'background') {
    return mftLastFiltered.map(ev => [
      ev.name, ev.runs,
      ev.medianMs === null ? '' : +ev.medianMs.toFixed(3),
      ev.minMs === null ? '' : +ev.minMs.toFixed(3),
      ev.maxMs === null ? '' : +ev.maxMs.toFixed(3),
      ev.medianIntervalMs === null ? '' : Math.round(ev.medianIntervalMs),
      ev.trend ? ev.trend.dir + ' ' + Math.round(ev.trend.pct) + '%' : '',
      ev.overlapCount || '', ev.unfinished || '',
      ev.firstTs || '', ev.lastTs || ''
    ]);
  }
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
    e.finished ? 'finished' : 'unfinished',
    (e.nPlusOne && e.nPlusOne.length) ? e.nPlusOne.map(function(d) { return d.type + ' ×' + d.count; }).join(', ') : ''
  ]);
}

// Incident Report source: individual microflow executions (all parsed, not the
// current view's aggregation), optionally narrowed to [fromMs, toMs] by start
// time. Returns null when empty (data-driven rule).
window.mftReportSection = function(fromMs, toMs) {
  if (!mftExecutions.length) return null;
  const inWin = mftExecutions.filter(function (e) {
    if (fromMs != null && !isNaN(e.startMs) && e.startMs < fromMs) return false;
    if (toMs != null && !isNaN(e.startMs) && e.startMs > toMs) return false;
    return true;
  });
  if (!inWin.length) return null;
  let firstMs = Infinity, lastMs = -Infinity, unfinished = 0;
  const rows = inWin.map(function (e) {
    if (!isNaN(e.startMs)) { if (e.startMs < firstMs) firstMs = e.startMs; if (e.startMs > lastMs) lastMs = e.startMs; }
    if (!e.finished) unfinished++;
    return [
      e.displayName, e.startTs,
      (e.durationMs !== null && !isNaN(e.durationMs)) ? +e.durationMs.toFixed(3) : '',
      e.steps.length, e.children.length, e.depth, e.corrId,
      e.finished ? 'finished' : 'unfinished',
      (e.nPlusOne && e.nPlusOne.length) ? e.nPlusOne.map(function(d) { return d.type + ' ×' + d.count; }).join(', ') : ''
    ];
  });
  return {
    id: 'microflow-tracer', title: 'Microflow Tracer — executions',
    subtitle: rows.length + ' execution' + (rows.length === 1 ? '' : 's') + (unfinished ? ' · ' + unfinished + ' unfinished' : ''),
    columns: MFT_EXPORT_HEADER, rows: rows, total: rows.length,
    firstMs: firstMs === Infinity ? null : firstMs, lastMs: lastMs === -Infinity ? null : lastMs
  };
};

window.mftExportCsv = function() {
  if (mftLastFiltered.length === 0) { alert('Nothing to export — load a log first (and check the active filters).'); return; }
  const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
  const lines = [mftExportHeader().map(esc).join(',')];
  for (const row of mftExportRows()) lines.push(row.map(esc).join(','));
  window.downloadText(lines.join('\n'), mftView === 'background' ? 'microflow-background-events.csv' : 'microflow-executions.csv');
};

window.mftCopyMarkdown = function(btn) {
  if (mftLastFiltered.length === 0) { alert('Nothing to copy — load a log first (and check the active filters).'); return; }
  const esc = v => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const header = mftExportHeader();
  const lines = [
    '| ' + header.join(' | ') + ' |',
    '|' + header.map(() => '---').join('|') + '|'
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
  mftBackground = null;
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
    'MicroflowEngine at DEBUG &mdash; execution times &bull; at TRACE &mdash; activity steps &amp; call tree.' +
    '<div class="data-req"><span class="data-req-title">How to get this data</span>Raise <b>MicroflowEngine</b> to <b>DEBUG</b> (execution times) or <b>TRACE</b> (activity steps &amp; call tree) &mdash; Studio Pro: <em>Console &rarr; Advanced &rarr; Set Log Levels</em>; Mendix Cloud: <em>Environment &rarr; Details &rarr; Log Levels</em>. Reproduce the scenario, then export/download the log.</div></div>';
  document.getElementById('mft-count').textContent = '0 executions';
  document.getElementById('mft-detail-head').innerHTML = '<div style="color:var(--text-muted); font-size:0.85rem;">Select an execution to see its activity timeline and call tree.</div>';
  document.getElementById('mft-timeline-body').innerHTML = '';
  document.getElementById('mft-tree-content').innerHTML = '';
  document.getElementById('mft-raw-content').textContent = '';
  const fileInput = document.getElementById('mft-file-input');
  if (fileInput) fileInput.value = '';
};
