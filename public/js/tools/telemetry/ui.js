import { state } from './state.js';
import { tmUpdateChartsUI } from './charts.js';
import { tmRenderOtelTracesTable, tmRenderOtelLogsTable, tmRenderTraceWaterfall } from './traces.js';
import { tmStopPolling } from './poller.js';
import { tmStopAgentPolling } from './agent.js';
import { tmToggleMock } from './mock.js';

export function tmUpdateTabsVisibility() {
  const dashboardTab = document.getElementById('tm-tab-dashboard-btn');
  const postgresTab = document.getElementById('tm-tab-postgres-btn');
  const tracesTab = document.getElementById('tm-tab-traces-btn');
  const guideTab = document.getElementById('tm-tab-guide-btn');

  const isAgentConnected = (state.tmConnectionProfile.startsWith('agent') && state.tmAgentStatus === 'connected');
  const isDirectActive = (state.tmConnectionProfile === 'direct' && state.tmDirectConnected);
  const isMocking = state.tmIsMocking;

  const isConnected = isAgentConnected || isDirectActive || isMocking;

  if (!isConnected) {
    // Show only Guide
    if (dashboardTab) dashboardTab.style.display = 'none';
    if (postgresTab) postgresTab.style.display = 'none';
    if (tracesTab) tracesTab.style.display = 'none';
    if (guideTab) guideTab.style.display = 'block';
    
    // Switch to guide if the active tab is hidden
    if (state.tmActiveTab !== 'guide') {
      tmSetTab('guide');
    }
  } else {
    // Connected! Determine which tabs to show based on profile
    if (state.tmConnectionProfile === 'agent_prometheus') {
      if (dashboardTab) dashboardTab.style.display = 'block';
      if (postgresTab) postgresTab.style.display = 'block';
      if (tracesTab) tracesTab.style.display = 'none';
    } else if (state.tmConnectionProfile === 'agent_otel') {
      if (dashboardTab) dashboardTab.style.display = 'block';
      if (postgresTab) postgresTab.style.display = 'block';
      if (tracesTab) tracesTab.style.display = 'block';
    } else if (state.tmConnectionProfile === 'direct') {
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
    if (state.tmActiveTab === 'guide') {
      if (state.tmConnectionProfile === 'agent_otel') {
        tmSetTab('traces'); // OTel goes to Traces first
      } else {
        tmSetTab('dashboard');
      }
    }
  }
}

export function tmSetTab(tabId) {
  state.tmActiveTab = tabId;
  
  // Update tab buttons
  document.querySelectorAll('#panel-telemetry-monitor .tab').forEach(el => { el.classList.remove('active'); el.setAttribute('aria-selected', 'false'); });
  const btn = document.getElementById(`tm-tab-${tabId}-btn`);
  if (btn) { btn.classList.add('active'); btn.setAttribute('aria-selected', 'true'); }

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
      if (state.tmSelectedTraceId) {
        tmRenderTraceWaterfall();
      }
    }, 50);
  }
}

export function tmChangeConnectionProfile() {
  const profile = document.getElementById('tm-conn-profile').value;
  state.tmConnectionProfile = profile;
  
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
  state.tmDirectConnected = false;
  state.tmAgentStatus = 'disconnected';
  if (state.tmIsMocking) tmToggleMock();

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

export function tmToggleConnectionCard(forceCollapse) {
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

export function tmTogglePgConfigCard(forceCollapse) {
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

