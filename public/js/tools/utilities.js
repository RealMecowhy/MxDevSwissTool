// UTILITIES
// ============================================================
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function escRegex(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function copyToClipboard(text){if(navigator.clipboard)navigator.clipboard.writeText(text).catch(()=>fallbackCopy(text));else fallbackCopy(text);}
function fallbackCopy(text){const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);}
function downloadText(text,filename){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'text/plain'}));a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),10000);}
// ── Lazy vendor loading ──────────────────────────────────────────────────────
// mermaid (3.5 MB) and chart.js (200 KB) used to load on every start, for every
// user, no matter which of the 38 tools they opened — 3.7 MB of the first load
// belonged to four of them. They are injected on first use instead.
//
// Deliberately a <script> tag rather than a dynamic import(): the release ships
// `public/` as-is, and the production build inlines every dynamic import into
// one file (viteSingleFile + inlineDynamicImports), so an import() would be
// bundled straight back into the first load. A tag injected at runtime is the
// one form the bundler leaves alone, and `scripts/copy-vendor.js` already puts
// these files next to the built page.
//
// The promise is cached per file, so ten call sites racing on the same tool
// produce one network request and one script tag.
const mtVendorLoads = {};
function mtLoadVendor(file) {
  if (mtVendorLoads[file]) return mtVendorLoads[file];
  mtVendorLoads[file] = new Promise(function (resolve, reject) {
    const s = document.createElement('script');
    s.src = 'js/vendor/' + file;
    s.onload = function () { resolve(true); };
    s.onerror = function () {
      // Let the next call retry — an offline first visit should not permanently
      // poison the tool for the rest of the session.
      delete mtVendorLoads[file];
      reject(new Error('Could not load js/vendor/' + file));
    };
    document.head.appendChild(s);
  });
  return mtVendorLoads[file];
}

// Mermaid config, in one place because two things depend on getting it right.
//
// `useMaxWidth` (the default, true) writes `max-width: <natural>px` onto the SVG
// and stretches it to the container's width — so a 8 592 px domain model was
// squeezed into a 650 px panel at 7% scale, every label under one pixel tall,
// and because the SVG then "fitted", there was nothing left to scroll either.
// Off, the diagram keeps its natural size and #arch-output scrolls, which is
// what the zoom/pan wrapper in architecture.js builds on.
//
// The theme has to be re-applied whenever the app theme changes: initialize()
// only affects *subsequent* renders, so an already-drawn diagram keeps the old
// palette — dark-theme boxes (#ccc) and edges (#d3d3d3) on the light-theme
// background (#f5f5f5) come out at ~1.3:1 contrast, i.e. invisible.
function mtMermaidApplyTheme() {
  if (!window.mermaid) return;
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  window.mermaid.initialize({
    startOnLoad: false,
    theme: isLight ? 'default' : 'dark',
    class: { useMaxWidth: false },
    flowchart: { useMaxWidth: false }
  });
}

function mtLoadMermaid() {
  return mtLoadVendor('mermaid.min.js').then(function () {
    if (window.mermaid) {
      window._mtMermaidReady = true;
      mtMermaidApplyTheme();
    }
    return true;
  });
}

// ── Mendix table → entity ────────────────────────────────────────────────────
// PostgreSQL names tables `module$entity`; a Mendix developer thinks in
// `Module.Entity`. When a domain model has been loaded from a live database
// (Domain Model & Architecture → Load model from database) the translation is
// published on window._mxTableMap, and the SQL-facing tools can speak the
// developer's language instead of the database's.
//
// Progressive enrichment, the same contract edxMapTables already proves: with no
// model loaded this returns null and every caller renders exactly what it
// rendered before. A live database is a bonus here, never a requirement.
let mxTableIdx = null, mxTableIdxFor = null;
function mxEntityForTable(table) {
  const map = window._mxTableMap;
  if (!map || !table) return null;
  // Rebuild the lookup only when a different map object arrives — the callers
  // are row renderers, so this runs per visible row.
  if (mxTableIdxFor !== map) {
    mxTableIdx = {};
    Object.keys(map).forEach(function (k) { mxTableIdx[String(k).toLowerCase()] = map[k]; });
    mxTableIdxFor = map;
  }
  const key = String(table).replace(/^public\./i, '').replace(/"/g, '').trim().toLowerCase();
  return mxTableIdx[key] || null;
}

function handleTextFileDrop(e, inputId, callbackName) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    const file = e.dataTransfer.files[0];
    const reader = new FileReader();
    reader.onload = function(evt) {
      document.getElementById(inputId).value = evt.target.result;
      if (window[callbackName]) window[callbackName]();
    };
    reader.readAsText(file);
  }
}

// Keyboard shortcuts (8.6): Ctrl+Enter triggers a tool's primary action.
// Generic by design — it doesn't hold a per-tool registry of functions to
// call. Instead, a tool opts in simply by putting a <kbd>Ctrl+Enter</kbd>
// hint inside its primary action button's label (already the case for
// Format buttons in SQL/JSON/XML/Microflow Expression); this handler finds
// that hint in the active panel and replays a real click on its button,
// reusing whatever onclick the tool already wired up. One button per panel
// is expected to carry the hint — if a tool ever needs a second one, it
// should not also add a second <kbd>, since only the first match fires.
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.key !== 'Enter') return;
  const panel = document.querySelector('.tool-panel.active');
  if (!panel) return;
  // A multi-tab tool (Query Intelligence, JVM Health) has one hinted button
  // PER TAB, all in the DOM at once — only the tab that's actually visible
  // (not display:none) may own the shortcut right now.
  const kbd = Array.from(panel.querySelectorAll('kbd')).find(k => k.offsetParent !== null);
  const btn = kbd && kbd.closest('button');
  if (btn) { e.preventDefault(); btn.click(); }
});

// Fonts are self-hosted in styles/fonts.css (linked from index.html), not fetched
// from fonts.googleapis.com at boot as they were before. The remote stylesheet was
// cross-origin, so the service worker never precached it: offline and air-gapped
// sessions fell back to Segoe UI + Consolas, and every online boot told Google the
// app had started - both at odds with the offline-first, nothing-leaves-the-machine
// promise on the Home screen.

// ============================================================

// --- AUTO-GENERATED ESM EXPORTS ---
window.escHtml = escHtml;
window.escRegex = escRegex;
window.mxEntityForTable = mxEntityForTable;
window.mtLoadVendor = mtLoadVendor;
window.mtLoadMermaid = mtLoadMermaid;
window.mtMermaidApplyTheme = mtMermaidApplyTheme;
window.copyToClipboard = copyToClipboard;
window.fallbackCopy = fallbackCopy;
window.downloadText = downloadText;
window.handleTextFileDrop = handleTextFileDrop;
