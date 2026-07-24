// ODATA BUILDER
// ============================================================
function odataFields() {
  return {
    base: document.getElementById('odata-base').value.trim(),
    entity: document.getElementById('odata-entity').value.trim(),
    filter: document.getElementById('odata-filter').value.trim(),
    select: document.getElementById('odata-select').value.trim(),
    expand: document.getElementById('odata-expand').value.trim(),
    orderby: document.getElementById('odata-orderby').value.trim(),
    top: document.getElementById('odata-top').value.trim(),
    skip: document.getElementById('odata-skip').value.trim(),
    count: document.getElementById('odata-count').value,
    format: document.getElementById('odata-format').value
  };
}

// Pure: the same base+entity+params join used by the colored preview, the
// plain-text copy, and the Test button — one place decides what "the URL" is.
function odataBuildUrl(f) {
  const base = f.base || 'https://your-app.mendixcloud.com/odata/Service/v1';
  const params = [];
  ['filter', 'select', 'expand', 'orderby'].forEach(p => { if (f[p]) params.push(['$' + p, f[p]]); });
  if (f.top) params.push(['$top', f.top]);
  if (f.skip) params.push(['$skip', f.skip]);
  if (f.count) params.push(['$count', f.count]);
  if (f.format) params.push(['$format', f.format]);
  let url = base + (f.entity ? '/' + f.entity : '');
  if (params.length) url += '?' + params.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  return url;
}

function odataBuild() {
  const f = odataFields();
  const displayEl = document.getElementById('odata-url-display');
  if (!f.base && !f.entity) { displayEl.innerHTML = '<span style="color:var(--text-muted)">Fill in the fields above...</span>'; return; }
  const params = [];
  ['filter', 'select', 'expand', 'orderby'].forEach(p => { if (f[p]) params.push(['$' + p, f[p]]); });
  if (f.top) params.push(['$top', f.top]);
  if (f.skip) params.push(['$skip', f.skip]);
  if (f.count) params.push(['$count', f.count]);
  if (f.format) params.push(['$format', f.format]);
  let html = '<span class="url-base">' + escHtml(f.base || 'https://your-app.mendixcloud.com/odata/Service/v1') + '</span>';
  if (f.entity) html += '<span style="color:var(--text-primary)">' + '/' + escHtml(f.entity) + '</span>';
  if (params.length) html += '<span class="url-sep">?</span>' + params.map(([k, v], i) => (i > 0 ? '<span class="url-sep">&amp;</span>' : '') + '<span class="url-param-name">' + k + '</span><span class="url-sep">=</span><span class="url-param-val">' + escHtml(v) + '</span>').join('');
  displayEl.innerHTML = html;
}

function odataCopyUrl() {
  const url = odataBuildUrl(odataFields());
  copyToClipboard(url);
  odataSaveToHistory(url);
}

// ── Visual $filter builder (12.5) ───────────────────────────────────────────
// No live domain model is wired into this tool (unlike Domain Model/QI), so
// attribute names are free text, not picked from real metadata — honest about
// what it actually knows, still saves hand-typing OData operator syntax.
const ODATA_FILTER_FUNCS = { contains: true, startswith: true, endswith: true };
let odataFilterRows = [{ attr: '', op: 'eq', value: '' }];

function odataFormatFilterValue(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (v === '') return v;
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (/^(true|false)$/i.test(v)) return v.toLowerCase();
  return "'" + v.replace(/'/g, "''") + "'";
}

function odataBuildFilterExpr(rows) {
  return (rows || [])
    .filter(r => r.attr && r.attr.trim() && String(r.value == null ? '' : r.value).trim() !== '')
    .map(r => {
      const attr = r.attr.trim();
      const val = odataFormatFilterValue(r.value);
      return ODATA_FILTER_FUNCS[r.op] ? r.op + '(' + attr + ',' + val + ')' : attr + ' ' + r.op + ' ' + val;
    })
    .join(' and ');
}

function odataSyncFilterExpr() {
  document.getElementById('odata-filter').value = odataBuildFilterExpr(odataFilterRows);
  odataBuild();
}

window.odataAddFilterRow = function () {
  odataFilterRows.push({ attr: '', op: 'eq', value: '' });
  odataRenderFilterRows();
};
window.odataRemoveFilterRow = function (idx) {
  odataFilterRows.splice(idx, 1);
  if (!odataFilterRows.length) odataFilterRows.push({ attr: '', op: 'eq', value: '' });
  odataRenderFilterRows();
  odataSyncFilterExpr();
};
window.odataUpdateFilterRow = function (idx, field, value) {
  odataFilterRows[idx][field] = value;
  odataSyncFilterExpr();
};

function odataRenderFilterRows() {
  const box = document.getElementById('odata-filter-rows');
  if (!box) return;
  const opts = ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'contains', 'startswith', 'endswith'];
  box.innerHTML = odataFilterRows.map((r, i) => `
    <div style="display:flex;gap:6px;margin-bottom:4px;align-items:center">
      <input class="input input-mono input-sm" style="flex:1" placeholder="Attribute" value="${escHtml(r.attr)}" oninput="window.odataUpdateFilterRow(${i},'attr',this.value)">
      <select class="select select-sm" style="width:110px" onchange="window.odataUpdateFilterRow(${i},'op',this.value)">
        ${opts.map(o => `<option value="${o}"${r.op === o ? ' selected' : ''}>${o}</option>`).join('')}
      </select>
      <input class="input input-mono input-sm" style="flex:1" placeholder="Value" value="${escHtml(r.value)}" oninput="window.odataUpdateFilterRow(${i},'value',this.value)">
      <button type="button" class="btn btn-ghost btn-xs" onclick="window.odataRemoveFilterRow(${i})" title="Remove condition">&times;</button>
    </div>`).join('');
}

// ── $expand path builder (12.5) ─────────────────────────────────────────────
// A "tree of navigation properties" would need real association metadata,
// which this tool has no connection to — this is honestly a path LIST builder
// instead: each entry is one (optionally nested, e.g. "Orders/Items") expand
// path, joined with commas into $expand.
let odataExpandPaths = [''];

window.odataAddExpandPath = function () {
  odataExpandPaths.push('');
  odataRenderExpandPaths();
};
window.odataRemoveExpandPath = function (idx) {
  odataExpandPaths.splice(idx, 1);
  if (!odataExpandPaths.length) odataExpandPaths.push('');
  odataRenderExpandPaths();
  odataSyncExpandExpr();
};
window.odataUpdateExpandPath = function (idx, value) {
  odataExpandPaths[idx] = value;
  odataSyncExpandExpr();
};

function odataSyncExpandExpr() {
  document.getElementById('odata-expand').value = odataExpandPaths.map(p => p.trim()).filter(Boolean).join(',');
  odataBuild();
}

function odataRenderExpandPaths() {
  const box = document.getElementById('odata-expand-rows');
  if (!box) return;
  box.innerHTML = odataExpandPaths.map((p, i) => `
    <div style="display:flex;gap:6px;margin-bottom:4px;align-items:center">
      <input class="input input-mono input-sm" style="flex:1" placeholder="Orders or Orders/Items" value="${escHtml(p)}" oninput="window.odataUpdateExpandPath(${i},this.value)">
      <button type="button" class="btn btn-ghost btn-xs" onclick="window.odataRemoveExpandPath(${i})" title="Remove">&times;</button>
    </div>`).join('');
}

// ── URL history (12.5) — last 10, via the shared toolState chokepoint ───────
const ODATA_TOOL_ID = 'odata-builder';
const ODATA_HISTORY_MAX = 10;

function odataSaveToHistory(url) {
  if (!url) return;
  let hist = window.mtStateGet(ODATA_TOOL_ID, 'urlHistory', []) || [];
  hist = hist.filter(u => u !== url);
  hist.unshift(url);
  hist = hist.slice(0, ODATA_HISTORY_MAX);
  window.mtStateSet(ODATA_TOOL_ID, 'urlHistory', hist);
  odataRenderHistory();
}

// Reverses odataBuildUrl for a stored URL — pure, no DOM — so field
// repopulation and its tests don't depend on the input elements existing.
function odataParseUrl(url) {
  const out = { base: '', entity: '', filter: '', select: '', expand: '', orderby: '', top: '', skip: '', count: '', format: '' };
  const qIdx = url.indexOf('?');
  const pathPart = qIdx === -1 ? url : url.slice(0, qIdx);
  const query = qIdx === -1 ? '' : url.slice(qIdx + 1);
  const lastSlash = pathPart.lastIndexOf('/');
  if (lastSlash > 'https://'.length) {
    out.base = pathPart.slice(0, lastSlash);
    out.entity = pathPart.slice(lastSlash + 1);
  } else {
    out.base = pathPart;
  }
  if (query) {
    query.split('&').forEach(pair => {
      const eq = pair.indexOf('=');
      if (eq === -1) return;
      const k = decodeURIComponent(pair.slice(0, eq));
      const v = decodeURIComponent(pair.slice(eq + 1));
      if (k === '$filter') out.filter = v;
      else if (k === '$select') out.select = v;
      else if (k === '$expand') out.expand = v;
      else if (k === '$orderby') out.orderby = v;
      else if (k === '$top') out.top = v;
      else if (k === '$skip') out.skip = v;
      else if (k === '$count') out.count = v;
      else if (k === '$format') out.format = v;
    });
  }
  return out;
}

window.odataLoadFromHistory = function (url) {
  if (!url) return;
  const f = odataParseUrl(url);
  document.getElementById('odata-base').value = f.base;
  document.getElementById('odata-entity').value = f.entity;
  document.getElementById('odata-filter').value = f.filter;
  document.getElementById('odata-select').value = f.select;
  document.getElementById('odata-expand').value = f.expand;
  document.getElementById('odata-orderby').value = f.orderby;
  document.getElementById('odata-top').value = f.top;
  document.getElementById('odata-skip').value = f.skip;
  document.getElementById('odata-count').value = f.count;
  document.getElementById('odata-format').value = f.format;
  odataFilterRows = [{ attr: '', op: 'eq', value: '' }];
  odataExpandPaths = f.expand ? f.expand.split(',') : [''];
  odataRenderFilterRows();
  odataRenderExpandPaths();
  odataBuild();
};

function odataRenderHistory() {
  const sel = document.getElementById('odata-history');
  if (!sel) return;
  const hist = window.mtStateGet(ODATA_TOOL_ID, 'urlHistory', []) || [];
  sel.innerHTML = '<option value="">Recent URLs…</option>' +
    hist.map(u => `<option value="${escHtml(u)}">${escHtml(u.length > 90 ? u.slice(0, 90) + '…' : u)}</option>`).join('');
  sel.style.display = hist.length ? '' : 'none';
}

// ── Test button (12.5) — via the Bridge, same one-shot proxy Perf Lab uses ──
// Reuses /api/perf-test with count=1/concurrency=1 rather than a new endpoint —
// one less network-facing surface to secure. That endpoint only proxies
// localhost/private-IP targets by default (SSRF guard), which covers the real
// "test my local Studio Pro app" case; a public Mendix Cloud URL gets the same
// honest refusal (with the MXDEV_ALLOW_EXTERNAL_PERFTEST unlock) Perf Lab
// already shows — not a silent failure, and not a new security decision.
window.odataTest = async function (btn) {
  const url = odataBuildUrl(odataFields());
  odataSaveToHistory(url);
  const resultEl = document.getElementById('odata-test-result');
  if (!resultEl) return;
  const old = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = 'Testing…'; }
  resultEl.style.display = 'block';
  resultEl.innerHTML = '<span style="color:var(--text-muted)">Requesting…</span>';
  try {
    const resp = await fetch('http://localhost:9999/api/perf-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, method: 'GET', concurrency: 1, count: 1 })
    });
    const data = await resp.json();
    if (!data.success) {
      resultEl.innerHTML = `<div class="notice notice-warning" style="margin:0">${escHtml(data.message || data.error || 'Request failed.')}</div>`;
    } else {
      const r = data.results && data.results[0];
      if (!r) { resultEl.innerHTML = '<div class="notice notice-warning" style="margin:0">No response.</div>'; }
      else if (r.status === 'Error') { resultEl.innerHTML = `<div class="notice notice-warning" style="margin:0">Request failed after ${r.time} ms.</div>`; }
      else {
        const ok = typeof r.status === 'number' && r.status >= 200 && r.status < 300;
        resultEl.innerHTML = `<div class="notice ${ok ? 'notice-success' : 'notice-warning'}" style="margin:0">HTTP <strong>${r.status}</strong> in ${r.time} ms</div>`;
      }
    }
  } catch (e) {
    resultEl.innerHTML = `<div class="notice notice-warning" style="margin:0">Observability Bridge not reachable on http://localhost:9999. Start it with "npm run bridge" to use Test.</div>`;
  } finally {
    if (btn && old !== null) { btn.disabled = false; btn.innerHTML = old; }
  }
};

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.odataBuild = odataBuild;
window.odataCopyUrl = odataCopyUrl;

// Exposed for scripts/parser-test.js (pure functions, no DOM).
window.odataBuildUrl = odataBuildUrl;
window.odataBuildFilterExpr = odataBuildFilterExpr;
window.odataFormatFilterValue = odataFormatFilterValue;
window.odataParseUrl = odataParseUrl;

export function init() {
  odataRenderFilterRows();
  odataRenderExpandPaths();
  odataRenderHistory();
}
