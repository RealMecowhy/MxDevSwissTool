// =========================================================================
// PERFORMANCE LAB — REST LOAD TESTER · prefix `pl`
// =========================================================================
// Two engines, one set of charts. The BROWSER engine is the zero-setup path:
// it fetches straight from the tab, which costs it the browser's ~6 connections
// per host — fine for a smoke test, useless above that, because past the limit
// you are measuring Chrome's queue and not the Mendix app. The SERVER engine
// runs in the Bridge as a session (server/perf-session.js) and is the only one
// that can do the two things a real load test needs: run without a known end,
// and change the thread count while traffic flows.
//
// Everything downstream of "how did the request go" is shared. Both engines
// produce the same VIEW MODEL — tiles, four charts, CSV — so a change to a
// chart is made once. The engines differ in where the numbers come from:
//
//   • browser: every sample is in the tab, so percentiles are EXACT.
//   • server: an unbounded run cannot keep every sample, so percentiles come
//     from a fixed-bin histogram and are accurate to a bin width. The UI says
//     so rather than pretending otherwise.
// =========================================================================

const PL_AGENT_URL = 'http://localhost:9999';
const PL_SCATTER_MAX = 2000;   // points drawn; older ones stay in plResults for CSV
const PL_EXPORT_MAX = 50000;   // samples retained for CSV on a long continuous run

let plStopFlag = false;
let plActiveCount = 0;
let plResults = [];
let plCharts = {};
let plLastChartUpdate = 0;
let plTestStartTime = 0;

let plSession = null;      // { id, sinceBucket, sinceSample } while a server run is live
let plBuckets = [];        // accumulated per-second buckets from the server
let plAdjustTimer = null;
let plSampleGap = false;

// Mirrors telemetry/charts.js's tmGetChartColors — same data-theme detection,
// same shape. The axis/title/legend colors were previously hardcoded dark-theme
// values (#333/#aaa/#fff), invisible on the light theme; the dataset accent
// colors (pink/blue/yellow/status palette) stay fixed since they're saturated
// enough to read on either background.
function plGetChartColors() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    gridColor: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)',
    textColor: isDark ? '#b3b3b3' : '#666666',
    titleColor: isDark ? '#ffffff' : '#1a1a1a',
  };
}

function plEl(id) { return document.getElementById(id); }

// =========================================================================
// CHARTS
// =========================================================================

function plInitCharts() {
  ['timeline', 'throughput', 'histogram', 'status'].forEach(id => {
    if (plCharts[id]) {
      plCharts[id].destroy();
      plCharts[id] = null;
    }
  });

  if (typeof Chart === 'undefined') return;

  const c = plGetChartColors();
  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { display: false } },
    scales: { x: { grid: { color: c.gridColor }, ticks: { color: c.textColor } }, y: { grid: { color: c.gridColor }, ticks: { color: c.textColor } } }
  };

  const timelineCtx = plEl('pl-chart-timeline');
  if (timelineCtx) {
    plCharts['timeline'] = new Chart(timelineCtx, {
      type: 'scatter',
      data: { datasets: [{ label: 'Response Time', data: [], backgroundColor: '#e84393' }] },
      options: {
        ...commonOptions,
        plugins: { ...commonOptions.plugins, title: { display: true, text: 'Response Time over Time (ms)', color: c.titleColor } },
        scales: { x: { title: { display: true, text: 'Time since start (s)', color: c.textColor }, ...commonOptions.scales.x }, y: { title: { display: true, text: 'Latency (ms)', color: c.textColor }, ...commonOptions.scales.y, beginAtZero: true } }
      }
    });
  }

  // Throughput carries a second series — the thread count — on its own axis.
  // That pairing is the whole point of the live slider: the moment RPS stops
  // following the threads up, while latency climbs, is the app's knee.
  const throughputCtx = plEl('pl-chart-throughput');
  if (throughputCtx) {
    plCharts['throughput'] = new Chart(throughputCtx, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          { label: 'Requests/sec', data: [], backgroundColor: '#0984e3', order: 2 },
          { type: 'line', label: 'Threads', data: [], borderColor: '#e17055', backgroundColor: '#e17055', borderWidth: 2, pointRadius: 0, yAxisID: 'y1', order: 1 }
        ]
      },
      options: {
        ...commonOptions,
        plugins: {
          legend: { display: true, position: 'bottom', labels: { color: c.textColor, boxWidth: 12 } },
          title: { display: true, text: 'Throughput & Threads', color: c.titleColor }
        },
        scales: {
          x: { ...commonOptions.scales.x },
          y: { ...commonOptions.scales.y, beginAtZero: true, title: { display: true, text: 'req/s', color: c.textColor } },
          y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { color: c.textColor, precision: 0 }, title: { display: true, text: 'threads', color: c.textColor } }
        }
      }
    });
  }

  const histogramCtx = plEl('pl-chart-histogram');
  if (histogramCtx) {
    plCharts['histogram'] = new Chart(histogramCtx, {
      type: 'bar',
      data: { labels: [], datasets: [{ label: 'Requests', data: [], backgroundColor: '#fdcb6e' }] },
      options: {
        ...commonOptions,
        plugins: { ...commonOptions.plugins, title: { display: true, text: 'Latency Distribution', color: c.titleColor } },
        scales: { x: { ...commonOptions.scales.x }, y: { ...commonOptions.scales.y, beginAtZero: true } }
      }
    });
  }

  const statusCtx = plEl('pl-chart-status');
  if (statusCtx) {
    plCharts['status'] = new Chart(statusCtx, {
      type: 'doughnut',
      data: { labels: [], datasets: [{ data: [], backgroundColor: ['#00b894', '#d63031', '#feca57', '#a29bfe', '#636e72'] }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { position: 'right', labels: { color: c.textColor } }, title: { display: true, text: 'Status Codes', color: c.titleColor } }
      }
    });
  }
}

// Regroups any list of [loMs, hiMs, count] ranges into at most 12 display bars.
// Both engines feed this: the server sends its fixed histogram bins, the browser
// engine sends one range per raw measurement.
function plHistBars(hist) {
  if (!hist || hist.length === 0) return { labels: [], data: [] };
  let lo = Infinity, hi = 0;
  hist.forEach(h => { if (h[0] < lo) lo = h[0]; if (h[1] > hi) hi = h[1]; });
  if (hi <= lo) hi = lo + 1;

  const bars = Math.min(12, Math.max(1, hist.length));
  const width = (hi - lo) / bars;
  const counts = new Array(bars).fill(0);
  hist.forEach(h => {
    const mid = (h[0] + h[1]) / 2;
    let idx = Math.floor((mid - lo) / width);
    if (idx < 0) idx = 0;
    if (idx >= bars) idx = bars - 1;
    counts[idx] += h[2];
  });

  const labels = counts.map((_, i) => {
    const a = Math.round(lo + i * width);
    const b = Math.round(lo + (i + 1) * width);
    return `${a}-${b}ms`;
  });
  return { labels, data: counts };
}

function plRenderCharts(vm) {
  if (!plCharts['timeline']) return;

  const scatter = vm.samples.slice(-PL_SCATTER_MAX).map(s => ({ x: +(s.t / 1000).toFixed(2), y: s.ms }));
  plCharts['timeline'].data.datasets[0].data = scatter;
  plCharts['timeline'].update();

  if (plCharts['throughput']) {
    plCharts['throughput'].data.labels = vm.buckets.map(b => b.sec + 's');
    plCharts['throughput'].data.datasets[0].data = vm.buckets.map(b => b.n);
    plCharts['throughput'].data.datasets[1].data = vm.buckets.map(b => b.threads);
    plCharts['throughput'].update();
  }

  if (plCharts['histogram']) {
    const bars = plHistBars(vm.hist);
    plCharts['histogram'].data.labels = bars.labels;
    plCharts['histogram'].data.datasets[0].data = bars.data;
    plCharts['histogram'].update();
  }

  if (plCharts['status']) {
    plCharts['status'].data.labels = Object.keys(vm.statusCounts);
    plCharts['status'].data.datasets[0].data = Object.values(vm.statusCounts);
    plCharts['status'].update();
  }
}

// =========================================================================
// VIEW MODEL
// =========================================================================

// Browser engine: every sample is in memory, so the percentiles are exact and
// the histogram is built from the raw measurements.
function plVmFromResults() {
  const times = plResults.filter(r => typeof r.time === 'number').map(r => r.time);
  const sorted = times.slice().sort((a, b) => a - b);
  const pct = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p / 100 * (sorted.length - 1)))] : 0;

  const statusCounts = {};
  plResults.forEach(r => {
    const k = String(r.status);
    statusCounts[k] = (statusCounts[k] || 0) + 1;
  });

  const buckets = {};
  plResults.forEach(r => {
    if (typeof r.end !== 'number') return;
    const sec = Math.floor(r.end / 1000);
    if (!buckets[sec]) buckets[sec] = { sec, n: 0, errs: 0, threads: plTargetConcurrency() };
    buckets[sec].n++;
    if (r.status === 'Error' || r.status >= 400) buckets[sec].errs++;
  });
  const bucketList = [];
  const maxSec = Math.max(-1, ...Object.keys(buckets).map(Number));
  for (let i = 0; i <= maxSec; i++) bucketList.push(buckets[i] || { sec: i, n: 0, errs: 0, threads: plTargetConcurrency() });

  const elapsedMs = plResults.length ? Math.max(...plResults.map(r => r.end)) : 0;

  return {
    sent: plResults.length,
    completed: plResults.length,
    errors: plResults.filter(r => r.status === 'Error' || r.status >= 400).length,
    min: sorted.length ? sorted[0] : 0,
    max: sorted.length ? sorted[sorted.length - 1] : 0,
    avg: times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0,
    p50: pct(50), p95: pct(95), p99: pct(99),
    rps: elapsedMs > 0 ? +(plResults.length / (elapsedMs / 1000)).toFixed(2) : 0,
    rpsRecent: null,
    activeWorkers: plActiveCount,
    exact: true,
    statusCounts,
    buckets: bucketList,
    samples: plResults.map(r => ({ t: r.start - plTestStartTime, ms: r.time })),
    hist: times.map(t => [t, t + 1, 1])
  };
}

function plVmFromStats(stats) {
  return {
    sent: stats.sent,
    completed: stats.completed,
    errors: stats.errors,
    min: stats.min, max: stats.max, avg: stats.avg,
    p50: stats.p50, p95: stats.p95, p99: stats.p99,
    rps: stats.rps,
    rpsRecent: stats.rpsRecent,
    activeWorkers: stats.activeWorkers,
    exact: false,
    statusCounts: stats.statusCounts,
    buckets: plBuckets,
    samples: plResults.map(r => ({ t: r.start, ms: r.time })),
    hist: stats.hist
  };
}

function plRenderTiles(vm) {
  const set = (id, text) => { const el = plEl(id); if (el) el.innerText = text; };
  set('pl-stats-req', vm.sent);
  set('pl-stats-err', vm.errors);
  set('pl-stats-min', vm.min.toFixed(1) + ' ms');
  set('pl-stats-avg', vm.avg.toFixed(1) + ' ms');
  set('pl-stats-max', vm.max.toFixed(1) + ' ms');
  set('pl-stats-p50', vm.p50.toFixed(1) + ' ms');
  set('pl-stats-p95', vm.p95.toFixed(1) + ' ms');
  set('pl-stats-p99', vm.p99.toFixed(1) + ' ms');
  set('pl-stats-rps', (vm.rpsRecent !== null && vm.rpsRecent !== undefined ? vm.rpsRecent : vm.rps).toFixed(1));
  set('pl-stats-threads', vm.activeWorkers);

  const note = plEl('pl-pct-note');
  if (note) note.style.display = vm.exact ? 'none' : 'inline';
}

function plRender(vm, force) {
  plRenderTiles(vm);
  const now = performance.now();
  if (force || now - plLastChartUpdate > 900) {
    plRenderCharts(vm);
    plLastChartUpdate = now;
  }
}

// =========================================================================
// CONFIG READING
// =========================================================================

function plTargetConcurrency() {
  const el = plEl('pl-concurrency');
  return el ? (parseInt(el.value, 10) || 1) : 1;
}

// Mirrors isPrivateOrLocalHost in server/perf-session.js. It has to agree with
// the Bridge, or the confirmation checkbox would be hidden for a target the
// Bridge then refuses to start.
function plIsExternalTarget(rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch (e) {
    return false;
  }
  if (host === 'localhost' || host === '::1') return false;
  if (host.endsWith('.local') || host.endsWith('.localhost')) return false;

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const o = [+m[1], +m[2], +m[3], +m[4]];
    if (o.some(n => n > 255)) return true;
    if (o[0] === 127 || o[0] === 10) return false;
    if (o[0] === 192 && o[1] === 168) return false;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false;
    if (o[0] === 169 && o[1] === 254) return false;
    return true;
  }
  return host.indexOf('.') !== -1;
}

function plReadConfig() {
  const url = plEl('pl-url').value.trim();
  const method = plEl('pl-method').value;
  if (!url) {
    plShowError('Enter a target URL.');
    return null;
  }

  let headers = {};
  const headersStr = plEl('pl-headers').value.trim();
  if (headersStr) {
    try {
      headers = JSON.parse(headersStr);
    } catch (e) {
      plShowError('Headers must be a valid JSON object.');
      return null;
    }
  }

  let body;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    const bodyStr = plEl('pl-body').value.trim();
    if (bodyStr) body = bodyStr;
  }

  const runmode = plEl('pl-runmode') ? plEl('pl-runmode').value : 'count';
  const confirmEl = plEl('pl-confirm-external');
  return {
    url, method, headers, body,
    mode: runmode,
    count: parseInt(plEl('pl-count').value, 10) || 1,
    concurrency: plTargetConcurrency(),
    confirmExternal: !!(confirmEl && confirmEl.checked)
  };
}

function plShowError(msg) {
  const box = plEl('pl-error');
  if (!box) return;
  box.innerHTML = msg;
  box.style.display = 'block';
}

function plClearError() {
  const box = plEl('pl-error');
  if (box) box.style.display = 'none';
}

// =========================================================================
// RUN CONTROL
// =========================================================================

function plStart() {
  const cfg = plReadConfig();
  if (!cfg) return;

  plClearError();
  plStopFlag = false;
  plResults = [];
  plBuckets = [];
  plSampleGap = false;
  plSession = null;
  plTestStartTime = performance.now();
  plLastChartUpdate = 0;

  plEl('pl-empty-state').style.display = 'none';
  plEl('pl-results-content').style.display = 'flex';
  const exportBtn = plEl('pl-btn-export');
  if (exportBtn) exportBtn.style.display = 'none';

  plEl('pl-btn-start').style.display = 'none';
  plEl('pl-btn-stop').style.display = 'inline-block';
  plInitCharts();

  const engine = plEl('pl-engine') ? plEl('pl-engine').value : 'browser';
  if (engine === 'server') plStartServerRun(cfg);
  else plStartBrowserRun(cfg);
}

// ── Browser engine: fixed count only, capped by the browser's connection pool ──
function plStartBrowserRun(cfg) {
  plEl('pl-status').innerText = 'Running in browser…';

  const fetchOpts = { method: cfg.method, mode: 'cors', cache: 'no-store', headers: cfg.headers };
  if (cfg.body !== undefined) fetchOpts.body = cfg.body;

  let sent = 0;
  const count = cfg.count;

  const worker = () => {
    if (plStopFlag || sent >= count) return;
    const id = sent++;
    plActiveCount++;
    const t0 = performance.now();

    fetch(cfg.url, fetchOpts)
      .then(res => {
        const t1 = performance.now();
        plResults.push({ id, time: t1 - t0, status: res.status, start: t0 - plTestStartTime, end: t1 - plTestStartTime });
      })
      .catch(() => {
        const t1 = performance.now();
        const duration = t1 - t0;
        plResults.push({ id, time: duration, status: 'Error', start: t0 - plTestStartTime, end: t1 - plTestStartTime });
        if (duration < 150) {
          plShowError('<strong>Potential CORS issue.</strong> Requests failed immediately without a status code. Either the target must allow this origin, or switch the engine to <b>Server (Bridge)</b>, which is not bound by CORS.');
        }
      })
      .finally(() => {
        plActiveCount--;
        plRender(plVmFromResults(), false);
        if (sent < count && !plStopFlag) worker();
        else if (plActiveCount === 0) plFinish();
      });
  };

  for (let i = 0; i < cfg.concurrency; i++) worker();
}

// ── Server engine: a session in the Bridge, polled once a second ──
async function plStartServerRun(cfg) {
  plEl('pl-status').innerText = 'Starting on Bridge…';
  try {
    // The Bridge token is added by the global fetch wrapper in index.html, the
    // same way every other tool reaches the Bridge.
    const res = await fetch(`${PL_AGENT_URL}/perf/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg)
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      plShowError(data.message || 'The Bridge refused to start the load test.');
      return plFinish();
    }
    plSession = { id: data.sessionId, sinceBucket: 0, sinceSample: 0 };
    if (data.concurrency !== cfg.concurrency) {
      plShowError(`Thread count capped at ${data.concurrency} — ${data.externalTarget ? 'an external target is limited for safety' : 'that is the engine maximum'}.`);
      plSetConcurrency(data.concurrency);
    }
    plEl('pl-status').innerText = cfg.mode === 'continuous' ? 'Running (continuous) — move the slider to retune' : 'Running on Bridge…';
    plPoll();
  } catch (e) {
    plShowError('Cannot reach the Observability Bridge on ' + PL_AGENT_URL + '. Start it with <code>npm start</code>.');
    plFinish();
  }
}

async function plPoll() {
  if (!plSession) return;
  try {
    const res = await fetch(`${PL_AGENT_URL}/perf/stats?sessionId=${plSession.id}&sinceBucket=${plSession.sinceBucket}&sinceSample=${plSession.sinceSample}`);
    const stats = await res.json();
    if (!res.ok || !stats.success) {
      plShowError(stats.message || 'Lost contact with the load test session.');
      return plFinish();
    }

    plSession.sinceBucket = stats.nextBucket;
    plSession.sinceSample = stats.nextSample;
    if (stats.sampleGap) plSampleGap = true;

    stats.buckets.forEach(b => { plBuckets[b.sec] = b; });
    for (let i = 0; i < plBuckets.length; i++) {
      if (!plBuckets[i]) plBuckets[i] = { sec: i, n: 0, errs: 0, avg: 0, max: 0, threads: 0 };
    }

    stats.samples.forEach(s => {
      plResults.push({ id: s.id, time: s.ms, status: s.status, start: s.t, end: s.t + s.ms });
    });
    if (plResults.length > PL_EXPORT_MAX) plResults.splice(0, plResults.length - PL_EXPORT_MAX);

    const running = stats.session.running;
    plRender(plVmFromStats(stats), !running);

    if (running) {
      setTimeout(plPoll, 1000);
    } else {
      if (stats.stopReason && stats.stopReason.indexOf('Auto-stopped') === 0) plShowError(stats.stopReason);
      plFinish();
    }
  } catch (e) {
    plShowError('Lost contact with the Bridge while polling: ' + e.message);
    plFinish();
  }
}

function plStop() {
  plStopFlag = true;
  plEl('pl-status').innerText = 'Stopping…';
  if (plSession) {
    fetch(`${PL_AGENT_URL}/perf/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: plSession.id })
    }).catch(() => {});
  }
}

// A server run's closing poll already rendered the authoritative numbers — its
// aggregates cover every request, while plResults only holds what the sample
// buffer delivered. Re-rendering from plResults here would quietly replace
// them with a partial view.
function plFinish() {
  const wasServerRun = plSession !== null;
  plSession = null;
  plEl('pl-btn-start').style.display = 'inline-block';
  plEl('pl-btn-stop').style.display = 'none';
  plEl('pl-status').innerText = 'Completed.';
  const exportBtn = plEl('pl-btn-export');
  if (exportBtn && plResults.length > 0) exportBtn.style.display = 'inline-block';
  if (!wasServerRun && plResults.length > 0) plRender(plVmFromResults(), true);
}

// =========================================================================
// LIVE CONTROLS
// =========================================================================

function plSetConcurrency(n) {
  const slider = plEl('pl-concurrency');
  const label = plEl('pl-concurrency-val');
  if (slider) slider.value = n;
  if (label) label.innerText = n;
}

// A slider drag fires continuously; retuning the pool on every pixel would
// spawn and retire workers faster than they complete a request.
function plConcurrencyInput() {
  const n = plTargetConcurrency();
  const label = plEl('pl-concurrency-val');
  if (label) label.innerText = n;
  plCheckConcurrency();

  if (!plSession) return;
  if (plAdjustTimer) clearTimeout(plAdjustTimer);
  plAdjustTimer = setTimeout(() => {
    if (!plSession) return;
    fetch(`${PL_AGENT_URL}/perf/adjust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: plSession.id, concurrency: n })
    }).catch(() => {});
  }, 200);
}

// The slider ceiling is the honest limit of the selected engine, not a taste
// setting: 6 connections per host in a browser, 25 against an external target,
// 100 locally.
function plSyncSliderRange() {
  const slider = plEl('pl-concurrency');
  if (!slider) return;
  const engine = plEl('pl-engine') ? plEl('pl-engine').value : 'browser';
  const external = plIsExternalTarget(plEl('pl-url').value.trim());
  const max = engine === 'browser' ? 20 : (external ? 25 : 100);
  slider.max = max;
  if (parseInt(slider.value, 10) > max) plSetConcurrency(max);

  const confirmRow = plEl('pl-confirm-row');
  if (confirmRow) confirmRow.style.display = (engine === 'server' && external) ? 'flex' : 'none';
}

window.plMethodChanged = function () {
  const method = plEl('pl-method').value;
  plEl('pl-body-group').style.display = (method === 'POST' || method === 'PUT' || method === 'PATCH') ? 'block' : 'none';
};

function plCheckConcurrency() {
  const conc = plTargetConcurrency();
  const warn = plEl('pl-concurrency-warn');
  const engine = plEl('pl-engine') ? plEl('pl-engine').value : 'browser';
  if (warn) warn.style.display = (conc > 6 && engine === 'browser') ? 'inline-block' : 'none';
}

// Continuous runs and live retuning both need a session, which only the Bridge
// engine has — so picking one implies the other rather than failing later.
function plRunModeChanged() {
  const runmode = plEl('pl-runmode').value;
  const engine = plEl('pl-engine');
  const countGroup = plEl('pl-count-group');
  if (runmode === 'continuous') {
    engine.value = 'server';
    engine.disabled = true;
    if (countGroup) countGroup.style.display = 'none';
  } else {
    engine.disabled = false;
    if (countGroup) countGroup.style.display = 'block';
  }
  plSyncSliderRange();
  plCheckConcurrency();
  plSyncLiveHint();
}

function plEngineChanged() {
  plSyncSliderRange();
  plCheckConcurrency();
  plSyncLiveHint();
}

function plSyncLiveHint() {
  const hint = plEl('pl-live-hint');
  if (!hint) return;
  const engine = plEl('pl-engine') ? plEl('pl-engine').value : 'browser';
  hint.style.display = engine === 'server' ? 'block' : 'none';
}

// =========================================================================
// PRESETS & EXPORT
// =========================================================================

window.plSavePreset = function () {
  const preset = {
    url: plEl('pl-url').value,
    method: plEl('pl-method').value,
    headers: plEl('pl-headers').value,
    body: plEl('pl-body').value,
    conc: plTargetConcurrency(),
    count: plEl('pl-count').value,
    engine: plEl('pl-engine') ? plEl('pl-engine').value : 'browser',
    runmode: plEl('pl-runmode') ? plEl('pl-runmode').value : 'count'
  };
  localStorage.setItem('perfLabPreset', JSON.stringify(preset));
  alert('Preset saved to browser memory.');
};

window.plLoadPreset = function () {
  const saved = localStorage.getItem('perfLabPreset');
  if (!saved) return alert('No preset found in memory.');
  try {
    const preset = JSON.parse(saved);
    if (preset.url) plEl('pl-url').value = preset.url;
    if (preset.method) { plEl('pl-method').value = preset.method; window.plMethodChanged(); }
    if (preset.headers) plEl('pl-headers').value = preset.headers;
    if (preset.body) plEl('pl-body').value = preset.body;
    if (preset.count) plEl('pl-count').value = preset.count;
    if (preset.engine && plEl('pl-engine')) plEl('pl-engine').value = preset.engine;
    if (preset.runmode && plEl('pl-runmode')) plEl('pl-runmode').value = preset.runmode;
    plRunModeChanged();
    if (preset.conc) plSetConcurrency(preset.conc);
    plCheckConcurrency();
  } catch (e) {
    alert('Failed to load preset');
  }
};

window.plExportCSV = function () {
  if (plResults.length === 0) return alert('No results to export.');
  let csv = '';
  if (plSampleGap) csv += '# NOTE: the run outpaced the sample buffer — some individual samples are missing. Aggregates in the UI cover every request.\n';
  csv += 'RequestID,LatencyMs,StatusCode,StartMsSinceTestStart,EndMsSinceTestStart\n';
  plResults.forEach(r => {
    csv += `${r.id},${Math.round(r.time)},${r.status},${Math.round(r.start)},${Math.round(r.end)}\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `perf_lab_results_${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
};

// --- AUTO-GENERATED ESM EXPORTS ---
window.plStart = plStart;
window.plStop = plStop;
window.plFinish = plFinish;
window.plGetChartColors = plGetChartColors;
window.plCheckConcurrency = plCheckConcurrency;

export function init() {
  const slider = plEl('pl-concurrency');
  if (slider && !slider.dataset.plBound) {
    slider.dataset.plBound = '1';
    slider.addEventListener('input', plConcurrencyInput);
  }
  const runmode = plEl('pl-runmode');
  if (runmode && !runmode.dataset.plBound) {
    runmode.dataset.plBound = '1';
    runmode.addEventListener('change', plRunModeChanged);
  }
  const engine = plEl('pl-engine');
  if (engine && !engine.dataset.plBound) {
    engine.dataset.plBound = '1';
    engine.addEventListener('change', plEngineChanged);
  }
  const urlInput = plEl('pl-url');
  if (urlInput && !urlInput.dataset.plBound) {
    urlInput.dataset.plBound = '1';
    urlInput.addEventListener('input', plSyncSliderRange);
  }
  plSyncSliderRange();
  plSyncLiveHint();
}
