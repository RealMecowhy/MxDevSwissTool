import { state, TM_USED_METRICS } from './state.js';
import { tmProcessMetrics } from './processor.js';
import { tmUpdateTabsVisibility } from './ui.js';
import { tmParsePrometheusText } from './parsers/prometheus.js';

export function tmFetchMetrics() {
  let url = document.getElementById('tm-endpoint-url').value.trim();
  const authKey = document.getElementById('tm-auth-header').value.trim();
  const headers = {};
  
  if (state.tmConnectionProfile.startsWith('agent')) {
    const agentUrl = document.getElementById('tm-agent-url').value.trim();
    if (!agentUrl) return;
    const adminPort = document.getElementById('tm-agent-prom-port')?.value.trim() || '8090';
    url = `${agentUrl}/prometheus?port=${adminPort}`;
  } else {
    if (!url) return alert('Please enter a Prometheus Endpoint URL');
    if (authKey) headers['X-API-Key'] = authKey;
  }

  const btn = document.getElementById('tm-btn-fetch');
  if (btn && state.tmConnectionProfile === 'direct') {
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

      if (state.tmConnectionProfile === 'direct') {
        state.tmDirectConnected = true;
        tmUpdateTabsVisibility();
      }
    })
    .catch(err => {
      if (state.tmConnectionProfile === 'direct') {
        console.error(err);
        tmStopPolling();
        state.tmDirectConnected = false;
        tmUpdateTabsVisibility();
        alert(`Connection failed!\n\nCould not retrieve telemetry from "${url}".\nReason: ${err.message}`);
      }
      // Silently ignore if proxy fails in agent mode (e.g., Mendix Prometheus not enabled)
    })
    .finally(() => {
      if (btn && state.tmConnectionProfile === 'direct') {
        btn.disabled = false;
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg> Fetch Metrics';
      }
    });
}

export function tmChangePollInterval() {
  tmStopPolling();
  
  const select = document.getElementById('tm-poll-interval');
  if (!select) return;

  const interval = parseInt(select.value);
  if (interval > 0 && (state.tmConnectionProfile === 'direct' || state.tmConnectionProfile.startsWith('agent'))) {
    tmFetchMetrics();
    state.tmPollTimer = setInterval(tmFetchMetrics, interval);
  }
}

export function tmStopPolling() {
  if (state.tmPollTimer) {
    clearInterval(state.tmPollTimer);
    state.tmPollTimer = null;
  }
}

export function tmParsePastedMetrics() {
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

// Metrics Inventory: fetch the raw Prometheus text from the active endpoint and
// list every unique metric received, split into "currently visualized"
// (TM_USED_METRICS) vs. "available but not used". Helps discover metrics worth
// charting. Shown in a lightweight overlay modal.
export function tmDumpAllMetrics() {
  let url;
  if (state.tmConnectionProfile.startsWith('agent')) {
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

