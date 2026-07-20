// DATA HUB v0 — one loaded file, shared across the log tools
// ============================================================
// Every log tool used to be an island: the same 60 MB log had to be dropped
// into the Log Viewer, then again into the Query Extractor, then again into the
// Microflow Tracer. Point-to-point cross-links (mftLoadText / lqeLoadText …)
// covered a few of those hops; the Hub generalizes them.
//
// It holds ONE active source — the file most recently parsed by any log tool —
// and renders a bar saying what is loaded plus an "Open in…" button per tool
// that can consume it. The raw text is already in memory (the tools keep it for
// their own re-parsing), so handing it over costs a function call, not a re-read.
//
// Data-driven principle: with nothing loaded the bar renders NOTHING (no empty
// shell, no placeholder counts) — mounts stay collapsed until a file arrives.
//
// Pure builders (mtHubSummary / mtHubTargets) attach to window/self so they can
// be unit tested in Node; everything touching the DOM is browser-only.

(function (root) {
  'use strict';

  // Tools that can consume a raw Mendix log, in sidebar order. `fn` is the
  // global entry point each one already exposes for cross-tool hand-off.
  // `hasData` is an optional global predicate ("does this tool currently show
  // something?") used to warn before a hand-off silently replaces it.
  var HUB_TARGETS = [
    { id: 'log-viewer',          label: 'Log Viewer',           fn: 'logLoadText', hasData: 'logHasData' },
    { id: 'log-query-extractor', label: 'Query Extractor',      fn: 'lqeLoadText', hasData: 'lqeHasData' },
    { id: 'microflow-tracer',    label: 'Microflow Tracer',     fn: 'mftLoadText', hasData: 'mftHasData' },
    { id: 'ws-rest-extractor',   label: 'REST & WS Extractor',  fn: 'wsreLoadText', hasData: 'wsreHasData' }
  ];

  var FORMAT_LABELS = {
    csv:  'Studio Pro CSV export',
    live: 'Mendix Cloud live log'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatBytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatCount(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
    return n.toLocaleString('en-US');
  }

  // Describes the active source for the bar. Returns null when there is nothing
  // to describe — callers render nothing rather than an empty shell.
  function mtHubSummary(source) {
    if (!source || !source.name) return null;
    var sizeText = formatBytes(source.size);
    var recordsText = typeof source.records === 'number' && source.records >= 0
      ? formatCount(source.records) + ' record' + (source.records === 1 ? '' : 's')
      : '';
    var formatText = FORMAT_LABELS[source.format] || '';
    // A batch of files (Log Viewer accepts several) is reported honestly: the
    // Hub carries one file, so the others are named as staying where they are.
    var siblings = typeof source.siblings === 'number' && source.siblings > 0
      ? source.siblings : 0;
    var parts = [source.name];
    if (sizeText) parts.push(sizeText);
    if (recordsText) parts.push(recordsText);
    if (formatText) parts.push(formatText);
    return {
      name: source.name,
      sizeText: sizeText,
      recordsText: recordsText,
      formatText: formatText,
      siblings: siblings,
      line: 'Loaded: ' + parts.join(' · ')
    };
  }

  // Which tools this source can still be pushed into. The tool that parsed it —
  // and any tool it was already pushed into — is reported as `loaded`, so the
  // bar can show "✓ here" instead of offering a pointless round trip.
  function mtHubTargets(source, currentToolId) {
    if (!source || !source.name) return [];
    var loadedIn = source.loadedIn || [];
    return HUB_TARGETS.map(function (t) {
      return {
        id: t.id,
        label: t.label,
        fn: t.fn,
        current: t.id === currentToolId,
        loaded: loadedIn.indexOf(t.id) !== -1
      };
    });
  }

  root.mtHubSummary = mtHubSummary;
  root.mtHubTargets = mtHubTargets;
  root.mtHubFormatBytes = formatBytes;

  // ── Browser-only state, mounts and rendering ──────────────────────────────
  if (typeof document === 'undefined') return;

  var source = null;              // the one active source, or null
  var mounts = new Set();
  var listeners = new Set();

  function render(el) {
    var summary = mtHubSummary(source);
    // Data-driven: nothing loaded → nothing rendered.
    if (!summary) { el.innerHTML = ''; el.style.display = 'none'; return; }
    el.style.display = '';

    var toolId = el.getAttribute('data-mt-hub') || root.currentTool || '';
    var targets = mtHubTargets(source, toolId);
    var buttons = targets.map(function (t) {
      if (t.current) {
        return '<span style="font-size:0.7rem;color:var(--text-muted);white-space:nowrap">✓ here</span>';
      }
      return '<button class="btn btn-secondary btn-xs" data-hub-open="' + esc(t.id) + '"' +
        (t.loaded ? ' title="Already loaded there — click to re-parse the same file"' : '') +
        '>' + (t.loaded ? '✓ ' : '') + esc(t.label) + '</button>';
    }).join('');

    var more = summary.siblings
      ? '<span style="font-size:0.7rem;color:var(--text-muted)"> (+' + summary.siblings +
        ' more file' + (summary.siblings === 1 ? '' : 's') + ' in the Log Viewer — only this one is shared)</span>'
      : '';

    el.innerHTML =
      '<div style="display:flex;align-items:center;gap:var(--sp-2);flex-wrap:wrap;' +
      'border:1px solid var(--border);border-radius:var(--r-md);padding:var(--sp-2) var(--sp-3);' +
      'background:var(--bg-elevated)">' +
        '<span style="font-size:0.78rem;color:var(--text-secondary);font-family:var(--font-mono);' +
        'word-break:break-all"><b style="font-family:var(--font-sans)">' + esc(summary.line) + '</b></span>' + more +
        '<span style="margin-left:auto;display:flex;align-items:center;gap:var(--sp-2);flex-wrap:wrap">' +
          '<span style="font-size:0.7rem;color:var(--text-muted)">Open in…</span>' + buttons +
          '<button class="btn btn-ghost btn-xs" data-hub-clear title="Forget this file (does not clear the tools)">×</button>' +
        '</span>' +
      '</div>';

    el.querySelectorAll('[data-hub-open]').forEach(function (btn) {
      btn.addEventListener('click', function () { mtHub.openIn(btn.getAttribute('data-hub-open')); });
    });
    var clearBtn = el.querySelector('[data-hub-clear]');
    if (clearBtn) clearBtn.addEventListener('click', function () { mtHub.clear(); });
  }

  function notify() {
    mounts.forEach(render);
    listeners.forEach(function (cb) { try { cb(source); } catch (e) {} });
  }

  var mtHub = {
    // Called by every log tool right after it parses a file. `text` is kept by
    // reference — the tools already hold it, so this adds no copy.
    setSource: function (info) {
      if (!info || !info.text) return;
      source = {
        name: info.name || 'log',
        size: typeof info.size === 'number' ? info.size : info.text.length,
        format: info.format || null,
        records: typeof info.records === 'number' ? info.records : null,
        siblings: info.siblings || 0,
        text: info.text,
        origin: info.origin || null,
        loadedIn: info.origin ? [info.origin] : [],
        loadedAt: Date.now()
      };
      notify();
    },
    // Lets a tool report a record count that only becomes known after an async
    // (worker) parse, without re-sending the text.
    updateStats: function (originId, stats) {
      if (!source || source.origin !== originId || !stats) return;
      if (typeof stats.records === 'number') source.records = stats.records;
      if (stats.format) source.format = stats.format;
      notify();
    },
    getSource: function () { return source; },
    clear: function () { source = null; notify(); },
    onChange: function (cb) { listeners.add(cb); return function () { listeners.delete(cb); }; },
    // Shared "was this a genuine user drop" publisher used by every log tool
    // right after it finishes parsing. `pending` is the {name,size} the tool
    // recorded when the user dropped/selected a file; the caller passes null
    // (or has already cleared its own pending variable) when the text instead
    // arrived via a cross-link or the Hub itself, so a hand-off never re-publishes.
    publishFromParse: function (pending, text, res, origin) {
      if (!pending || !text) return;
      mtHub.setSource({
        name: pending.name,
        size: pending.size,
        text: text,
        format: res && res.format,
        records: res && res.records ? res.records.length : null,
        origin: origin
      });
    },
    // Pushes the active source into another tool and navigates there. The target
    // parses it exactly as if the user had dropped the file in themselves.
    openIn: function (toolId) {
      if (!source) return false;
      var target = HUB_TARGETS.filter(function (t) { return t.id === toolId; })[0];
      if (!target) return false;
      var fn = root[target.fn];
      if (typeof fn !== 'function') return false;
      // The target already has THIS source — no risk, no need to ask. Otherwise,
      // if it currently shows unrelated data of its own, a silent one-click
      // replace is exactly the kind of thing that should be confirmed first.
      if (source.loadedIn.indexOf(toolId) === -1 && target.hasData) {
        var hasDataFn = root[target.hasData];
        if (typeof hasDataFn === 'function' && hasDataFn()) {
          var proceed = root.confirm
            ? root.confirm('This replaces whatever is currently loaded in ' + target.label + '. Continue?')
            : true;
          if (!proceed) return false;
        }
      }
      if (source.loadedIn.indexOf(toolId) === -1) source.loadedIn.push(toolId);
      // Navigate first so the target panel exists and is visible before it
      // renders parse results into it.
      if (typeof root.navigateWithReturn === 'function') root.navigateWithReturn(toolId);
      else if (typeof root.navigate === 'function') root.navigate(toolId, null);
      try {
        fn(source.text, source.name);
      } catch (e) {
        console.error('Data Hub: ' + target.fn + ' failed', e);
        return false;
      }
      notify();
      return true;
    },
    // Re-scans for mount points; safe to call repeatedly.
    mountAll: function () {
      document.querySelectorAll('[data-mt-hub]').forEach(function (el) {
        mounts.add(el);
        render(el);
      });
    }
  };

  root.mtHub = mtHub;
  root.mtHubInit = function () { mtHub.mountAll(); };
})(typeof window !== 'undefined' ? window : self);
