import { tmGetMetricSum, tmGetMetricValue } from './parsers/prometheus.js';

// Turns one parsed /prometheus scrape into the numbers the dashboard shows.
//
// A metric that is not in the scrape is `null`, never a stand-in: 10 threads, a
// 200-thread pool, a 1 GiB heap or a request rate of 0 drawn as measurements
// were indistinguishable from real ones. `null` becomes a gap in a chart and a
// dash on a card. The one exception to "null in, null out" is arithmetic over
// several series, where the series that exist are summed.

const MB = 1024 * 1024;

const toMB = (v) => (v === null ? null : Math.round(v / MB));
const round = (v, digits) => (v === null ? null : parseFloat(v.toFixed(digits)));

// Per-second rate of a counter. A counter that went DOWN means the runtime
// restarted and the counter began again: the difference is meaningless, so it is
// a gap, not a 0 and not a negative.
function counterRate(cur, prev, dt) {
  if (cur === null || prev === null || prev === undefined || cur < prev) return null;
  return (cur - prev) / dt;
}

function counterDelta(cur, prev) {
  if (cur === null || prev === null || prev === undefined || cur < prev) return null;
  return cur - prev;
}

// Latency comes from ONE metric family: its _sum and _count are the same
// requests. Pairing a sum from one family with a count from another (a handler
// counter against a Jetty timer) divided two different populations.
const LATENCY_FAMILIES = ['jetty_requests_seconds', 'http_server_requests_seconds'];

function latencyPair(parsed) {
  for (const family of LATENCY_FAMILIES) {
    const sum = tmGetMetricSum(parsed, family + '_sum');
    const count = tmGetMetricSum(parsed, family + '_count');
    if (sum !== null && count !== null) return { sum: sum, count: count };
  }
  return { sum: null, count: null };
}

export function tmDeriveSample(parsed, prev, epoch) {
  // 1. JVM memory. `committed` is not `used`, so it is no fallback for it.
  const heapUsed = tmGetMetricSum(parsed, 'jvm_memory_used_bytes', { area: 'heap' }) ??
                   tmGetMetricSum(parsed, 'jvm_memory_used', { area: 'heap' });
  const heapMax = tmGetMetricSum(parsed, 'jvm_memory_max_bytes', { area: 'heap' }) ??
                  tmGetMetricSum(parsed, 'jvm_memory_max', { area: 'heap' });
  const nonHeapUsed = tmGetMetricSum(parsed, 'jvm_memory_used_bytes', { area: 'nonheap' }) ??
                      tmGetMetricSum(parsed, 'jvm_memory_used', { area: 'nonheap' });

  // 2. CPU and threads
  let cpuLoad = tmGetMetricValue(parsed, 'system_cpu_usage') ??
                tmGetMetricValue(parsed, 'process_cpu_usage') ??
                tmGetMetricValue(parsed, 'process_cpu_load');
  if (cpuLoad !== null && cpuLoad <= 1) cpuLoad = cpuLoad * 100;

  const threadsActive = tmGetMetricValue(parsed, 'jetty_threads_active') ??
                        tmGetMetricValue(parsed, 'jetty_thread_pool_threads', { state: 'busy' }) ??
                        tmGetMetricValue(parsed, 'jvm_threads_live_threads');
  const threadsMax = tmGetMetricValue(parsed, 'jetty_threads_limit') ??
                     tmGetMetricValue(parsed, 'jetty_thread_pool_threads_limit');

  // 3. Database counters
  const dbCounter = (kind) => tmGetMetricValue(parsed, 'mx_runtime_stats_connectionbus_' + kind + '_total') ??
                              tmGetMetricValue(parsed, 'mx_runtime_stats_connectionbus_' + kind);
  const rawSelects = dbCounter('selects'), rawInserts = dbCounter('inserts');
  const rawUpdates = dbCounter('updates'), rawDeletes = dbCounter('deletes');

  // 4. Requests and latency
  const rawRequests = tmGetMetricValue(parsed, 'mx_runtime_stats_handler_requests_total', { name: 'xas/' }) ??
                      tmGetMetricValue(parsed, 'jetty_requests_total') ??
                      tmGetMetricValue(parsed, 'http_server_requests_seconds_count') ??
                      tmGetMetricValue(parsed, 'mx_runtime_stats_action_executions');
  const lat = latencyPair(parsed);

  // 5. GC
  const rawGcCount = tmGetMetricSum(parsed, 'jvm_gc_collection_seconds_count') ??
                     tmGetMetricSum(parsed, 'jvm_gc_pause_seconds_count');
  const rawGcTime = tmGetMetricSum(parsed, 'jvm_gc_collection_seconds_sum') ??
                    tmGetMetricSum(parsed, 'jvm_gc_pause_seconds_sum');

  // 6. Network, allocation, thread states, classes
  const rawNetIn = tmGetMetricSum(parsed, 'jetty_connections_bytes_in_bytes_sum');
  const rawNetOut = tmGetMetricSum(parsed, 'jetty_connections_bytes_out_bytes_sum');
  const rawAllocatedBytes = tmGetMetricSum(parsed, 'jvm_gc_memory_allocated_bytes_total');
  const waiting = tmGetMetricSum(parsed, 'jvm_threads_states_threads', { state: 'waiting' });
  const timedWaiting = tmGetMetricSum(parsed, 'jvm_threads_states_threads', { state: 'timed-waiting' });
  const classes = tmGetMetricSum(parsed, 'jvm_classes_loaded_classes');

  // Rates, from the previous scrape
  let selectRate = null, insertRate = null, updateRate = null, deleteRate = null;
  let reqsRate = null, avgLatency = null;
  let gcCountDelta = null, gcTimeDelta = null;
  let netInRate = null, netOutRate = null, allocRate = null;

  if (prev && prev.timestamp !== null && prev.timestamp !== undefined) {
    const dt = (epoch - prev.timestamp) / 1000.0;
    if (dt > 0) {
      selectRate = counterRate(rawSelects, prev.dbSelects, dt);
      insertRate = counterRate(rawInserts, prev.dbInserts, dt);
      updateRate = counterRate(rawUpdates, prev.dbUpdates, dt);
      deleteRate = counterRate(rawDeletes, prev.dbDeletes, dt);
      reqsRate = counterRate(rawRequests, prev.requests, dt);

      const dCount = counterDelta(lat.count, prev.latCount);
      const dSum = counterDelta(lat.sum, prev.latSum);
      // No request finished in the interval: there is no average to report.
      if (dCount !== null && dSum !== null && dCount > 0) avgLatency = (dSum / dCount) * 1000;

      gcCountDelta = counterDelta(rawGcCount, prev.gcCounts);
      const gcSecs = counterDelta(rawGcTime, prev.gcTimes);
      gcTimeDelta = gcSecs === null ? null : gcSecs * 1000;

      const inRate = counterRate(rawNetIn, prev.netIn, dt);
      const outRate = counterRate(rawNetOut, prev.netOut, dt);
      netInRate = inRate === null ? null : inRate / 1024;       // KB/s
      netOutRate = outRate === null ? null : outRate / 1024;
      const alloc = counterRate(rawAllocatedBytes, prev.allocatedBytes, dt);
      allocRate = alloc === null ? null : alloc / MB;           // MB/s
    }
  }

  const dbParts = [selectRate, insertRate, updateRate, deleteRate].filter(v => v !== null);
  const totalDb = dbParts.length ? dbParts.reduce((a, b) => a + b, 0) : null;

  return {
    sample: {
      heapUsed: toMB(heapUsed),
      heapMax: toMB(heapMax),
      nonHeapUsed: toMB(nonHeapUsed),
      cpuLoad: cpuLoad === null ? null : Math.round(cpuLoad),
      threadsActive: threadsActive,
      threadsMax: threadsMax,
      selectRate: round(selectRate, 1), insertRate: round(insertRate, 1),
      updateRate: round(updateRate, 1), deleteRate: round(deleteRate, 1),
      totalDb: round(totalDb, 1),
      reqsRate: round(reqsRate, 1),
      avgLatency: avgLatency === null ? null : Math.round(avgLatency),
      gcCountDelta: gcCountDelta,
      gcTimeDelta: gcTimeDelta === null ? null : Math.round(gcTimeDelta),
      anonSessions: tmGetMetricValue(parsed, 'mx_runtime_stats_sessions_anonymous_sessions'),
      namedSessions: tmGetMetricValue(parsed, 'mx_runtime_stats_sessions_named_user_sessions'),
      namedUsers: tmGetMetricValue(parsed, 'mx_runtime_stats_sessions_named_users'),
      poolActive: tmGetMetricValue(parsed, 'commons_pool2_num_active_objects'),
      poolIdle: tmGetMetricValue(parsed, 'commons_pool2_num_idle_objects'),
      poolWaiters: tmGetMetricValue(parsed, 'commons_pool2_num_waiters_threads'),
      httpConns: tmGetMetricValue(parsed, 'jetty_connections_current_connections'),
      httpConnsMax: tmGetMetricValue(parsed, 'jetty_connections_max_connections'),
      netInRate: round(netInRate, 1),
      netOutRate: round(netOutRate, 1),
      queueWaitMax: round(tmGetMetricValue(parsed, 'mx_runtime_stats_taskqueue_queue_wait_time_seconds_max'), 2),
      threadRunnable: tmGetMetricSum(parsed, 'jvm_threads_states_threads', { state: 'runnable' }),
      threadBlocked: tmGetMetricSum(parsed, 'jvm_threads_states_threads', { state: 'blocked' }),
      threadWaiting: waiting === null && timedWaiting === null ? null : (waiting || 0) + (timedWaiting || 0),
      bufferUsed: toMB(tmGetMetricSum(parsed, 'jvm_buffer_memory_used_bytes')),
      classesLoaded: classes === null ? null : Math.round(classes / 1000),   // thousands
      allocRate: round(allocRate, 1)
    },
    counters: {
      dbSelects: rawSelects, dbInserts: rawInserts, dbUpdates: rawUpdates, dbDeletes: rawDeletes,
      requests: rawRequests,
      latSum: lat.sum, latCount: lat.count,
      gcCounts: rawGcCount, gcTimes: rawGcTime,
      netIn: rawNetIn, netOut: rawNetOut,
      allocatedBytes: rawAllocatedBytes,
      timestamp: epoch
    }
  };
}
