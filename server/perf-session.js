"use strict";

// =========================================================================
// PERF LAB — LOAD TEST SESSION ENGINE
// =========================================================================
// The old /api/perf-test route fired N requests and answered once, at the end.
// That shape makes two things impossible: a run without a known end, and
// changing the thread count while traffic is flowing — which is exactly how a
// load test finds the knee where a Mendix app stops scaling. So a run is a
// SESSION here: start it, poll it, retune it, stop it.
//
// Three decisions carry the design:
//
//   1. THREAD COUNT IS A TARGET, NOT A LOOP BOUND. Workers are anonymous; a
//      supervisor tick compares how many are alive to the target and either
//      spawns the difference or sets a retire budget that the next workers to
//      finish a request consume. Nothing is interrupted mid-request, so the
//      slider never poisons a latency sample.
//
//   2. AGGREGATION LIVES HERE, NOT IN THE BROWSER. A continuous run has no
//      bound, so keeping every sample is an out-of-memory bug with a delay
//      fuse. What survives the whole run is O(1): per-second buckets, a
//      fixed-bin latency histogram, status counts, exact min/max. Raw samples
//      live in a ring only long enough to be handed to the poller once.
//
//   3. PERCENTILES COME FROM THE HISTOGRAM, so they are accurate to a bin
//      width (1 ms below 100 ms, 5 ms below 1 s, 50 ms below 10 s) rather than
//      to the sample. That is the price of an unbounded run and it is stated
//      in the UI — an exact p99 would require keeping every measurement.
//
// One session at a time: the UI drives a single test, and a second concurrent
// run would silently share the target's capacity and corrupt both results.
// =========================================================================

// The Message Factory renderer is loaded from the browser tree on purpose. The
// preview the user approves and the bytes actually sent have to come from ONE
// implementation — a second, server-side copy would drift, and the preview
// would quietly become a lie. Both files are plain scripts attaching their pure
// layer to `self`, which Node does not define; scripts/parser-test.js shims it
// the same way.
if (typeof global.self === 'undefined') global.self = global;
require('../public/js/tools/data-factory-generators.js');
require('../public/js/tools/perf-lab-messages.js');

// Ceilings are safety, not tuning. A private/local target may be hammered
// (that is the point of a dev tool), an external one may not — a laptop
// pointed at a cloud app is a traffic generator with somebody else's name on
// the invoice.
const MAX_CONCURRENCY_LOCAL = 200;
const MAX_CONCURRENCY_EXTERNAL = 25;
const MAX_COUNT = 1000000;
const SAMPLE_RING = 5000;      // enough for a 1 Hz poll to never miss a sample
const SUPERVISOR_MS = 200;

let session = null;
let nextId = 1;

// =========================================================================
// LATENCY HISTOGRAM (fixed bins, O(1) memory for an unbounded run)
// =========================================================================
const HIST_OVERFLOW = 460;

function histIndex(ms) {
  if (ms < 0) ms = 0;
  if (ms < 100) return Math.floor(ms);                 // 0..99    — 1 ms bins
  if (ms < 1000) return 100 + Math.floor((ms - 100) / 5);   // 100..279 — 5 ms
  if (ms < 10000) return 280 + Math.floor((ms - 1000) / 50); // 280..459 — 50 ms
  return HIST_OVERFLOW;
}

function histRange(i) {
  if (i < 100) return [i, i + 1];
  if (i < 280) return [100 + (i - 100) * 5, 100 + (i - 100) * 5 + 5];
  if (i < HIST_OVERFLOW) return [1000 + (i - 280) * 50, 1000 + (i - 280) * 50 + 50];
  return [10000, 10000];
}

// Rank-based lookup over cumulative bin counts. Returns the bin midpoint, so a
// reported value is never outside the bin the measurement actually fell in.
function histPercentile(hist, total, p) {
  if (!total) return 0;
  const target = Math.ceil(total * p / 100);
  let seen = 0;
  for (let i = 0; i <= HIST_OVERFLOW; i++) {
    const c = hist[i];
    if (!c) continue;
    seen += c;
    if (seen >= target) {
      const r = histRange(i);
      return i === HIST_OVERFLOW ? 10000 : (r[0] + r[1]) / 2;
    }
  }
  return 0;
}

// Only non-empty bins travel to the browser — a saturated run touches a few
// dozen of the 461, and the client needs the edges to group them for display.
function histSparse(hist) {
  const out = [];
  for (let i = 0; i <= HIST_OVERFLOW; i++) {
    if (!hist[i]) continue;
    const r = histRange(i);
    out.push([r[0], r[1], hist[i]]);
  }
  return out;
}

// =========================================================================
// SESSION LIFECYCLE
// =========================================================================

// Prefix matching on the raw host is not enough: `10.evil.com` starts with
// "10." and is a public name. An address only counts as private when it really
// is one — a valid private IPv4, loopback, or a name that cannot be public
// (single-label intranet host, .local, .localhost). Anything else is external
// and has to be confirmed; asking once is cheaper than a mistake.
function isPrivateOrLocalHost(host) {
  const h = String(host == null ? '' : host).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  if (h.endsWith('.local') || h.endsWith('.localhost')) return true;

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const o = [+m[1], +m[2], +m[3], +m[4]];
    if (o.some(n => n > 255)) return false;
    if (o[0] === 127 || o[0] === 10) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 169 && o[1] === 254) return true;
    return false;
  }

  // A single-label name has no public DNS meaning — it is an intranet host.
  return h.length > 0 && h.indexOf('.') === -1;
}

// Throws Error with .statusCode so the route can answer with the right status.
function fail(message, statusCode) {
  const e = new Error(message);
  e.statusCode = statusCode || 400;
  return e;
}

function startSession(config) {
  if (session && session.running) throw fail('A load test is already running. Stop it before starting another.', 409);
  if (typeof fetch === 'undefined') throw fail('Node.js version too old. fetch() is required.', 500);

  const targetUrl = String(config.url || '').trim();
  if (!targetUrl) throw fail('Missing url', 400);

  // The URL may be a template (/rest/orders/{orderId}). Braces are not legal in
  // a URL, so the host is read from a probe copy with the placeholders filled —
  // the real per-request URL is rendered later, and its host cannot differ:
  // placeholders only ever appear after the origin has been typed.
  const probeUrl = targetUrl.replace(/\{[^{}\s]+\}/g, '1');
  let host;
  try {
    host = new URL(probeUrl).hostname;
  } catch (e) {
    throw fail(`Not a valid URL: ${targetUrl}`, 400);
  }

  // The external-target gate. Confirmation is explicit and per-run, and it
  // still cannot lift the external thread ceiling — a confirmed run is an
  // authorized one, not an unbounded one.
  const local = isPrivateOrLocalHost(host);
  const envAllowed = process.env.MXDEV_ALLOW_EXTERNAL_PERFTEST === 'true';
  if (!local && !config.confirmExternal && !envAllowed) {
    throw fail(`${host} is not a local or private address. Tick "I am authorized to load-test this target" to run it, or start the Bridge with MXDEV_ALLOW_EXTERNAL_PERFTEST=true.`, 403);
  }

  const maxConc = local ? MAX_CONCURRENCY_LOCAL : MAX_CONCURRENCY_EXTERNAL;
  const concurrency = clampConcurrency(config.concurrency, maxConc);
  const mode = config.mode === 'continuous' ? 'continuous' : 'count';
  const count = mode === 'count' ? Math.min(Math.max(parseInt(config.count, 10) || 1, 1), MAX_COUNT) : Infinity;
  const method = String(config.method || 'GET').toUpperCase();

  const headers = {};
  if (config.headers && typeof config.headers === 'object') {
    Object.keys(config.headers).forEach(k => { headers[k] = String(config.headers[k]); });
  }

  const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';

  // Message Factory: compiled once here, rendered per request. Without it the
  // run falls back to the single static body, exactly as before.
  let compiledMessage = null;
  const spec = config.message;
  if (spec && (spec.source || spec.fields) && (spec.fields || []).length) {
    compiledMessage = global.plmCompile({
      kind: spec.kind,
      source: hasBody ? (spec.source || '') : '',
      fields: spec.fields,
      seed: spec.seed,
      urlTemplate: targetUrl
    });
    if (compiledMessage.error) throw fail(`Message template: ${compiledMessage.error}`, 400);
    // A generated JSON body sent as text/plain is a 415 that reads like the app
    // rejecting valid data. Only filled in when the user set nothing.
    const hasContentType = Object.keys(headers).some(h => h.toLowerCase() === 'content-type');
    const ct = hasBody ? global.plmContentType(compiledMessage.kind) : '';
    if (!hasContentType && ct) headers['Content-Type'] = ct;
  }

  session = {
    id: String(nextId++),
    running: true,
    stopFlag: false,
    stopReason: '',
    url: targetUrl,
    method,
    headers,
    body: hasBody && config.body ? String(config.body) : undefined,
    message: compiledMessage,
    hasBody,
    timeoutMs: Math.min(Math.max(parseInt(config.timeoutMs, 10) || 30000, 1000), 300000),
    mode,
    count,
    maxConcurrency: maxConc,
    externalTarget: !local,
    target: concurrency,
    workers: 0,
    retire: 0,
    startedAt: Date.now(),
    endedAt: 0,
    sent: 0,
    completed: 0,
    errors: 0,
    minMs: Infinity,
    maxMs: 0,
    sumMs: 0,
    statusCounts: {},
    hist: new Array(HIST_OVERFLOW + 1).fill(0),
    buckets: [],
    samples: [],
    sampleSeq: 0,
    oldestSeq: 1,
    lastPollAt: Date.now(),
    supervisor: null
  };

  session.supervisor = setInterval(superviseTick, SUPERVISOR_MS);
  superviseTick();
  return publicState(session);
}

function clampConcurrency(v, max) {
  const n = parseInt(v, 10);
  if (!isFinite(n) || n < 1) return 1;
  return Math.min(n, max);
}

// Reconciles live workers with the target. Growing spawns immediately; shrinking
// only sets a budget, because a worker mid-request must finish it — an aborted
// request is not a faster one, it is a missing sample.
// A continuous run has no end of its own, so a closed browser tab would leave
// the Bridge hammering the target indefinitely. The 1 Hz poll doubles as a dead
// man's switch.
// 90 s, not 15 s: browsers throttle timers in a hidden tab to roughly one firing
// per minute, so the 1 Hz poll legitimately goes quiet for ~60 s the moment the
// user switches tabs. At 15 s the switch fired on a perfectly healthy run and
// killed it with "the browser stopped polling for results" — the dead man's
// switch has to outlast the throttle it is being judged against. A genuinely
// closed tab still stops the run, just 90 s later.
const POLL_TIMEOUT_MS = 90000;

function superviseTick() {
  const s = session;
  if (!s) return;

  if (s.running && !s.stopFlag && Date.now() - s.lastPollAt > POLL_TIMEOUT_MS) {
    s.stopFlag = true;
    s.stopReason = 'Auto-stopped: the browser stopped polling for results.';
  }

  // A count run that has handed out its last request must not be topped up —
  // spawning workers that exit on their first check would spin every tick.
  const exhausted = s.mode === 'count' && s.sent >= s.count;
  if (!s.stopFlag && !exhausted) {
    const deficit = s.target - s.workers;
    if (deficit > 0) {
      for (let i = 0; i < deficit; i++) {
        s.workers++;
        runWorker(s);
      }
      s.retire = 0;
    } else if (deficit < 0) {
      s.retire = -deficit;
    }
  }

  // Idle seconds are real data — a bucket missing from the timeline would draw
  // a throughput dip as if it never happened.
  touchBucket(s, Date.now());

  if (s.workers === 0 && (s.stopFlag || (s.mode === 'count' && s.sent >= s.count))) {
    finishSession(s);
  }
}

function bucketAt(s, at) {
  const idx = Math.floor((at - s.startedAt) / 1000);
  while (s.buckets.length <= idx) {
    s.buckets.push({ sec: s.buckets.length, n: 0, errs: 0, sum: 0, min: Infinity, max: 0, threads: s.target });
  }
  return s.buckets[idx];
}

function touchBucket(s, at) {
  const b = bucketAt(s, at);
  if (s.target > b.threads) b.threads = s.target;
}

async function runWorker(s) {
  try {
    while (true) {
      if (s.stopFlag) break;
      if (s.retire > 0) { s.retire--; break; }
      if (s.mode === 'count' && s.sent >= s.count) break;

      const id = s.sent++;

      // Each request gets its own message and its own URL. The request index is
      // the generator's row index, so a re-run with the same seed reproduces
      // request N byte for byte regardless of how threads interleaved.
      let url = s.url;
      let body = s.body;
      if (s.message) {
        const rendered = global.plmRender(s.message, id);
        url = rendered.url;
        if (s.hasBody) body = rendered.body;
      }

      const t0 = Date.now();
      let status;
      try {
        const opts = { method: s.method, headers: s.headers, signal: AbortSignal.timeout(s.timeoutMs) };
        if (body !== undefined) opts.body = body;
        const r = await fetch(url, opts);
        // The body has to be drained or the connection is not really done, and
        // every latency after it would be measured against a stalled pool.
        await r.arrayBuffer().catch(() => null);
        status = r.status;
      } catch (err) {
        status = err && err.name === 'TimeoutError' ? 'Timeout' : 'Error';
      }
      record(s, id, t0, Date.now(), status);
    }
  } finally {
    s.workers--;
  }
}

function record(s, id, t0, t1, status) {
  const ms = t1 - t0;
  const failed = status === 'Error' || status === 'Timeout' || (typeof status === 'number' && status >= 400);

  s.completed++;
  if (failed) s.errors++;
  s.sumMs += ms;
  if (ms < s.minMs) s.minMs = ms;
  if (ms > s.maxMs) s.maxMs = ms;
  s.hist[histIndex(ms)]++;

  const key = String(status);
  s.statusCounts[key] = (s.statusCounts[key] || 0) + 1;

  const b = bucketAt(s, t1);
  b.n++;
  if (failed) b.errs++;
  b.sum += ms;
  if (ms < b.min) b.min = ms;
  if (ms > b.max) b.max = ms;
  if (s.target > b.threads) b.threads = s.target;

  s.samples.push({ seq: ++s.sampleSeq, id, t: t0 - s.startedAt, ms, status: key });
  if (s.samples.length > SAMPLE_RING) {
    s.samples.splice(0, s.samples.length - SAMPLE_RING);
    s.oldestSeq = s.samples[0].seq;
  }
}

function finishSession(s) {
  if (!s.running) return;
  s.running = false;
  s.endedAt = Date.now();
  if (s.supervisor) {
    clearInterval(s.supervisor);
    s.supervisor = null;
  }
}

function publicState(s) {
  return {
    sessionId: s.id,
    running: s.running,
    mode: s.mode,
    concurrency: s.target,
    maxConcurrency: s.maxConcurrency,
    externalTarget: s.externalTarget,
    count: s.mode === 'count' ? s.count : null
  };
}

// =========================================================================
// PUBLIC API (one route each)
// =========================================================================

function requireSession(id) {
  if (!session || (id && String(id) !== session.id)) throw fail('No such load test session. It may have been stopped already.', 404);
  return session;
}

function adjust(id, concurrency) {
  const s = requireSession(id);
  if (!s.running) throw fail('This load test has already finished.', 409);
  s.target = clampConcurrency(concurrency, s.maxConcurrency);
  touchBucket(s, Date.now());
  superviseTick();
  return publicState(s);
}

function stop(id) {
  const s = requireSession(id);
  s.stopFlag = true;
  s.stopReason = 'Stopped by user';
  superviseTick();
  return publicState(s);
}

function getStats(id, sinceBucket, sinceSample) {
  const s = requireSession(id);
  s.lastPollAt = Date.now();
  const from = Math.max(parseInt(sinceBucket, 10) || 0, 0);
  const fromSeq = Math.max(parseInt(sinceSample, 10) || 0, 0);

  const elapsedMs = (s.endedAt || Date.now()) - s.startedAt;
  const completed = s.completed;

  // While running, closed buckets only — the current second is still filling and
  // would draw a fake throughput collapse at the right edge on every poll. Once
  // the run is over there is nothing left to fill, so the final partial second
  // is flushed: without it a run shorter than two seconds would leave the
  // throughput chart completely empty.
  const lastClosed = s.running ?
    Math.floor((Date.now() - s.startedAt) / 1000) - 1 :
    s.buckets.length - 1;
  const buckets = [];
  for (let i = from; i <= lastClosed && i < s.buckets.length; i++) {
    const b = s.buckets[i];
    buckets.push({
      sec: b.sec,
      n: b.n,
      errs: b.errs,
      avg: b.n ? +(b.sum / b.n).toFixed(1) : 0,
      max: b.max,
      threads: b.threads
    });
  }

  const newSamples = [];
  let gap = false;
  for (let i = 0; i < s.samples.length; i++) {
    if (s.samples[i].seq > fromSeq) newSamples.push(s.samples[i]);
  }
  if (fromSeq > 0 && s.oldestSeq > fromSeq + 1) gap = true;

  // Throughput over the last 5 closed seconds — an average over the whole run
  // lags too far behind to show what a slider move just did.
  let recentN = 0, recentSecs = 0;
  for (let i = Math.max(0, lastClosed - 4); i <= lastClosed && i < s.buckets.length; i++) {
    recentN += s.buckets[i].n;
    recentSecs++;
  }

  return {
    session: publicState(s),
    stopReason: s.stopReason,
    elapsedMs,
    sent: s.sent,
    completed,
    errors: s.errors,
    activeWorkers: s.workers,
    min: completed ? s.minMs : 0,
    max: completed ? s.maxMs : 0,
    avg: completed ? +(s.sumMs / completed).toFixed(1) : 0,
    p50: histPercentile(s.hist, completed, 50),
    p90: histPercentile(s.hist, completed, 90),
    p95: histPercentile(s.hist, completed, 95),
    p99: histPercentile(s.hist, completed, 99),
    rps: elapsedMs > 0 ? +(completed / (elapsedMs / 1000)).toFixed(2) : 0,
    // Before the first second closes there is no recent window yet — falling
    // back to the run average beats showing a hard 0 next to live traffic.
    rpsRecent: recentSecs ? +(recentN / recentSecs).toFixed(2) : (elapsedMs > 0 ? +(completed / (elapsedMs / 1000)).toFixed(2) : 0),
    statusCounts: s.statusCounts,
    hist: histSparse(s.hist),
    buckets,
    nextBucket: Math.max(from, lastClosed + 1),
    samples: newSamples,
    nextSample: s.sampleSeq,
    sampleGap: gap
  };
}

// Called when the bridge shuts down or a stale session outlives its UI tab.
function disposeAll() {
  if (session) {
    session.stopFlag = true;
    finishSession(session);
    session = null;
  }
}

module.exports = {
  startSession,
  adjust,
  stop,
  getStats,
  disposeAll,
  // exported for scripts/parser-test.js
  histIndex,
  histRange,
  histPercentile,
  isPrivateOrLocalHost
};
