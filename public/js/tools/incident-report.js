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
  { id: 'log-viewer',          label: 'Log Viewer — log entries',            fn: 'logReportSection' },
  { id: 'log-query-extractor', label: 'Log Query Extractor — SQL queries',   fn: 'lqeReportSection' },
  { id: 'microflow-tracer',    label: 'Microflow Tracer — executions',       fn: 'mftReportSection' },
  { id: 'ws-rest-extractor',   label: 'REST & WS Extractor — calls',         fn: 'wsreReportSection' },
  { id: 'nginx-log',           label: 'Nginx — HTTP requests',               fn: 'nginxReportSection' },
  { id: 'har-analyzer',        label: 'Client Traffic (HAR) — browser calls', fn: 'harReportSection' },
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
  // Anchored at both ends: "…10:00:002026-09-20 9:00" once parsed as its first
  // 19 characters and silently set the window. A trailing " UTC"/"Z" is accepted.
  const m = str.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:\s*(?:UTC|Z))?$/);
  if (!m) return NaN;
  const base = Date.parse(m[1] + 'T' + m[2] + ':' + m[3] + ':' + m[4] + 'Z');
  return base + (m[5] ? parseFloat('0.' + m[5]) * 1000 : 0);
}

// Marks the window fields (review UX-07): a malformed bound or an end before the
// start used to surface only as a toast at Generate, or not at all — a reversed
// window just produced an empty report. The mark appears when the user leaves the
// field (not at "2026-0", halfway through typing) and clears on the keystroke that
// makes it right: `clearOnly` is the as-you-type call. Returns true when usable.
function irCheckWindow(clearOnly) {
  const fromEl = document.getElementById('ir-from');
  const toEl = document.getElementById('ir-to');
  const hint = document.getElementById('ir-window-hint');
  if (!fromEl || !toEl) return true;
  const fromMs = irParseMs(fromEl.value), toMs = irParseMs(toEl.value);
  let bad = null, msg = '';
  if (Number.isNaN(fromMs)) { bad = fromEl; msg = 'Start: use YYYY-MM-DD HH:MM:SS (UTC), e.g. 2026-09-20 09:00:00, or leave it blank.'; }
  else if (Number.isNaN(toMs)) { bad = toEl; msg = 'End: use YYYY-MM-DD HH:MM:SS (UTC), e.g. 2026-09-20 10:00:00, or leave it blank.'; }
  else if (fromMs != null && toMs != null && fromMs > toMs) { bad = toEl; msg = 'The end is before the start — the report would be empty.'; }
  if (clearOnly && bad) return false;
  [fromEl, toEl].forEach(function (el) {
    el.classList.toggle('is-invalid', el === bad);
    if (el === bad) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
  });
  if (hint) { hint.textContent = msg; hint.style.display = bad ? '' : 'none'; }
  return !bad;
}

let irProbed = []; // [{ src, section|null }]

// A log tool with nothing loaded does not have to be skipped when the Data Hub holds a
// log it has not seen: the Hub carries the parsed records, so filling that source is a
// click, without leaving the report. A tool the Hub file already went into and that
// still has no section simply found nothing of its kind — offering it again would not help.
const IR_HUB_TOOLS = ['log-viewer', 'log-query-extractor', 'microflow-tracer', 'ws-rest-extractor'];
function irHubOffer(id) {
  const src = window.mtHub && window.mtHub.getSource();
  if (!src || IR_HUB_TOOLS.indexOf(id) === -1 || src.loadedIn.indexOf(id) !== -1) return null;
  return src;
}
// The window the report filled in by itself, so a new source can widen it. A window the
// user typed is theirs and stays; left as it was, the pre-filled one would cut the new
// source down to the span of whatever was loaded before it.
let irAutoWindow = null;
async function irLoadFromHub(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  try {
    await window.mtHub.loadInto(id);
  } catch (e) {
    console.error('Incident Report: loading from the Data Hub failed', e);
    window.mtToast('Could not load the Data Hub file: ' + e.message, 'error');
  }
  const fromEl = document.getElementById('ir-from'), toEl = document.getElementById('ir-to');
  if (fromEl && toEl && irAutoWindow && fromEl.value === irAutoWindow.from && toEl.value === irAutoWindow.to) {
    fromEl.value = ''; toEl.value = '';
  }
  irRefresh();
}

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
    if (p.section) {
      return '<label class="ir-source ir-source-on">'
        + '<input type="checkbox" class="ir-source-cb" value="' + p.src.id + '" checked>'
        + '<span class="ir-source-label">' + escHtml(p.src.label) + '</span>'
        + '<span class="ir-source-count" data-ir-count="' + p.src.id + '"></span>'
        + '</label>';
    }
    const hub = irHubOffer(p.src.id);
    const action = hub
      ? '<button type="button" class="btn btn-secondary btn-sm" title="' + escHtml('Load ' + hub.name + ' — already parsed — without leaving the report') + '" onclick="irLoadFromHub(\'' + p.src.id + '\', this)">Load from Data Hub</button>'
      : '<button type="button" class="btn btn-ghost btn-sm" onclick="window.navigate(\'' + p.src.id + '\', null)">Open &amp; load data</button>';
    return '<div class="ir-source ir-source-off">'
      + '<span class="ir-source-dot"></span>'
      + '<span class="ir-source-label">' + escHtml(p.src.label) + '</span>'
      + action
      + '</div>';
  }).join('');

  const fromEl = document.getElementById('ir-from');
  const toEl = document.getElementById('ir-to');
  if (fromEl && toEl && !fromEl.value && !toEl.value && minMs !== Infinity) {
    fromEl.value = irFmtInput(minMs);
    toEl.value = irFmtInput(maxMs);
    irAutoWindow = { from: fromEl.value, to: toEl.value };
  }

  irCheckWindow();
  irUpdateCounts();

  const status = document.getElementById('ir-status');
  if (status) {
    status.textContent = available.length
      ? available.length + ' source' + (available.length === 1 ? '' : 's') + ' with data ready to include.'
      : 'No diagnostics tool has data loaded yet. Load a log in the Log Viewer, Log Query Extractor, Microflow Tracer, REST & WS Extractor or Nginx analyzer, or analyze a thread dump in JVM Health — then refresh.';
  }
  const genBtn = document.getElementById('ir-generate-btn');
  if (genBtn) genBtn.disabled = available.length === 0;
}

// Row count each source contributes AT THE CURRENT WINDOW — the number that
// actually lands in the report. Without this the checklist showed the unwindowed
// total, so a narrow window silently produced a much smaller (or empty) report.
// Re-run whenever the window inputs change.
function irUpdateCounts() {
  const fromEl = document.getElementById('ir-from');
  const toEl = document.getElementById('ir-to');
  const fromMs = fromEl ? irParseMs(fromEl.value) : null;
  const toMs = toEl ? irParseMs(toEl.value) : null;
  const windowed = !isNaN(fromMs) && !isNaN(toMs) && (fromMs != null || toMs != null);

  irProbed.forEach(function (p) {
    if (!p.section) return;
    const chip = document.querySelector('[data-ir-count="' + p.src.id + '"]');
    if (!chip) return;
    const loaded = p.section.total != null ? p.section.total : (p.section.rows ? p.section.rows.length : 0);

    let inWin = loaded;
    if (windowed) {
      let sec = null;
      try { sec = window[irFn(p.src)](fromMs, toMs); } catch (e) { sec = null; }
      inWin = sec ? (sec.total != null ? sec.total : (sec.rows ? sec.rows.length : 0)) : 0;
    }

    chip.classList.toggle('ir-source-count-zero', inWin === 0);
    if (inWin === 0) chip.textContent = 'none in window — skipped';
    else if (inWin < loaded) chip.textContent = inWin + ' of ' + loaded + ' in window';
    else chip.textContent = loaded + ' row' + (loaded === 1 ? '' : 's');
  });
}

// Collect the selected sources at the chosen window, build the report and download
// it; also render an on-screen summary of what went in.
function irGenerate() {
  const fromMs = irParseMs(document.getElementById('ir-from').value);
  const toMs = irParseMs(document.getElementById('ir-to').value);
  if (!irCheckWindow()) {
    const bad = document.querySelector('#ir-from.is-invalid, #ir-to.is-invalid');
    if (bad) bad.focus();
    window.mtToast('Fix the time window first — the problem is described under the field.', 'warning');
    return;
  }

  const checked = {};
  Array.prototype.forEach.call(document.querySelectorAll('.ir-source-cb:checked'), function (cb) { checked[cb.value] = true; });

  // Sources that were selected but contribute nothing at this window are named in
  // the summary — dropping them silently made the report look arbitrarily smaller
  // than the checklist promised.
  const sections = [];
  const skipped = [];
  IR_SOURCES.forEach(function (src) {
    if (!checked[src.id]) return;
    const fn = window[irFn(src)];
    if (typeof fn !== 'function') return;
    let sec = null;
    try { sec = fn(fromMs, toMs); } catch (e) { sec = null; }
    if (sec && sec.rows && sec.rows.length) sections.push(sec);
    else skipped.push(src.label);
  });

  const summary = document.getElementById('ir-summary');
  if (!sections.length) {
    if (summary) {
      summary.style.display = 'block';
      summary.innerHTML = '<div class="edx-empty"><p style="font-weight:600;color:var(--text-primary)">Nothing to report for this selection</p>'
        + '<p>No selected source has rows inside the chosen time window: ' + escHtml(skipped.join(', ')) + '. '
        + 'Widen the window or press Clear to re-read the full span of loaded data.</p></div>';
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
      + (skipped.length ? '<div class="ir-done-meta ir-done-skipped">Skipped — no rows inside the window: ' + escHtml(skipped.join(', ')) + '</div>' : '')
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
window.irLoadFromHub = irLoadFromHub;
window.irUpdateCounts = irUpdateCounts;
window.irGenerate = irGenerate;
window.irResetWindow = irResetWindow;
window.irCheckWindow = irCheckWindow;

// navigate() calls init() on every open, so the source checklist always reflects
// the current state of the other tools.
export function init() { irRefresh(); }
