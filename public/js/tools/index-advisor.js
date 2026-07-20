// =========================================================================
// INDEX ADVISOR (Live DB — Wave 6, Release 2) · prefix `ixa`
// =========================================================================
// A tab of Query Intelligence that reads PostgreSQL's own catalogs through the
// Observability Bridge (POST /livedb/indexes) and renders the findings that
// server/livedb.js produced. All analysis lives on the server side in pure,
// unit-tested functions — this file only renders.
//
// Live DB is PROGRESSIVE ENHANCEMENT. Without a connection this tab explains
// what a connection would unlock and what to do instead; nothing else in Query
// Intelligence depends on it.
//
// The one thing worth understanding before reading the render code: findings
// come in two flavours. `structural: true` findings (duplicate / redundant /
// invalid indexes) are read off the catalog shape and are true on any database.
// The rest depend on usage counters, which are meaningless on a freshly
// restored copy — so they arrive with a confidence verdict that the UI shows
// *above* the list rather than burying it in a tooltip.
// =========================================================================

const AGENT_URL = 'http://localhost:9999';

let ixaLast = null;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SEVERITY = {
  high:   ['var(--danger)',  'var(--danger-subtle)',  'High'],
  medium: ['var(--warning)', 'var(--warning-subtle)', 'Medium'],
  info:   ['var(--info)',    'var(--info-subtle)',    'Info']
};

const KIND_LABEL = {
  'duplicate-index': 'Duplicate index',
  'redundant-index': 'Redundant index',
  'invalid-index': 'Invalid index',
  'unused-index': 'Never scanned',
  'seq-scan-heavy': 'Sequential scans'
};

// The confidence banner. On a cold database this is the most important thing on
// the screen — it is the difference between "your schema is clean" and "we
// cannot tell yet", and those must never look alike.
function ixaStatsBanner(stats) {
  const map = {
    ok:   ['var(--success)', 'var(--success-subtle)', 'Statistics look usable'],
    low:  ['var(--warning)', 'var(--warning-subtle)', 'Statistics are thin — read usage findings as questions'],
    none: ['var(--danger)',  'var(--danger-subtle)',  'Statistics cannot support usage findings']
  };
  const [color, bg, title] = map[stats.confidence] || map.none;
  const since = stats.statsSince
    ? new Date(stats.statsSince).toLocaleString()
    : 'unknown';
  return `<div style="border-left:3px solid ${color};background:${bg};padding:var(--sp-2) var(--sp-3);border-radius:var(--r-sm);margin-bottom:var(--sp-3)">
      <div style="font-weight:600;font-size:0.82rem;color:${color};margin-bottom:2px">${esc(title)}</div>
      <div style="font-size:0.78rem;color:var(--text-secondary);line-height:1.5">${esc(stats.reason)}</div>
      <div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px;font-family:var(--font-mono)">
        counters since ${esc(since)} · ${stats.totalIdxScan} index scans · ${stats.totalSeqScan} sequential scans
      </div>
    </div>`;
}

function ixaFindingCard(f) {
  const [color, bg, label] = SEVERITY[f.severity] || SEVERITY.info;
  const evidence = (f.evidence || []).map(e =>
    `<li style="font-family:var(--font-mono);font-size:0.72rem;color:var(--text-secondary);word-break:break-all">${esc(e)}</li>`).join('');
  const verify = (f.verify || []).map(v =>
    `<li style="font-size:0.76rem;color:var(--text-secondary);margin-bottom:3px">${esc(v)}</li>`).join('');
  const mendix = f.mendixNote
    ? `<div style="margin-top:var(--sp-2);padding:var(--sp-2);background:var(--bg-sunken);border-radius:var(--r-sm);font-size:0.76rem;color:var(--text-secondary);line-height:1.5">
         <strong style="color:var(--accent)">Mendix:</strong> ${esc(f.mendixNote)}</div>`
    : '';
  // Deliberately labelled a *candidate*, never an instruction: the tool states
  // what it observed, the developer decides. Same contract as Error Decoder.
  // A per-card Copy button is what a "paste this into psql" workflow actually
  // wants — the bulk CSV/Markdown export is for the list, not for one statement.
  const candidate = f.candidate
    ? `<div style="margin-top:var(--sp-2)">
         <div style="font-size:0.68rem;text-transform:uppercase;color:var(--text-muted);margin-bottom:2px;display:flex;align-items:center;gap:var(--sp-2)">
           <span>Candidate statement — review before running</span>
           <button type="button" class="btn btn-ghost btn-xs" style="margin-left:auto;text-transform:none" onclick="window.ixaCopyCandidate(this)" data-sql="${esc(f.candidate)}">Copy</button>
         </div>
         <code style="display:block;padding:6px 8px;background:var(--bg-sunken);border-radius:var(--r-sm);font-size:0.74rem;word-break:break-all">${esc(f.candidate)}</code>
       </div>`
    : '';

  return `<div style="border:1px solid var(--border);border-left:3px solid ${color};border-radius:var(--r-md);padding:var(--sp-3);margin-bottom:var(--sp-3);background:var(--bg-elevated)">
      <div style="display:flex;align-items:center;gap:var(--sp-2);flex-wrap:wrap;margin-bottom:var(--sp-2)">
        <span style="font-size:0.68rem;font-weight:700;color:${color};background:${bg};padding:1px 8px;border-radius:999px">${label}</span>
        <span style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em">${esc(KIND_LABEL[f.kind] || f.kind)}</span>
        ${f.structural ? '<span style="font-size:0.66rem;color:var(--text-muted)" title="Read from the catalog shape — independent of usage statistics">structural</span>' : ''}
        <span style="margin-left:auto;font-size:0.72rem;color:var(--text-muted);font-family:var(--font-mono)">${esc(f.table)}</span>
      </div>
      <div style="font-weight:600;font-size:0.85rem;margin-bottom:4px">${esc(f.title)}</div>
      <div style="font-size:0.8rem;color:var(--text-secondary);line-height:1.55">${esc(f.detail)}</div>
      ${mendix}
      ${evidence ? `<div style="margin-top:var(--sp-2)"><div style="font-size:0.68rem;text-transform:uppercase;color:var(--text-muted);margin-bottom:2px">Evidence</div><ul style="margin:0;padding-left:1.1rem">${evidence}</ul></div>` : ''}
      ${verify ? `<div style="margin-top:var(--sp-2)"><div style="font-size:0.68rem;text-transform:uppercase;color:var(--text-muted);margin-bottom:2px">How to check</div><ul style="margin:0;padding-left:1.1rem">${verify}</ul></div>` : ''}
      ${candidate}
    </div>`;
}

// pg_stat_statements is optional; its absence degrades the report instead of
// failing it, and the empty state says how to turn it on (data principle).
function ixaStatementsPanel(st) {
  if (!st) return '';
  if (!st.available) {
    return `<div style="border:1px dashed var(--border);border-radius:var(--r-md);padding:var(--sp-3);margin-bottom:var(--sp-3)">
        <div style="font-weight:600;font-size:0.82rem;margin-bottom:4px">Per-query history unavailable</div>
        <div style="font-size:0.78rem;color:var(--text-secondary);line-height:1.55">${esc(st.reason || '')}</div>
        <div style="font-size:0.78rem;color:var(--text-muted);margin-top:6px">Meanwhile, Log Query Extractor reconstructs the same picture from <code>ConnectionBus_Queries</code> TRACE logs, with no extension required.</div>
      </div>`;
  }
  const rows = (st.top || []).map(q => `<tr>
      <td style="font-family:var(--font-mono);font-size:0.72rem;max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(q.query)}">${esc(q.query)}</td>
      <td style="text-align:right">${q.calls}</td>
      <td style="text-align:right">${q.meanMs}</td>
      <td style="text-align:right">${q.totalMs}</td>
    </tr>`).join('');
  return `<details style="margin-bottom:var(--sp-3);border:1px solid var(--border);border-radius:var(--r-md);padding:var(--sp-2) var(--sp-3)">
      <summary style="font-weight:600;font-size:0.82rem;cursor:pointer">Top queries by total time (pg_stat_statements)</summary>
      <div style="overflow-x:auto;margin-top:var(--sp-2)">
        <table class="data-table" style="width:100%;font-size:0.76rem">
          <thead><tr><th>Query</th><th style="text-align:right">Calls</th><th style="text-align:right">Mean ms</th><th style="text-align:right">Total ms</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </details>`;
}

function ixaRender(data) {
  const out = document.getElementById('ixa-result');
  if (!out) return;
  if (!data) { out.innerHTML = ''; return; }

  if (data.error) {
    out.innerHTML = `<div class="notice notice-warning" style="font-size:0.82rem">Index Advisor failed: ${esc(data.message || 'unknown error')}</div>`;
    return;
  }

  const s = data.summary || {};
  const chips = [
    ['Indexes inspected', s.indexCount],
    ['Tables inspected', s.tableCount],
    ['Findings', s.findingCount],
    ['Structural', s.structuralCount],
    ['Reclaimable', s.reclaimableLabel]
  ].map(([k, v]) => `<span style="font-size:0.74rem;color:var(--text-secondary)"><strong style="color:var(--text-primary)">${esc(v)}</strong> ${esc(k)}</span>`).join('');

  let body;
  if (!data.findings || !data.findings.length) {
    // Data principle: distinguish "nothing wrong" from "cannot tell".
    const cold = data.stats && data.stats.confidence === 'none';
    body = `<div style="border:1px dashed var(--border);border-radius:var(--r-md);padding:var(--sp-4);text-align:center">
        <div style="font-weight:600;margin-bottom:6px">${cold ? 'No structural problems found — usage findings withheld' : 'No index problems found'}</div>
        <div style="font-size:0.8rem;color:var(--text-secondary);line-height:1.55;max-width:60ch;margin:0 auto">${cold
          ? 'The catalog shows no duplicate, redundant or invalid indexes. Usage-based findings need a database that has actually served traffic — run this against production, or against a dev database after exercising the app.'
          : 'No duplicate, redundant, invalid or unscanned indexes, and no table dominated by sequential scans, in ' + esc(s.indexCount) + ' indexes across ' + esc(s.tableCount) + ' tables.'}</div>
      </div>`;
  } else {
    body = data.findings.map(ixaFindingCard).join('') +
      (data.truncated ? `<div style="font-size:0.76rem;color:var(--text-muted);text-align:center">Only the first ${data.findings.length} findings are shown.</div>` : '');
  }

  out.innerHTML = `
    <div style="display:flex;gap:var(--sp-3);flex-wrap:wrap;align-items:center;margin-bottom:var(--sp-3);padding-bottom:var(--sp-2);border-bottom:1px solid var(--border)">
      ${chips}
      ${data.server ? `<span style="margin-left:auto;font-size:0.72rem;color:var(--text-muted);font-family:var(--font-mono)">${esc(data.server)}</span>` : ''}
    </div>
    ${data.stats ? ixaStatsBanner(data.stats) : ''}
    ${ixaStatementsPanel(data.statements)}
    ${body}`;
}

window.ixaAnalyze = async function (btn) {
  const out = document.getElementById('ixa-result');
  if (!window.mtDb || !window.mtDb.isConnected()) {
    if (out) {
      out.innerHTML = `<div class="notice notice-warning" style="font-size:0.82rem">
        Connect a live database above to run the Index Advisor. It reads only PostgreSQL's catalogs and statistics views — no application data is touched.
      </div>`;
    }
    const bar = document.getElementById('ixa-livedb-bar');
    if (bar) bar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  const oldHtml = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = 'Analyzing…'; }
  if (out) out.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;padding:var(--sp-3)">Reading catalogs and statistics…</div>';
  try {
    const resp = await fetch(`${AGENT_URL}/livedb/indexes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(window.mtDb.getConfig())
    });
    const data = await resp.json();
    ixaLast = data;
    ixaRender(data);
  } catch (e) {
    ixaRender({ error: true, message: 'Observability Bridge not reachable on ' + AGENT_URL + '. Start it with "npm run bridge".' });
  } finally {
    if (btn && oldHtml !== null) { btn.disabled = false; btn.innerHTML = oldHtml; }
  }
};

// Export via the shared helper, so Index Advisor findings travel the same way
// as every other tool's table.
window.ixaExport = function (format) {
  if (!ixaLast || !ixaLast.findings || !ixaLast.findings.length) {
    alert('Run the advisor first — there is nothing to export yet.');
    return;
  }
  const headers = ['Severity', 'Kind', 'Table', 'Index', 'Finding', 'Detail', 'Candidate'];
  const rows = ixaLast.findings.map(f => [
    f.severity, f.kind, f.table, f.index || '', f.title, f.detail, f.candidate || ''
  ]);
  if (format === 'csv') {
    window.mtExport.downloadCsv('index-advisor-findings.csv', headers, rows);
  } else {
    window.mtExport.copyMarkdown(headers, rows, document.getElementById('ixa-export-md'));
  }
};

// One candidate statement at a time — the bulk export above is for the list.
window.ixaCopyCandidate = function (btn) {
  const sql = btn.getAttribute('data-sql');
  if (!sql || !navigator.clipboard) return;
  navigator.clipboard.writeText(sql).then(function () {
    const old = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(function () { btn.textContent = old; }, 1500);
  });
};
