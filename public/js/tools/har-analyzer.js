// MENDIX CLIENT TRAFFIC ANALYZER (HAR)
// Parses a browser HAR export and decodes the Mendix client (XAS) protocol into
// semantic operations — which microflows ran, which XPath retrieves fired, how
// often, and how much they transferred. This is what Chrome DevTools cannot show:
// 300 identical "POST /xas/" become named, grouped, countable operations.
// Everything runs locally; the HAR (which contains cookies/tokens) never leaves the browser.
// ============================================================

let harEntries = [];
let harLastCalls = [];   // the decoded Mendix calls of the current HAR, for the Incident Report

function harReset() {
  harEntries = [];
  harLastCalls = [];
  document.getElementById('har-results').style.display = 'none';
  document.getElementById('har-empty').style.display = 'flex';
  const input = document.getElementById('har-file-input');
  if (input) input.value = '';
}

function harHandleDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  if (e.dataTransfer.files && e.dataTransfer.files.length) harLoadFile(e.dataTransfer.files);
}

function harLoadFile(files) {
  if (!files || !files.length) return;
  const file = files[0];
  const reader = new FileReader();
  if (window.showLoader) window.showLoader('Parsing HAR...');
  reader.onload = e => {
    setTimeout(() => {
      try {
        const har = JSON.parse(e.target.result);
        harAnalyze(har);
      } catch (err) {
        if (window.hideLoader) window.hideLoader();
        window.mtToast('Could not parse HAR file: ' + err.message, 'error');
      }
    }, 30);
  };
  reader.readAsText(file);
}

// Collapses identifier segments so repeated calls to the same resource land in one
// group. Without it `/rest/orders/v1/orders/1`, `/2`, `/3` … produce N groups of
// one, which hides the very N+1 pattern this tool exists to surface.
// Handles both REST path ids and the OData key predicate `Orders(guid'…')`.
const HAR_GUID_SEG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function harApiTemplate(path) {
  return path.split('/').map(seg => {
    if (!seg) return seg;
    const key = seg.indexOf('(');
    if (key > 0) return seg.substring(0, key) + '({id})';
    if (/^\d+$/.test(seg) || HAR_GUID_SEG.test(seg)) return '{id}';
    return seg;
  }).join('/');
}

// Decodes a single HAR entry into a Mendix operation, or null if it is not one.
// Three protocols count as Mendix traffic:
//   /xas/    — the client protocol, operation is inside the JSON body
//   /rest/   — a published REST service; the operation IS the method + path
//   /odata/  — a published OData service; same, plus key predicates
// Modern Mendix apps serve React/native clients and integrations over the latter
// two, so recognising only /xas/ made the tool blind to half the capture and told
// the user their HAR was empty.
function harClassify(entry) {
  let path;
  try { path = new URL(entry.request.url).pathname; }
  catch (e) { path = entry.request.url; }

  const isXas = /\/xas\/?$/.test(path) || path.indexOf('/xas/') !== -1;
  if (!isXas) {
    const method = String(entry.request.method || 'GET').toUpperCase();
    if (path.indexOf('/rest/') !== -1) {
      return { action: 'REST ' + method, detail: harApiTemplate(path), read: method === 'GET' };
    }
    if (path.indexOf('/odata/') !== -1) {
      return { action: 'OData ' + method, detail: harApiTemplate(path), read: method === 'GET' };
    }
    return null;
  }

  let action = 'xas';
  let detail = '';
  const body = entry.request.postData && entry.request.postData.text;
  if (body) {
    try {
      const json = JSON.parse(body);
      action = json.action || json.operation || 'xas';
      const p = json.params || json.parameters || json;
      if (/executeaction|execute/i.test(action)) {
        detail = p.actionname || p.action || p.microflow || '';
      } else if (/retrieve/i.test(action)) {
        detail = p.xpath || (p.schema && p.schema.id) || (p.query && p.query.xpath) || '';
      } else if (/change|commit/i.test(action)) {
        const objs = p.objects || p.changes;
        if (Array.isArray(objs)) detail = objs.length + ' object(s)';
      }
    } catch (e) { /* non-JSON body → group as generic xas */ }
  }
  return { action: action, detail: detail, read: /retrieve/i.test(action) };
}

function harBytes(entry) {
  const r = entry.response || {};
  if (r._transferSize && r._transferSize > 0) return r._transferSize;
  if (r.content && r.content.size > 0) return r.content.size;
  if (r.bodySize && r.bodySize > 0) return r.bodySize;
  return 0;
}

function harFormatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(2) + ' MB';
}

// Flags runs of 2+ back-to-back identical XAS calls (same action+detail, strictly
// adjacent in the chronological xasList — not just "same group somewhere in the
// capture", which is what the N+1 detector above already covers). This catches the
// narrower "widget fired the same call twice in a row" symptom that N+1's count>=5
// threshold misses. Pure function of the already-built xasList (needs `startMs`).
function harDetectDuplicates(xasList) {
  const runs = [];
  let i = 0;
  while (i < xasList.length) {
    let j = i;
    while (j + 1 < xasList.length && xasList[j + 1].action === xasList[i].action && xasList[j + 1].detail === xasList[i].detail) j++;
    const count = j - i + 1;
    if (count >= 2) {
      let wastedMs = 0;
      for (let k = i + 1; k <= j; k++) wastedMs += xasList[k].time;
      runs.push({
        firstIndex: i,
        count: count,
        action: xasList[i].action,
        detail: xasList[i].detail,
        spanMs: xasList[j].startMs - xasList[i].startMs,
        wastedMs: wastedMs
      });
    }
    i = j + 1;
  }
  return runs;
}

// Buckets the chronological xasList by HAR page (entry.pageref / har.log.pages),
// preserving first-appearance order. Falls back to a single unlabeled group when
// the HAR carries no `pages` array (older exports, synthetic fixtures) — callers
// treat a lone group with title=null as "don't show page headers".
function harGroupByPage(xasList, pages) {
  const pageMeta = new Map();
  (pages || []).forEach(p => pageMeta.set(p.id, p.title || p.id));
  const order = [];
  const buckets = new Map();
  xasList.forEach(item => {
    const pid = item.pageref || '__none__';
    if (!buckets.has(pid)) { buckets.set(pid, []); order.push(pid); }
    buckets.get(pid).push(item);
  });
  return order.map(pid => ({
    pageId: pid,
    title: pageMeta.has(pid) ? pageMeta.get(pid) : null,
    items: buckets.get(pid)
  }));
}

// Decodes HAR response content, handling the base64 encoding Chrome/Firefox use
// for binary or non-UTF8-safe bodies. Uses TextDecoder over real bytes (like
// encBytesToBase64/encBase64ToBytes in encoder.js) instead of the escape/unescape
// textual trick, which mangles genuinely binary or multi-byte UTF-8 content.
function harContentText(content) {
  if (!content || !content.text) return '';
  if (content.encoding === 'base64') {
    try {
      const bin = atob(content.text);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) { return content.text; }
  }
  return content.text;
}

function harAnalyze(har) {
  if (window.hideLoader) window.hideLoader();
  const entries = (har && har.log && har.log.entries) || [];
  if (!entries.length) { window.mtToast('This HAR contains no entries.', 'warning'); return; }

  harEntries = entries;

  let xasCount = 0, totalTime = 0, totalBytes = 0, xasBytes = 0, xasTime = 0;
  const groups = new Map(); // key -> {action, detail, count, total, max, bytes, xpath}
  const xasList = [];

  entries.forEach((entry, idx) => {
    totalTime += entry.time || 0;
    totalBytes += harBytes(entry);
    const op = harClassify(entry);
    if (!op) return;
    xasCount++;
    const t = entry.time || 0;
    const bytes = harBytes(entry);
    xasTime += t;
    xasBytes += bytes;

    const key = op.action + '||' + op.detail;
    if (!groups.has(key)) {
      groups.set(key, { action: op.action, detail: op.detail, read: op.read, count: 0, total: 0, max: 0, bytes: 0 });
    }
    const g = groups.get(key);
    g.count++;
    g.total += t;
    g.max = Math.max(g.max, t);
    g.bytes += bytes;

    xasList.push({
      started: entry.startedDateTime,
      action: op.action,
      detail: op.detail,
      time: t,
      bytes: bytes,
      status: entry.response ? entry.response.status : '',
      entryIndex: idx,
      pageref: entry.pageref || null
    });
  });

  // Relative offsets for the waterfall — origin is the first XAS call, not the
  // first HAR entry, so the bars use the resolution that matters for this tool.
  const origin = xasList.length ? Date.parse(xasList[0].started) || 0 : 0;
  xasList.forEach(x => { x.startMs = (Date.parse(x.started) || origin) - origin; });

  const groupArr = Array.from(groups.values()).sort((a, b) => b.total - a.total);

  // ── Detections ──────────────────────────────────────────
  const detections = [];
  groupArr.forEach(g => {
    if (g.read && g.count >= 5 && g.detail) {
      // A repeated read is the same pathology whichever protocol carries it, but
      // the remedy differs: an XAS retrieve is fixed in the domain model, a
      // published REST/OData read is fixed by the caller batching its requests.
      const isApi = /^(REST|OData) /.test(g.action);
      const what = isApi ? 'the same endpoint' : 'the same retrieve';
      const fix = isApi
        ? 'Consider requesting the collection once instead of one call per record.'
        : 'Consider fetching over an association or in one batch.';
      detections.push({ level: 'danger', text: `<strong>Possible N+1:</strong> ${what} (<code>${window.escHtml(g.detail.substring(0, 80))}${g.detail.length > 80 ? '…' : ''}</code>) fired <strong>${g.count}×</strong>. ${fix}` });
    } else if (/executeaction|execute/i.test(g.action) && g.count >= 10 && g.detail) {
      detections.push({ level: 'warn', text: `<strong>Chatty microflow:</strong> <code>${window.escHtml(g.detail)}</code> was invoked <strong>${g.count}×</strong> in this session.` });
    }
  });
  const bigResponses = xasList.filter(x => x.bytes > 1024 * 1024).sort((a, b) => b.bytes - a.bytes);
  bigResponses.slice(0, 3).forEach(x => {
    detections.push({ level: 'warn', text: `<strong>Large response:</strong> ${window.escHtml(x.action)}${x.detail ? ' (' + window.escHtml(x.detail.substring(0, 60)) + ')' : ''} transferred <strong>${harFormatBytes(x.bytes)}</strong>.` });
  });
  const dupRuns = harDetectDuplicates(xasList);
  dupRuns.forEach(d => {
    detections.push({ level: 'warn', text: `<strong>Duplicate calls:</strong> ${window.escHtml(d.action)}${d.detail ? ' (' + window.escHtml(d.detail.substring(0, 60)) + (d.detail.length > 60 ? '…' : '') + ')' : ''} fired <strong>${d.count}×</strong> back-to-back (${d.spanMs.toFixed(0)} ms span, ${d.wastedMs.toFixed(0)} ms in the repeats). Check for a widget re-render loop or duplicate event binding.` });
  });

  const pageGroups = harGroupByPage(xasList, (har.log && har.log.pages) || []);
  harLastCalls = xasList;

  harRender({ total: entries.length, xasCount, totalTime, totalBytes, xasBytes, xasTime, groupArr, xasList, detections, pageGroups });
}

function harRender(d) {
  document.getElementById('har-empty').style.display = 'none';
  document.getElementById('har-results').style.display = 'flex';

  // Stat cards
  document.getElementById('har-stat-total').textContent = d.total.toLocaleString();
  document.getElementById('har-stat-xas').textContent = d.xasCount.toLocaleString();
  document.getElementById('har-stat-time').textContent = (d.xasTime / 1000).toFixed(1) + ' s';
  document.getElementById('har-stat-bytes').textContent = harFormatBytes(d.xasBytes);

  // Detections
  const detEl = document.getElementById('har-detections');
  if (d.detections.length) {
    detEl.style.display = 'block';
    detEl.innerHTML = d.detections.map(dt =>
      `<div class="notice notice-${dt.level === 'danger' ? 'danger' : 'warning'}" style="margin-bottom:var(--sp-2)">${dt.text}</div>`
    ).join('');
  } else {
    detEl.style.display = 'block';
    detEl.innerHTML = '<div class="notice notice-success">No N+1 patterns or oversized responses detected in the Mendix client traffic.</div>';
  }

  // Aggregation table
  const tbody = document.getElementById('har-agg-body');
  if (!d.groupArr.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--text-muted)">No Mendix calls found in this HAR. This tool recognises the client protocol (<code>/xas/</code>) plus published <code>/rest/</code> and <code>/odata/</code> services — a capture holding only static files, or one recorded before the app loaded, has none of them.</td></tr>';
  } else {
    tbody.innerHTML = d.groupArr.map(g => {
      const isRetrieve = /retrieve/i.test(g.action) && g.detail;
      const detailCell = g.detail
        ? `<span style="font-family:var(--font-mono);font-size:0.78rem">${window.escHtml(g.detail.substring(0, 90))}${g.detail.length > 90 ? '…' : ''}</span>${isRetrieve ? ` <button class="btn btn-ghost btn-sm" style="padding:0 4px" title="Preview the full XPath query (copy it or open it in the XPath Formatter)" onclick="harShowXpath(this)" data-xpath="${window.escHtml(g.detail)}">XPath</button>` : ''}`
        : '<span style="color:var(--text-muted)">—</span>';
      return `<tr style="border-top:1px solid var(--border)">
        <td style="padding:6px 10px;font-family:var(--font-mono);color:var(--accent)">${window.escHtml(g.action)}</td>
        <td style="padding:6px 10px">${detailCell}</td>
        <td style="padding:6px 10px;text-align:right;font-weight:600;${g.count >= 5 ? 'color:var(--warning)' : ''}">${g.count}</td>
        <td style="padding:6px 10px;text-align:right">${g.total.toFixed(0)} ms</td>
        <td style="padding:6px 10px;text-align:right">${(g.total / g.count).toFixed(0)} ms</td>
        <td style="padding:6px 10px;text-align:right">${harFormatBytes(g.bytes)}</td>
      </tr>`;
    }).join('');
  }

  // Chronological waterfall (capped, grouped by HAR page when the export has one).
  // Each row doubles as: a timing bar (waterfall), a duplicate-run marker, and a
  // click target that opens the full request/response body (#har-detail-modal).
  const CAP = 300;
  const listEl = document.getElementById('har-timeline');
  d.xasList.forEach((x, i) => { x.listIndex = i; });
  const totalSpan = Math.max(1, ...d.xasList.map(x => x.startMs + x.time));
  const dupMap = new Map();
  harDetectDuplicates(d.xasList).forEach(r => {
    for (let k = r.firstIndex; k < r.firstIndex + r.count; k++) dupMap.set(k, { count: r.count, isFirst: k === r.firstIndex });
  });
  const showPageHeaders = d.pageGroups.length > 1 || (d.pageGroups.length === 1 && d.pageGroups[0].title);
  let shown = 0;
  const rowsHtml = [];
  for (const group of d.pageGroups) {
    if (shown >= CAP) break;
    if (showPageHeaders) rowsHtml.push(`<div class="har-wf-page-header">Page: ${window.escHtml(group.title || group.pageId)}</div>`);
    for (const x of group.items) {
      if (shown >= CAP) break;
      shown++;
      const time = x.started ? x.started.split('T')[1] || x.started : '';
      const dup = dupMap.get(x.listIndex);
      const dupBadge = dup && dup.isFirst ? `<span style="color:var(--warning);font-weight:700;margin-right:4px" title="${dup.count} identical calls fired back-to-back">dup×${dup.count}</span>` : '';
      const leftPct = (x.startMs / totalSpan * 100).toFixed(2);
      const widthPct = Math.max(x.time / totalSpan * 100, 0.4).toFixed(2);
      rowsHtml.push(`<div class="har-row${dup ? ' har-row-dup' : ''}" style="display:grid;grid-template-columns:70px 110px 1fr 140px 55px 65px;gap:8px;padding:3px 8px;border-bottom:1px solid var(--border-subtle);font-size:0.75rem;align-items:center" onclick="harShowDetail(${x.entryIndex})" title="Click to view request/response body">
        <span style="color:var(--text-muted)">${window.escHtml((time || '').substring(0, 12))}</span>
        <span style="color:var(--accent);font-family:var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${dupBadge}${window.escHtml(x.action)}</span>
        <span style="font-family:var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${window.escHtml(x.detail)}">${window.escHtml(x.detail || '')}</span>
        <span class="har-wf-track" title="${x.time.toFixed(0)} ms, started +${x.startMs.toFixed(0)} ms"><span class="har-wf-bar" style="left:${leftPct}%;width:${widthPct}%;background:${harBarColor(x.action)}"></span></span>
        <span style="text-align:right">${x.time.toFixed(0)} ms</span>
        <span style="text-align:right;color:var(--text-muted)">${harFormatBytes(x.bytes)}</span>
      </div>`);
    }
  }
  listEl.innerHTML = rowsHtml.join('');
  document.getElementById('har-timeline-note').textContent =
    d.xasList.length > CAP ? `Showing first ${CAP} of ${d.xasList.length} Mendix calls (chronological, click a row for details)` : `${d.xasList.length} Mendix calls (chronological, click a row for details)`;
}

function harBarColor(action) {
  if (/retrieve/i.test(action)) return 'var(--info)';
  if (/executeaction|execute/i.test(action)) return 'var(--accent)';
  if (/change|commit/i.test(action)) return 'var(--success)';
  return 'var(--text-muted)';
}

let harCurrentDetail = null;

function harPretty(text) {
  if (!text) return '';
  const t = text.trim();
  if (t[0] === '{' || t[0] === '[') {
    try { return JSON.stringify(JSON.parse(t), null, 2); } catch (e) { return text; }
  }
  if (t[0] === '<' && typeof DOMParser !== 'undefined' && window.serializeXmlPretty) {
    try {
      const doc = new DOMParser().parseFromString(t, 'application/xml');
      if (!doc.querySelector('parsererror')) return window.serializeXmlPretty(doc.documentElement, 0);
    } catch (e) { /* keep raw */ }
  }
  return text;
}

// Reuses the JSON Formatter's and XML Formatter's own highlighters (already
// exposed on window for exactly this kind of reuse — see WSRE's wsreHighlightBody,
// which does the same thing for REST call bodies) instead of growing a third
// copy of JSON/XML pretty-printing in this tool.
function harHighlightBody(text) {
  const pretty = harPretty(text);
  const t = pretty.trim();
  if ((t[0] === '{' || t[0] === '[') && window.highlightJsonSimple) {
    try { JSON.parse(t); return { html: window.highlightJsonSimple(pretty), isXml: false }; } catch (e) { /* fall through */ }
  }
  if (t[0] === '<' && typeof DOMParser !== 'undefined' && window.renderXmlTree) {
    try {
      const doc = new DOMParser().parseFromString(t, 'application/xml');
      if (!doc.querySelector('parsererror')) return { html: window.renderXmlTree(doc.documentElement, 0), isXml: true };
    } catch (e) { /* fall through */ }
  }
  return { html: window.escHtml ? window.escHtml(pretty) : pretty, isXml: false };
}

// xml.js's own toggle binder is hardcoded to its #xml-tree-output container (same
// constraint WSRE hit — see wsreBindXmlToggles there), so a body rendered into this
// modal needs its own scoped collapse/expand wiring.
function harBindXmlToggles(container) {
  if (!container) return;
  container.querySelectorAll('.jt-collapse').forEach(el => {
    el.onclick = function () {
      const target = document.getElementById(this.dataset.target);
      const placeholder = document.getElementById(this.dataset.target + '-placeholder');
      if (!target) return;
      const collapsed = target.style.display === 'none';
      target.style.display = collapsed ? '' : 'none';
      if (placeholder) placeholder.style.display = collapsed ? 'none' : 'inline';
      this.textContent = collapsed ? '▼' : '▶';
    };
  });
}

function harRenderBody(elId, text, emptyMsg) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!text) { el.innerHTML = `<span style="color:var(--text-muted)">${window.escHtml(emptyMsg)}</span>`; return; }
  const r = harHighlightBody(text);
  el.innerHTML = r.html;
  if (r.isXml) harBindXmlToggles(el);
}

// Opens the per-call detail modal: full request/response body, prettified. This is
// the "response body is not shown" gap from the audit — everything else in this
// tool only ever showed aggregated counts/durations.
function harShowDetail(entryIndex) {
  const entry = harEntries[entryIndex];
  if (!entry) return;
  const op = harClassify(entry) || { action: 'xas', detail: '' };
  const reqBody = entry.request && entry.request.postData ? entry.request.postData.text : '';
  const resBody = harContentText(entry.response && entry.response.content);
  harCurrentDetail = { reqBody, resBody };
  document.getElementById('har-detail-title').textContent = op.action + (op.detail ? ' — ' + op.detail.substring(0, 100) : '');
  document.getElementById('har-detail-meta').textContent =
    `${entry.startedDateTime || ''} · ${(entry.time || 0).toFixed(0)} ms · status ${entry.response ? entry.response.status : '—'} · ${harFormatBytes(harBytes(entry))}`;
  harRenderBody('har-detail-request', reqBody, 'No request body.');
  harRenderBody('har-detail-response', resBody, 'No response body captured (the HAR may have been saved without response content, or the body was empty).');
  document.getElementById('har-detail-modal').classList.add('active');
}

function harCloseDetailModal() {
  document.getElementById('har-detail-modal').classList.remove('active');
}

function harCopyDetailBody(which, btn) {
  if (!harCurrentDetail) return;
  const text = which === 'request' ? harCurrentDetail.reqBody : harCurrentDetail.resBody;
  if (!text) return;
  window.copyToClipboard(text);
  const oldHtml = btn.innerHTML;
  btn.innerHTML = 'Copied!';
  setTimeout(() => btn.innerHTML = oldHtml, 2000);
}

// In-place preview modal: shows the full XPath without leaving the HAR analysis
function harShowXpath(btn) {
  const xpath = btn.getAttribute('data-xpath');
  if (!xpath) return;
  window._harCurrentXpath = xpath;
  document.getElementById('har-xpath-content').textContent = xpath;
  document.getElementById('har-xpath-modal').classList.add('active');
}

function harCloseXpathModal() {
  document.getElementById('har-xpath-modal').classList.remove('active');
}

function harCopyXpath(btn) {
  if (!window._harCurrentXpath) return;
  navigator.clipboard.writeText(window._harCurrentXpath).then(() => {
    const oldHtml = btn.innerHTML;
    btn.innerHTML = 'Copied!';
    setTimeout(() => btn.innerHTML = oldHtml, 2000);
  });
}

function harOpenXpathInFormatter() {
  const xpath = window._harCurrentXpath;
  if (!xpath) return;
  harCloseXpathModal();
  window.navigateWithReturn('xpath-builder');
  const input = document.getElementById('xpath-input');
  if (input) {
    input.value = xpath;
    if (window.xpathAnalyze) window.xpathAnalyze();
    if (window.formatXPathClick) window.formatXPathClick();
  }
}

// Incident Report source: the Mendix calls decoded from the loaded HAR, narrowed
// to [fromMs, toMs]. This is the client half of an incident — until now every
// section of the report stopped at the server boundary, even though the browser
// timings were sitting right here, already decoded.
//
// Note on time: `x.startMs` is an offset relative to the first Mendix call (the
// waterfall's own origin), not an epoch — the report needs absolute time to line
// up with the log tools, so it is resolved from `x.started` here.
window.harReportSection = function (fromMs, toMs) {
  if (!harLastCalls.length) return null;
  let firstMs = Infinity, lastMs = -Infinity;
  const rows = [];
  harLastCalls.forEach(function (x) {
    const ms = Date.parse(x.started);
    if (!isNaN(ms)) {
      if (fromMs != null && ms < fromMs) return;
      if (toMs != null && ms > toMs) return;
      if (ms < firstMs) firstMs = ms;
      if (ms > lastMs) lastMs = ms;
    }
    rows.push([
      x.started || '',
      x.action || '',
      x.detail || '',
      x.time != null ? +x.time.toFixed(1) : '',
      x.bytes != null ? x.bytes : '',
      x.status !== undefined && x.status !== null ? x.status : ''
    ]);
  });
  if (!rows.length) return null;
  return {
    id: 'har-analyzer',
    title: 'Client Traffic (HAR) — browser calls',
    subtitle: rows.length + ' Mendix call' + (rows.length === 1 ? '' : 's') + ' decoded from the browser capture',
    columns: ['Started', 'Action', 'Detail', 'Duration (ms)', 'Bytes', 'Status'],
    rows: rows, total: rows.length,
    firstMs: firstMs === Infinity ? null : firstMs,
    lastMs: lastMs === -Infinity ? null : lastMs
  };
};

// --- ESM EXPORTS ---
window.harLoadFile = harLoadFile;
window.harHandleDrop = harHandleDrop;
window.harReset = harReset;
window.harShowXpath = harShowXpath;
window.harCloseXpathModal = harCloseXpathModal;
window.harCopyXpath = harCopyXpath;
window.harOpenXpathInFormatter = harOpenXpathInFormatter;
window.harShowDetail = harShowDetail;
window.harCloseDetailModal = harCloseDetailModal;
window.harCopyDetailBody = harCopyDetailBody;

// Exposed for scripts/parser-test.js (pure functions, no DOM).
window.harDetectDuplicates = harDetectDuplicates;
window.harGroupByPage = harGroupByPage;
window.harContentText = harContentText;
window.harClassify = harClassify;
window.harApiTemplate = harApiTemplate;
window.harBarColor = harBarColor;

export function init() {}
