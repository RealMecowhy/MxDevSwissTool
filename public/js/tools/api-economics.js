// API ECONOMICS & PAYLOAD ANALYZER

function apiEconAnalyze() {
  const input = document.getElementById('api-econ-input').value;
  const out = document.getElementById('api-econ-results');
  if (!input.trim()) {
    out.innerHTML = '<div style="color:var(--text-muted)">Paste a JSON payload to see analysis...</div>';
    return;
  }
  
  let json;
  try {
    json = JSON.parse(input);
  } catch (e) {
    out.innerHTML = '<div style="color:var(--danger)">Invalid JSON: ' + escHtml(e.message) + '</div>';
    return;
  }
  
  const originalSize = new Blob([input]).size;
  const minified = JSON.stringify(json);
  const minifiedSize = new Blob([minified]).size;
  
  // Approximate GZIP (usually 60-70% reduction for JSON)
  const gzipSize = Math.floor(minifiedSize * 0.35);
  
  // Analyze fields
  const fieldCounts = {};
  const fieldSizes = {};
  
  function traverse(obj) {
    if (typeof obj === 'object' && obj !== null) {
      if (Array.isArray(obj)) {
        obj.forEach(traverse);
      } else {
        Object.keys(obj).forEach(k => {
          fieldCounts[k] = (fieldCounts[k] || 0) + 1;
          const valStr = JSON.stringify(obj[k]);
          fieldSizes[k] = (fieldSizes[k] || 0) + (valStr ? new Blob([valStr]).size : 0);
          traverse(obj[k]);
        });
      }
    }
  }
  
  traverse(json);
  
  // Sort by size
  const sortedFields = Object.keys(fieldSizes).sort((a,b) => fieldSizes[b] - fieldSizes[a]).slice(0, 10);
  
  let html = `<div class="grid-2" style="gap:var(--sp-4);margin-bottom:var(--sp-4)">
    <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--r-md);padding:var(--sp-4)">
      <div style="font-size:0.75rem;color:var(--text-secondary);text-transform:uppercase;margin-bottom:4px">Original Size</div>
      <div style="font-size:1.5rem;font-weight:bold;color:var(--text-primary)">${formatBytes(originalSize)}</div>
    </div>
    <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--r-md);padding:var(--sp-4)">
      <div style="font-size:0.75rem;color:var(--text-secondary);text-transform:uppercase;margin-bottom:4px">Minified Size</div>
      <div style="font-size:1.5rem;font-weight:bold;color:var(--success)">${formatBytes(minifiedSize)}</div>
      <div style="font-size:0.75rem;color:var(--success-dark)">(-${((originalSize - minifiedSize) / originalSize * 100).toFixed(1)}%)</div>
    </div>
    <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--r-md);padding:var(--sp-4)">
      <div style="font-size:0.75rem;color:var(--text-secondary);text-transform:uppercase;margin-bottom:4px">Est. GZIP Size</div>
      <div style="font-size:1.5rem;font-weight:bold;color:var(--info)">~${formatBytes(gzipSize)}</div>
    </div>
    <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--r-md);padding:var(--sp-4)">
      <div style="font-size:0.75rem;color:var(--text-secondary);text-transform:uppercase;margin-bottom:4px">Data Nodes (Keys)</div>
      <div style="font-size:1.5rem;font-weight:bold;color:var(--accent)">${Object.keys(fieldCounts).length}</div>
    </div>
  </div>`;
  
  html += `<h4 style="margin-bottom:var(--sp-2)">Top 10 Heaviest Fields</h4>`;
  html += `<table class="jwt-claim-table" style="width:100%">
    <tr><th style="text-align:left">Field Name</th><th style="text-align:right">Occurrences</th><th style="text-align:right">Total Data Size</th><th style="text-align:right">% of Payload</th></tr>`;
  
  sortedFields.forEach(f => {
    const perc = ((fieldSizes[f] / minifiedSize) * 100).toFixed(1);
    html += `<tr>
      <td style="font-family:var(--font-mono);font-weight:600">${escHtml(f)}</td>
      <td style="text-align:right">${fieldCounts[f]}</td>
      <td style="text-align:right">${formatBytes(fieldSizes[f])}</td>
      <td style="text-align:right">
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:4px">
          <span>${perc}%</span>
          <div style="width:50px;height:6px;background:var(--bg-sunken);border-radius:3px;overflow:hidden">
            <div style="width:${perc}%;height:100%;background:var(--warning)"></div>
          </div>
        </div>
      </td>
    </tr>`;
  });
  
  html += `</table>`;
  
  if (minifiedSize > 500 * 1024) {
    html += `<div class="notice notice-warning" style="margin-top:var(--sp-4)">
      <strong>Warning:</strong> This payload is quite large (>500KB). Consider implementing pagination or using OData <code>$select</code> to fetch only necessary fields.
    </div>`;
  }
  
  out.innerHTML = html;
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}


// --- AUTO-GENERATED ESM EXPORTS ---
window.apiEconAnalyze = apiEconAnalyze;
window.formatBytes = formatBytes;

export function init() {}
