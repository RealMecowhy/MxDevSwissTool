import { state, TM_THRESHOLD_DEFAULTS } from './state.js';

let alertToastContainer = null;
const activeAlerts = new Map(); // key -> element

function getOrCreateToastContainer() {
  if (alertToastContainer) return alertToastContainer;
  alertToastContainer = document.getElementById('tm-alert-container');
  if (!alertToastContainer) {
    alertToastContainer = document.createElement('div');
    alertToastContainer.id = 'tm-alert-container';
    alertToastContainer.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:10px;pointer-events:none';
    document.body.appendChild(alertToastContainer);
  }
  return alertToastContainer;
}

function showThresholdAlert(id, title, message, type = 'warning') {
  const container = getOrCreateToastContainer();
  
  if (activeAlerts.has(id)) {
    // Just update the text if it's already showing
    const el = activeAlerts.get(id);
    el.querySelector('.tm-alert-msg').textContent = message;
    return;
  }
  
  const bg = type === 'danger' ? 'var(--danger, #e74c3c)' : 'var(--warning, #f39c12)';
  const color = type === 'warning' ? '#000' : '#fff';
  
  const toast = document.createElement('div');
  toast.style.cssText = `background:${bg};color:${color};padding:12px 16px;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.3);font-family:var(--font-sans);max-width:350px;animation:slideInRight 0.3s ease-out;pointer-events:auto;display:flex;flex-direction:column;gap:4px;border-left:4px solid rgba(0,0,0,0.2)`;
  
  toast.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;font-weight:bold;font-size:0.9rem">
      <span>⚠️ ${title}</span>
      <span style="cursor:pointer;opacity:0.7" onclick="this.closest('div').parentElement.remove(); window.tmDismissAlert('${id}')">&times;</span>
    </div>
    <div class="tm-alert-msg" style="font-size:0.8rem;opacity:0.9">${message}</div>
  `;
  
  container.appendChild(toast);
  activeAlerts.set(id, toast);
  
  // Auto dismiss after 10s if it's resolved, wait, threshold alerts should stay as long as the threshold is breached.
  // We handle dismissal via tmCheckThresholds
}

export function tmDismissAlert(id) {
  activeAlerts.delete(id);
}
window.tmDismissAlert = tmDismissAlert;

// ── 8.7: configurable thresholds (different apps have different baselines —
// the fixed 90%/75%/1000 tx/s defaults don't fit everyone) ──────────────────
export function tmLoadThresholds() {
  const saved = (window.mtStateGet && window.mtStateGet('telemetry-monitor', 'thresholds', null)) || null;
  state.tmThresholds = Object.assign({}, TM_THRESHOLD_DEFAULTS, saved || {});
  tmSyncThresholdInputs();
  return state.tmThresholds;
}
window.tmLoadThresholds = tmLoadThresholds;

function tmSyncThresholdInputs() {
  const t = state.tmThresholds;
  Object.keys(t).forEach(key => {
    const el = document.getElementById('tm-thr-' + key.replace(/([A-Z])/g, '-$1').toLowerCase());
    if (el) el.value = t[key];
  });
}

// Reads the 6 inputs, validates warn < danger per pair (otherwise the two
// alert levels would contradict each other), and persists via toolState.
export function tmSaveThresholdsFromInputs() {
  const read = (key) => {
    const el = document.getElementById('tm-thr-' + key.replace(/([A-Z])/g, '-$1').toLowerCase());
    return el ? parseFloat(el.value) : NaN;
  };
  const next = {
    heapWarn: read('heapWarn'), heapDanger: read('heapDanger'),
    threadsWarn: read('threadsWarn'), threadsDanger: read('threadsDanger'),
    dbWarn: read('dbWarn'), dbDanger: read('dbDanger')
  };
  const statusEl = document.getElementById('tm-thr-status');
  for (const key of Object.keys(next)) {
    if (isNaN(next[key]) || next[key] <= 0) {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">All thresholds must be positive numbers.</span>';
      return;
    }
  }
  if (next.heapWarn >= next.heapDanger || next.threadsWarn >= next.threadsDanger || next.dbWarn >= next.dbDanger) {
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">Each "Warning" threshold must be lower than its "Danger" threshold.</span>';
    return;
  }
  state.tmThresholds = next;
  if (window.mtStateSet) window.mtStateSet('telemetry-monitor', 'thresholds', next);
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--success)">Saved.</span>';
}
window.tmSaveThresholdsFromInputs = tmSaveThresholdsFromInputs;

export function tmResetThresholds() {
  state.tmThresholds = Object.assign({}, TM_THRESHOLD_DEFAULTS);
  if (window.mtStateSet) window.mtStateSet('telemetry-monitor', 'thresholds', state.tmThresholds);
  tmSyncThresholdInputs();
  const statusEl = document.getElementById('tm-thr-status');
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-muted)">Reset to defaults.</span>';
}
window.tmResetThresholds = tmResetThresholds;

export function tmCheckThresholds() {
  if (state.tmHistory.heapMax.length === 0) return;
  
  const lastIdx = state.tmHistory.heapMax.length - 1;
  
  const t = state.tmThresholds;

  // 1. Memory Threshold
  const heapMax = state.tmHistory.heapMax[lastIdx];
  const heapUsed = state.tmHistory.heapUsed[lastIdx];
  if (heapMax > 0) {
    const heapPct = (heapUsed / heapMax) * 100;
    if (heapPct >= t.heapDanger) {
      showThresholdAlert('heap_danger', 'Critical Memory Usage', `Heap usage is at ${heapPct.toFixed(1)}% (${heapUsed}MB / ${heapMax}MB). System may crash soon.`, 'danger');
    } else if (heapPct >= t.heapWarn) {
      showThresholdAlert('heap_warn', 'High Memory Usage', `Heap usage is at ${heapPct.toFixed(1)}% (${heapUsed}MB / ${heapMax}MB).`, 'warning');
      removeAlert('heap_danger');
    } else {
      removeAlert('heap_danger');
      removeAlert('heap_warn');
    }
  }

  // 2. Threads Threshold
  const threadsMax = state.tmHistory.threadsMax[lastIdx];
  const threadsActive = state.tmHistory.threadsActive[lastIdx];
  if (threadsMax > 0) {
    const threadsPct = (threadsActive / threadsMax) * 100;
    if (threadsPct >= t.threadsDanger) {
      showThresholdAlert('threads_danger', 'Thread Pool Exhaustion', `Thread pool is ${threadsPct.toFixed(1)}% full (${threadsActive} / ${threadsMax}). New requests will be blocked.`, 'danger');
    } else if (threadsPct >= t.threadsWarn) {
      showThresholdAlert('threads_warn', 'High Thread Usage', `Thread pool is ${threadsPct.toFixed(1)}% full.`, 'warning');
      removeAlert('threads_danger');
    } else {
      removeAlert('threads_danger');
      removeAlert('threads_warn');
    }
  }

  // 3. Database Threshold
  const dbTx = state.tmHistory.dbTx[lastIdx];
  if (dbTx > t.dbDanger) {
    showThresholdAlert('db_danger', 'High Database Load', `Database transactions reached ${dbTx.toFixed(1)}/s.`, 'danger');
  } else if (dbTx > t.dbWarn) {
    showThresholdAlert('db_warn', 'Elevated Database Load', `Database transactions are at ${dbTx.toFixed(1)}/s.`, 'warning');
    removeAlert('db_danger');
  } else {
    removeAlert('db_danger');
    removeAlert('db_warn');
  }
}

function removeAlert(id) {
  if (activeAlerts.has(id)) {
    const el = activeAlerts.get(id);
    el.style.animation = 'fadeOut 0.3s ease-out forwards';
    setTimeout(() => el.remove(), 300);
    activeAlerts.delete(id);
  }
}

// Add simple CSS animations for alerts if not present
if (!document.getElementById('tm-alert-styles')) {
  const style = document.createElement('style');
  style.id = 'tm-alert-styles';
  style.textContent = `
    @keyframes slideInRight { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    @keyframes fadeOut { from { opacity: 1; } to { opacity: 0; transform: scale(0.95); } }
  `;
  document.head.appendChild(style);
}
