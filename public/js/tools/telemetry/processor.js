import { tmParsePrometheusText } from './parsers/prometheus.js';
import { tmDeriveSample } from './derive.js';
import { state } from './state.js';
import { tmUpdateChartsUI } from './charts.js';
import { tmCheckThresholds } from './alerts.js';

export function tmProcessMetrics(textData) {
  const parsed = tmParsePrometheusText(textData);
  tmProcessParsedMetrics(parsed);
}

// A card shows a dash where there is no measurement; 0 would read as "measured,
// and nothing".
const dash = (v, fmt) => (v === null || v === undefined ? '—' : fmt(v));

export function tmProcessParsedMetrics(parsed) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const epoch = now.getTime();

  const derived = tmDeriveSample(parsed, state.tmPrevCounters, epoch);
  const s = derived.sample;
  state.tmPrevCounters = derived.counters;

  // Add history. null stays null: the charts draw it as a gap.
  const h = state.tmHistory;
  h.timestamps.push(timeStr);
  h.heapUsed.push(s.heapUsed);
  h.heapMax.push(s.heapMax);
  h.nonHeapUsed.push(s.nonHeapUsed);
  h.cpuLoad.push(s.cpuLoad);
  h.threadsActive.push(s.threadsActive);
  h.threadsMax.push(s.threadsMax);
  h.dbSelects.push(s.selectRate);
  h.dbInserts.push(s.insertRate);
  h.dbUpdates.push(s.updateRate);
  h.dbDeletes.push(s.deleteRate);
  h.dbTx.push(s.totalDb);
  h.requestsSec.push(s.reqsRate);
  h.latencyMs.push(s.avgLatency);
  h.gcCounts.push(s.gcCountDelta);
  h.gcTimes.push(s.gcTimeDelta);
  h.sessionsAnon.push(s.anonSessions);
  h.sessionsNamed.push(s.namedSessions);
  h.sessionsNamedTotal.push(s.namedUsers);
  h.poolActive.push(s.poolActive);
  h.poolIdle.push(s.poolIdle);
  h.poolWaiters.push(s.poolWaiters);
  h.httpConns.push(s.httpConns);
  h.httpConnsMax.push(s.httpConnsMax);
  h.netInSec.push(s.netInRate);
  h.netOutSec.push(s.netOutRate);
  h.queueWaitMax.push(s.queueWaitMax);
  h.threadRunnable.push(s.threadRunnable);
  h.threadBlocked.push(s.threadBlocked);
  h.threadWaiting.push(s.threadWaiting);
  h.bufferUsed.push(s.bufferUsed);
  h.classesLoaded.push(s.classesLoaded);
  h.allocRate.push(s.allocRate);

  // Parse Task Queues
  let tqActive = parsed['mx_runtime_stats_taskqueue_queue_active_threads'] || [];
  for (let q of tqActive) {
    let qName = q.labels.queue || 'Unknown';
    if (!state.tmHistory.taskQueues[qName]) {
      state.tmHistory.taskQueues[qName] = new Array(Math.max(0, state.tmHistory.timestamps.length - 1)).fill(null);
    }
  }
  for (let qName in state.tmHistory.taskQueues) {
    let found = tqActive.find(q => (q.labels.queue || 'Unknown') === qName);
    state.tmHistory.taskQueues[qName].push(found ? found.value : null);
  }

  // Parse Max Task Executions (Latest Only)
  let tasksMax = parsed['mx_runtime_stats_taskqueue_task_execution_time_seconds_max'] || [];
  tasksMax.sort((a,b) => b.value - a.value);
  let topTasks = tasksMax.slice(0, 10);
  state.tmHistory.maxTasksLabels = topTasks.map(t => t.labels.task || 'Unknown');
  state.tmHistory.maxTasksValues = topTasks.map(t => parseFloat(t.value.toFixed(2)));

  if (state.tmHistory.timestamps.length > 30) {
    for (let key in state.tmHistory) {
      if (key === 'taskQueues') {
        for (let qName in state.tmHistory.taskQueues) state.tmHistory.taskQueues[qName].shift();
      } else if (key !== 'maxTasksLabels' && key !== 'maxTasksValues') {
        state.tmHistory[key].shift();
      }
    }
  }

  // Update cards
  const heapKnown = s.heapUsed !== null;
  const heapLimit = s.heapMax !== null && s.heapMax > 0;
  const heapPct = heapKnown && heapLimit ? Math.round((s.heapUsed / s.heapMax) * 100) : null;
  document.getElementById('tm-card-heap').textContent = heapKnown
    ? `${s.heapUsed} MB / ${s.heapMax === null ? '—' : s.heapMax + ' MB'}`
    : '—';
  document.getElementById('tm-card-heap-pct').textContent = heapPct !== null
    ? `${heapPct}% used`
    : (heapKnown ? 'no heap limit metric' : 'no metric');
  document.getElementById('tm-card-threads').textContent = `${dash(s.threadsActive, String)} / ${dash(s.threadsMax, String)}`;

  // Threshold highlighting: heap and thread-pool saturation are the signals
  // that most reliably precede a Mendix runtime falling over.
  const heapBox = document.getElementById('tm-card-heap-box');
  if (heapBox) {
    heapBox.classList.toggle('stat-alert-danger', heapPct !== null && heapPct >= 85);
    heapBox.classList.toggle('stat-alert-warn', heapPct !== null && heapPct >= 70 && heapPct < 85);
  }
  const threadsBox = document.getElementById('tm-card-threads-box');
  if (threadsBox) {
    const thrRatio = s.threadsActive !== null && s.threadsMax !== null && s.threadsMax > 0 ? s.threadsActive / s.threadsMax : null;
    threadsBox.classList.toggle('stat-alert-danger', thrRatio !== null && thrRatio >= 0.9);
    threadsBox.classList.toggle('stat-alert-warn', thrRatio !== null && thrRatio >= 0.75 && thrRatio < 0.9);
  }
  document.getElementById('tm-card-reqs').textContent = dash(s.reqsRate, v => `${v.toFixed(1)} req/s`);
  document.getElementById('tm-card-latency').textContent = `Avg latency: ${dash(s.avgLatency, v => `${v} ms`)}`;

  document.getElementById('tm-card-db').textContent = dash(s.totalDb, v => `${v.toFixed(1)} / s`);
  const rate0 = v => dash(v, x => x.toFixed(0));
  document.getElementById('tm-card-db-breakdown').textContent = `S:${rate0(s.selectRate)} I:${rate0(s.insertRate)} U:${rate0(s.updateRate)} D:${rate0(s.deleteRate)}`;

  tmUpdateChartsUI();
  tmCheckThresholds();
}
