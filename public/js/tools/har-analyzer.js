// MENDIX CLIENT TRAFFIC ANALYZER (HAR)
// Parses a browser HAR export and decodes the Mendix client (XAS) protocol into
// semantic operations — which microflows ran, which XPath retrieves fired, how
// often, and how much they transferred. This is what Chrome DevTools cannot show:
// 300 identical "POST /xas/" become named, grouped, countable operations.
// Everything runs locally; the HAR (which contains cookies/tokens) never leaves the browser.
// ============================================================

let harEntries = [];

function harReset() {
  harEntries = [];
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
        alert('Could not parse HAR file: ' + err.message);
      }
    }, 30);
  };
  reader.readAsText(file);
}

// Decodes a single HAR entry into a Mendix operation, or null if it is not an XAS call.
function harClassify(entry) {
  let path;
  try { path = new URL(entry.request.url).pathname; }
  catch (e) { path = entry.request.url; }

  const isXas = /\/xas\/?$/.test(path) || path.indexOf('/xas/') !== -1;
  if (!isXas) return null;

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
  return { action: action, detail: detail };
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

function harAnalyze(har) {
  if (window.hideLoader) window.hideLoader();
  const entries = (har && har.log && har.log.entries) || [];
  if (!entries.length) { alert('This HAR contains no entries.'); return; }

  harEntries = entries;

  let xasCount = 0, totalTime = 0, totalBytes = 0, xasBytes = 0, xasTime = 0;
  const groups = new Map(); // key -> {action, detail, count, total, max, bytes, xpath}
  const xasList = [];

  entries.forEach(entry => {
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
      groups.set(key, { action: op.action, detail: op.detail, count: 0, total: 0, max: 0, bytes: 0 });
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
      status: entry.response ? entry.response.status : ''
    });
  });

  const groupArr = Array.from(groups.values()).sort((a, b) => b.total - a.total);

  // ── Detections ──────────────────────────────────────────
  const detections = [];
  groupArr.forEach(g => {
    if (/retrieve/i.test(g.action) && g.count >= 5 && g.detail) {
      detections.push({ level: 'danger', text: `<strong>Possible N+1:</strong> the same retrieve (<code>${window.escHtml(g.detail.substring(0, 80))}${g.detail.length > 80 ? '…' : ''}</code>) fired <strong>${g.count}×</strong>. Consider fetching over an association or in one batch.` });
    } else if (/executeaction|execute/i.test(g.action) && g.count >= 10 && g.detail) {
      detections.push({ level: 'warn', text: `<strong>Chatty microflow:</strong> <code>${window.escHtml(g.detail)}</code> was invoked <strong>${g.count}×</strong> in this session.` });
    }
  });
  const bigResponses = xasList.filter(x => x.bytes > 1024 * 1024).sort((a, b) => b.bytes - a.bytes);
  bigResponses.slice(0, 3).forEach(x => {
    detections.push({ level: 'warn', text: `<strong>Large response:</strong> ${window.escHtml(x.action)}${x.detail ? ' (' + window.escHtml(x.detail.substring(0, 60)) + ')' : ''} transferred <strong>${harFormatBytes(x.bytes)}</strong>.` });
  });

  harRender({ total: entries.length, xasCount, totalTime, totalBytes, xasBytes, xasTime, groupArr, xasList, detections });
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
    tbody.innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--text-muted)">No Mendix XAS calls found in this HAR. (This capture may predate the login, or the app uses only static/OData endpoints.)</td></tr>';
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

  // Chronological list (capped)
  const CAP = 300;
  const listEl = document.getElementById('har-timeline');
  const shown = d.xasList.slice(0, CAP);
  listEl.innerHTML = shown.map(x => {
    const time = x.started ? x.started.split('T')[1] || x.started : '';
    return `<div style="display:grid;grid-template-columns:90px 140px 1fr 70px 80px;gap:8px;padding:3px 8px;border-bottom:1px solid var(--border-subtle);font-size:0.75rem">
      <span style="color:var(--text-muted)">${window.escHtml((time || '').substring(0, 12))}</span>
      <span style="color:var(--accent);font-family:var(--font-mono)">${window.escHtml(x.action)}</span>
      <span style="font-family:var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${window.escHtml(x.detail)}">${window.escHtml(x.detail || '')}</span>
      <span style="text-align:right">${x.time.toFixed(0)} ms</span>
      <span style="text-align:right;color:var(--text-muted)">${harFormatBytes(x.bytes)}</span>
    </div>`;
  }).join('');
  document.getElementById('har-timeline-note').textContent =
    d.xasList.length > CAP ? `Showing first ${CAP} of ${d.xasList.length} XAS calls (chronological)` : `${d.xasList.length} XAS calls (chronological)`;
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

// --- ESM EXPORTS ---
window.harLoadFile = harLoadFile;
window.harHandleDrop = harHandleDrop;
window.harReset = harReset;
window.harShowXpath = harShowXpath;
window.harCloseXpathModal = harCloseXpathModal;
window.harCopyXpath = harCopyXpath;
window.harOpenXpathInFormatter = harOpenXpathInFormatter;

export function init() {}
