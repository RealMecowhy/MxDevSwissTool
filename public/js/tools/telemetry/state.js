export const state = {
  tmPollTimer: null,
  tmIsMocking: false,
  tmMockInterval: null,
  tmActiveTab: 'guide',
  tmConnectionProfile: 'agent', // 'agent' | 'direct' | 'paste'
  tmDirectConnected: false,

  // Local Agent state
  tmAgentTimerLogs: null,
  tmAgentTimerPg: null,
  tmAgentTimerOtel: null,
  tmAgentStatus: 'disconnected',
  tmLastLogTimestamp: 0,
  tmLastOtelTraceTimestamp: 0,
  tmLastOtelLogTimestamp: 0,

  // Metrics Time-Series History
  tmHistory: {
    timestamps: [],
    heapUsed: [], heapMax: [], nonHeapUsed: [],
    cpuLoad: [], threadsActive: [], threadsMax: [],
    dbSelects: [], dbInserts: [], dbUpdates: [], dbDeletes: [], dbTx: [],
    requestsSec: [], latencyMs: [], gcCounts: [], gcTimes: [],
    sessionsAnon: [], sessionsNamed: [], sessionsNamedTotal: [],
    taskQueues: {}, maxTasksLabels: [], maxTasksValues: [],
    
    // New metrics
    poolActive: [], poolIdle: [], poolWaiters: [],
    httpConns: [], httpConnsMax: [],
    netInSec: [], netOutSec: [],
    queueWaitMax: [],
    threadRunnable: [], threadBlocked: [], threadWaiting: [],
    bufferUsed: [], classesLoaded: [], allocRate: []
  },

  // Raw counter tracking for rates calculation
  tmPrevCounters: {
    dbSelects: null, dbInserts: null, dbUpdates: null, dbDeletes: null,
    requests: null, reqTime: null,
    gcCounts: null, gcTimes: null,
    netIn: null, netOut: null,
    allocatedBytes: null,
    timestamp: null
  },

  // Chart instances
  tmCharts: {
    memory: null,
    cpuThreads: null,
    db: null,
    requests: null,
    gc: null
  },

  // Trace exploration state
  tmParsedSpans: [],
  tmParsedLogs: [],
  tmSelectedTraceId: null,
  tmActiveOtelSubtab: 'traces',

  // Mock (sandbox) simulation state — fields consumed by mock.js tmGenerateMockTick
  tmSimState: {
    heap: 250,
    maxHeap: 1024,
    nonHeap: 64,
    threads: 15,
    selects: 500,
    inserts: 20,
    updates: 50,
    deletes: 10,
    requests: 120,
    reqTime: 12,
    gcTimes: 1,
    gcCounts: 2,
    ticksSinceGc: 0
  },

  tmChartGroupsWired: false
};

export const TM_USED_METRICS = new Set([
  'jvm_memory_used_bytes', 'jvm_memory_used', 'jvm_memory_committed_bytes',
  'jvm_memory_max_bytes', 'jvm_memory_max',
  'system_cpu_usage', 'process_cpu_usage', 'process_cpu_load',
  'jetty_threads_active', 'jetty_thread_pool_threads', 'jvm_threads_live_threads',
  'jetty_threads_limit', 'jetty_thread_pool_threads_limit',
  'mx_runtime_stats_connectionbus_selects_total', 'mx_runtime_stats_connectionbus_selects',
  'mx_runtime_stats_connectionbus_inserts_total', 'mx_runtime_stats_connectionbus_inserts',
  'mx_runtime_stats_connectionbus_updates_total', 'mx_runtime_stats_connectionbus_updates',
  'mx_runtime_stats_connectionbus_deletes_total', 'mx_runtime_stats_connectionbus_deletes',
  'mx_runtime_stats_handler_requests_total', 'jetty_requests_total',
  'http_server_requests_seconds_count', 'mx_runtime_stats_action_executions',
  'jetty_requests_seconds_sum', 'http_server_requests_seconds_sum',
  'jvm_gc_collection_seconds_count', 'jvm_gc_pause_seconds_count',
  'jvm_gc_collection_seconds_sum', 'jvm_gc_pause_seconds_sum',
  'mx_runtime_stats_sessions_anonymous_sessions',
  'mx_runtime_stats_sessions_named_user_sessions',
  'mx_runtime_stats_sessions_named_users',
  'mx_runtime_stats_taskqueue_queue_active_threads',
  'mx_runtime_stats_taskqueue_task_execution_time_seconds_max',
  'commons_pool2_num_active_objects', 'commons_pool2_num_idle_objects', 'commons_pool2_num_waiters_threads',
  'jetty_connections_current_connections', 'jetty_connections_max_connections',
  'jetty_connections_bytes_in_bytes_sum', 'jetty_connections_bytes_out_bytes_sum',
  'mx_runtime_stats_taskqueue_queue_wait_time_seconds_max',
  'jvm_threads_states_threads',
  'jvm_buffer_memory_used_bytes', 'jvm_classes_loaded_classes', 'jvm_gc_memory_allocated_bytes_total'
]);
