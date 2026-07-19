import { state } from './state.js';
import { tmConnectAgent, tmStopAgentPolling, tmRenderPostgresStats } from './agent.js';
import { tmChangePollInterval, tmStopPolling } from './poller.js';
import { tmUpdateTabsVisibility } from './ui.js';
import { tmUpdateChartsUI } from './charts.js';
import { tmProcessMetrics } from './processor.js';

// Simulation state (tmSimState) lives on the shared `state` object (state.js);
// all reads/writes below go through state.tmSimState.

export function tmToggleMock() {
  const btn = document.getElementById('tm-btn-mock');
  const txt = document.getElementById('tm-mock-text');
  
  if (state.tmIsMocking) {
    state.tmIsMocking = false;
    clearInterval(state.tmMockInterval);
    state.tmMockInterval = null;
    btn.classList.remove('btn-success');
    btn.classList.add('btn-secondary');
    txt.textContent = 'Start Sandbox';
    
    if (state.tmConnectionProfile.startsWith('agent') && state.tmAgentStatus === 'connected') {
      tmConnectAgent();
    } else {
      tmChangePollInterval();
    }
  } else {
    state.tmIsMocking = true;
    tmStopPolling();
    tmStopAgentPolling();

    btn.classList.remove('btn-secondary');
    btn.classList.add('btn-success');
    txt.textContent = 'Stop Sandbox';
    
    tmResetData();
    tmGenerateMockTick();
    state.tmMockInterval = setInterval(tmGenerateMockTick, 3000);
  }
  tmUpdateTabsVisibility();
}

export function tmResetData() {
  state.tmHistory = {
    timestamps: [], heapUsed: [], heapMax: [], nonHeapUsed: [],
    cpuLoad: [], threadsActive: [], threadsMax: [],
    dbSelects: [], dbInserts: [], dbUpdates: [], dbDeletes: [], dbTx: [],
    requestsSec: [], latencyMs: [], gcCounts: [], gcTimes: [],
    sessionsAnon: [], sessionsNamed: [], sessionsNamedTotal: [],
    taskQueues: {}, maxTasksLabels: [], maxTasksValues: [],
    poolActive: [], poolIdle: [], poolWaiters: [],
    httpConns: [], httpConnsMax: [],
    netInSec: [], netOutSec: [],
    queueWaitMax: [],
    threadRunnable: [], threadBlocked: [], threadWaiting: [],
    bufferUsed: [], classesLoaded: [], allocRate: []
  };
  tmUpdateChartsUI();
  
  // Reset Live Dashboard stat cards
  const setText = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  setText('tm-card-heap', '0 MB / 0 MB');
  setText('tm-card-threads', '0 / 0');
  setText('tm-card-reqs', '0 req/s');
  setText('tm-card-db', '0 / s');
  ['tm-card-heap-box', 'tm-card-threads-box'].forEach(id => {
    const box = document.getElementById(id);
    if (box) box.classList.remove('stat-alert-warn', 'stat-alert-danger');
  });
  
  // Reset Postgres Stats cards & tables
  setText('tm-pg-card-conns', '0 / 0');
  setText('tm-pg-card-size', '0 MB');
  setText('tm-pg-card-hitrate', '0.0 %');
  setText('tm-pg-card-locks', '0 locks');
  
  const sessionsBody = document.getElementById('tm-pg-sessions-tbody');
  if (sessionsBody) sessionsBody.innerHTML = '<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted)">No active query sessions.</td></tr>';
  
  const locksBody = document.getElementById('tm-pg-locks-tbody');
  if (locksBody) locksBody.innerHTML = '<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted)">No transaction lock conflicts identified.</td></tr>';

  const longTbody = document.getElementById('tm-pg-long-running-tbody');
  if (longTbody) longTbody.innerHTML = '<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted)">No long-running idle transactions.</td></tr>';

  const slowQueriesTbody = document.getElementById('tm-pg-slow-queries-tbody');
  if (slowQueriesTbody) slowQueriesTbody.innerHTML = '<tr><td colspan="4" style="padding:16px;text-align:center;color:var(--text-muted)">No slow queries recorded.</td></tr>';

  const tableHealthTbody = document.getElementById('tm-pg-table-health-tbody');
  if (tableHealthTbody) tableHealthTbody.innerHTML = '<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted)">No table health data available.</td></tr>';
}

export function tmGenerateMockTick() {
  state.tmSimState.ticksSinceGc++;
  
  const isSpike = Math.random() < 0.22;
  const loadMultiplier = isSpike ? (3 + Math.random() * 3) : (0.8 + Math.random() * 0.5);

  const targetThreads = Math.round(15 + (isSpike ? 20 + Math.random() * 15 : Math.random() * 5));
  state.tmSimState.threads = Math.round(state.tmSimState.threads * 0.6 + targetThreads * 0.4);

  const targetCpu = isSpike ? 65 + Math.random() * 25 : 3 + Math.random() * 10;
  
  const deltaSelects = Math.round((5 + Math.random() * 12) * loadMultiplier);
  const deltaInserts = Math.round((0.2 + Math.random() * 2) * loadMultiplier);
  const deltaUpdates = Math.round((0.5 + Math.random() * 3) * loadMultiplier);
  const deltaDeletes = Math.round((Math.random() > 0.8 ? Math.random() * 1.5 : 0) * loadMultiplier);

  state.tmSimState.selects += deltaSelects;
  state.tmSimState.inserts += deltaInserts;
  state.tmSimState.updates += deltaUpdates;
  state.tmSimState.deletes += deltaDeletes;

  const deltaReqs = Math.round((2 + Math.random() * 5) * loadMultiplier);
  state.tmSimState.requests += deltaReqs;
  
  const currentAvgLatency = isSpike ? 120 + Math.random() * 200 : 8 + Math.random() * 12;
  state.tmSimState.reqTime += (deltaReqs * currentAvgLatency) / 1000.0;

  const heapAllocation = (20 + Math.random() * 35) * loadMultiplier;
  state.tmSimState.heap += heapAllocation;
  state.tmSimState.nonHeap += (Math.random() < 0.1) ? Math.random() * 2 : 0;

  let triggerGc = false;
  if (state.tmSimState.heap > state.tmSimState.maxHeap * 0.72) triggerGc = true;
  if (state.tmSimState.ticksSinceGc > 15 && Math.random() < 0.15) triggerGc = true;

  if (triggerGc) {
    state.tmSimState.gcCounts += 1;
    const gcDurationMs = 80 + Math.random() * 180;
    state.tmSimState.gcTimes += gcDurationMs / 1000.0;
    state.tmSimState.heap = Math.round(100 + state.tmSimState.threads * 1.5 + Math.random() * 40);
    state.tmSimState.ticksSinceGc = 0;
  }

  const promText = `
# HELP jvm_memory_used_bytes Used memory
# TYPE jvm_memory_used_bytes gauge
jvm_memory_used_bytes{area="heap"} ${state.tmSimState.heap * 1024 * 1024}
jvm_memory_used_bytes{area="nonheap"} ${state.tmSimState.nonHeap * 1024 * 1024}
# HELP jvm_memory_max_bytes Max memory
# TYPE jvm_memory_max_bytes gauge
jvm_memory_max_bytes{area="heap"} ${state.tmSimState.maxHeap * 1024 * 1024}
# HELP system_cpu_usage CPU
# TYPE system_cpu_usage gauge
system_cpu_usage ${targetCpu / 100.0}
# HELP jetty_threads_active Active threads
# TYPE jetty_threads_active gauge
jetty_threads_active ${state.tmSimState.threads}
# HELP jetty_threads_limit Thread limit
jetty_threads_limit 200
# HELP mx_runtime_stats_connectionbus_selects Selects
mx_runtime_stats_connectionbus_selects ${state.tmSimState.selects}
# HELP mx_runtime_stats_connectionbus_inserts Inserts
mx_runtime_stats_connectionbus_inserts ${state.tmSimState.inserts}
# HELP mx_runtime_stats_connectionbus_updates Updates
mx_runtime_stats_connectionbus_updates ${state.tmSimState.updates}
# HELP mx_runtime_stats_connectionbus_deletes Deletes
mx_runtime_stats_connectionbus_deletes ${state.tmSimState.deletes}
# HELP jetty_requests_total Requests
jetty_requests_total ${state.tmSimState.requests}
# HELP jetty_requests_seconds_sum Latency sum
jetty_requests_seconds_sum ${state.tmSimState.reqTime}
# HELP jvm_gc_collection_seconds_count GC count
jvm_gc_collection_seconds_count ${state.tmSimState.gcCounts}
# HELP jvm_gc_collection_seconds_sum GC time
jvm_gc_collection_seconds_sum ${state.tmSimState.gcTimes}
`;

  tmProcessMetrics(promText);
  
  // Update mock PostgreSQL details as well!
  tmGenerateMockPgStats();
}

export function tmGenerateMockPgStats() {
  // Generate beautiful simulated PostgreSQL stats
  const hitRate = 98.4 + Math.random() * 1.5;
  const dbSizeMB = Math.round(152 + Math.random() * 10);
  const totalConns = 12 + Math.round(state.tmSimState.threads * 0.4 + Math.random() * 3);
  const idleConns = Math.round(totalConns * 0.7);
  const activeConns = totalConns - idleConns;
  
  // Deadlocks: 10% chance to simulate a lock waiter
  const isLocked = Math.random() < 0.15;
  const lockCount = isLocked ? 1 : 0;

  const mockPgData = {
    dbname: 'mendix_local_dev',
    stats: {
      active_conns: activeConns,
      idle_conns: idleConns,
      max_conns: 100,
      size_bytes: dbSizeMB * 1024 * 1024,
      hit_ratio: hitRate,
      lock_waiters: lockCount
    },
    sessions: [
      { pid: 14022, state: 'active', duration_ms: 4, client: '127.0.0.1:52110', query: 'SELECT "id", "name", "created_date" FROM "sales$order" WHERE "status" = \'Pending\' ORDER BY "id" ASC LIMIT 50' },
      { pid: 14023, state: 'idle in transaction', duration_ms: 124, client: '127.0.0.1:52112', query: 'UPDATE "production$inventory" SET "quantity" = "quantity" - 1 WHERE "product_id" = 22401' },
      { pid: 14025, state: 'idle', duration_ms: null, client: '127.0.0.1:52115', query: 'SELECT 1' }
    ],
    locks: isLocked ? [
      {
        blocked_pid: 14023,
        blocking_pid: 14022,
        blocked_statement: 'UPDATE "production$inventory" SET "quantity" = 100 WHERE "product_id" = 22401',
        blocking_statement: 'SELECT * FROM "production$inventory" WHERE "product_id" = 22401 FOR UPDATE',
        duration_ms: 1250
      }
    ] : [],
    table_health: [
      { table_name: 'sales$order', seq_scan: 12050, idx_scan: 450, dead_tuples: 2540, bloat_ratio: 25.4, hit_ratio: 88.5 },
      { table_name: 'system$session', seq_scan: 42, idx_scan: 50400, dead_tuples: 12, bloat_ratio: 0.1, hit_ratio: 99.8 },
      { table_name: 'production$inventory', seq_scan: 4500, idx_scan: 1200, dead_tuples: 500, bloat_ratio: 15.2, hit_ratio: 92.1 }
    ],
    slow_queries: [
      { query: "SELECT \\\"id\\\", \\\"name\\\" FROM \\\"sales$order\\\" WHERE \\\"status\\\" = 'Pending'", calls: 502, total_time_ms: 12500.5, mean_time_ms: 24.9 },
      { query: 'UPDATE "production$inventory" SET "quantity" = "quantity" - 1', calls: 1500, total_time_ms: 8500.2, mean_time_ms: 5.6 }
    ],
    slow_queries_error: null
  };

  // Add the running query if we had a spike
  if (state.tmSimState.threads > 25) {
    mockPgData.sessions.unshift({
      pid: 14029,
      state: 'active',
      duration_ms: 2420,
      client: '127.0.0.1:52125',
      query: 'SELECT SUM("o"."total_price"), "c"."country" FROM "sales$order" "o" JOIN "sales$customer" "c" ON "o"."customer_id" = "c"."id" GROUP BY "c"."country" ORDER BY 1 DESC'
    });
  }

  tmRenderPostgresStats(mockPgData);
}

