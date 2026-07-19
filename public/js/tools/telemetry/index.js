import { state } from './state.js';
import { tmUpdateChartsUI, tmGetChartColors, tmInitChart } from './charts.js';
import { tmChangeConnectionProfile, tmUpdateTabsVisibility, tmSetTab, tmToggleConnectionCard, tmTogglePgConfigCard } from './ui.js';
import { tmParsePrometheusText, tmGetMetricValue, tmGetMetricSum } from './parsers/prometheus.js';
import { tmParseOtelMetrics } from './parsers/otel.js';
import { tmProcessMetrics, tmProcessParsedMetrics } from './processor.js';
import { tmConnectAgent, tmStartAgentPolling, tmStopAgentPolling, tmFetchAgentLogs, tmFetchAgentOtel, tmFetchAgentPostgres, tmShowQueryModal, tmRefreshPostgres, tmRenderPostgresStats } from './agent.js';
import { tmFetchMetrics, tmChangePollInterval, tmStopPolling, tmParsePastedMetrics, tmDumpAllMetrics } from './poller.js';
import { tmToggleMock, tmResetData, tmGenerateMockTick, tmGenerateMockPgStats } from './mock.js';
import { tmLoadMockTraceJSON, tmClearTraces, tmParseTraces, tmRenderTraceWaterfall, tmSelectSpan, tmSetOtelSubtab, tmGetTraceList, tmRenderOtelTracesTable, tmRenderOtelLogsTable, tmSelectTrace, tmCloseSelectedTrace } from './traces.js';

const tmThemeObserver = new MutationObserver(() => {
  if (state.tmActiveTab === 'dashboard') {
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

// Collapsible chart groups: restore per-group open/closed state and persist changes.
// Charts inside a re-opened <details> need a resize kick to pick up their size.
export function tmInitChartGroups() {
  if (state.tmChartGroupsWired) return;
  const groups = document.querySelectorAll('#tm-tab-dashboard .tm-chart-group');
  if (!groups.length) return;
  state.tmChartGroupsWired = true;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('tm-chart-groups') || '{}'); } catch (e) {}
  groups.forEach(g => {
    const id = g.getAttribute('data-group-id');
    if (saved[id] === false) g.removeAttribute('open');
    g.addEventListener('toggle', () => {
      saved[id] = g.open;
      try { localStorage.setItem('tm-chart-groups', JSON.stringify(saved)); } catch (e) {}
      if (g.open) window.dispatchEvent(new Event('resize'));
    });
  });
}

export function init() {
  if (document.getElementById('tm-conn-profile')) {
    tmChangeConnectionProfile();
  }
  tmInitChartGroups();
}

