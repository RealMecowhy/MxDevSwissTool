// API ECONOMICS & PAYLOAD ANALYZER

// Pure — testable from scripts/parser-test.js without touching the DOM.
function apiEconIsEmptyValue(v) {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0) return true;
  return false;
}

function apiEconTraverse(json) {
  const fieldCounts = {}, fieldSizes = {}, fieldEmptyCounts = {};
  function traverse(obj) {
    if (typeof obj === 'object' && obj !== null) {
      if (Array.isArray(obj)) {
        obj.forEach(traverse);
      } else {
        Object.keys(obj).forEach(k => {
          fieldCounts[k] = (fieldCounts[k] || 0) + 1;
          const val = obj[k];
          const valStr = JSON.stringify(val);
          fieldSizes[k] = (fieldSizes[k] || 0) + (valStr ? new Blob([valStr]).size : 0);
          if (apiEconIsEmptyValue(val)) fieldEmptyCounts[k] = (fieldEmptyCounts[k] || 0) + 1;
          traverse(val);
        });
      }
    }
  }
  traverse(json);
  return { fieldCounts, fieldSizes, fieldEmptyCounts };
}

// A field only earns a $select suggestion if EVERY occurrence in the payload
// was empty — one non-empty occurrence means the field is real data somewhere.
function apiEconAlwaysEmptyFields(fieldCounts, fieldEmptyCounts) {
  return Object.keys(fieldCounts).filter(k => fieldEmptyCounts[k] === fieldCounts[k]).sort();
}

// Real measurement via the native CompressionStream, not a guess — returns
// null (not a number) when the API isn't available, so callers never render
// a fabricated size.
async function apiEconGzipSize(str) {
  if (typeof CompressionStream === 'undefined') return null;
  const bytes = new TextEncoder().encode(str);
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  let total = 0;
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
  }
  return total;
}

// Parses + measures one payload. Returns { error } or the full analysis —
// no DOM access, so this is the part covered by scripts/parser-test.js.
async function apiEconAnalyzePayload(input) {
  if (!input || !input.trim()) return { error: null, empty: true };
  let json;
  try {
    json = JSON.parse(input);
  } catch (e) {
    return { error: e.message };
  }
  const originalSize = new Blob([input]).size;
  const minified = JSON.stringify(json);
  const minifiedSize = new Blob([minified]).size;
  const gzipSize = await apiEconGzipSize(minified);
  const { fieldCounts, fieldSizes, fieldEmptyCounts } = apiEconTraverse(json);
  const alwaysEmptyFields = apiEconAlwaysEmptyFields(fieldCounts, fieldEmptyCounts);
  return { error: null, empty: false, json, originalSize, minifiedSize, gzipSize, fieldCounts, fieldSizes, alwaysEmptyFields };
}

function apiEconCompareSummary(a, b) {
  return {
    minifiedDelta: b.minifiedSize - a.minifiedSize,
    minifiedDeltaPct: a.minifiedSize ? ((b.minifiedSize - a.minifiedSize) / a.minifiedSize * 100) : 0,
    gzipDelta: (a.gzipSize != null && b.gzipSize != null) ? b.gzipSize - a.gzipSize : null,
  };
}

// --- DOM wiring -------------------------------------------------------------

function apiEconResultHtml(r) {
  if (r.empty) return '<div style="color:var(--text-muted)">Paste a JSON payload to see analysis...</div>';
  if (r.error) return '<div style="color:var(--danger)">Invalid JSON: ' + escHtml(r.error) + '</div>';

  const gzipCard = r.gzipSize != null
    ? `<div style="font-size:1.5rem;font-weight:bold;color:var(--info)">${formatBytes(r.gzipSize)}</div>`
    : `<div style="font-size:.85rem;color:var(--text-muted)">Not available (CompressionStream unsupported in this browser)</div>`;

  const sortedFields = Object.keys(r.fieldSizes).sort((a,b) => r.fieldSizes[b] - r.fieldSizes[a]).slice(0, 10);

  let html = `<div class="grid-2" style="gap:var(--sp-4);margin-bottom:var(--sp-4)">
    <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--r-md);padding:var(--sp-4)">
      <div style="font-size:0.75rem;color:var(--text-secondary);text-transform:uppercase;margin-bottom:4px">Original Size</div>
      <div style="font-size:1.5rem;font-weight:bold;color:var(--text-primary)">${formatBytes(r.originalSize)}</div>
    </div>
    <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--r-md);padding:var(--sp-4)">
      <div style="font-size:0.75rem;color:var(--text-secondary);text-transform:uppercase;margin-bottom:4px">Minified Size</div>
      <div style="font-size:1.5rem;font-weight:bold;color:var(--success)">${formatBytes(r.minifiedSize)}</div>
      <div style="font-size:0.75rem;color:var(--success-dark)">(-${((r.originalSize - r.minifiedSize) / r.originalSize * 100).toFixed(1)}%)</div>
    </div>
    <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--r-md);padding:var(--sp-4)">
      <div style="font-size:0.75rem;color:var(--text-secondary);text-transform:uppercase;margin-bottom:4px">GZIP Size <span title="Measured with the browser's real CompressionStream('gzip'), not an estimate">(real)</span></div>
      ${gzipCard}
    </div>
    <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--r-md);padding:var(--sp-4)">
      <div style="font-size:0.75rem;color:var(--text-secondary);text-transform:uppercase;margin-bottom:4px">Data Nodes (Keys)</div>
      <div style="font-size:1.5rem;font-weight:bold;color:var(--accent)">${Object.keys(r.fieldCounts).length}</div>
    </div>
  </div>`;

  html += `<h4 style="margin-bottom:var(--sp-2)">Top 10 Heaviest Fields</h4>`;
  html += `<table class="jwt-claim-table" style="width:100%">
    <tr><th style="text-align:left">Field Name</th><th style="text-align:right">Occurrences</th><th style="text-align:right">Total Data Size</th><th style="text-align:right">% of Payload</th></tr>`;

  sortedFields.forEach(f => {
    const perc = ((r.fieldSizes[f] / r.minifiedSize) * 100).toFixed(1);
    html += `<tr>
      <td style="font-family:var(--font-mono);font-weight:600">${escHtml(f)}</td>
      <td style="text-align:right">${r.fieldCounts[f]}</td>
      <td style="text-align:right">${formatBytes(r.fieldSizes[f])}</td>
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

  if (r.alwaysEmptyFields.length) {
    html += `<div class="notice notice-info" style="margin-top:var(--sp-4)">
      <strong>Always empty/null in this payload:</strong> ${r.alwaysEmptyFields.map(escHtml).join(', ')}.
      Consider excluding them with OData <code>$select</code> if this shape is representative.
    </div>`;
  }

  if (r.minifiedSize > 500 * 1024) {
    html += `<div class="notice notice-warning" style="margin-top:var(--sp-4)">
      <strong>Warning:</strong> This payload is quite large (>500KB). Consider implementing pagination or using OData <code>$select</code> to fetch only necessary fields.
    </div>`;
  }

  return html;
}

function apiEconCompareHtml(a, b) {
  const d = apiEconCompareSummary(a, b);
  const pctStr = (d.minifiedDeltaPct >= 0 ? '+' : '') + d.minifiedDeltaPct.toFixed(1) + '%';
  const gzipRow = d.gzipDelta != null
    ? `<tr><td>GZIP</td><td style="text-align:right">${formatBytes(a.gzipSize)}</td><td style="text-align:right">${formatBytes(b.gzipSize)}</td><td style="text-align:right">${(d.gzipDelta>=0?'+':'')+formatBytes(Math.abs(d.gzipDelta))}</td></tr>`
    : `<tr><td>GZIP</td><td colspan="3" style="text-align:right;color:var(--text-muted)">Not available</td></tr>`;
  return `<h4 style="margin:var(--sp-4) 0 var(--sp-2)">Comparison (B vs. A)</h4>
    <table class="jwt-claim-table" style="width:100%">
      <tr><th style="text-align:left"></th><th style="text-align:right">A</th><th style="text-align:right">B</th><th style="text-align:right">Delta</th></tr>
      <tr><td>Minified</td><td style="text-align:right">${formatBytes(a.minifiedSize)}</td><td style="text-align:right">${formatBytes(b.minifiedSize)}</td><td style="text-align:right">${(d.minifiedDelta>=0?'+':'')+formatBytes(Math.abs(d.minifiedDelta))} (${pctStr})</td></tr>
      ${gzipRow}
    </table>`;
}

async function apiEconAnalyze() {
  const out = document.getElementById('api-econ-results');
  const input = document.getElementById('api-econ-input').value;
  const compareOn = document.getElementById('api-econ-compare-toggle') && document.getElementById('api-econ-compare-toggle').checked;

  out.innerHTML = '<div style="color:var(--text-muted)">Analyzing...</div>';
  const resultA = await apiEconAnalyzePayload(input);
  let html = apiEconResultHtml(resultA);

  if (compareOn) {
    const inputB = document.getElementById('api-econ-input-b') ? document.getElementById('api-econ-input-b').value : '';
    const resultB = await apiEconAnalyzePayload(inputB);
    html += apiEconResultHtml(resultB).replace('<div class="grid-2"', '<h4 style="margin:var(--sp-4) 0 var(--sp-2)">Payload B</h4><div class="grid-2"');
    if (!resultA.error && !resultA.empty && !resultB.error && !resultB.empty) {
      html += apiEconCompareHtml(resultA, resultB);
    }
  }

  out.innerHTML = html;
}

function apiEconToggleCompare() {
  const on = document.getElementById('api-econ-compare-toggle').checked;
  const wrap = document.getElementById('api-econ-input-b-wrap');
  if (wrap) wrap.style.display = on ? 'flex' : 'none';
}

function formatBytes(bytes, decimals = 2) {
    const numBytes = +bytes;
    if (!numBytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}


// --- AUTO-GENERATED ESM EXPORTS ---
window.apiEconAnalyze = apiEconAnalyze;
window.apiEconToggleCompare = apiEconToggleCompare;
window.formatBytes = formatBytes;
window.apiEconTraverse = apiEconTraverse;
window.apiEconAlwaysEmptyFields = apiEconAlwaysEmptyFields;
window.apiEconGzipSize = apiEconGzipSize;
window.apiEconAnalyzePayload = apiEconAnalyzePayload;
window.apiEconCompareSummary = apiEconCompareSummary;

export function init() {}
