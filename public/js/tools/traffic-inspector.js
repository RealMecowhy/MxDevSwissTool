// TRAFFIC INSPECTOR (Module H)
// Parses HAR files or cURL commands

let tiFileContent = null;

function initTi() {
  const input = document.getElementById('ti-input');
  if (!input) return;
  input.addEventListener('dragover', (e) => { e.preventDefault(); input.style.borderColor = 'var(--accent)'; });
  input.addEventListener('dragleave', (e) => { e.preventDefault(); input.style.borderColor = 'var(--border)'; });
  input.addEventListener('drop', (e) => {
    e.preventDefault();
    input.style.borderColor = 'var(--border)';
    const file = e.dataTransfer.files[0];
    if (file) {
      document.getElementById('ti-file-info').innerText = `Loaded file: ${file.name} (${Math.round(file.size/1024)} KB)`;
      document.getElementById('ti-file-info').style.display = 'block';
      input.value = `[File loaded: ${file.name}]`;
      const reader = new FileReader();
      reader.onload = (evt) => {
        tiFileContent = evt.target.result;
        tiParse();
      };
      reader.readAsText(file);
    }
  });
  input.addEventListener('input', () => {
    if (!input.value.startsWith('[File loaded:')) {
      tiFileContent = null;
      document.getElementById('ti-file-info').style.display = 'none';
    }
  });
}

function tiParse() {
  const input = document.getElementById('ti-input').value.trim();
  const out = document.getElementById('ti-results');
  const content = tiFileContent || input;
  
  if (!content) {
    out.innerHTML = '<div style="color:var(--text-muted)">Paste HAR JSON or cURL command...</div>';
    return;
  }
  
  if (content.startsWith('curl')) {
    tiParseCurl(content, out);
  } else if (content.startsWith('{')) {
    tiParseHar(content, out);
  } else {
    out.innerHTML = '<div style="color:var(--danger)">Format not recognized. Please paste a valid HAR JSON or cURL command.</div>';
  }
}

function tiParseCurl(curlStr, out) {
  // Simple heuristic parser for cURL
  const methodMatch = curlStr.match(/-X\s+([A-Z]+)/);
  const method = methodMatch ? methodMatch[1] : (curlStr.includes('--data') || curlStr.includes('-d') ? 'POST' : 'GET');
  
  const urlMatch = curlStr.match(/curl\s+["']?(https?:\/\/[^\s"']+)["']?/);
  const url = urlMatch ? urlMatch[1] : 'Unknown URL';
  
  const headers = [];
  const headerRegex = /-H\s+["']([^"']+)["']/g;
  let m;
  while ((m = headerRegex.exec(curlStr)) !== null) {
    headers.push(m[1]);
  }
  
  const dataMatch = curlStr.match(/(?:--data|-d|--data-raw)\s+["']([^"']+)["']/);
  const data = dataMatch ? dataMatch[1] : null;
  
  let html = `<div style="margin-bottom:var(--sp-4)">
    <div style="font-size:1.2rem;font-weight:bold;margin-bottom:4px"><span style="color:var(--accent)">${method}</span> <span style="font-family:var(--font-mono);font-size:1rem">${escHtml(url)}</span></div>
  </div>`;
  
  if (headers.length > 0) {
    html += `<h4>Headers</h4>
    <div style="background:var(--bg-elevated);padding:var(--sp-3);border-radius:var(--r-md);font-family:var(--font-mono);font-size:0.85rem;margin-bottom:var(--sp-4)">
      ${headers.map(h => {
        const [k, ...v] = h.split(':');
        return `<div><strong style="color:var(--info)">${escHtml(k)}:</strong> ${escHtml(v.join(':'))}</div>`;
      }).join('')}
    </div>`;
  }
  
  if (data) {
    html += `<h4>Body Payload</h4>
    <div style="background:var(--bg-elevated);padding:var(--sp-3);border-radius:var(--r-md);font-family:var(--font-mono);font-size:0.85rem;white-space:pre-wrap">
      ${escHtml(data)}
    </div>`;
  }
  
  out.innerHTML = html;
}

function tiParseHar(harStr, out) {
  try {
    const har = JSON.parse(harStr);
    if (!har.log || !har.log.entries) throw new Error('Invalid HAR file format (missing log.entries)');
    
    let html = `<div class="grid-2" style="gap:var(--sp-4);margin-bottom:var(--sp-4)">
      <div style="background:var(--bg-elevated);padding:var(--sp-4);border-radius:var(--r-md)">
        <div style="font-size:0.75rem;color:var(--text-secondary);text-transform:uppercase">Total Requests</div>
        <div style="font-size:1.5rem;font-weight:bold">${har.log.entries.length}</div>
      </div>
      <div style="background:var(--bg-elevated);padding:var(--sp-4);border-radius:var(--r-md)">
        <div style="font-size:0.75rem;color:var(--text-secondary);text-transform:uppercase">Creator</div>
        <div style="font-size:1.5rem;font-weight:bold">${escHtml(har.log.creator.name)}</div>
      </div>
    </div>`;
    
    html += `<h4>Requests Overview</h4>`;
    html += `<table style="width:100%;font-size:0.85rem" class="jwt-claim-table">
      <tr><th style="text-align:left">Method</th><th style="text-align:left">URL</th><th style="text-align:right">Status</th><th style="text-align:right">Time</th></tr>`;
      
    har.log.entries.slice(0, 50).forEach(e => {
      const u = new URL(e.request.url);
      const color = e.response.status >= 400 ? 'var(--danger)' : 'var(--success)';
      html += `<tr>
        <td style="font-family:var(--font-mono);font-weight:bold">${e.request.method}</td>
        <td style="word-break:break-all"><div style="max-height:3em;overflow:hidden">${escHtml(u.pathname + u.search)}</div></td>
        <td style="text-align:right;color:${color}">${e.response.status}</td>
        <td style="text-align:right">${Math.round(e.time)} ms</td>
      </tr>`;
    });
    
    html += `</table>`;
    if (har.log.entries.length > 50) html += `<div style="margin-top:var(--sp-2);color:var(--text-muted);font-size:0.8rem">Showing first 50 entries...</div>`;
    
    out.innerHTML = html;
  } catch(e) {
    out.innerHTML = '<div style="color:var(--danger)">Error parsing HAR: ' + escHtml(e.message) + '</div>';
  }
}


// --- AUTO-GENERATED ESM EXPORTS ---
window.tiParse = tiParse;
window.tiParseCurl = tiParseCurl;
window.tiParseHar = tiParseHar;
window.initTi = initTi;

export function init() { initTi(); }
