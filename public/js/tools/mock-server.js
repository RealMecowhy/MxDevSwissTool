// MOCK SERVER & CHAOS (Module I)

let msActive = false;

async function msStart() {
  const payload = document.getElementById('ms-code').value;
  const status = document.getElementById('ms-status').value;
  const delay = parseInt(document.getElementById('ms-delay').value);
  const chaos = document.getElementById('ms-chaos').checked;
  const out = document.getElementById('ms-output');
  
  out.innerHTML = `<div style="color:var(--text-muted)">Pushing config to Mendix Observability Bridge...</div>`;
  
  try {
    const res = await fetch('http://localhost:9999/mock-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, status, delay, chaos })
    });
    if (!res.ok) throw new Error('Failed to configure mock server');
    
    msActive = true;
    out.innerHTML = `<div style="color:var(--success)">Mock Server activated on <b>http://localhost:9999/mock</b><br><br>Configure your Mendix Call REST action to use this URL.</div>`;
  } catch (err) {
    msActive = false;
    out.innerHTML = `<div style="color:var(--danger)">Error: Could not connect to local bridge.<br>Please run <code>node mendix-observability-bridge.js</code> in your terminal.</div>`;
  }
}

async function msTrigger() {
  if (!msActive) return alert('Activate the Mock Server first!');
  const out = document.getElementById('ms-output');
  out.innerHTML = `<div style="color:var(--text-muted)">Request sent to http://localhost:9999/mock, waiting for response...</div>`;
  
  const startTime = Date.now();
  try {
    const res = await fetch('http://localhost:9999/mock');
    const timeTaken = Date.now() - startTime;
    const text = await res.text();
    const timeStr = new Date().toLocaleTimeString();
    
    out.innerHTML = `
      <div style="font-size:0.8rem;color:var(--text-muted)">${timeStr} - Response received after ${timeTaken}ms</div>
      <div style="margin-top:var(--sp-2)">
        <span class="badge ${res.status >= 200 && res.status < 300 ? 'badge-success' : 'badge-danger'}">HTTP ${res.status} ${res.statusText}</span>
      </div>
      <pre style="margin-top:var(--sp-2);background:var(--bg-card);padding:var(--sp-3);border-radius:var(--r-md);font-size:0.85rem">${escHtml(text)}</pre>
    `;
  } catch (err) {
    out.innerHTML = `<div style="color:var(--danger)">Network Error: ${err.message}</div>`;
  }
}

function msStop() {
  msActive = false;
  document.getElementById('ms-output').innerHTML = `<div style="color:var(--text-muted)">Mock responder stopped in UI.<br>(Note: bridge server might still be running on port 9999)</div>`;
}


// --- AUTO-GENERATED ESM EXPORTS ---
window.msStart = msStart;
window.msTrigger = msTrigger;
window.msStop = msStop;

export function init() {}
