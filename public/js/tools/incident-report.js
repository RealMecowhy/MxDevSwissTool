// INCIDENT REPORT (wave 5)
// ============================================================
// Assembles ONE self-contained HTML report from whatever diagnostics tools
// currently hold data, for a chosen time window. Each source tool exposes a
// `<x>ReportSection(fromMs, toMs)` that returns a normalized section (or null
// when it has nothing), so this tool stays decoupled: it probes the sources,
// lets the user pick a window and which to include, then hands the collected
// sections to the shared report builder (window.mtBuildIncidentReport →
// mtExportToHtml). Data-driven: only sources that actually hold data are
// offered, and the report contains only sections that produced rows.

// Registry: display label + the window function each source attaches. Order is
// the order sections appear in the report.
const IR_SOURCES = [
  { id: 'log-viewer',          label: 'Log Viewer — warnings & errors',      fn: 'logReportSection' },
  { id: 'log-query-extractor', label: 'Log Query Extractor — SQL queries',   fn: 'lqeReportSection' },
  { id: 'microflow-tracer',    label: 'Microflow Tracer — executions',       fn: 'mftReportSection' },
  { id: 'ws-rest-extractor',   label: 'REST & WS Extractor — calls',         fn: 'wsreReportSection' },
  { id: 'nginx-log',           label: 'Nginx — HTTP requests',               fn: 'nginxReportSection' },
  { id: 'thread-dump',         label: 'JVM Health — thread dump',            fn: 'thread-dump-noop' }
];
// JVM uses a different (argument-less) accessor name; map it explicitly.
const IR_FN_OVERRIDE = { 'thread-dump': 'jvmReportSection' };

function irFn(src) { return IR_FN_OVERRIDE[src.id] || src.fn; }

// Probe a source with no window → the full section it currently holds, or null.
function irProbe(src) {
  const fn = window[irFn(src)];
  if (typeof fn !== 'function') return null;
  try { return fn(null, null); } catch (e) { return null; }
}

// "YYYY-MM-DD HH:MM:SS" (UTC) for the editable window inputs — no " UTC" suffix
// so the value round-trips through irParseMs.
function irFmtInput(ms) {
  if (ms == null || isNaN(ms)) return '';
  const full = window.mtFmtTs ? window.mtFmtTs(ms) : '';
  return full.replace(/ UTC$/, '');
}

// "YYYY-MM-DD HH:MM:SS" (UTC) → epoch ms; blank → null; unparseable → NaN.
function irParseMs(str) {
  str = (str || '').trim();
  if (!str) return null;
  const m = str.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!m) return NaN;
  const base = Date.parse(m[1] + 'T' + m[2] + ':' + m[3] + ':' + m[4] + 'Z');
  return base + (m[5] ? parseFloat('0.' + m[5]) * 1000 : 0);
}

let irProbed = []; // [{ src, section|null }]

// Probe every source, render the checklist, and pre-fill the window inputs from
// the combined data span (only when the user has not already typed a window).
function irRefresh() {
  irProbed = IR_SOURCES.map(function (src) { return { src: src, section: irProbe(src) }; });

  const list = document.getElementById('ir-sources');
  if (!list) return;

  const available = irProbed.filter(function (p) { return p.section; });
  let minMs = Infinity, maxMs = -Infinity;
  available.forEach(function (p) {
    if (p.section.firstMs != null && !isNaN(p.section.firstMs)) minMs = Math.min(minMs, p.section.firstMs);
    if (p.section.lastMs != null && !isNaN(p.section.lastMs)) maxMs = Math.max(maxMs, p.section.lastMs);
  });

  list.innerHTML = irProbed.map(function (p) {
    const on = !!p.section;
    const count = on ? (p.section.total != null ? p.section.total : (p.section.rows ? p.section.rows.length : 0)) : 0;
    if (on) {
      return '<label class="ir-source ir-source-on">'
        + '<input type="checkbox" class="ir-source-cb" value="' + p.src.id + '" checked>'
        + '<span class="ir-source-label">' + escHtml(p.src.label) + '</span>'
        + '<span class="ir-source-count">' + count + ' row' + (count === 1 ? '' : 's') + '</span>'
        + '</label>';
    }
    return '<div class="ir-source ir-source-off">'
      + '<span class="ir-source-dot"></span>'
      + '<span class="ir-source-label">' + escHtml(p.src.label) + '</span>'
      + '<button type="button" class="btn btn-ghost btn-sm" onclick="window.navigate(\'' + p.src.id + '\', null)">Open &amp; load data</button>'
      + '</div>';
  }).join('');

  const fromEl = document.getElementById('ir-from');
  const toEl = document.getElementById('ir-to');
  if (fromEl && toEl && !fromEl.value && !toEl.value && minMs !== Infinity) {
    fromEl.value = irFmtInput(minMs);
    toEl.value = irFmtInput(maxMs);
  }

  const status = document.getElementById('ir-status');
  if (status) {
    status.textContent = available.length
      ? available.length + ' source' + (available.length === 1 ? '' : 's') + ' with data ready to include.'
      : 'No diagnostics tool has data loaded yet. Load a log in the Log Viewer, Log Query Extractor, Microflow Tracer, REST & WS Extractor or Nginx analyzer, or analyze a thread dump in JVM Health — then refresh.';
  }
  const genBtn = document.getElementById('ir-generate-btn');
  if (genBtn) genBtn.disabled = available.length === 0;
}

// Collect the selected sources at the chosen window, build the report and download
// it; also render an on-screen summary of what went in.
function irGenerate() {
  const fromMs = irParseMs(document.getElementById('ir-from').value);
  const toMs = irParseMs(document.getElementById('ir-to').value);
  if (isNaN(fromMs) || isNaN(toMs)) {
    alert('Time window must be blank or "YYYY-MM-DD HH:MM:SS" (UTC). Leave a field empty for an open-ended bound.');
    return;
  }

  const checked = {};
  Array.prototype.forEach.call(document.querySelectorAll('.ir-source-cb:checked'), function (cb) { checked[cb.value] = true; });

  const sections = [];
  IR_SOURCES.forEach(function (src) {
    if (!checked[src.id]) return;
    const fn = window[irFn(src)];
    if (typeof fn !== 'function') return;
    let sec = null;
    try { sec = fn(fromMs, toMs); } catch (e) { sec = null; }
    if (sec && sec.rows && sec.rows.length) sections.push(sec);
  });

  const summary = document.getElementById('ir-summary');
  if (!sections.length) {
    if (summary) {
      summary.style.display = 'block';
      summary.innerHTML = '<div class="edx-empty"><p style="font-weight:600;color:var(--text-primary)">Nothing to report for this selection</p>'
        + '<p>No selected source has rows inside the chosen time window. Widen the window (or clear it), or pick sources that hold data.</p></div>';
    }
    return;
  }

  const title = (document.getElementById('ir-title').value || '').trim() || 'Mendix Incident Report';
  const notes = (document.getElementById('ir-notes').value || '').trim();
  const opts = { title: title, fromMs: fromMs, toMs: toMs, notes: notes };

  const model = window.mtBuildIncidentReport(sections, opts);
  const filename = title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'incident-report';
  window.mtExport.downloadHtml(filename + '.html', model);

  if (summary) {
    summary.style.display = 'block';
    const win = (opts.fromMs != null || opts.toMs != null)
      ? escHtml((opts.fromMs != null ? window.mtFmtTs(opts.fromMs) : 'start') + ' → ' + (opts.toMs != null ? window.mtFmtTs(opts.toMs) : 'end'))
      : 'all loaded data';
    summary.innerHTML = '<div class="ir-done">'
      + '<div class="ir-done-title"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg> Report downloaded — <strong>' + escHtml(filename) + '.html</strong></div>'
      + '<div class="ir-done-meta">Window: ' + win + '</div>'
      + '<ul class="ir-done-list">' + sections.map(function (s) {
          return '<li><strong>' + escHtml(s.title) + '</strong> — ' + escHtml(s.subtitle || (s.rows.length + ' rows')) + '</li>';
        }).join('') + '</ul>'
      + '<div class="ir-done-meta">Open the file in any browser — it is fully self-contained. Review for sensitive data before sharing.</div>'
      + '</div>';
  }
}

function irResetWindow() {
  const fromEl = document.getElementById('ir-from');
  const toEl = document.getElementById('ir-to');
  if (fromEl) fromEl.value = '';
  if (toEl) toEl.value = '';
  irRefresh();
}

window.irRefresh = irRefresh;
window.irGenerate = irGenerate;
window.irResetWindow = irResetWindow;

// navigate() calls init() on every open, so the source checklist always reflects
// the current state of the other tools.
export function init() { irRefresh(); }
