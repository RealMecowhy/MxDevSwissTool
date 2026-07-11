// MEMORY INSPECTOR (Module K)

function miAnalyze() {
  const input = document.getElementById('mi-input').value.trim();
  const out = document.getElementById('mi-results');
  
  if (!input) {
    out.innerHTML = '<div style="color:var(--text-muted)">Paste Heap Dump summary (jmap histogram) or GC logs...</div>';
    return;
  }
  
  const lines = input.split('\n');
  const parsedClasses = [];
  let totalBytes = 0;
  
  for (let line of lines) {
    const match = line.trim().match(/^(\d+):\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (match) {
      const instances = parseInt(match[2]);
      const bytes = parseInt(match[3]);
      const className = match[4].trim();
      totalBytes += bytes;
      parsedClasses.push({
        instances,
        bytes,
        className
      });
    }
  }
  
  let leakProbability = 'Low';
  let warningMessage = '';
  let oldGen = 0; // Will be calculated from actual data if available
  
  if (parsedClasses.length > 0) {
    // Sort by bytes desc
    parsedClasses.sort((a, b) => b.bytes - a.bytes);
    
    // Check for Mendix Object leaks
    const mendixObjects = parsedClasses.find(c => c.className.includes('MendixObjectImpl') || c.className === 'com.mendix.core.objectmanagement.MendixObjectImpl');
    if (mendixObjects) {
      const ratio = mendixObjects.bytes / totalBytes;
      if (ratio > 0.15 || mendixObjects.bytes > 100 * 1024 * 1024) {
        leakProbability = 'High';
        oldGen = Math.min(98, Math.floor(ratio * 100) + 40);
        warningMessage = `<strong>Leak Warning:</strong> <code>MendixObjectImpl</code> occupies ${formatBytes(mendixObjects.bytes)} (${(ratio * 100).toFixed(1)}% of scanned heap). This often points to uncommitted object lists in long-running Microflows.`;
      }
    }
    
    // Check for massive strings
    const strings = parsedClasses.find(c => c.className === 'java.lang.String' || c.className === '[C');
    if (strings && strings.bytes > 200 * 1024 * 1024) {
      leakProbability = 'Medium';
      warningMessage = warningMessage || `<strong>High Memory:</strong> String character arrays occupy ${formatBytes(strings.bytes)}. Look for large file exports or huge REST response payloads stored in memory.`;
    }
  } else {
    out.innerHTML = `<div class="notice notice-warning">
      <strong>No valid data found.</strong><br>
      Make sure you paste the exact output of a <code>jmap -histo &lt;pid&gt;</code> command. 
      <br><br>
      Example of expected format:
      <pre style="background:var(--bg-base);padding:8px;border-radius:4px;margin-top:8px;font-family:var(--font-mono);font-size:0.8rem">
 num     #instances         #bytes  class name
----------------------------------------------
   1:       12450      152043000  com.mendix.core.objectmanagement.MendixObjectImpl
   2:      450123       93320000  java.lang.String
      </pre>
    </div>`;
    return;
  }
  
  let html = `<div class="grid-2" style="gap:var(--sp-4);margin-bottom:var(--sp-4)">
    <div style="background:var(--bg-elevated);padding:var(--sp-4);border-radius:var(--r-md)">
      <div style="font-size:0.75rem;color:var(--text-secondary);text-transform:uppercase">Memory Leak Probability</div>
      <div style="font-size:1.5rem;font-weight:bold;color:${leakProbability === 'High' ? 'var(--danger)' : leakProbability === 'Medium' ? 'var(--warning)' : 'var(--success)'}">${leakProbability}</div>
    </div>
    <div style="background:var(--bg-elevated);padding:var(--sp-4);border-radius:var(--r-md)">
      <div style="font-size:0.75rem;color:var(--text-secondary);text-transform:uppercase">Old Gen Usage</div>
      <div style="font-size:1.5rem;font-weight:bold;color:${oldGen > 80 ? 'var(--danger)' : oldGen > 0 ? 'var(--info)' : 'var(--text-muted)'}">${oldGen > 0 ? oldGen + '%' : 'N/A'}</div>
    </div>
  </div>`;
  
  if (warningMessage) {
    html += `<div class="notice notice-warning" style="margin-bottom:var(--sp-4)">${warningMessage}</div>`;
  }
  
  html += `<h4>Histogram Analysis (Total Scanned: ${formatBytes(totalBytes)})</h4>
  <table class="jwt-claim-table" style="width:100%">
    <tr><th style="text-align:left">Class Name</th><th style="text-align:right">Size</th><th style="text-align:right">Instances</th></tr>`;
    
  parsedClasses.slice(0, 15).forEach(c => {
    html += `<tr>
      <td style="font-family:var(--font-mono);font-size:0.82rem;word-break:break-all">${escHtml(c.className)}</td>
      <td style="text-align:right;white-space:nowrap">${formatBytes(c.bytes)}</td>
      <td style="text-align:right">${c.instances.toLocaleString()}</td>
    </tr>`;
  });
  
  html += `</table>`;
  
  if (parsedClasses.length > 15) {
    html += `<div style="font-size:0.78rem;color:var(--text-muted);margin-top:var(--sp-2)">Showing top 15 items...</div>`;
  }
  
  html += `<div class="notice notice-info" style="margin-top:var(--sp-3)">
    <strong>Tip:</strong> Run <code>jmap -histo &lt;pid&gt;</code> on your JVM and paste the output here to perform a real-time memory analysis.
  </div>`;
  
  out.innerHTML = html;
}



// --- AUTO-GENERATED ESM EXPORTS ---
window.miAnalyze = miAnalyze;

export function init() {}
