// ============================================================
// METRICS & TELEMETRY MONITOR (Module O)
// ============================================================

// State management
let tmPollTimer = null;
let tmIsMocking = false;
let tmMockInterval = null;
let tmActiveTab = 'guide';
let tmConnectionProfile = 'agent'; // 'agent' | 'direct' | 'paste'
let tmDirectConnected = false;

// Local Agent state
let tmAgentTimerLogs = null;
let tmAgentTimerPg = null;
let tmAgentTimerOtel = null;
let tmAgentStatus = 'disconnected';
let tmLastLogTimestamp = 0;
let tmLastOtelTraceTimestamp = 0;
let tmLastOtelLogTimestamp = 0;

// Metrics Time-Series History
let tmHistory = {
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
};

// Raw counter tracking for rates calculation
let tmPrevCounters = {
  dbSelects: null, dbInserts: null, dbUpdates: null, dbDeletes: null,
  requests: null, reqTime: null,
  gcCounts: null, gcTimes: null,
  netIn: null, netOut: null,
  allocatedBytes: null,
  timestamp: null
};

// Chart instances
let tmCharts = {
  memory: null,
  cpuThreads: null,
  db: null,
  requests: null,
  gc: null
};

// Trace exploration state
let tmParsedSpans = [];
let tmParsedLogs = [];
let tmSelectedTraceId = null;
let tmActiveOtelSubtab = 'traces';

// ============================================================
// INITIALIZATION AND TABS
// ============================================================

function tmUpdateTabsVisibility() {
  const dashboardTab = document.getElementById('tm-tab-dashboard-btn');
  const postgresTab = document.getElementById('tm-tab-postgres-btn');
  const tracesTab = document.getElementById('tm-tab-traces-btn');
  const guideTab = document.getElementById('tm-tab-guide-btn');

  const isAgentConnected = (tmConnectionProfile.startsWith('agent') && tmAgentStatus === 'connected');
  const isDirectActive = (tmConnectionProfile === 'direct' && tmDirectConnected);
  const isMocking = tmIsMocking;

  const isConnected = isAgentConnected || isDirectActive || isMocking;

  if (!isConnected) {
    // Show only Guide
    if (dashboardTab) dashboardTab.style.display = 'none';
    if (postgresTab) postgresTab.style.display = 'none';
    if (tracesTab) tracesTab.style.display = 'none';
    if (guideTab) guideTab.style.display = 'block';
    
    // Switch to guide if the active tab is hidden
    if (tmActiveTab !== 'guide') {
      tmSetTab('guide');
    }
  } else {
    // Connected! Determine which tabs to show based on profile
    if (tmConnectionProfile === 'agent_prometheus') {
      if (dashboardTab) dashboardTab.style.display = 'block';
      if (postgresTab) postgresTab.style.display = 'block';
      if (tracesTab) tracesTab.style.display = 'none';
    } else if (tmConnectionProfile === 'agent_otel') {
      if (dashboardTab) dashboardTab.style.display = 'block';
      if (postgresTab) postgresTab.style.display = 'block';
      if (tracesTab) tracesTab.style.display = 'block';
    } else if (tmConnectionProfile === 'direct') {
      if (dashboardTab) dashboardTab.style.display = 'block';
      if (postgresTab) postgresTab.style.display = 'none';
      if (tracesTab) tracesTab.style.display = 'none';
    } else { // Mocking
      if (dashboardTab) dashboardTab.style.display = 'block';
      if (postgresTab) postgresTab.style.display = 'block';
      if (tracesTab) tracesTab.style.display = 'block';
    }
    
    if (guideTab) guideTab.style.display = 'block';

    // If active tab is 'guide', switch to the main page of the selected profile
    if (tmActiveTab === 'guide') {
      if (tmConnectionProfile === 'agent_otel') {
        tmSetTab('traces'); // OTel goes to Traces first
      } else {
        tmSetTab('dashboard');
      }
    }
  }
}

function tmSetTab(tabId) {
  tmActiveTab = tabId;
  
  // Update tab buttons
  document.querySelectorAll('#panel-telemetry-monitor .tab').forEach(el => el.classList.remove('active'));
  const btn = document.getElementById(`tm-tab-${tabId}-btn`);
  if (btn) btn.classList.add('active');

  // Update tab views
  document.getElementById('tm-tab-dashboard').style.display = (tabId === 'dashboard') ? 'flex' : 'none';
  document.getElementById('tm-tab-postgres').style.display = (tabId === 'postgres') ? 'flex' : 'none';
  document.getElementById('tm-tab-traces').style.display = (tabId === 'traces') ? 'flex' : 'none';
  document.getElementById('tm-tab-guide').style.display = (tabId === 'guide') ? 'flex' : 'none';

  // Re-render charts when showing dashboard tab
  if (tabId === 'dashboard') {
    setTimeout(tmUpdateChartsUI, 50);
  }
  if (tabId === 'traces') {
    setTimeout(() => {
      tmRenderOtelTracesTable();
      tmRenderOtelLogsTable();
      if (tmSelectedTraceId) {
        tmRenderTraceWaterfall();
      }
    }, 50);
  }
}

function tmChangeConnectionProfile() {
  const profile = document.getElementById('tm-conn-profile').value;
  tmConnectionProfile = profile;
  
  const cfgAgent = document.getElementById('tm-cfg-agent');
  const logPathGroup = document.getElementById('tm-agent-logpath-group');
  const agentUrlInput = document.getElementById('tm-agent-url');
  const cfgDirect = document.getElementById('tm-cfg-direct');
  const btnFetch = document.getElementById('tm-btn-fetch');
  const btnAgent = document.getElementById('tm-btn-agent-connect');
  const agentStatusBar = document.getElementById('tm-agent-status-bar');

  // Reset state
  tmStopPolling();
  tmStopAgentPolling();
  tmDirectConnected = false;
  tmAgentStatus = 'disconnected';
  if (tmIsMocking) tmToggleMock();

  // Reset database connection stats header status
  const pgStatus = document.getElementById('tm-pg-status-indicator');
  if (pgStatus) pgStatus.innerHTML = '';

  if (profile === 'agent_prometheus' || profile === 'agent_otel') {
    cfgAgent.style.display = 'flex';
    cfgDirect.style.display = 'none';
    btnFetch.style.display = 'none';
    btnAgent.style.display = 'inline-flex';
    agentStatusBar.style.display = 'flex';
    
    agentUrlInput.value = 'http://localhost:9999';
    if (profile === 'agent_prometheus') {
      if (logPathGroup) logPathGroup.style.display = 'none';
      if (document.getElementById('tm-agent-otel-port-group')) document.getElementById('tm-agent-otel-port-group').style.display = 'none';
      if (document.getElementById('tm-agent-otel-service-group')) document.getElementById('tm-agent-otel-service-group').style.display = 'none';
    } else {
      if (logPathGroup) logPathGroup.style.display = 'flex';
      if (document.getElementById('tm-agent-otel-port-group')) document.getElementById('tm-agent-otel-port-group').style.display = 'flex';
      if (document.getElementById('tm-agent-otel-service-group')) document.getElementById('tm-agent-otel-service-group').style.display = 'flex';
    }
  } else if (profile === 'direct') {
    cfgAgent.style.display = 'none';
    cfgDirect.style.display = 'flex';
    btnFetch.style.display = 'inline-flex';
    btnAgent.style.display = 'none';
    agentStatusBar.style.display = 'none';
  }

  // Toggle setup callouts
  const otelCallout = document.getElementById('tm-otel-help-callout');
  const promCallout = document.getElementById('tm-prometheus-help-callout');
  if (otelCallout) otelCallout.style.display = (profile === 'agent_otel') ? 'block' : 'none';
  if (promCallout) promCallout.style.display = (profile === 'agent_prometheus') ? 'block' : 'none';
  
  tmUpdateTabsVisibility();
  
  // Expand connection card to show new inputs
  tmToggleConnectionCard(false);
}

function tmToggleConnectionCard(forceCollapse) {
  const body = document.getElementById('tm-connection-card-body');
  const btn = document.getElementById('tm-connection-toggle-btn');
  const summary = document.getElementById('tm-connection-card-summary');
  
  if (!body) return;
  
  let shouldCollapse;
  if (forceCollapse !== undefined) {
    shouldCollapse = forceCollapse;
  } else {
    shouldCollapse = (body.style.display !== 'none');
  }
  
  if (shouldCollapse) {
    body.style.display = 'none';
    if (btn) btn.textContent = 'Expand';
    
    // Update summary text
    const profileSelect = document.getElementById('tm-conn-profile');
    const profileText = profileSelect ? profileSelect.options[profileSelect.selectedIndex].text : '';
    const statusText = document.getElementById('tm-agent-status-text') ? document.getElementById('tm-agent-status-text').textContent : '';
    if (summary) {
      summary.textContent = `${profileText} (${statusText})`;
    }
  } else {
    body.style.display = 'flex';
    if (btn) btn.textContent = 'Collapse';
    if (summary) summary.textContent = '';
  }
}

function tmTogglePgConfigCard(forceCollapse) {
  const body = document.getElementById('tm-pg-config-card-body');
  const btn = document.getElementById('tm-pg-config-toggle-btn');
  
  if (!body) return;
  
  let shouldCollapse;
  if (forceCollapse !== undefined) {
    shouldCollapse = forceCollapse;
  } else {
    shouldCollapse = (body.style.display !== 'none');
  }
  
  if (shouldCollapse) {
    body.style.display = 'none';
    if (btn) btn.textContent = 'Expand';
  } else {
    body.style.display = 'flex';
    if (btn) btn.textContent = 'Collapse';
  }
}

// ============================================================
// PROMETHEUS METRICS PARSER
// ============================================================

function tmParsePrometheusText(text) {
  const lines = text.split('\n');
  const metrics = {};

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\{([^}]+)\})?\s+([eE0-9.+-]+|NaN|-?Infinity)(?:\s+\d+)?$/i);
    if (!match) continue;

    const name = match[1];
    const labelsStr = match[2];
    const val = parseFloat(match[3]);

    const labels = {};
    if (labelsStr) {
      const parts = labelsStr.split(',');
      for (let p of parts) {
        const lp = p.split('=');
        if (lp.length === 2) {
          const lKey = lp[0].trim();
          const lVal = lp[1].trim().replace(/^"|"$/g, '');
          labels[lKey] = lVal;
        }
      }
    }

    if (!metrics[name]) {
      metrics[name] = [];
    }
    metrics[name].push({ value: val, labels: labels });
  }

  return metrics;
}

function tmGetMetricValue(parsedMetrics, name, labelFilters = {}) {
  const list = parsedMetrics[name];
  if (!list) return null;

  for (let item of list) {
    let match = true;
    for (let k in labelFilters) {
      if (item.labels[k] !== labelFilters[k]) {
        match = false;
        break;
      }
    }
    if (match) return item.value;
  }
  
  return list[0].value;
}

function tmGetMetricSum(parsedMetrics, name, labelFilters = {}) {
  const list = parsedMetrics[name];
  if (!list) return null;
  let sum = 0;
  let found = false;
  for (let item of list) {
    let match = true;
    for (let k in labelFilters) {
      if (item.labels[k] !== labelFilters[k]) {
        match = false;
        break;
      }
    }
    if (match && item.value > 0) { // ignore -1 max values
      sum += item.value;
      found = true;
    }
  }
  return found ? sum : null;
}

// ============================================================
// OPENTELEMETRY METRICS PARSER
// ============================================================

function tmParseOtelMetrics(payload) {
  const parsed = {};
  if (!payload || !payload.resourceMetrics) return parsed;

  function addMetricVal(name, value, labels) {
    if (value === null || value === undefined || isNaN(value)) return;
    if (!parsed[name]) {
      parsed[name] = [];
    }
    parsed[name].push({ value: parseFloat(value), labels: labels });
  }

  payload.resourceMetrics.forEach(rm => {
    if (!rm.scopeMetrics) return;
    rm.scopeMetrics.forEach(sm => {
      if (!sm.metrics) return;
      sm.metrics.forEach(metric => {
        if (!metric.name) return;

        // Base name with dots replaced by underscores
        const baseName = metric.name.replace(/\./g, '_');
        
        // Find data points
        const dps = (metric.gauge && metric.gauge.dataPoints) ||
                    (metric.sum && metric.sum.dataPoints) ||
                    (metric.histogram && metric.histogram.dataPoints) ||
                    (metric.summary && metric.summary.dataPoints) ||
                    [];

        dps.forEach(dp => {
          // Extract labels
          const labels = {};
          if (dp.attributes) {
            dp.attributes.forEach(attr => {
              const val = attr.value;
              let strVal = '';
              if (val) {
                if (val.stringValue !== undefined) strVal = val.stringValue;
                else if (val.intValue !== undefined) strVal = val.intValue;
                else if (val.boolValue !== undefined) strVal = val.boolValue;
                else if (val.doubleValue !== undefined) strVal = val.doubleValue;
                else strVal = String(val);
              }
              labels[attr.key] = strVal;
            });
          }

          // Extract value
          const val = dp.asDouble !== undefined ? dp.asDouble :
                      (dp.asInt !== undefined ? dp.asInt :
                      (dp.value !== undefined ? dp.value : null));

          // If it is a histogram or summary, we might have count and sum instead of a single value
          if (metric.histogram || metric.summary) {
            const count = dp.count !== undefined ? dp.count : null;
            const sum = dp.sum !== undefined ? dp.sum : null;

            if (count !== null) {
              addMetricVal(`${baseName}_count`, count, labels);
              addMetricVal(`${baseName}_total`, count, labels);
              addMetricVal(`${baseName}_seconds_count`, count, labels);
            }
            if (sum !== null) {
              addMetricVal(`${baseName}_sum`, sum, labels);
              addMetricVal(`${baseName}_seconds_sum`, sum, labels);
            }
            if (dp.max !== undefined && dp.max !== null) {
              addMetricVal(`${baseName}_max`, dp.max, labels);
              addMetricVal(`${baseName}_seconds_max`, dp.max, labels);
            }
          } else {
            // Gauge or Sum
            addMetricVal(baseName, val, labels);

            // Add standard aliases/suffixes to match what Prometheus dashboard expects
            addMetricVal(`${baseName}_total`, val, labels);
            
            // JVM Memory / buffer units
            if (baseName.includes('memory') || baseName.includes('buffer')) {
              addMetricVal(`${baseName}_bytes`, val, labels);
            }
            
            // Network bytes
            if (baseName.includes('bytes_in') || baseName.includes('bytes_out')) {
              addMetricVal(`${baseName}_bytes_sum`, val, labels);
            }
          }
        });
      });
    });
  });

  // Additional custom mappings/aliases for standard Micrometer / JVM metrics
  // to perfectly match Prometheus metrics dashboard expectations
  const mappings = {
    'jvm_memory_used': ['jvm_memory_used_bytes'],
    'jvm_memory_committed': ['jvm_memory_committed_bytes'],
    'jvm_memory_max': ['jvm_memory_max_bytes'],
    'jvm_buffer_memory_used': ['jvm_buffer_memory_used_bytes'],
    'jvm_gc_memory_allocated': ['jvm_gc_memory_allocated_bytes_total'],
    'jvm_threads_states': ['jvm_threads_states_threads'],
    'jvm_threads_live': ['jvm_threads_live_threads'],
    'jvm_threads_peak': ['jvm_threads_peak_threads'],
    'jvm_classes_loaded': ['jvm_classes_loaded_classes'],
    'jetty_connections_current': ['jetty_connections_current_connections'],
    'jetty_connections_max': ['jetty_connections_max_connections'],
    'jetty_connections_bytes_in': ['jetty_connections_bytes_in_bytes_sum'],
    'jetty_connections_bytes_out': ['jetty_connections_bytes_out_bytes_sum'],
    'jetty_threads_active': ['jetty_threads_active'],
    'jetty_threads_limit': ['jetty_threads_limit']
  };

  for (const src in mappings) {
    if (parsed[src]) {
      mappings[src].forEach(target => {
        if (!parsed[target]) {
          parsed[target] = parsed[src];
        }
      });
    }
  }

  return parsed;
}

// ============================================================
// CORE DATA UPDATER
// ============================================================

function tmProcessMetrics(textData) {
  const parsed = tmParsePrometheusText(textData);
  tmProcessParsedMetrics(parsed);
}

function tmProcessParsedMetrics(parsed) {
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

  if (tmPrevCounters.timestamp !== null) {
    const timeDelta = (epoch - tmPrevCounters.timestamp) / 1000.0;
    if (timeDelta > 0) {
      selectRate = Math.max(0, (rawSelects - tmPrevCounters.dbSelects) / timeDelta);
      insertRate = Math.max(0, (rawInserts - tmPrevCounters.dbInserts) / timeDelta);
      updateRate = Math.max(0, (rawUpdates - tmPrevCounters.dbUpdates) / timeDelta);
      deleteRate = Math.max(0, (rawDeletes - tmPrevCounters.dbDeletes) / timeDelta);
      
      const reqDelta = Math.max(0, rawRequests - tmPrevCounters.requests);
      reqsRate = reqDelta / timeDelta;

      if (reqDelta > 0) {
        const timeSumDelta = Math.max(0, rawReqTime - tmPrevCounters.reqTime);
        avgLatency = (timeSumDelta / reqDelta) * 1000;
      }

      gcCountDelta = Math.max(0, rawGcCount - tmPrevCounters.gcCounts);
      gcTimeDelta = Math.max(0, rawGcTime - tmPrevCounters.gcTimes) * 1000;

      netInRate = Math.max(0, (rawNetIn - tmPrevCounters.netIn) / timeDelta) / 1024; // KB/s
      netOutRate = Math.max(0, (rawNetOut - tmPrevCounters.netOut) / timeDelta) / 1024; // KB/s
      allocRate = Math.max(0, (rawAllocatedBytes - tmPrevCounters.allocatedBytes) / timeDelta) / (1024 * 1024); // MB/s
    }
  }

  tmPrevCounters = {
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
  tmHistory.timestamps.push(timeStr);
  tmHistory.heapUsed.push(heapUsed);
  tmHistory.heapMax.push(heapMax);
  tmHistory.nonHeapUsed.push(nonHeapUsed);
  tmHistory.cpuLoad.push(Math.round(cpuLoad));
  tmHistory.threadsActive.push(threadsActive);
  tmHistory.threadsMax.push(threadsMax);
  tmHistory.dbSelects.push(parseFloat(selectRate.toFixed(1)));
  tmHistory.dbInserts.push(parseFloat(insertRate.toFixed(1)));
  tmHistory.dbUpdates.push(parseFloat(updateRate.toFixed(1)));
  tmHistory.dbDeletes.push(parseFloat(deleteRate.toFixed(1)));
  tmHistory.dbTx.push(parseFloat(totalDb.toFixed(1)));
  tmHistory.requestsSec.push(parseFloat(reqsRate.toFixed(1)));
  tmHistory.latencyMs.push(Math.round(avgLatency));
  tmHistory.gcCounts.push(gcCountDelta);
  tmHistory.gcTimes.push(Math.round(gcTimeDelta));
  tmHistory.sessionsAnon.push(anonSessions);
  tmHistory.sessionsNamed.push(namedSessions);
  tmHistory.sessionsNamedTotal.push(namedUsers);
  tmHistory.poolActive.push(poolActive);
  tmHistory.poolIdle.push(poolIdle);
  tmHistory.poolWaiters.push(poolWaiters);
  tmHistory.httpConns.push(httpConns);
  tmHistory.httpConnsMax.push(httpConnsMax);
  tmHistory.netInSec.push(parseFloat(netInRate.toFixed(1)));
  tmHistory.netOutSec.push(parseFloat(netOutRate.toFixed(1)));
  tmHistory.queueWaitMax.push(parseFloat(queueWaitMax.toFixed(2)));
  tmHistory.threadRunnable.push(threadRunnable);
  tmHistory.threadBlocked.push(threadBlocked);
  tmHistory.threadWaiting.push(threadWaiting);
  tmHistory.bufferUsed.push(bufferUsed);
  tmHistory.classesLoaded.push(classesLoaded);
  tmHistory.allocRate.push(parseFloat(allocRate.toFixed(1)));

  // Parse Task Queues
  let tqActive = parsed['mx_runtime_stats_taskqueue_queue_active_threads'] || [];
  for (let q of tqActive) {
    let qName = q.labels.queue || 'Unknown';
    if (!tmHistory.taskQueues[qName]) {
      tmHistory.taskQueues[qName] = new Array(Math.max(0, tmHistory.timestamps.length - 1)).fill(0);
    }
  }
  for (let qName in tmHistory.taskQueues) {
    let found = tqActive.find(q => (q.labels.queue || 'Unknown') === qName);
    tmHistory.taskQueues[qName].push(found ? found.value : 0);
  }

  // Parse Max Task Executions (Latest Only)
  let tasksMax = parsed['mx_runtime_stats_taskqueue_task_execution_time_seconds_max'] || [];
  tasksMax.sort((a,b) => b.value - a.value);
  let topTasks = tasksMax.slice(0, 10);
  tmHistory.maxTasksLabels = topTasks.map(t => t.labels.task || 'Unknown');
  tmHistory.maxTasksValues = topTasks.map(t => parseFloat(t.value.toFixed(2)));

  if (tmHistory.timestamps.length > 30) {
    for (let key in tmHistory) {
      if (key === 'taskQueues') {
        for (let qName in tmHistory.taskQueues) tmHistory.taskQueues[qName].shift();
      } else if (key !== 'maxTasksLabels' && key !== 'maxTasksValues') {
        tmHistory[key].shift();
      }
    }
  }

  // Update cards
  document.getElementById('tm-card-heap').textContent = `${heapUsed} MB / ${heapMax} MB`;
  const heapPct = heapMax > 0 ? Math.round((heapUsed / heapMax) * 100) : 0;
  document.getElementById('tm-card-heap-pct').textContent = `${heapPct}% used`;
  document.getElementById('tm-card-threads').textContent = `${threadsActive} / ${threadsMax}`;
  document.getElementById('tm-card-reqs').textContent = `${reqsRate.toFixed(1)} req/s`;
  document.getElementById('tm-card-latency').textContent = `Avg latency: ${Math.round(avgLatency)} ms`;
  
  document.getElementById('tm-card-db').textContent = `${totalDb.toFixed(1)} / s`;
  document.getElementById('tm-card-db-breakdown').textContent = `S:${selectRate.toFixed(0)} I:${insertRate.toFixed(0)} U:${updateRate.toFixed(0)} D:${deleteRate.toFixed(0)}`;

  tmUpdateChartsUI();
}

// ============================================================
// LOCAL AGENT CONTROLLER (LOGS & POSTGRESQL STATS)
// ============================================================

function tmConnectAgent() {
  const agentUrl = document.getElementById('tm-agent-url').value.trim();
  const logPath = document.getElementById('tm-agent-logpath').value.trim();

  if (!agentUrl) return alert('Please enter a Local Agent Endpoint URL');

  const btn = document.getElementById('tm-btn-agent-connect');
  btn.disabled = true;
  btn.innerHTML = '<span style="display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 1s linear infinite;margin-right:5px"></span> Connecting...';

  // Append status query
  fetch(`${agentUrl}/status`)
    .then(res => {
      if (!res.ok) throw new Error(`Agent returned status ${res.status}`);
      return res.json();
    })
    .then(data => {
      tmAgentStatus = 'connected';
      tmLastLogTimestamp = Date.now() - 1000; // start capturing logs from now

      // UI Updates
      document.getElementById('tm-agent-status-dot').style.background = 'var(--success)';
      const statusText = document.getElementById('tm-agent-status-text');
      statusText.textContent = 'Agent Connected';
      statusText.style.color = 'var(--success)';

      document.getElementById('tm-agent-info-text').innerHTML = `
        Log File: <code style="color:var(--accent);background:rgba(0,0,0,0.2);padding:2px 4px;border-radius:3px">${escHtml(data.logFile)}</code>
        ${data.otel ? `| OTLP Collector: <code style="color:var(--info);background:rgba(0,0,0,0.2);padding:2px 4px;border-radius:3px">:${data.otel.port}</code> (Traces/Logs: <strong style="color:var(--success)">${data.otel.tracesReceived}/${data.otel.logsReceived}</strong>)` : ''}
      `;

      btn.classList.remove('btn-primary');
      btn.classList.add('btn-success');
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Connected';
      btn.disabled = false;

      // Start Polling loops for logs and Postgres
      tmStartAgentPolling(agentUrl);
      tmUpdateTabsVisibility();

      // Auto-collapse connection settings card on successful connection
      tmToggleConnectionCard(true);
    })
    .catch(err => {
      console.error(err);
      tmAgentStatus = 'disconnected';
      
      document.getElementById('tm-agent-status-dot').style.background = 'var(--danger)';
      const statusText = document.getElementById('tm-agent-status-text');
      statusText.textContent = 'Connection Failed';
      statusText.style.color = 'var(--danger)';
      
      document.getElementById('tm-agent-info-text').innerHTML = `Could not reach Agent at <strong>${escHtml(agentUrl)}</strong>. <br/><span style="color:var(--danger)">Error: ${escHtml(err.message)}</span><br/>Ensure you ran <code>node mendix-observability-bridge.js</code> in your Mendix project directory.`;
      
      btn.classList.remove('btn-success');
      btn.classList.add('btn-primary');
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10"/></svg> Connect Agent';
      btn.disabled = false;
 
      tmStopAgentPolling();
      tmUpdateTabsVisibility();

      // Auto-expand connection settings card to show error details
      tmToggleConnectionCard(false);
    });
}

function tmStartAgentPolling(agentUrl) {
  tmStopAgentPolling();

  // Poll logs frequently (every 2s) for live feel
  tmAgentTimerLogs = setInterval(() => tmFetchAgentLogs(agentUrl), 2000);
  
  // Poll PostgreSQL statistics (every 8s)
  tmFetchAgentPostgres(agentUrl, true); // immediate first load in background
  tmAgentTimerPg = setInterval(() => tmFetchAgentPostgres(agentUrl, true), 8000);

  // Poll OTEL Traces and Logs (every 3s)
  tmAgentTimerOtel = setInterval(() => tmFetchAgentOtel(agentUrl), 3000);

  // Direct Prometheus Polling for Dashboard Metrics (if agent also exposes prometheus parser,
  // but Mendix app runs Prometheus on port 8090. Let's poll Mendix Prometheus endpoint directly in parallel!)
  // If the user is running Local Agent, we fetch Mendix app metrics directly from localhost:8090/prometheus in background.
  tmChangePollInterval();
}

function tmStopAgentPolling() {
  if (tmAgentTimerLogs) {
    clearInterval(tmAgentTimerLogs);
    tmAgentTimerLogs = null;
  }
  if (tmAgentTimerPg) {
    clearInterval(tmAgentTimerPg);
    tmAgentTimerPg = null;
  }
  if (tmAgentTimerOtel) {
    clearInterval(tmAgentTimerOtel);
    tmAgentTimerOtel = null;
  }
}

function tmFetchAgentLogs(agentUrl) {
  fetch(`${agentUrl}/logs?since=${tmLastLogTimestamp}`)
    .then(res => res.json())
    .then(data => {
      tmLastLogTimestamp = data.timestamp;
      
      if (data.lines && data.lines.length > 0) {
        const textBlock = data.lines.map(l => l.text).join('\n');
        
        // Push directly into Log Viewer tool if available!
        if (typeof logParseContent === 'function') {
          logParseContent(textBlock, 'Live Agent Stream');
          
          // Flash connection dot to indicate logs flowing
          const dot = document.getElementById('tm-agent-status-dot');
          dot.style.transform = 'scale(1.4)';
          dot.style.background = '#3498db';
          setTimeout(() => {
            dot.style.transform = 'scale(1)';
            dot.style.background = 'var(--success)';
          }, 400);
        }
      }
    })
    .catch(err => {
      console.warn('[Bridge] Log fetch failed:', err.message);
    });
}

function tmFetchAgentOtel(agentUrl) {
  // Fetch Traces
  fetch(`${agentUrl}/otel/traces?since=${tmLastOtelTraceTimestamp}`)
    .then(res => res.json())
    .then(data => {
      tmLastOtelTraceTimestamp = data.timestamp;
      if (data.items && data.items.length > 0) {
        // Collect spans from payload
        const newSpans = [];
        data.items.forEach(item => {
          if (item.payload && item.payload.resourceSpans) {
            item.payload.resourceSpans.forEach(rs => {
              if (rs.scopeSpans) {
                rs.scopeSpans.forEach(ss => {
                  if (ss.spans) newSpans.push(...ss.spans);
                });
              }
            });
          } else if (Array.isArray(item.payload)) {
             newSpans.push(...item.payload);
          }
        });
        
        if (newSpans.length > 0) {
           tmParsedSpans = tmParsedSpans.concat(newSpans);
           // keep max 2000 spans
           if (tmParsedSpans.length > 2000) tmParsedSpans = tmParsedSpans.slice(-2000);
           
           if (tmActiveTab === 'traces') {
             tmRenderOtelTracesTable();
             if (tmSelectedTraceId) {
               tmRenderTraceWaterfall();
             }
           }
           
           const btn = document.getElementById('tm-tab-traces-btn');
           if (btn) btn.innerHTML = `OTLP Traces <span style="background:var(--success);color:#fff;border-radius:10px;padding:2px 6px;font-size:0.7rem;margin-left:4px">${tmGetTraceList().length}</span>`;
        }
      }
    })
    .catch(err => console.warn('[Bridge] OTEL Trace fetch failed:', err.message));

  // Fetch Logs
  fetch(`${agentUrl}/otel/logs?since=${tmLastOtelLogTimestamp}`)
    .then(res => res.json())
    .then(data => {
      tmLastOtelLogTimestamp = data.timestamp;
      if (data.items && data.items.length > 0) {
        let logLines = '';
        const newLogs = [];
        data.items.forEach(item => {
           if (item.payload && item.payload.resourceLogs) {
             item.payload.resourceLogs.forEach(rl => {
                if (rl.scopeLogs) {
                   rl.scopeLogs.forEach(sl => {
                      if (sl.logRecords) {
                         sl.logRecords.forEach(lr => {
                            const sev = lr.severityText || 'INFO';
                            const msg = lr.body ? (lr.body.stringValue || lr.body.intValue || lr.body.boolValue || '') : '';
                            const timeMs = lr.timeUnixNano ? parseInt(lr.timeUnixNano) / 1000000 : Date.now();
                            const timeStr = new Date(timeMs).toISOString();
                            logLines += `${timeStr} [OTLP_${sev}] ${msg}\n`;
                            
                            newLogs.push({
                              timestamp: timeMs,
                              severity: sev,
                              message: msg,
                              traceId: lr.traceId || '',
                              spanId: lr.spanId || ''
                            });
                         });
                      }
                   });
                }
             });
           }
        });
        
        if (newLogs.length > 0) {
          tmParsedLogs = tmParsedLogs.concat(newLogs);
          if (tmParsedLogs.length > 2000) tmParsedLogs = tmParsedLogs.slice(-2000);
          
          if (tmActiveTab === 'traces') {
            tmRenderOtelLogsTable();
          }
        }
        
        if (logLines && typeof logParseContent === 'function') {
           logParseContent(logLines, 'OTLP Live Stream');
        }
      }
    })
    .catch(err => console.warn('[Bridge] OTEL Log fetch failed:', err.message));
}

function tmFetchAgentPostgres(agentUrl, isAutoPoll = false) {
  const dbConfig = {
    host: document.getElementById('tm-pg-host').value.trim(),
    port: parseInt(document.getElementById('tm-pg-port').value.trim()),
    database: document.getElementById('tm-pg-dbname').value.trim(),
    user: document.getElementById('tm-pg-user').value.trim(),
    password: document.getElementById('tm-pg-pass').value
  };

  const statusIndicator = document.getElementById('tm-pg-status-indicator');
  const connBtn = document.getElementById('tm-pg-btn-connect');
  
  if (!isAutoPoll) {
    if (connBtn) {
      connBtn.disabled = true;
      connBtn.innerHTML = '<span style="display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 1s linear infinite;margin-right:5px"></span> Connecting...';
    }
    if (statusIndicator) {
      statusIndicator.innerHTML = '<span style="color:var(--text-secondary)">Connecting...</span>';
    }
  }

  fetch(`${agentUrl}/postgres`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dbConfig)
  })
    .then(res => res.json())
    .then(data => {
      if (!isAutoPoll) {
        if (connBtn) {
          connBtn.disabled = false;
          connBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M12 2v10M18.36 6.64a9 9 0 1 1-12.73 0"/></svg> Connect &amp; Refresh';
        }
      }
      if (data.error) {
         const sessionsTbody = document.getElementById('tm-pg-sessions-tbody');
         if (sessionsTbody) {
           sessionsTbody.innerHTML = `<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--danger)">Database Connection Error: ${data.message}</td></tr>`;
         }
         if (statusIndicator) {
           statusIndicator.innerHTML = '<span style="color:var(--danger);font-weight:600">● Connection Error</span>';
         }
         if (!isAutoPoll) {
           tmTogglePgConfigCard(false); // auto-expand on manual error
         }
         return;
      }
      if (statusIndicator) {
        statusIndicator.innerHTML = '<span style="color:var(--success);font-weight:600">● Connected</span>';
      }
      tmRenderPostgresStats(data);
      if (!isAutoPoll) {
        tmTogglePgConfigCard(true); // auto-collapse on manual success
      }
    })
    .catch(err => {
      if (!isAutoPoll) {
        if (connBtn) {
          connBtn.disabled = false;
          connBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M12 2v10M18.36 6.64a9 9 0 1 1-12.73 0"/></svg> Connect &amp; Refresh';
        }
      }
      if (statusIndicator) {
        statusIndicator.innerHTML = '<span style="color:var(--danger);font-weight:600">● Connection Error</span>';
      }
      const sessionsTbody = document.getElementById('tm-pg-sessions-tbody');
      if (sessionsTbody) {
        sessionsTbody.innerHTML = `<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--danger)">Connection Error: ${err.message || err}</td></tr>`;
      }
      if (!isAutoPoll) {
        tmTogglePgConfigCard(false); // auto-expand on manual error
      }
    });
}

function tmRefreshPostgres() {
  if (tmIsMocking) {
    // Generate new mock PostgreSQL stats
    tmGenerateMockPgStats();
    
    // Auto-collapse PostgreSQL settings card on success
    tmTogglePgConfigCard(true);
    return;
  }
  
  if (tmAgentStatus !== 'connected') {
    return alert('Please connect the Local Observability Agent first.');
  }
  const agentUrl = document.getElementById('tm-agent-url').value.trim();
  tmFetchAgentPostgres(agentUrl, false);
}

function tmShowQueryModal(e, query) {
  e.preventDefault();
  let modal = document.getElementById('tm-query-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'tm-query-modal';
    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.width = '100vw';
    modal.style.height = '100vh';
    modal.style.backgroundColor = 'rgba(0,0,0,0.7)';
    modal.style.zIndex = '9999';
    modal.style.display = 'flex';
    modal.style.justifyContent = 'center';
    modal.style.alignItems = 'center';

    const content = document.createElement('div');
    content.style.backgroundColor = 'var(--bg)';
    content.style.padding = '20px';
    content.style.borderRadius = '8px';
    content.style.width = '80%';
    content.style.maxWidth = '800px';
    content.style.maxHeight = '80vh';
    content.style.display = 'flex';
    content.style.flexDirection = 'column';
    content.style.boxShadow = '0 10px 25px rgba(0,0,0,0.5)';
    content.style.border = '1px solid var(--border)';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.marginBottom = '15px';
    header.innerHTML = '<h3 style="margin:0;color:var(--text-primary)">SQL Query Preview</h3><button class="btn btn-secondary btn-sm" id="tm-query-modal-close">Close</button>';

    const body = document.createElement('pre');
    body.id = 'tm-query-modal-body';
    body.style.backgroundColor = 'var(--bg-elevated)';
    body.style.padding = '15px';
    body.style.borderRadius = '4px';
    body.style.overflow = 'auto';
    body.style.whiteSpace = 'pre-wrap';
    body.style.wordBreak = 'break-all';
    body.style.fontFamily = 'var(--font-mono)';
    body.style.fontSize = '0.8rem';
    body.style.color = 'var(--text-primary)';
    body.style.border = '1px solid var(--border)';
    body.style.flexGrow = '1';

    content.appendChild(header);
    content.appendChild(body);
    modal.appendChild(content);

    document.body.appendChild(modal);

    document.getElementById('tm-query-modal-close').addEventListener('click', () => {
      modal.style.display = 'none';
    });
    modal.addEventListener('click', (ev) => {
      if (ev.target === modal) modal.style.display = 'none';
    });
  }

  document.getElementById('tm-query-modal-body').textContent = query || 'No query available.';
  modal.style.display = 'flex';
}

function tmRenderPostgresStats(data) {
  const statusIndicator = document.getElementById('tm-pg-status-indicator');
  if (statusIndicator) {
    statusIndicator.innerHTML = '<span style="color:var(--success);font-weight:600">● Connected</span>';
  }

  const stats = data.stats || {};
  
  // Size formatting
  const sizeBytes = stats.size_bytes || 0;
  const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);

  // 1. Update Cards
  const activeC = stats.active_conns || 0;
  const maxC = stats.max_conns || 100;
  const idleC = stats.idle_conns || 0;
  
  document.getElementById('tm-pg-card-conns').textContent = `${activeC} / ${maxC}`;
  document.getElementById('tm-pg-card-idle').textContent = `${idleC} idle sessions`;
  document.getElementById('tm-pg-card-size').textContent = `${sizeMB} MB`;
  document.getElementById('tm-pg-card-dbname').textContent = `DB: ${data.dbname || 'mendix'}`;
  document.getElementById('tm-pg-card-hitrate').textContent = `${(stats.hit_ratio || 0.0).toFixed(1)} %`;
  
  const locksCount = stats.lock_waiters || 0;
  const locksCard = document.getElementById('tm-pg-card-locks');
  locksCard.textContent = `${locksCount} lock${locksCount === 1 ? '' : 's'}`;
  document.getElementById('tm-pg-card-blocked').textContent = `${locksCount} blocked trans.`;
  
  // Highlight locks in red if deadlocks exist
  const locksCardParent = locksCard.closest('.stat-item');
  if (locksCount > 0) {
    locksCardParent.style.borderLeftColor = 'var(--danger)';
    locksCardParent.style.background = 'rgba(231, 76, 60, 0.08)';
  } else {
    locksCardParent.style.borderLeftColor = 'var(--danger)';
    locksCardParent.style.background = '';
  }

  // 1.5 Update Global Stats
  const globalStats = data.global_stats || {};
  document.getElementById('tm-pg-global-alloc').textContent = (globalStats.buffers_alloc || 0).toLocaleString();
  document.getElementById('tm-pg-global-clean').textContent = (globalStats.buffers_clean || 0).toLocaleString();
  document.getElementById('tm-pg-global-maxclean').textContent = (globalStats.maxwritten_clean || 0).toLocaleString();
  document.getElementById('tm-pg-global-backend').textContent = (globalStats.buffers_backend || 0).toLocaleString();

  // 2. Active Sessions Table
  const sessionsTbody = document.getElementById('tm-pg-sessions-tbody');
  sessionsTbody.innerHTML = '';
  
  const sessions = data.sessions || [];
  if (sessions.length === 0) {
    sessionsTbody.innerHTML = `<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted)">No active query sessions.</td></tr>`;
  } else {
    sessions.forEach(s => {
      let stateColor = 'var(--text-muted)';
      if (s.state === 'active') stateColor = 'var(--success)';
      else if (s.state.includes('transaction')) stateColor = 'var(--warning)';

      const row = document.createElement('tr');
      row.style.borderBottom = '1px solid var(--border)';
      row.innerHTML = `
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem">${s.pid}</td>
        <td style="padding:8px 12px;font-weight:600;font-size:0.7rem;color:${stateColor}">${escHtml(s.state)}</td>
        <td style="padding:8px 12px;font-size:0.72rem">${s.duration_ms ? s.duration_ms + ' ms' : '< 1 ms'}</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.7rem">${escHtml(s.client || 'local')}</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(s.query)}">
          <a href="#" onclick="tmShowQueryModal(event, this.parentElement.getAttribute('title'))" style="color:var(--accent);text-decoration:none;margin-right:8px;display:inline-flex;align-items:center" title="Preview SQL Query"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:middle;margin-right:4px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></a>${escHtml(s.query)}
        </td>
      `;
      sessionsTbody.appendChild(row);
    });
  }

  // 3. Locks Table
  const locksTbody = document.getElementById('tm-pg-locks-tbody');
  locksTbody.innerHTML = '';

  const locks = data.locks || [];
  if (locks.length === 0) {
    locksTbody.innerHTML = `<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted)">No transaction lock conflicts identified.</td></tr>`;
  } else {
    locks.forEach(l => {
      const row = document.createElement('tr');
      row.style.borderBottom = '1px solid var(--border)';
      row.style.background = 'rgba(231, 76, 60, 0.03)';
      row.innerHTML = `
        <td style="padding:8px 12px;font-family:var(--font-mono);font-weight:600;color:var(--danger)">${l.blocked_pid}</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);font-weight:600;color:var(--success)">${l.blocking_pid}</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(l.blocked_statement)}">
          <a href="#" onclick="tmShowQueryModal(event, this.parentElement.getAttribute('title'))" style="color:var(--accent);text-decoration:none;margin-right:8px;display:inline-flex;align-items:center" title="Preview SQL Query"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:middle;margin-right:4px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></a>${escHtml(l.blocked_statement)}
        </td>
        <td style="padding:8px 12px;font-family:var(--font-mono);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(l.blocking_statement)}">
          <a href="#" onclick="tmShowQueryModal(event, this.parentElement.getAttribute('title'))" style="color:var(--accent);text-decoration:none;margin-right:8px;display:inline-flex;align-items:center" title="Preview SQL Query"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:middle;margin-right:4px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></a>${escHtml(l.blocking_statement)}
        </td>
        <td style="padding:8px 12px;font-weight:600;color:var(--danger)">${l.duration_ms} ms</td>
      `;
      locksTbody.appendChild(row);
    });
  }

  // 4. Long-Running Transactions Table
  const longTbody = document.getElementById('tm-pg-long-running-tbody');
  longTbody.innerHTML = '';
  const longRunning = sessions.filter(s => s.state === 'idle in transaction' && s.duration_ms > 1000);
  if (longRunning.length === 0) {
    longTbody.innerHTML = `<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted)">No long-running idle transactions.</td></tr>`;
  } else {
    longRunning.forEach(s => {
      const row = document.createElement('tr');
      row.style.borderBottom = '1px solid var(--border)';
      row.style.background = 'rgba(243, 156, 18, 0.05)';
      row.innerHTML = `
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem">${s.pid}</td>
        <td style="padding:8px 12px;font-weight:600;font-size:0.7rem;color:var(--warning)">${escHtml(s.state)}</td>
        <td style="padding:8px 12px;font-size:0.72rem;color:var(--warning)">${s.duration_ms} ms</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.7rem">${escHtml(s.client || 'local')}</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(s.query)}">
          <a href="#" onclick="tmShowQueryModal(event, this.parentElement.getAttribute('title'))" style="color:var(--accent);text-decoration:none;margin-right:8px;display:inline-flex;align-items:center" title="Preview SQL Query"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:middle;margin-right:4px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></a>${escHtml(s.query)}
        </td>
      `;
      longTbody.appendChild(row);
    });
  }

  // 5. Slow Queries Table
  const slowQueriesTbody = document.getElementById('tm-pg-slow-queries-tbody');
  slowQueriesTbody.innerHTML = '';
  const slowError = document.getElementById('tm-pg-slow-queries-error');
  const slowTable = document.getElementById('tm-pg-slow-queries-table');
  
  if (data.slow_queries_error) {
    slowError.style.display = 'block';
    if (data.slow_queries_error.includes('pg_stat_statements')) {
      slowError.innerHTML = `${escHtml(data.slow_queries_error)}<br><br><span style="font-size:0.75rem;color:var(--text-muted)">Hint: To enable slow queries tracking, connect to your database and run <code>CREATE EXTENSION pg_stat_statements;</code>. Also ensure it is added to <code>shared_preload_libraries</code> in <code>postgresql.conf</code>.</span>`;
    } else {
      slowError.textContent = data.slow_queries_error;
    }
    slowTable.style.display = 'none';
  } else {
    slowError.style.display = 'none';
    slowTable.style.display = 'table';
    const slowQueries = data.slow_queries || [];
    if (slowQueries.length === 0) {
      slowQueriesTbody.innerHTML = `<tr><td colspan="4" style="padding:16px;text-align:center;color:var(--text-muted)">No slow queries recorded.</td></tr>`;
    } else {
      slowQueries.forEach(sq => {
        const row = document.createElement('tr');
        row.style.borderBottom = '1px solid var(--border)';
        row.innerHTML = `
          <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(sq.query)}">
            <a href="#" onclick="tmShowQueryModal(event, this.parentElement.getAttribute('title'))" style="color:var(--accent);text-decoration:none;margin-right:8px;display:inline-flex;align-items:center" title="Preview SQL Query"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:middle;margin-right:4px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></a>${escHtml(sq.query)}
          </td>
          <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem">${sq.calls}</td>
          <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem">${sq.mean_time_ms}</td>
          <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem">${sq.total_time_ms}</td>
        `;
        slowQueriesTbody.appendChild(row);
      });
    }
  }

  // 6. Table Health
  const tableHealthTbody = document.getElementById('tm-pg-table-health-tbody');
  tableHealthTbody.innerHTML = '';
  const tableHealth = data.table_health || [];
  if (tableHealth.length === 0) {
    tableHealthTbody.innerHTML = `<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted)">No table health data available.</td></tr>`;
  } else {
    tableHealth.forEach(th => {
      const bloatColor = th.bloat_ratio > 20 ? 'var(--warning)' : 'inherit';
      const hitColor = th.hit_ratio < 90 ? 'var(--warning)' : 'var(--success)';
      const row = document.createElement('tr');
      row.style.borderBottom = '1px solid var(--border)';
      row.innerHTML = `
        <td style="padding:8px 12px;font-weight:600;font-size:0.75rem">${escHtml(th.table_name)}</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem">${th.seq_scan || 0}</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem">${th.idx_scan || 0}</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem;color:${bloatColor}">${th.dead_tuples || 0} (${th.bloat_ratio || 0}%)</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem;color:${hitColor}">${th.hit_ratio || 0}%</td>
      `;
      tableHealthTbody.appendChild(row);
    });
  }
}

// ============================================================
// CHART.JS INITIALIZATION & UPDATES
// ============================================================

function tmGetChartColors() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    gridColor: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.05)',
    textColor: isDark ? '#b3b3b3' : '#666666',
    tooltipBg: isDark ? '#1f1f1f' : '#ffffff',
    tooltipBorder: isDark ? '#373737' : '#dddddd',
    tooltipColor: isDark ? '#ffffff' : '#000000'
  };
}

function tmInitChart(chartId, type, config) {
  const ctx = document.getElementById(chartId);
  if (!ctx) return null;

  if (tmCharts[chartId]) {
    tmCharts[chartId].destroy();
  }

  const colors = tmGetChartColors();

  config.options = config.options || {};
  config.options.responsive = true;
  config.options.maintainAspectRatio = false;
  config.options.animation = { duration: 300 };
  
  config.options.plugins = config.options.plugins || {};
  config.options.plugins.tooltip = {
    backgroundColor: colors.tooltipBg,
    titleColor: colors.tooltipColor,
    bodyColor: colors.textColor,
    borderColor: colors.tooltipBorder,
    borderWidth: 1,
    padding: 8,
    boxPadding: 4,
    usePointStyle: true,
    callbacks: config.options.plugins.tooltip?.callbacks || {}
  };

  config.options.scales = config.options.scales || {};
  for (let s in config.options.scales) {
    config.options.scales[s].grid = config.options.scales[s].grid || {};
    config.options.scales[s].grid.color = colors.gridColor;
    config.options.scales[s].grid.drawBorder = false;

    config.options.scales[s].ticks = config.options.scales[s].ticks || {};
    config.options.scales[s].ticks.color = colors.textColor;
    config.options.scales[s].ticks.font = { size: 10 };
  }

  tmCharts[chartId] = new Chart(ctx, config);
  return tmCharts[chartId];
}

function tmUpdateChartsUI() {
  const colors = tmGetChartColors();

  // 1. MEMORY CHART
  if (!tmCharts['tm-chart-memory']) {
    tmInitChart('tm-chart-memory', 'line', {
      type: 'line',
      data: {
        labels: tmHistory.timestamps,
        datasets: [
          {
            label: 'Heap Used',
            data: tmHistory.heapUsed,
            borderColor: '#3498db',
            backgroundColor: 'rgba(52, 152, 219, 0.1)',
            fill: true,
            borderWidth: 2,
            tension: 0.2,
            pointRadius: 2
          },
          {
            label: 'Heap Max',
            data: tmHistory.heapMax,
            borderColor: 'rgba(52, 152, 219, 0.5)',
            borderDash: [5, 5],
            fill: false,
            borderWidth: 1,
            tension: 0,
            pointRadius: 0
          },
          {
            label: 'Non-Heap',
            data: tmHistory.nonHeapUsed,
            borderColor: '#9b59b6',
            backgroundColor: 'rgba(155, 89, 182, 0.05)',
            fill: true,
            borderWidth: 1.5,
            tension: 0.2,
            pointRadius: 1
          }
        ]
      },
      options: {
        plugins: {
          legend: { display: true, position: 'top', labels: { boxWidth: 12, color: colors.textColor } }
        },
        scales: {
          y: {
            title: { display: true, text: 'MB', color: colors.textColor },
            beginAtZero: true
          },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    tmCharts['tm-chart-memory'].data.labels = tmHistory.timestamps;
    tmCharts['tm-chart-memory'].data.datasets[0].data = tmHistory.heapUsed;
    tmCharts['tm-chart-memory'].data.datasets[1].data = tmHistory.heapMax;
    tmCharts['tm-chart-memory'].data.datasets[2].data = tmHistory.nonHeapUsed;
    tmCharts['tm-chart-memory'].update();
  }

  // 2. CPU / THREADS CHART
  if (!tmCharts['tm-chart-cpu-threads']) {
    tmInitChart('tm-chart-cpu-threads', 'line', {
      type: 'line',
      data: {
        labels: tmHistory.timestamps,
        datasets: [
          {
            label: 'CPU Load (%)',
            data: tmHistory.cpuLoad,
            borderColor: '#e74c3c',
            yAxisID: 'yCPU',
            borderWidth: 2,
            fill: false,
            tension: 0.3,
            pointRadius: 1
          },
          {
            label: 'Active Threads',
            data: tmHistory.threadsActive,
            borderColor: '#2ecc71',
            yAxisID: 'yThreads',
            borderWidth: 2,
            fill: false,
            tension: 0.1,
            pointRadius: 1
          }
        ]
      },
      options: {
        plugins: {
          legend: { display: true, position: 'top', labels: { boxWidth: 12, color: colors.textColor } }
        },
        scales: {
          yCPU: {
            type: 'linear',
            position: 'left',
            min: 0,
            max: 100,
            title: { display: true, text: 'CPU %', color: colors.textColor }
          },
          yThreads: {
            type: 'linear',
            position: 'right',
            beginAtZero: true,
            grid: { drawOnChartArea: false },
            title: { display: true, text: 'Threads Count', color: colors.textColor }
          },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    tmCharts['tm-chart-cpu-threads'].data.labels = tmHistory.timestamps;
    tmCharts['tm-chart-cpu-threads'].data.datasets[0].data = tmHistory.cpuLoad;
    tmCharts['tm-chart-cpu-threads'].data.datasets[1].data = tmHistory.threadsActive;
    tmCharts['tm-chart-cpu-threads'].update();
  }

  // 3. DATABASE TRANSACTIONS
  if (!tmCharts['tm-chart-db']) {
    tmInitChart('tm-chart-db', 'line', {
      type: 'line',
      data: {
        labels: tmHistory.timestamps,
        datasets: [
          { label: 'Selects', data: tmHistory.dbSelects, borderColor: '#3498db', borderWidth: 1.5, fill: false, tension: 0.1, pointRadius: 1 },
          { label: 'Inserts', data: tmHistory.dbInserts, borderColor: '#2ecc71', borderWidth: 1.5, fill: false, tension: 0.1, pointRadius: 1 },
          { label: 'Updates', data: tmHistory.dbUpdates, borderColor: '#f1c40f', borderWidth: 1.5, fill: false, tension: 0.1, pointRadius: 1 },
          { label: 'Deletes', data: tmHistory.dbDeletes, borderColor: '#e74c3c', borderWidth: 1.5, fill: false, tension: 0.1, pointRadius: 1 },
          { label: 'Total Tx', data: tmHistory.dbTx, borderColor: '#9b59b6', borderWidth: 2, borderDash: [5, 5], fill: false, tension: 0.1, pointRadius: 0 }
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          y: { title: { display: true, text: 'Queries / s', color: colors.textColor }, beginAtZero: true },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    tmCharts['tm-chart-db'].data.labels = tmHistory.timestamps;
    tmCharts['tm-chart-db'].data.datasets[0].data = tmHistory.dbSelects;
    tmCharts['tm-chart-db'].data.datasets[1].data = tmHistory.dbInserts;
    tmCharts['tm-chart-db'].data.datasets[2].data = tmHistory.dbUpdates;
    tmCharts['tm-chart-db'].data.datasets[3].data = tmHistory.dbDeletes;
    tmCharts['tm-chart-db'].data.datasets[4].data = tmHistory.dbTx;
    tmCharts['tm-chart-db'].update();
  }

  // 4. REQUESTS AND LATENCY
  if (!tmCharts['tm-chart-requests']) {
    tmInitChart('tm-chart-requests', 'line', {
      type: 'line',
      data: {
        labels: tmHistory.timestamps,
        datasets: [
          { label: 'Requests/s', data: tmHistory.requestsSec, borderColor: '#e67e22', yAxisID: 'yReqs', borderWidth: 2, fill: false, tension: 0.2, pointRadius: 1 },
          { label: 'Latency (ms)', data: tmHistory.latencyMs, borderColor: '#9b59b6', yAxisID: 'yLatency', borderWidth: 1.5, fill: false, tension: 0.2, pointRadius: 1 }
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          yReqs: { type: 'linear', position: 'left', beginAtZero: true, title: { display: true, text: 'Reqs/s', color: colors.textColor } },
          yLatency: { type: 'linear', position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'Latency (ms)', color: colors.textColor } },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    tmCharts['tm-chart-requests'].data.labels = tmHistory.timestamps;
    tmCharts['tm-chart-requests'].data.datasets[0].data = tmHistory.requestsSec;
    tmCharts['tm-chart-requests'].data.datasets[1].data = tmHistory.latencyMs;
    tmCharts['tm-chart-requests'].update();
  }

  // 5. GARBAGE COLLECTION
  if (!tmCharts['tm-chart-gc']) {
    tmInitChart('tm-chart-gc', 'bar', {
      type: 'bar',
      data: {
        labels: tmHistory.timestamps,
        datasets: [
          { label: 'GC Count', data: tmHistory.gcCounts, backgroundColor: '#f39c12', yAxisID: 'yCount', barThickness: 6 },
          { label: 'GC Duration (ms)', data: tmHistory.gcTimes, backgroundColor: '#d35400', yAxisID: 'yTime', barThickness: 6 }
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          yCount: { type: 'linear', position: 'left', beginAtZero: true, ticks: { stepSize: 1 }, title: { display: true, text: 'GC Count', color: colors.textColor } },
          yTime: { type: 'linear', position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'Duration (ms)', color: colors.textColor } },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    tmCharts['tm-chart-gc'].data.labels = tmHistory.timestamps;
    tmCharts['tm-chart-gc'].data.datasets[0].data = tmHistory.gcCounts;
    tmCharts['tm-chart-gc'].data.datasets[1].data = tmHistory.gcTimes;
    tmCharts['tm-chart-gc'].update();
  }

  // 6. SESSIONS
  if (!tmCharts['tm-chart-sessions']) {
    tmInitChart('tm-chart-sessions', 'line', {
      type: 'line',
      data: {
        labels: tmHistory.timestamps,
        datasets: [
          { label: 'Named User Sessions', data: tmHistory.sessionsNamed, borderColor: '#3498db', borderWidth: 2, fill: true, backgroundColor: 'rgba(52, 152, 219, 0.1)', tension: 0.1, pointRadius: 1 },
          { label: 'Anonymous Sessions', data: tmHistory.sessionsAnon, borderColor: '#95a5a6', borderWidth: 2, fill: true, backgroundColor: 'rgba(149, 165, 166, 0.1)', tension: 0.1, pointRadius: 1 },
          { label: 'Total Named Users', data: tmHistory.sessionsNamedTotal, borderColor: '#2ecc71', borderWidth: 2, borderDash: [5, 5], fill: false, tension: 0.1, pointRadius: 0 }
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          y: { title: { display: true, text: 'Count', color: colors.textColor }, beginAtZero: true, ticks: { stepSize: 1 } },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    tmCharts['tm-chart-sessions'].data.labels = tmHistory.timestamps;
    tmCharts['tm-chart-sessions'].data.datasets[0].data = tmHistory.sessionsNamed;
    tmCharts['tm-chart-sessions'].data.datasets[1].data = tmHistory.sessionsAnon;
    tmCharts['tm-chart-sessions'].data.datasets[2].data = tmHistory.sessionsNamedTotal;
    tmCharts['tm-chart-sessions'].update();
  }

  // 7. TASK QUEUES
  if (!tmCharts['tm-chart-taskqueues']) {
    tmInitChart('tm-chart-taskqueues', 'line', {
      type: 'line',
      data: {
        labels: tmHistory.timestamps,
        datasets: []
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          y: { title: { display: true, text: 'Active Threads', color: colors.textColor }, beginAtZero: true, ticks: { stepSize: 1 } },
          x: { grid: { display: false } }
        }
      }
    });
  }
  
  if (tmCharts['tm-chart-taskqueues']) {
    let qKeys = Object.keys(tmHistory.taskQueues);
    let datasets = qKeys.map((q, idx) => {
      const lineColors = ['#f1c40f', '#e67e22', '#e74c3c', '#9b59b6', '#34495e'];
      return {
        label: q,
        data: tmHistory.taskQueues[q],
        borderColor: lineColors[idx % lineColors.length],
        borderWidth: 2,
        fill: false,
        tension: 0.1,
        pointRadius: 1
      };
    });
    tmCharts['tm-chart-taskqueues'].data.labels = tmHistory.timestamps;
    tmCharts['tm-chart-taskqueues'].data.datasets = datasets;
    tmCharts['tm-chart-taskqueues'].update();
  }

  // 8. BACKGROUND TASKS
  if (!tmCharts['tm-chart-tasks']) {
    tmInitChart('tm-chart-tasks', 'bar', {
      type: 'bar',
      data: {
        labels: tmHistory.maxTasksLabels,
        datasets: [
          { label: 'Max Execution Time (s)', data: tmHistory.maxTasksValues, backgroundColor: '#3498db', barThickness: 20 }
        ]
      },
      options: {
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: { title: { display: true, text: 'Time (seconds)', color: colors.textColor }, beginAtZero: true },
          y: { grid: { display: false } }
        }
      }
    });
  } else {
    tmCharts['tm-chart-tasks'].data.labels = tmHistory.maxTasksLabels;
    tmCharts['tm-chart-tasks'].data.datasets[0].data = tmHistory.maxTasksValues;
    tmCharts['tm-chart-tasks'].update();
  }

  // 9. Database Connection Pool
  if (!tmCharts['tm-chart-dbpool']) {
    tmInitChart('tm-chart-dbpool', 'line', {
      type: 'line',
      data: {
        labels: tmHistory.timestamps,
        datasets: [
          { label: 'Active', data: tmHistory.poolActive, borderColor: '#e74c3c', borderWidth: 2, fill: false, tension: 0.1, pointRadius: 1 },
          { label: 'Idle', data: tmHistory.poolIdle, borderColor: '#2ecc71', borderWidth: 2, fill: false, tension: 0.1, pointRadius: 1 },
          { label: 'Waiters', data: tmHistory.poolWaiters, borderColor: '#f1c40f', borderWidth: 2, borderDash: [5, 5], fill: true, backgroundColor: 'rgba(241, 196, 15, 0.2)', tension: 0.1, pointRadius: 1 }
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          y: { title: { display: true, text: 'Connections / Threads', color: colors.textColor }, beginAtZero: true, ticks: { stepSize: 1 } },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    tmCharts['tm-chart-dbpool'].data.labels = tmHistory.timestamps;
    tmCharts['tm-chart-dbpool'].data.datasets[0].data = tmHistory.poolActive;
    tmCharts['tm-chart-dbpool'].data.datasets[1].data = tmHistory.poolIdle;
    tmCharts['tm-chart-dbpool'].data.datasets[2].data = tmHistory.poolWaiters;
    tmCharts['tm-chart-dbpool'].update();
  }

  // 10. HTTP Server Connections
  if (!tmCharts['tm-chart-httpconns']) {
    tmInitChart('tm-chart-httpconns', 'line', {
      type: 'line',
      data: {
        labels: tmHistory.timestamps,
        datasets: [
          { label: 'Current', data: tmHistory.httpConns, borderColor: '#3498db', borderWidth: 2, fill: true, backgroundColor: 'rgba(52, 152, 219, 0.2)', tension: 0.1, pointRadius: 1 },
          { label: 'Max', data: tmHistory.httpConnsMax, borderColor: '#e67e22', borderWidth: 2, borderDash: [5, 5], fill: false, tension: 0.1, pointRadius: 0 }
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          y: { title: { display: true, text: 'Connections', color: colors.textColor }, beginAtZero: true, ticks: { stepSize: 1 } },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    tmCharts['tm-chart-httpconns'].data.labels = tmHistory.timestamps;
    tmCharts['tm-chart-httpconns'].data.datasets[0].data = tmHistory.httpConns;
    tmCharts['tm-chart-httpconns'].data.datasets[1].data = tmHistory.httpConnsMax;
    tmCharts['tm-chart-httpconns'].update();
  }

  // 11. Network Traffic Rate
  if (!tmCharts['tm-chart-network']) {
    tmInitChart('tm-chart-network', 'line', {
      type: 'line',
      data: {
        labels: tmHistory.timestamps,
        datasets: [
          { label: 'Inbound (KB/s)', data: tmHistory.netInSec, borderColor: '#2ecc71', borderWidth: 2, fill: true, backgroundColor: 'rgba(46, 204, 113, 0.1)', tension: 0.2, pointRadius: 1 },
          { label: 'Outbound (KB/s)', data: tmHistory.netOutSec, borderColor: '#9b59b6', borderWidth: 2, fill: true, backgroundColor: 'rgba(155, 89, 182, 0.1)', tension: 0.2, pointRadius: 1 }
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          y: { title: { display: true, text: 'KB / s', color: colors.textColor }, beginAtZero: true },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    tmCharts['tm-chart-network'].data.labels = tmHistory.timestamps;
    tmCharts['tm-chart-network'].data.datasets[0].data = tmHistory.netInSec;
    tmCharts['tm-chart-network'].data.datasets[1].data = tmHistory.netOutSec;
    tmCharts['tm-chart-network'].update();
  }

  // 12. Task Queue Wait Times
  if (!tmCharts['tm-chart-taskwaits']) {
    tmInitChart('tm-chart-taskwaits', 'line', {
      type: 'line',
      data: {
        labels: tmHistory.timestamps,
        datasets: [
          { label: 'Max Wait Time (s)', data: tmHistory.queueWaitMax, borderColor: '#e74c3c', borderWidth: 2, fill: true, backgroundColor: 'rgba(231, 76, 60, 0.2)', tension: 0.1, pointRadius: 2 }
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          y: { title: { display: true, text: 'Seconds', color: colors.textColor }, beginAtZero: true },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    tmCharts['tm-chart-taskwaits'].data.labels = tmHistory.timestamps;
    tmCharts['tm-chart-taskwaits'].data.datasets[0].data = tmHistory.queueWaitMax;
    tmCharts['tm-chart-taskwaits'].update();
  }

  // 13. JVM Thread States
  if (!tmCharts['tm-chart-threadstates']) {
    tmInitChart('tm-chart-threadstates', 'bar', {
      type: 'bar',
      data: {
        labels: tmHistory.timestamps,
        datasets: [
          { label: 'Runnable', data: tmHistory.threadRunnable, backgroundColor: '#2ecc71' },
          { label: 'Waiting', data: tmHistory.threadWaiting, backgroundColor: '#f1c40f' },
          { label: 'Blocked', data: tmHistory.threadBlocked, backgroundColor: '#e74c3c' }
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Thread Count', color: colors.textColor } }
        }
      }
    });
  } else {
    tmCharts['tm-chart-threadstates'].data.labels = tmHistory.timestamps;
    tmCharts['tm-chart-threadstates'].data.datasets[0].data = tmHistory.threadRunnable;
    tmCharts['tm-chart-threadstates'].data.datasets[1].data = tmHistory.threadWaiting;
    tmCharts['tm-chart-threadstates'].data.datasets[2].data = tmHistory.threadBlocked;
    tmCharts['tm-chart-threadstates'].update();
  }

  // 14. JVM Off-Heap Buffers & Allocation
  if (!tmCharts['tm-chart-jvmextra']) {
    tmInitChart('tm-chart-jvmextra', 'line', {
      type: 'line',
      data: {
        labels: tmHistory.timestamps,
        datasets: [
          { label: 'Direct Buffer Used (MB)', data: tmHistory.bufferUsed, borderColor: '#e67e22', yAxisID: 'yLeft', borderWidth: 2, fill: false, tension: 0.1, pointRadius: 1 },
          { label: 'Loaded Classes (k)', data: tmHistory.classesLoaded, borderColor: '#95a5a6', yAxisID: 'yLeft', borderWidth: 2, borderDash: [5, 5], fill: false, tension: 0.1, pointRadius: 0 },
          { label: 'Alloc Rate (MB/s)', data: tmHistory.allocRate, borderColor: '#3498db', yAxisID: 'yRight', borderWidth: 2, fill: true, backgroundColor: 'rgba(52, 152, 219, 0.1)', tension: 0.2, pointRadius: 1 }
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          yLeft: { type: 'linear', position: 'left', beginAtZero: true, title: { display: true, text: 'MB / Count', color: colors.textColor } },
          yRight: { type: 'linear', position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'MB / s', color: colors.textColor } },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    tmCharts['tm-chart-jvmextra'].data.labels = tmHistory.timestamps;
    tmCharts['tm-chart-jvmextra'].data.datasets[0].data = tmHistory.bufferUsed;
    tmCharts['tm-chart-jvmextra'].data.datasets[1].data = tmHistory.classesLoaded;
    tmCharts['tm-chart-jvmextra'].data.datasets[2].data = tmHistory.allocRate;
    tmCharts['tm-chart-jvmextra'].update();
  }

  // Dynamic grid update
  for (let c in tmCharts) {
    if (tmCharts[c]) {
      const scales = tmCharts[c].options.scales;
      for (let s in scales) {
        if (scales[s].grid) scales[s].grid.color = colors.gridColor;
        if (scales[s].ticks) scales[s].ticks.color = colors.textColor;
      }
      if (tmCharts[c].options.plugins.legend && tmCharts[c].options.plugins.legend.labels) {
        tmCharts[c].options.plugins.legend.labels.color = colors.textColor;
      }
      tmCharts[c].options.plugins.tooltip.backgroundColor = colors.tooltipBg;
      tmCharts[c].options.plugins.tooltip.titleColor = colors.tooltipColor;
      tmCharts[c].options.plugins.tooltip.borderColor = colors.tooltipBorder;
      tmCharts[c].update('none');
    }
  }
}

// ============================================================
// AJAX HTTP POLLER
// ============================================================

function tmFetchMetrics() {
  let url = document.getElementById('tm-endpoint-url').value.trim();
  const authKey = document.getElementById('tm-auth-header').value.trim();
  const headers = {};
  
  if (tmConnectionProfile.startsWith('agent')) {
    const agentUrl = document.getElementById('tm-agent-url').value.trim();
    if (!agentUrl) return;
    const adminPort = document.getElementById('tm-agent-prom-port')?.value.trim() || '8090';
    url = `${agentUrl}/prometheus?port=${adminPort}`;
  } else {
    if (!url) return alert('Please enter a Prometheus Endpoint URL');
    if (authKey) headers['X-API-Key'] = authKey;
  }

  const btn = document.getElementById('tm-btn-fetch');
  if (btn && tmConnectionProfile === 'direct') {
    btn.disabled = true;
    btn.innerHTML = '<span style="display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 1s linear infinite;margin-right:5px"></span> Fetching...';
  }

  fetch(url, { headers })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP Error Status: ${res.status}`);
      return res.text();
    })
    .then(data => {
      // Check if it's the error JSON wrapper from the bridge
      if (data.startsWith('{"error":true')) return;
      tmProcessMetrics(data);

      if (tmConnectionProfile === 'direct') {
        tmDirectConnected = true;
        tmUpdateTabsVisibility();
      }
    })
    .catch(err => {
      if (tmConnectionProfile === 'direct') {
        console.error(err);
        tmStopPolling();
        tmDirectConnected = false;
        tmUpdateTabsVisibility();
        alert(`Connection failed!\n\nCould not retrieve telemetry from "${url}".\nReason: ${err.message}`);
      }
      // Silently ignore if proxy fails in agent mode (e.g., Mendix Prometheus not enabled)
    })
    .finally(() => {
      if (btn && tmConnectionProfile === 'direct') {
        btn.disabled = false;
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg> Fetch Metrics';
      }
    });
}

function tmChangePollInterval() {
  tmStopPolling();
  
  const select = document.getElementById('tm-poll-interval');
  if (!select) return;

  const interval = parseInt(select.value);
  if (interval > 0 && (tmConnectionProfile === 'direct' || tmConnectionProfile.startsWith('agent'))) {
    tmFetchMetrics();
    tmPollTimer = setInterval(tmFetchMetrics, interval);
  }
}

function tmStopPolling() {
  if (tmPollTimer) {
    clearInterval(tmPollTimer);
    tmPollTimer = null;
  }
}

// ============================================================
// DIAGNOSTIC: Dump all available Prometheus metric names
// ============================================================
const TM_USED_METRICS = new Set([
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

function tmDumpAllMetrics() {
  let url;
  if (tmConnectionProfile.startsWith('agent')) {
    const agentUrl = document.getElementById('tm-agent-url').value.trim();
    if (!agentUrl) return alert('Connect to agent first!');
    const adminPort = document.getElementById('tm-agent-prom-port')?.value.trim() || '8090';
    url = `${agentUrl}/prometheus?port=${adminPort}`;
  } else {
    url = document.getElementById('tm-endpoint-url').value.trim();
    if (!url) return alert('Set a Prometheus endpoint first!');
  }

  fetch(url)
    .then(r => r.text())
    .then(text => {
      const parsed = tmParsePrometheusText(text);
      const allNames = Object.keys(parsed).sort();

      const used = allNames.filter(n => TM_USED_METRICS.has(n));
      const unused = allNames.filter(n => !TM_USED_METRICS.has(n));

      let html = `<div style="max-height:70vh;overflow-y:auto;font-family:var(--font-mono);font-size:0.78rem">`;
      html += `<p style="color:var(--text-secondary);margin-bottom:12px"><strong>Total unique metrics received: ${allNames.length}</strong> &mdash; Visualized: ${used.length}, Not used: ${unused.length}</p>`;

      html += `<h4 style="color:var(--success);margin:8px 0 4px">✅ Currently Visualized (${used.length})</h4>`;
      html += `<table style="width:100%;border-collapse:collapse;margin-bottom:16px">`;
      html += `<tr style="text-align:left;border-bottom:1px solid var(--border)"><th style="padding:4px 8px">Metric Name</th><th style="padding:4px 8px">Labels</th><th style="padding:4px 8px">Sample Value</th></tr>`;
      for (let name of used) {
        const entries = parsed[name];
        const sample = entries[0];
        const lbls = Object.entries(sample.labels).map(([k,v]) => `${k}="${v}"`).join(', ') || '—';
        html += `<tr style="border-bottom:1px solid var(--border-subtle)"><td style="padding:3px 8px;color:var(--success)">${name}</td><td style="padding:3px 8px;color:var(--text-muted)">${lbls}</td><td style="padding:3px 8px">${sample.value}</td></tr>`;
      }
      html += `</table>`;

      html += `<h4 style="color:var(--warning);margin:8px 0 4px">⚠️ Available but NOT Visualized (${unused.length})</h4>`;
      html += `<table style="width:100%;border-collapse:collapse">`;
      html += `<tr style="text-align:left;border-bottom:1px solid var(--border)"><th style="padding:4px 8px">Metric Name</th><th style="padding:4px 8px">Labels</th><th style="padding:4px 8px">Sample Value</th><th style="padding:4px 8px"># Series</th></tr>`;
      for (let name of unused) {
        const entries = parsed[name];
        const sample = entries[0];
        const lbls = Object.entries(sample.labels).map(([k,v]) => `${k}="${v}"`).join(', ') || '—';
        html += `<tr style="border-bottom:1px solid var(--border-subtle)"><td style="padding:3px 8px;color:var(--warning)">${name}</td><td style="padding:3px 8px;color:var(--text-muted);max-width:300px;overflow:hidden;text-overflow:ellipsis">${lbls}</td><td style="padding:3px 8px">${sample.value}</td><td style="padding:3px 8px">${entries.length}</td></tr>`;
      }
      html += `</table>`;
      html += `</div>`;

      // Show in a modal
      let overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);backdrop-filter:blur(3px);z-index:9999;display:flex;align-items:center;justify-content:center';
      overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

      let modal = document.createElement('div');
      modal.style.cssText = 'background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:24px;max-width:900px;width:90%;max-height:85vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:var(--shadow-lg)';
      modal.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h3 style="margin:0;color:var(--text-primary)">📊 Prometheus Metrics Inventory</h3><button onclick="this.closest('[style*=fixed]').remove()" style="background:none;border:none;color:var(--text-muted);font-size:1.5rem;cursor:pointer">&times;</button></div>${html}`;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
    })
    .catch(err => alert(`Failed to fetch metrics: ${err.message}`));
}

// ============================================================
// MOCK TELEMETRY GENERATOR (Sandbox Mode)
// ============================================================

let tmSimState = {
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
};

function tmToggleMock() {
  const btn = document.getElementById('tm-btn-mock');
  const txt = document.getElementById('tm-mock-text');
  
  if (tmIsMocking) {
    tmIsMocking = false;
    clearInterval(tmMockInterval);
    tmMockInterval = null;
    btn.classList.remove('btn-success');
    btn.classList.add('btn-secondary');
    txt.textContent = 'Start Sandbox';
    
    if (tmConnectionProfile.startsWith('agent') && tmAgentStatus === 'connected') {
      tmConnectAgent();
    } else {
      tmChangePollInterval();
    }
  } else {
    tmIsMocking = true;
    tmStopPolling();
    tmStopAgentPolling();

    btn.classList.remove('btn-secondary');
    btn.classList.add('btn-success');
    txt.textContent = 'Stop Sandbox';
    
    tmResetData();
    tmGenerateMockTick();
    tmMockInterval = setInterval(tmGenerateMockTick, 3000);
  }
  tmUpdateTabsVisibility();
}

function tmResetData() {
  tmHistory = {
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

function tmGenerateMockTick() {
  tmSimState.ticksSinceGc++;
  
  const isSpike = Math.random() < 0.22;
  const loadMultiplier = isSpike ? (3 + Math.random() * 3) : (0.8 + Math.random() * 0.5);

  const targetThreads = Math.round(15 + (isSpike ? 20 + Math.random() * 15 : Math.random() * 5));
  tmSimState.threads = Math.round(tmSimState.threads * 0.6 + targetThreads * 0.4);

  const targetCpu = isSpike ? 65 + Math.random() * 25 : 3 + Math.random() * 10;
  
  const deltaSelects = Math.round((5 + Math.random() * 12) * loadMultiplier);
  const deltaInserts = Math.round((0.2 + Math.random() * 2) * loadMultiplier);
  const deltaUpdates = Math.round((0.5 + Math.random() * 3) * loadMultiplier);
  const deltaDeletes = Math.round((Math.random() > 0.8 ? Math.random() * 1.5 : 0) * loadMultiplier);

  tmSimState.selects += deltaSelects;
  tmSimState.inserts += deltaInserts;
  tmSimState.updates += deltaUpdates;
  tmSimState.deletes += deltaDeletes;

  const deltaReqs = Math.round((2 + Math.random() * 5) * loadMultiplier);
  tmSimState.requests += deltaReqs;
  
  const currentAvgLatency = isSpike ? 120 + Math.random() * 200 : 8 + Math.random() * 12;
  tmSimState.reqTime += (deltaReqs * currentAvgLatency) / 1000.0;

  const heapAllocation = (20 + Math.random() * 35) * loadMultiplier;
  tmSimState.heap += heapAllocation;
  tmSimState.nonHeap += (Math.random() < 0.1) ? Math.random() * 2 : 0;

  let triggerGc = false;
  if (tmSimState.heap > tmSimState.maxHeap * 0.72) triggerGc = true;
  if (tmSimState.ticksSinceGc > 15 && Math.random() < 0.15) triggerGc = true;

  if (triggerGc) {
    tmSimState.gcCounts += 1;
    const gcDurationMs = 80 + Math.random() * 180;
    tmSimState.gcTimes += gcDurationMs / 1000.0;
    tmSimState.heap = Math.round(100 + tmSimState.threads * 1.5 + Math.random() * 40);
    tmSimState.ticksSinceGc = 0;
  }

  const promText = `
# HELP jvm_memory_used_bytes Used memory
# TYPE jvm_memory_used_bytes gauge
jvm_memory_used_bytes{area="heap"} ${tmSimState.heap * 1024 * 1024}
jvm_memory_used_bytes{area="nonheap"} ${tmSimState.nonHeap * 1024 * 1024}
# HELP jvm_memory_max_bytes Max memory
# TYPE jvm_memory_max_bytes gauge
jvm_memory_max_bytes{area="heap"} ${tmSimState.maxHeap * 1024 * 1024}
# HELP system_cpu_usage CPU
# TYPE system_cpu_usage gauge
system_cpu_usage ${targetCpu / 100.0}
# HELP jetty_threads_active Active threads
# TYPE jetty_threads_active gauge
jetty_threads_active ${tmSimState.threads}
# HELP jetty_threads_limit Thread limit
jetty_threads_limit 200
# HELP mx_runtime_stats_connectionbus_selects Selects
mx_runtime_stats_connectionbus_selects ${tmSimState.selects}
# HELP mx_runtime_stats_connectionbus_inserts Inserts
mx_runtime_stats_connectionbus_inserts ${tmSimState.inserts}
# HELP mx_runtime_stats_connectionbus_updates Updates
mx_runtime_stats_connectionbus_updates ${tmSimState.updates}
# HELP mx_runtime_stats_connectionbus_deletes Deletes
mx_runtime_stats_connectionbus_deletes ${tmSimState.deletes}
# HELP jetty_requests_total Requests
jetty_requests_total ${tmSimState.requests}
# HELP jetty_requests_seconds_sum Latency sum
jetty_requests_seconds_sum ${tmSimState.reqTime}
# HELP jvm_gc_collection_seconds_count GC count
jvm_gc_collection_seconds_count ${tmSimState.gcCounts}
# HELP jvm_gc_collection_seconds_sum GC time
jvm_gc_collection_seconds_sum ${tmSimState.gcTimes}
`;

  tmProcessMetrics(promText);
  
  // Update mock PostgreSQL details as well!
  tmGenerateMockPgStats();
}

function tmGenerateMockPgStats() {
  // Generate beautiful simulated PostgreSQL stats
  const hitRate = 98.4 + Math.random() * 1.5;
  const dbSizeMB = Math.round(152 + Math.random() * 10);
  const totalConns = 12 + Math.round(tmSimState.threads * 0.4 + Math.random() * 3);
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
  if (tmSimState.threads > 25) {
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

// ============================================================
// MANUAL PASTE ACTIONS
// ============================================================

function tmParsePastedMetrics() {
  const text = document.getElementById('tm-paste-input').value.trim();
  if (!text) return alert('Please paste some Prometheus metrics text first.');
  
  tmProcessMetrics(text);
  
  const btn = document.querySelector('button[onclick="tmParsePastedMetrics()"]');
  const oldText = btn.textContent;
  btn.textContent = 'Metrics Parsed! ✓';
  btn.style.background = 'var(--success)';
  btn.style.color = 'white';
  setTimeout(() => {
    btn.textContent = oldText;
    btn.style.background = '';
    btn.style.color = '';
  }, 1000);
}

// ============================================================
// OPENTELEMETRY TRACE PARSER & WATERFALL CHART
// ============================================================

function tmLoadMockTraceJSON() {
  const mockTrace = [
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "00f067aa0ba902b7",
      "name": "HTTP POST /rest/Orders/Submit",
      "kind": "SPAN_KIND_SERVER",
      "startTimeUnixNano": 1688582400000000000,
      "endTimeUnixNano": 1688582400780000000,
      "attributes": {
        "http.method": "POST",
        "http.target": "/rest/Orders/Submit",
        "http.status_code": 200,
        "mendix.environment": "production"
      }
    },
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "01f067aa0ba902b8",
      "parentSpanId": "00f067aa0ba902b7",
      "name": "Microflow.SubmitOrder",
      "kind": "SPAN_KIND_INTERNAL",
      "startTimeUnixNano": 1688582400020000000,
      "endTimeUnixNano": 1688582400760000000,
      "attributes": {
        "mendix.microflow.name": "Sales.SubmitOrder",
        "mendix.user.name": "mikolaj.d"
      }
    },
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "02f067aa0ba902b9",
      "parentSpanId": "01f067aa0ba902b8",
      "name": "Database.RetrieveOrderTemplate",
      "kind": "SPAN_KIND_CLIENT",
      "startTimeUnixNano": 1688582400050000000,
      "endTimeUnixNano": 1688582400120000000,
      "attributes": {
        "db.system": "postgresql",
        "db.statement": "SELECT * FROM sales$order_template WHERE id = ?",
        "mendix.activity.type": "Retrieve"
      }
    },
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "03f067aa0ba902ba",
      "parentSpanId": "01f067aa0ba902b8",
      "name": "JavaAction.CalculateDiscounts",
      "kind": "SPAN_KIND_INTERNAL",
      "startTimeUnixNano": 1688582400150000000,
      "endTimeUnixNano": 1688582400320000000,
      "attributes": {
        "mendix.java_action.name": "Sales.CalculateDiscounts",
        "sales.discount.type": "VolumeBased",
        "sales.items.count": 24
      }
    },
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "04f067aa0ba902bb",
      "parentSpanId": "03f067aa0ba902ba",
      "name": "Database.QueryActiveDiscountRules",
      "kind": "SPAN_KIND_CLIENT",
      "startTimeUnixNano": 1688582400160000000,
      "endTimeUnixNano": 1688582400280000000,
      "attributes": {
        "db.system": "postgresql",
        "db.statement": "SELECT * FROM sales$discount_rule WHERE active = true",
        "mendix.activity.type": "Retrieve"
      }
    },
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "05f067aa0ba902bc",
      "parentSpanId": "01f067aa0ba902b8",
      "name": "RestServiceCall.ValidatePaymentStatus",
      "kind": "SPAN_KIND_CLIENT",
      "startTimeUnixNano": 1688582400350000000,
      "endTimeUnixNano": 1688582400680000000,
      "attributes": {
        "http.url": "https://api.paymentgateway.com/v1/payments/chk_9281a",
        "http.method": "GET",
        "http.status_code": 200,
        "mendix.activity.type": "CallRestService"
      }
    },
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "06f067aa0ba902bd",
      "parentSpanId": "01f067aa0ba902b8",
      "name": "Database.CommitOrder",
      "kind": "SPAN_KIND_CLIENT",
      "startTimeUnixNano": 1688582400700000000,
      "endTimeUnixNano": 1688582400750000000,
      "attributes": {
        "db.system": "postgresql",
        "db.statement": "INSERT INTO sales$order (id, total, status) VALUES (?, ?, ?)",
        "mendix.activity.type": "Commit"
      }
    }
  ];

  document.getElementById('tm-trace-input').value = JSON.stringify(mockTrace, null, 2);
}

function tmClearTraces() {
  document.getElementById('tm-trace-input').value = '';
  document.getElementById('tm-trace-results-card').style.display = 'none';
  tmParsedSpans = [];
  tmParsedLogs = [];
  tmSelectedTraceId = null;
  tmRenderOtelTracesTable();
  tmRenderOtelLogsTable();
}

function tmParseTraces() {
  const jsonStr = document.getElementById('tm-trace-input').value.trim();
  if (!jsonStr) return alert('Please enter or load a Trace JSON first.');

  try {
    const rawData = JSON.parse(jsonStr);
    
    let spans = [];
    if (Array.isArray(rawData)) {
      spans = rawData;
    } else if (rawData.resourceSpans) {
      for (let resSpan of rawData.resourceSpans) {
        if (!resSpan.scopeSpans) continue;
        for (let scopeSpan of resSpan.scopeSpans) {
          if (!scopeSpan.spans) continue;
          for (let span of scopeSpan.spans) {
            spans.push(span);
          }
        }
      }
    } else if (rawData.spans) {
      spans = rawData.spans;
    } else {
      throw new Error('Trace structure not recognized. Input must be an array of spans or a standard OTLP payload.');
    }

    if (spans.length === 0) {
      throw new Error('No spans found in payload.');
    }

    tmParsedSpans = spans;
    if (spans[0] && spans[0].traceId) {
      tmSelectedTraceId = spans[0].traceId;
      tmSetOtelSubtab('traces');
      tmSelectTrace(tmSelectedTraceId);
    } else {
      tmRenderTraceWaterfall();
    }

  } catch(e) {
    alert(`Failed to parse Trace JSON: ${e.message}`);
  }
}

function tmRenderTraceWaterfall() {
  let spans = tmParsedSpans;
  if (tmSelectedTraceId) {
    spans = tmParsedSpans.filter(s => s.traceId === tmSelectedTraceId);
  }
  
  if (spans.length === 0) {
    const container = document.getElementById('tm-trace-waterfall-container');
    if (container) container.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;padding:20px;text-align:center">No spans found for this trace.</div>';
    return;
  }
  
  let minStart = Infinity;
  let maxEnd = -Infinity;
  
  const resolveTime = (tVal) => {
    if (typeof tVal === 'number') {
      if (tVal > 1e15) return tVal / 1e6;
      if (tVal > 1e12) return tVal / 1e3;
      return tVal;
    }
    if (typeof tVal === 'string') {
      if (/^\d+$/.test(tVal)) {
        const num = parseFloat(tVal);
        if (num > 1e15) return num / 1e6;
        if (num > 1e12) return num / 1e3;
        return num;
      }
      return new Date(tVal).getTime();
    }
    return 0;
  };

  spans.forEach(s => {
    s._startTimeMs = resolveTime(s.startTimeUnixNano || s.startTime || s.startTimeMs);
    s._endTimeMs = resolveTime(s.endTimeUnixNano || s.endTime || s.endTimeMs);
    s._durationMs = s._endTimeMs - s._startTimeMs;

    if (s._startTimeMs < minStart) minStart = s._startTimeMs;
    if (s._endTimeMs > maxEnd) maxEnd = s._endTimeMs;
  });

  const totalDuration = maxEnd - minStart;
  
  const spanMap = {};
  spans.forEach(s => { spanMap[s.spanId] = { span: s, children: [] }; });
  
  const roots = [];
  spans.forEach(s => {
    const parentId = s.parentSpanId || s.parentId;
    if (parentId && spanMap[parentId]) {
      spanMap[parentId].children.push(spanMap[s.spanId]);
    } else {
      roots.push(spanMap[s.spanId]);
    }
  });

  const sortTree = (node) => {
    node.children.sort((a, b) => a.span._startTimeMs - b.span._startTimeMs);
    node.children.forEach(sortTree);
  };
  roots.sort((a, b) => a.span._startTimeMs - b.span._startTimeMs);
  roots.forEach(sortTree);

  const rows = [];
  const traverse = (node, depth) => {
    rows.push({ node: node.span, depth: depth });
    node.children.forEach(child => traverse(child, depth + 1));
  };
  roots.forEach(r => traverse(r, 0));

  const waterfallContainer = document.getElementById('tm-trace-waterfall-container');
  waterfallContainer.innerHTML = '';

  rows.forEach((row, idx) => {
    const s = row.node;
    const depth = row.depth;
    
    const leftPct = totalDuration > 0 ? ((s._startTimeMs - minStart) / totalDuration) * 100 : 0;
    const widthPct = totalDuration > 0 ? (s._durationMs / totalDuration) * 100 : 100;
    
    let color = '#3498db';
    if (s.name.startsWith('Database.')) color = '#ff9f43';
    else if (s.name.startsWith('Microflow.')) color = '#2ecc71';
    else if (s.name.startsWith('JavaAction.')) color = '#9b59b6';
    else if (s.name.startsWith('RestServiceCall.') || s.name.startsWith('Http.')) color = '#f1c40f';

    const rowEl = document.createElement('div');
    rowEl.style.display = 'flex';
    rowEl.style.flexDirection = 'column';
    rowEl.style.padding = '8px 4px';
    rowEl.style.borderBottom = '1px solid var(--border)';
    rowEl.style.cursor = 'pointer';
    rowEl.className = 'tm-waterfall-row';
    rowEl.onclick = () => tmSelectSpan(s);
    
    rowEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.75rem;margin-bottom:4px;gap:8px">
        <div style="padding-left:${depth * 14}px;display:flex;align-items:center;gap:6px;font-weight:600;max-width:250px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color}"></span>
          ${escHtml(s.name)}
        </div>
        <div style="color:var(--text-secondary);font-size:0.7rem">${s._durationMs.toFixed(1)} ms</div>
      </div>
      <div style="height:8px;background:rgba(255,255,255,0.03);border-radius:4px;position:relative;width:100%">
        <div style="position:absolute;left:${leftPct}%;width:${Math.max(1, widthPct)}%;height:100%;background:${color};border-radius:4px"></div>
      </div>
    `;
    waterfallContainer.appendChild(rowEl);
  });

  document.getElementById('tm-trace-meta').textContent = `Total Spans: ${spans.length} · Duration: ${totalDuration.toFixed(1)}ms`;
  document.getElementById('tm-trace-results-card').style.display = 'block';

  if (rows.length > 0) {
    tmSelectSpan(rows[0].node);
  }
}

function tmSelectSpan(span) {
  document.querySelectorAll('.tm-waterfall-row').forEach(row => {
    row.style.background = '';
  });
  
  const container = document.getElementById('tm-span-details-container');
  
  const attrs = span.attributes || {};
  let attrRows = '';
  for (let key in attrs) {
    let val = attrs[key];
    if (typeof val === 'object') val = JSON.stringify(val);
    attrRows += `
      <tr>
        <td style="padding:6px;font-family:var(--font-mono);font-size:0.72rem;color:var(--text-secondary);border-bottom:1px solid var(--border);width:40%;word-break:break-all">${escHtml(key)}</td>
        <td style="padding:6px;font-family:var(--font-mono);font-size:0.72rem;color:var(--text);border-bottom:1px solid var(--border);word-break:break-all">${escHtml(val)}</td>
      </tr>
    `;
  }

  if (!attrRows) {
    attrRows = `<tr><td colspan="2" style="padding:10px;text-align:center;color:var(--text-muted)">No attributes associated with this span.</td></tr>`;
  }

  const dbStatement = attrs['db.statement'] || attrs['sql'] || null;
  let sqlSection = '';
  if (dbStatement) {
    sqlSection = `
      <div style="margin-top:var(--sp-3);background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--r-md);padding:var(--sp-3)">
        <span style="font-size:0.75rem;font-weight:600;color:var(--warning);display:block;margin-bottom:var(--sp-1)">Associated SQL / DB Statement</span>
        <pre style="margin:0;font-family:var(--font-mono);font-size:0.72rem;white-space:pre-wrap;color:var(--text);word-break:break-all">${escHtml(dbStatement)}</pre>
      </div>
    `;
  }

  container.innerHTML = `
    <h4 style="margin-top:0;margin-bottom:var(--sp-1);color:var(--accent);font-size:0.9rem">${escHtml(span.name)}</h4>
    <div style="display:grid;grid-template-columns:1fr;gap:4px;font-size:0.75rem;color:var(--text-secondary);margin-bottom:var(--sp-3)">
      <div><strong>Span ID:</strong> <code>${escHtml(span.spanId)}</code></div>
      <div><strong>Parent ID:</strong> <code>${escHtml(span.parentSpanId || 'None (Root)')}</code></div>
      <div><strong>Duration:</strong> ${span._durationMs.toFixed(2)} ms</div>
    </div>
    
    <span style="font-size:0.75rem;font-weight:600;color:var(--info);display:block;margin-bottom:4px">Span Attributes</span>
    <table style="width:100%;border-collapse:collapse;text-align:left;font-size:0.75rem">
      <thead>
        <tr style="border-bottom:1px solid var(--border)">
          <th style="padding:6px;color:var(--text-muted)">Key</th>
          <th style="padding:6px;color:var(--text-muted)">Value</th>
        </tr>
      </thead>
      <tbody>
        ${attrRows}
      </tbody>
    </table>

    ${sqlSection}
  `;
}

// ============================================================
// OTEL EXPLORER DASHBOARD HELPERS (Aspire-like functionality)
// ============================================================

function tmSetOtelSubtab(subtab) {
  tmActiveOtelSubtab = subtab;
  
  const subtabs = ['traces', 'logs', 'import'];
  subtabs.forEach(t => {
    const btn = document.getElementById(`tm-otel-subtab-${t}`);
    const content = document.getElementById(`tm-otel-content-${t}`);
    if (btn) {
      if (t === subtab) {
        btn.style.background = 'var(--accent)';
        btn.style.color = '#fff';
      } else {
        btn.style.background = 'transparent';
        btn.style.color = 'var(--text-secondary)';
      }
    }
    if (content) {
      content.style.display = (t === subtab) ? 'flex' : 'none';
    }
  });
  
  if (subtab === 'traces') {
    tmRenderOtelTracesTable();
  } else if (subtab === 'logs') {
    tmRenderOtelLogsTable();
  }
}

function tmGetTraceList() {
  const traceMap = {};
  
  const resolveTime = (tVal) => {
    if (typeof tVal === 'number') {
      if (tVal > 1e15) return tVal / 1e6;
      if (tVal > 1e12) return tVal / 1e3;
      return tVal;
    }
    if (typeof tVal === 'string') {
      if (/^\d+$/.test(tVal)) {
        const num = parseFloat(tVal);
        if (num > 1e15) return num / 1e6;
        if (num > 1e12) return num / 1e3;
        return num;
      }
      return new Date(tVal).getTime();
    }
    return 0;
  };

  tmParsedSpans.forEach(s => {
    const tId = s.traceId;
    if (!tId) return;
    
    const start = resolveTime(s.startTimeUnixNano || s.startTime || s.startTimeMs);
    const end = resolveTime(s.endTimeUnixNano || s.endTime || s.endTimeMs);
    
    if (!traceMap[tId]) {
      traceMap[tId] = {
        traceId: tId,
        spans: [],
        minStart: start,
        maxEnd: end,
        rootSpan: s
      };
    }
    
    traceMap[tId].spans.push(s);
    if (start < traceMap[tId].minStart) {
      traceMap[tId].minStart = start;
    }
    if (end > traceMap[tId].maxEnd) {
      traceMap[tId].maxEnd = end;
    }
    
    const pId = s.parentSpanId || s.parentId;
    if (!pId) {
      traceMap[tId].rootSpan = s;
    } else if (traceMap[tId].rootSpan === s) {
      // already root
    } else {
      const rootHasParent = traceMap[tId].rootSpan.parentSpanId || traceMap[tId].rootSpan.parentId;
      if (rootHasParent && !pId) {
        traceMap[tId].rootSpan = s;
      }
    }
  });
  
  return Object.values(traceMap).map(t => {
    return {
      traceId: t.traceId,
      name: t.rootSpan ? t.rootSpan.name : 'Unknown Trace',
      startTime: t.minStart,
      duration: t.maxEnd - t.minStart,
      spansCount: t.spans.length,
      spans: t.spans
    };
  }).sort((a, b) => b.startTime - a.startTime);
}

function tmRenderOtelTracesTable() {
  const body = document.getElementById('tm-otel-traces-body');
  if (!body) return;
  
  const traceList = tmGetTraceList();
  if (traceList.length === 0) {
    body.innerHTML = `
      <tr>
        <td colspan="5" style="padding:20px;text-align:center;color:var(--text-muted)">No traces received yet. Generate some traffic in your Mendix app!</td>
      </tr>
    `;
    return;
  }
  
  let html = '';
  traceList.forEach(t => {
    const dateStr = new Date(t.startTime).toLocaleTimeString();
    const isSelected = (t.traceId === tmSelectedTraceId);
    const rowBg = isSelected ? 'rgba(52, 152, 219, 0.15)' : 'transparent';
    const borderStyle = isSelected ? 'border-left: 3px solid var(--accent)' : 'border-left: 3px solid transparent';
    
    html += `
      <tr style="background:${rowBg};cursor:pointer;border-bottom:1px solid var(--border-subtle);transition:background 0.2s" onclick="tmSelectTrace('${t.traceId}')" class="tm-trace-row">
        <td style="padding:8px 12px;${borderStyle}">${dateStr}</td>
        <td style="padding:8px 12px;font-weight:600;color:var(--text-primary)">${escHtml(t.name)}</td>
        <td style="padding:8px 12px;color:var(--text-muted)">${t.spansCount}</td>
        <td style="padding:8px 12px;color:var(--accent);font-weight:600">${t.duration.toFixed(1)} ms</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.7rem;color:var(--text-secondary)">${t.traceId}</td>
      </tr>
    `;
  });
  body.innerHTML = html;
}

function tmRenderOtelLogsTable() {
  const body = document.getElementById('tm-otel-logs-body');
  if (!body) return;
  
  if (tmParsedLogs.length === 0) {
    body.innerHTML = `
      <tr>
        <td colspan="4" style="padding:20px;text-align:center;color:var(--text-muted)">No structured logs received yet.</td>
      </tr>
    `;
    return;
  }
  
  let html = '';
  const sortedLogs = [...tmParsedLogs].reverse();
  
  sortedLogs.forEach(l => {
    const dateStr = new Date(l.timestamp).toLocaleTimeString();
    let levelColor = 'var(--text-secondary)';
    if (l.severity === 'ERROR' || l.severity === 'CRITICAL') levelColor = 'var(--danger)';
    else if (l.severity === 'WARN' || l.severity === 'WARNING') levelColor = 'var(--warning)';
    else if (l.severity === 'INFO') levelColor = 'var(--info)';
    else if (l.severity === 'DEBUG') levelColor = 'var(--success)';
    
    const traceBadge = l.traceId 
      ? `<span onclick="event.stopPropagation(); tmSelectTrace('${l.traceId}'); tmSetOtelSubtab('traces')" style="background:rgba(52,152,219,0.2);color:var(--info);padding:2px 6px;border-radius:4px;font-family:var(--font-mono);font-size:0.65rem;cursor:pointer;border:1px solid rgba(52,152,219,0.3)">${l.traceId.substring(0, 8)}...</span>` 
      : '—';
      
    html += `
      <tr style="border-bottom:1px solid var(--border-subtle);font-size:0.75rem">
        <td style="padding:8px 12px;color:var(--text-muted)">${dateStr}</td>
        <td style="padding:8px 12px;font-weight:600;color:${levelColor}">${l.severity}</td>
        <td style="padding:8px 12px;color:var(--text-primary);white-space:pre-wrap">${escHtml(l.message)}</td>
        <td style="padding:8px 12px">${traceBadge}</td>
      </tr>
    `;
  });
  body.innerHTML = html;
}

function tmSelectTrace(traceId) {
  tmSelectedTraceId = traceId;
  
  tmRenderOtelTracesTable();
  
  const resultsCard = document.getElementById('tm-trace-results-card');
  if (resultsCard) {
    resultsCard.style.display = 'block';
  }
  
  tmRenderTraceWaterfall();
  
  const traceList = tmGetTraceList();
  const t = traceList.find(x => x.traceId === traceId);
  if (t) {
    document.getElementById('tm-trace-title').textContent = t.name;
    document.getElementById('tm-trace-meta').textContent = `Total Spans: ${t.spansCount} · Duration: ${t.duration.toFixed(1)}ms · Trace ID: ${t.traceId}`;
  }
  
  resultsCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function tmCloseSelectedTrace() {
  tmSelectedTraceId = null;
  const resultsCard = document.getElementById('tm-trace-results-card');
  if (resultsCard) {
    resultsCard.style.display = 'none';
  }
  tmRenderOtelTracesTable();
}

// ============================================================
// CLEANUP & EVENT LISTENERS
// ============================================================

const tmThemeObserver = new MutationObserver(() => {
  if (tmActiveTab === 'dashboard') {
    tmUpdateChartsUI();
  }
});
tmThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// Initial load setup
window.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('tm-conn-profile')) {
    tmChangeConnectionProfile();
  }
});


// --- AUTO-GENERATED ESM EXPORTS ---
window.tmUpdateTabsVisibility = tmUpdateTabsVisibility;
window.tmSetTab = tmSetTab;
window.tmChangeConnectionProfile = tmChangeConnectionProfile;
window.tmToggleConnectionCard = tmToggleConnectionCard;
window.tmTogglePgConfigCard = tmTogglePgConfigCard;
window.tmParsePrometheusText = tmParsePrometheusText;
window.tmGetMetricValue = tmGetMetricValue;
window.tmGetMetricSum = tmGetMetricSum;
window.tmParseOtelMetrics = tmParseOtelMetrics;
window.tmProcessMetrics = tmProcessMetrics;
window.tmProcessParsedMetrics = tmProcessParsedMetrics;
window.tmConnectAgent = tmConnectAgent;
window.tmStartAgentPolling = tmStartAgentPolling;
window.tmStopAgentPolling = tmStopAgentPolling;
window.tmFetchAgentLogs = tmFetchAgentLogs;
window.tmFetchAgentOtel = tmFetchAgentOtel;
window.tmFetchAgentPostgres = tmFetchAgentPostgres;
window.tmShowQueryModal = tmShowQueryModal;
window.tmRefreshPostgres = tmRefreshPostgres;
window.tmRenderPostgresStats = tmRenderPostgresStats;
window.tmGetChartColors = tmGetChartColors;
window.tmInitChart = tmInitChart;
window.tmUpdateChartsUI = tmUpdateChartsUI;
window.tmFetchMetrics = tmFetchMetrics;
window.tmChangePollInterval = tmChangePollInterval;
window.tmStopPolling = tmStopPolling;
window.tmDumpAllMetrics = tmDumpAllMetrics;
window.tmToggleMock = tmToggleMock;
window.tmResetData = tmResetData;
window.tmGenerateMockTick = tmGenerateMockTick;
window.tmGenerateMockPgStats = tmGenerateMockPgStats;
window.tmParsePastedMetrics = tmParsePastedMetrics;
window.tmLoadMockTraceJSON = tmLoadMockTraceJSON;
window.tmClearTraces = tmClearTraces;
window.tmParseTraces = tmParseTraces;
window.tmRenderTraceWaterfall = tmRenderTraceWaterfall;
window.tmSelectSpan = tmSelectSpan;
window.tmSetOtelSubtab = tmSetOtelSubtab;
window.tmGetTraceList = tmGetTraceList;
window.tmRenderOtelTracesTable = tmRenderOtelTracesTable;
window.tmRenderOtelLogsTable = tmRenderOtelLogsTable;
window.tmSelectTrace = tmSelectTrace;
window.tmCloseSelectedTrace = tmCloseSelectedTrace;

export function init() {
  if (document.getElementById('tm-conn-profile')) {
    tmChangeConnectionProfile();
  }
}
