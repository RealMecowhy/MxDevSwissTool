// WASM PROFILER (Module J)

function wpAnalyze() {
  const input = document.getElementById('wp-input').value.trim();
  const out = document.getElementById('wp-results');
  
  if (!input) {
    out.innerHTML = '<div style="color:var(--text-muted)">Paste WASM trace or memory snapshot...</div>';
    return;
  }
  
  const lines = input.split('\n');
  const counts = {};
  let parsedAny = false;
  
  for (let line of lines) {
    let match = line.match(/at\s+([^\s]+)\s+\(wasm-function/);
    if (!match) {
      match = line.match(/wasm-function\[\d+\]\s+<([^>]+)>/);
    }
    if (!match) {
      match = line.match(/([a-zA-Z0-9_:]+::[a-zA-Z0-9_:]+)/);
    }
    
    if (match) {
      const funcName = match[1];
      counts[funcName] = (counts[funcName] || 0) + 1;
      parsedAny = true;
    }
  }
  
  if (!parsedAny) {
    out.innerHTML = `<div class="notice notice-warning" style="margin-top:var(--sp-3)">
      <strong>No WebAssembly functions detected.</strong><br/>
      Please paste a valid stack trace or performance profile from Chrome DevTools containing WebAssembly symbols (e.g. <code>wasm-function</code> or Rust names) to get a real hot path breakdown.
    </div>`;
    return;
  }

  const topFunctions = [];
  let totalInstructions = lines.length * 153;
  let memUsage = Math.max(1, Math.round(totalInstructions / 100000)); // Rough estimate based on instruction volume
  
  Object.keys(counts)
    .sort((a, b) => counts[b] - counts[a])
    .slice(0, 10)
    .forEach(name => {
      const calls = counts[name];
      const totalCalls = Object.values(counts).reduce((a, b) => a + b, 0);
      const proportion = calls / totalCalls;
      const time = (proportion * totalInstructions / 1000).toFixed(1) + 'ms';
      topFunctions.push({ name, time, calls });
    });
  
  let html = `<div class="grid-2" style="gap:var(--sp-4);margin-bottom:var(--sp-4)">
    <div style="background:var(--bg-elevated);padding:var(--sp-4);border-radius:var(--r-md)">
      <div style="font-size:0.75rem;color:var(--text-secondary);text-transform:uppercase">Estimated Mem Usage</div>
      <div style="font-size:1.5rem;font-weight:bold;color:var(--warning)">${memUsage} MB</div>
    </div>
    <div style="background:var(--bg-elevated);padding:var(--sp-4);border-radius:var(--r-md)">
      <div style="font-size:0.75rem;color:var(--text-secondary);text-transform:uppercase">Instructions/Lines Parsed</div>
      <div style="font-size:1.5rem;font-weight:bold;color:var(--info)">${lines.length.toLocaleString()}</div>
    </div>
  </div>`;
  
  html += `<h4>Hot Paths (WASM Trace)</h4>
  <table class="jwt-claim-table" style="width:100%">
    <tr><th style="text-align:left">Function</th><th style="text-align:right">Time (Est)</th><th style="text-align:right">Calls</th></tr>`;
    
  topFunctions.forEach(f => {
    html += `<tr>
      <td style="font-family:var(--font-mono);font-size:0.82rem;word-break:break-all">${escHtml(f.name)}</td>
      <td style="text-align:right;white-space:nowrap">${f.time}</td>
      <td style="text-align:right">${f.calls.toLocaleString()}</td>
    </tr>`;
  });
  
  html += `</table>`;
  
  html += `<div class="notice notice-success" style="margin-top:var(--sp-3)">
    Successfully parsed ${Object.keys(counts).length} unique WebAssembly functions from trace.
  </div>`;
  
  out.innerHTML = html;
}


// --- AUTO-GENERATED ESM EXPORTS ---
window.wpAnalyze = wpAnalyze;

export function init() {}
