// Telemetry Monitor entry point
import { state } from './telemetry/state.js';
export * from './telemetry/agent.js';
import * as mod_agent from './telemetry/agent.js';
export * from './telemetry/charts.js';
import * as mod_charts from './telemetry/charts.js';
export * from './telemetry/index.js';
import * as mod_index from './telemetry/index.js';
export * from './telemetry/mock.js';
import * as mod_mock from './telemetry/mock.js';
export * from './telemetry/poller.js';
import * as mod_poller from './telemetry/poller.js';
export * from './telemetry/processor.js';
import * as mod_processor from './telemetry/processor.js';
export * from './telemetry/traces.js';
import * as mod_traces from './telemetry/traces.js';
export * from './telemetry/ui.js';
import * as mod_ui from './telemetry/ui.js';
export * from './telemetry/parsers/otel.js';
import * as mod_otel from './telemetry/parsers/otel.js';
export * from './telemetry/parsers/prometheus.js';
import * as mod_prometheus from './telemetry/parsers/prometheus.js';
export * from './telemetry/alerts.js';
import * as mod_alerts from './telemetry/alerts.js';

// --- AUTO-GENERATED ESM EXPORTS FOR HTML INLINE HANDLERS ---
window.tmConnectAgent = mod_agent.tmConnectAgent;
window.tmStartAgentPolling = mod_agent.tmStartAgentPolling;
window.tmStopAgentPolling = mod_agent.tmStopAgentPolling;
window.tmFetchAgentLogs = mod_agent.tmFetchAgentLogs;
window.tmFetchAgentOtel = mod_agent.tmFetchAgentOtel;
window.tmFetchAgentPostgres = mod_agent.tmFetchAgentPostgres;
window.tmRefreshPostgres = mod_agent.tmRefreshPostgres;
window.tmShowQueryModal = mod_agent.tmShowQueryModal;
window.tmRenderPostgresStats = mod_agent.tmRenderPostgresStats;
window.tmGetChartColors = mod_charts.tmGetChartColors;
window.tmInitChart = mod_charts.tmInitChart;
window.tmUpdateChartsUI = mod_charts.tmUpdateChartsUI;
window.tmInitChartGroups = mod_index.tmInitChartGroups;
window.tmToggleMock = mod_mock.tmToggleMock;
window.tmResetData = mod_mock.tmResetData;
window.tmGenerateMockTick = mod_mock.tmGenerateMockTick;
window.tmGenerateMockPgStats = mod_mock.tmGenerateMockPgStats;
window.tmFetchMetrics = mod_poller.tmFetchMetrics;
window.tmChangePollInterval = mod_poller.tmChangePollInterval;
window.tmStopPolling = mod_poller.tmStopPolling;
window.tmDumpAllMetrics = mod_poller.tmDumpAllMetrics;
window.tmParsePastedMetrics = mod_poller.tmParsePastedMetrics;
window.tmProcessMetrics = mod_processor.tmProcessMetrics;
window.tmProcessParsedMetrics = mod_processor.tmProcessParsedMetrics;
window.tmLoadMockTraceJSON = mod_traces.tmLoadMockTraceJSON;
window.tmClearTraces = mod_traces.tmClearTraces;
window.tmParseTraces = mod_traces.tmParseTraces;
window.tmRenderTraceWaterfall = mod_traces.tmRenderTraceWaterfall;
window.tmSelectSpan = mod_traces.tmSelectSpan;
window.tmSetOtelSubtab = mod_traces.tmSetOtelSubtab;
window.tmGetTraceList = mod_traces.tmGetTraceList;
window.tmRenderOtelTracesTable = mod_traces.tmRenderOtelTracesTable;
window.tmRenderOtelLogsTable = mod_traces.tmRenderOtelLogsTable;
window.tmSelectTrace = mod_traces.tmSelectTrace;
window.tmCloseSelectedTrace = mod_traces.tmCloseSelectedTrace;
window.tmUpdateTabsVisibility = mod_ui.tmUpdateTabsVisibility;
window.tmSetTab = mod_ui.tmSetTab;
window.tmChangeConnectionProfile = mod_ui.tmChangeConnectionProfile;
window.tmToggleConnectionCard = mod_ui.tmToggleConnectionCard;
window.tmTogglePgConfigCard = mod_ui.tmTogglePgConfigCard;
window.tmParseOtelMetrics = mod_otel.tmParseOtelMetrics;
window.tmParsePrometheusText = mod_prometheus.tmParsePrometheusText;
window.tmGetMetricValue = mod_prometheus.tmGetMetricValue;
window.tmGetMetricSum = mod_prometheus.tmGetMetricSum;

export function init() {
  if (document.getElementById('tm-conn-profile')) {
    window.tmChangeConnectionProfile();
  }
  // Initialize chart groups if exists
  if (typeof window.tmInitChartGroups === 'function') {
    window.tmInitChartGroups();
  }
}
