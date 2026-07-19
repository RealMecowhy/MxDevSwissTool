import { tmParsePrometheusText, tmGetMetricSum, tmGetMetricValue } from './parsers/prometheus.js';
import { state } from './state.js';
import { tmUpdateChartsUI } from './charts.js';
import { tmCheckThresholds } from './alerts.js';

export function tmProcessMetrics(textData) {
  const parsed = tmParsePrometheusText(textData);
  tmProcessParsedMetrics(parsed);
}

export function tmProcessParsedMetrics(parsed) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const epoch = now.getTime();

  // 1. JVM Memory
  let heapUsed = tmGetMetricSum(parsed, 'jvm_memory_used_bytes', { area: 'heap' }) || 
                 tmGetMetricSum(parsed, 'jvm_memory_used', { area: 'heap' }) || 
                 tmGetMetricSum(parsed, 'jvm_memory_committed_bytes', { area: 'heap' }) || 0;
  let heapMax = tmGetMetricSum(parsed, 'jvm_memory_max_bytes', { area: 'heap' }) || 
                tmGetMetricSum(parsed, 'jvm_memory_max', { area: 'heap' }) || 1024 * 1024 * 1024;
  let nonHeapUsed = tmGetMetricSum(parsed, 'jvm_memory_used_bytes', { area: 'nonheap' }) || 
                    tmGetMetricSum(parsed, 'jvm_memory_used', { area: 'nonheap' }) || 0;

  heapUsed = Math.round(heapUsed / (1024 * 1024));
  heapMax = Math.round(heapMax / (1024 * 1024));
  nonHeapUsed = Math.round(nonHeapUsed / (1024 * 1024));

  // 2. CPU and Threads
  let cpuLoad = tmGetMetricValue(parsed, 'system_cpu_usage') || 
                tmGetMetricValue(parsed, 'process_cpu_usage') || 
                tmGetMetricValue(parsed, 'process_cpu_load') || 0;
  if (cpuLoad <= 1) cpuLoad = cpuLoad * 100;

  let threadsActive = tmGetMetricValue(parsed, 'jetty_threads_active') || 
                      tmGetMetricValue(parsed, 'jetty_thread_pool_threads', { state: 'busy' }) || 
                      tmGetMetricValue(parsed, 'jvm_threads_live_threads') || 10;
  let threadsMax = tmGetMetricValue(parsed, 'jetty_threads_limit') || 
                   tmGetMetricValue(parsed, 'jetty_thread_pool_threads_limit') || 200;

  // 3. Database Counters
  let rawSelects = tmGetMetricValue(parsed, 'mx_runtime_stats_connectionbus_selects_total') || tmGetMetricValue(parsed, 'mx_runtime_stats_connectionbus_selects') || 0;
  let rawInserts = tmGetMetricValue(parsed, 'mx_runtime_stats_connectionbus_inserts_total') || tmGetMetricValue(parsed, 'mx_runtime_stats_connectionbus_inserts') || 0;
  let rawUpdates = tmGetMetricValue(parsed, 'mx_runtime_stats_connectionbus_updates_total') || tmGetMetricValue(parsed, 'mx_runtime_stats_connectionbus_updates') || 0;
  let rawDeletes = tmGetMetricValue(parsed, 'mx_runtime_stats_connectionbus_deletes_total') || tmGetMetricValue(parsed, 'mx_runtime_stats_connectionbus_deletes') || 0;

  // 4. Request Rates & Latency
  let rawRequests = tmGetMetricValue(parsed, 'mx_runtime_stats_handler_requests_total', {name: "xas/"}) || 
                     tmGetMetricValue(parsed, 'jetty_requests_total') || 
                     tmGetMetricValue(parsed, 'http_server_requests_seconds_count') || 
                     tmGetMetricValue(parsed, 'mx_runtime_stats_action_executions') || 0;
  
  let rawReqTime = tmGetMetricValue(parsed, 'jetty_requests_seconds_sum') || 
                    tmGetMetricValue(parsed, 'http_server_requests_seconds_sum') || 0;

  // 5. GC Counters
  let rawGcCount = tmGetMetricSum(parsed, 'jvm_gc_collection_seconds_count') || 
                    tmGetMetricSum(parsed, 'jvm_gc_pause_seconds_count') || 0;
  let rawGcTime = tmGetMetricSum(parsed, 'jvm_gc_collection_seconds_sum') || 
                   tmGetMetricSum(parsed, 'jvm_gc_pause_seconds_sum') || 0;

  // 6. Sessions
  let anonSessions = tmGetMetricValue(parsed, 'mx_runtime_stats_sessions_anonymous_sessions') || 0;
  let namedSessions = tmGetMetricValue(parsed, 'mx_runtime_stats_sessions_named_user_sessions') || 0;
  let namedUsers = tmGetMetricValue(parsed, 'mx_runtime_stats_sessions_named_users') || 0;

  // New parsed values
  let poolActive = tmGetMetricValue(parsed, 'commons_pool2_num_active_objects') || 0;
  let poolIdle = tmGetMetricValue(parsed, 'commons_pool2_num_idle_objects') || 0;
  let poolWaiters = tmGetMetricValue(parsed, 'commons_pool2_num_waiters_threads') || 0;
  let httpConns = tmGetMetricValue(parsed, 'jetty_connections_current_connections') || 0;
  let httpConnsMax = tmGetMetricValue(parsed, 'jetty_connections_max_connections') || 0;
  let rawNetIn = tmGetMetricSum(parsed, 'jetty_connections_bytes_in_bytes_sum') || 0;
  let rawNetOut = tmGetMetricSum(parsed, 'jetty_connections_bytes_out_bytes_sum') || 0;
  let queueWaitMax = tmGetMetricValue(parsed, 'mx_runtime_stats_taskqueue_queue_wait_time_seconds_max') || 0;
  
  let threadRunnable = tmGetMetricSum(parsed, 'jvm_threads_states_threads', { state: 'runnable' }) || 0;
  let threadBlocked = tmGetMetricSum(parsed, 'jvm_threads_states_threads', { state: 'blocked' }) || 0;
  let threadWaiting = (tmGetMetricSum(parsed, 'jvm_threads_states_threads', { state: 'waiting' }) || 0) + 
                      (tmGetMetricSum(parsed, 'jvm_threads_states_threads', { state: 'timed-waiting' }) || 0);
  
  let bufferUsed = Math.round((tmGetMetricSum(parsed, 'jvm_buffer_memory_used_bytes') || 0) / (1024 * 1024));
  let classesLoaded = Math.round((tmGetMetricSum(parsed, 'jvm_classes_loaded_classes') || 0) / 1000); // In thousands
  let rawAllocatedBytes = tmGetMetricSum(parsed, 'jvm_gc_memory_allocated_bytes_total') || 0;

  // Rates
  let selectRate = 0, insertRate = 0, updateRate = 0, deleteRate = 0;
  let reqsRate = 0, avgLatency = 0;
  let gcCountDelta = 0, gcTimeDelta = 0;
  let netInRate = 0, netOutRate = 0, allocRate = 0;

  if (state.tmPrevCounters.timestamp !== null) {
    const timeDelta = (epoch - state.tmPrevCounters.timestamp) / 1000.0;
    if (timeDelta > 0) {
      selectRate = Math.max(0, (rawSelects - state.tmPrevCounters.dbSelects) / timeDelta);
      insertRate = Math.max(0, (rawInserts - state.tmPrevCounters.dbInserts) / timeDelta);
      updateRate = Math.max(0, (rawUpdates - state.tmPrevCounters.dbUpdates) / timeDelta);
      deleteRate = Math.max(0, (rawDeletes - state.tmPrevCounters.dbDeletes) / timeDelta);
      
      const reqDelta = Math.max(0, rawRequests - state.tmPrevCounters.requests);
      reqsRate = reqDelta / timeDelta;

      if (reqDelta > 0) {
        const timeSumDelta = Math.max(0, rawReqTime - state.tmPrevCounters.reqTime);
        avgLatency = (timeSumDelta / reqDelta) * 1000;
      }

      gcCountDelta = Math.max(0, rawGcCount - state.tmPrevCounters.gcCounts);
      gcTimeDelta = Math.max(0, rawGcTime - state.tmPrevCounters.gcTimes) * 1000;

      netInRate = Math.max(0, (rawNetIn - state.tmPrevCounters.netIn) / timeDelta) / 1024; // KB/s
      netOutRate = Math.max(0, (rawNetOut - state.tmPrevCounters.netOut) / timeDelta) / 1024; // KB/s
      allocRate = Math.max(0, (rawAllocatedBytes - state.tmPrevCounters.allocatedBytes) / timeDelta) / (1024 * 1024); // MB/s
    }
  }

  state.tmPrevCounters = {
    dbSelects: rawSelects,
    dbInserts: rawInserts,
    dbUpdates: rawUpdates,
    dbDeletes: rawDeletes,
    requests: rawRequests,
    reqTime: rawReqTime,
    gcCounts: rawGcCount,
    gcTimes: rawGcTime,
    netIn: rawNetIn,
    netOut: rawNetOut,
    allocatedBytes: rawAllocatedBytes,
    timestamp: epoch
  };

  const totalDb = selectRate + insertRate + updateRate + deleteRate;

  // Add history
  state.tmHistory.timestamps.push(timeStr);
  state.tmHistory.heapUsed.push(heapUsed);
  state.tmHistory.heapMax.push(heapMax);
  state.tmHistory.nonHeapUsed.push(nonHeapUsed);
  state.tmHistory.cpuLoad.push(Math.round(cpuLoad));
  state.tmHistory.threadsActive.push(threadsActive);
  state.tmHistory.threadsMax.push(threadsMax);
  state.tmHistory.dbSelects.push(parseFloat(selectRate.toFixed(1)));
  state.tmHistory.dbInserts.push(parseFloat(insertRate.toFixed(1)));
  state.tmHistory.dbUpdates.push(parseFloat(updateRate.toFixed(1)));
  state.tmHistory.dbDeletes.push(parseFloat(deleteRate.toFixed(1)));
  state.tmHistory.dbTx.push(parseFloat(totalDb.toFixed(1)));
  state.tmHistory.requestsSec.push(parseFloat(reqsRate.toFixed(1)));
  state.tmHistory.latencyMs.push(Math.round(avgLatency));
  state.tmHistory.gcCounts.push(gcCountDelta);
  state.tmHistory.gcTimes.push(Math.round(gcTimeDelta));
  state.tmHistory.sessionsAnon.push(anonSessions);
  state.tmHistory.sessionsNamed.push(namedSessions);
  state.tmHistory.sessionsNamedTotal.push(namedUsers);
  state.tmHistory.poolActive.push(poolActive);
  state.tmHistory.poolIdle.push(poolIdle);
  state.tmHistory.poolWaiters.push(poolWaiters);
  state.tmHistory.httpConns.push(httpConns);
  state.tmHistory.httpConnsMax.push(httpConnsMax);
  state.tmHistory.netInSec.push(parseFloat(netInRate.toFixed(1)));
  state.tmHistory.netOutSec.push(parseFloat(netOutRate.toFixed(1)));
  state.tmHistory.queueWaitMax.push(parseFloat(queueWaitMax.toFixed(2)));
  state.tmHistory.threadRunnable.push(threadRunnable);
  state.tmHistory.threadBlocked.push(threadBlocked);
  state.tmHistory.threadWaiting.push(threadWaiting);
  state.tmHistory.bufferUsed.push(bufferUsed);
  state.tmHistory.classesLoaded.push(classesLoaded);
  state.tmHistory.allocRate.push(parseFloat(allocRate.toFixed(1)));

  // Parse Task Queues
  let tqActive = parsed['mx_runtime_stats_taskqueue_queue_active_threads'] || [];
  for (let q of tqActive) {
    let qName = q.labels.queue || 'Unknown';
    if (!state.tmHistory.taskQueues[qName]) {
      state.tmHistory.taskQueues[qName] = new Array(Math.max(0, state.tmHistory.timestamps.length - 1)).fill(0);
    }
  }
  for (let qName in state.tmHistory.taskQueues) {
    let found = tqActive.find(q => (q.labels.queue || 'Unknown') === qName);
    state.tmHistory.taskQueues[qName].push(found ? found.value : 0);
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
  document.getElementById('tm-card-heap').textContent = `${heapUsed} MB / ${heapMax} MB`;
  const heapPct = heapMax > 0 ? Math.round((heapUsed / heapMax) * 100) : 0;
  document.getElementById('tm-card-heap-pct').textContent = `${heapPct}% used`;
  document.getElementById('tm-card-threads').textContent = `${threadsActive} / ${threadsMax}`;

  // Threshold highlighting: heap and thread-pool saturation are the signals
  // that most reliably precede a Mendix runtime falling over.
  const heapBox = document.getElementById('tm-card-heap-box');
  if (heapBox) {
    heapBox.classList.toggle('stat-alert-danger', heapMax > 0 && heapPct >= 85);
    heapBox.classList.toggle('stat-alert-warn', heapMax > 0 && heapPct >= 70 && heapPct < 85);
  }
  const threadsBox = document.getElementById('tm-card-threads-box');
  if (threadsBox) {
    const thrRatio = threadsMax > 0 ? threadsActive / threadsMax : 0;
    threadsBox.classList.toggle('stat-alert-danger', thrRatio >= 0.9);
    threadsBox.classList.toggle('stat-alert-warn', thrRatio >= 0.75 && thrRatio < 0.9);
  }
  document.getElementById('tm-card-reqs').textContent = `${reqsRate.toFixed(1)} req/s`;
  document.getElementById('tm-card-latency').textContent = `Avg latency: ${Math.round(avgLatency)} ms`;
  
  document.getElementById('tm-card-db').textContent = `${totalDb.toFixed(1)} / s`;
  document.getElementById('tm-card-db-breakdown').textContent = `S:${selectRate.toFixed(0)} I:${insertRate.toFixed(0)} U:${updateRate.toFixed(0)} D:${deleteRate.toFixed(0)}`;

  tmUpdateChartsUI();
  tmCheckThresholds();
}

