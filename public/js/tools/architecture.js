// DOMAIN MODEL & ARCHITECTURE
// Generates Mermaid class diagrams from JSON payloads or pseudo-code

let archLastMermaidCode = '';

function archCopyMermaid() {
  if (!archLastMermaidCode) {
    window.mtToast('Generate a diagram first.', 'warning');
    return;
  }
  window.copyToClipboard(archLastMermaidCode);
}

function archDownloadSvg() {
  const svg = document.querySelector('#arch-output svg');
  if (!svg) {
    window.mtToast('Generate a diagram first.', 'warning');
    return;
  }
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const markup = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  a.download = 'domain-model.svg';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function archGenerate() {
  const input = document.getElementById('arch-input').value.trim();
  const out = document.getElementById('arch-output');
  archViewMode = 'entities';
  const toggle = document.getElementById('arch-view-toggle');
  if (toggle) toggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.view === 'entities'));
  if (!input) {
    out.innerHTML = '<div style="color:var(--text-muted)">Paste Domain Model JSON or Pseudo-code to generate diagram...</div>';
    return;
  }
  
  let mermaidCode = 'classDiagram\n';
  
  try {
    const json = JSON.parse(input);
    if (json.entities) {
      json.entities.forEach(ent => {
        mermaidCode += `  class ${ent.name} {\n`;
        if (ent.attributes) {
          ent.attributes.forEach(attr => {
            // Mermaid reads parentheses in a class member as a method signature,
            // so `String(200) Name` renders as a method rather than a field
            // (visibly inconsistent with unparameterised types next to it).
            // The precise type stays in the JSON; only the label drops the ().
            const type = String(attr.type == null ? '' : attr.type).replace(/\s*\(([^)]*)\)/, ' $1');
            mermaidCode += `    ${type.trim()} ${attr.name}\n`;
          });
        }
        mermaidCode += `  }\n`;
      });
      // Generalization, as supplied by the live-database loader. `extends` holds
      // the fully qualified name so it stays unambiguous across modules; the
      // arrow is only drawn when that super entity is actually in the diagram,
      // otherwise Mermaid would invent a bare node for a filtered-out class.
      const byFullName = {};
      json.entities.forEach(ent => {
        if (ent.fullName) byFullName[ent.fullName] = ent.name;
        byFullName[ent.name] = ent.name;
      });
      json.entities.forEach(ent => {
        const superName = ent.extends && byFullName[ent.extends];
        if (superName) mermaidCode += `  ${superName} <|-- ${ent.name}\n`;
      });
    }
    if (json.associations) {
      json.associations.forEach(assoc => {
        // The cardinality labels used to be compared against '1-*)' etc. — with
        // a stray ')' that no input could ever match, so every association fell
        // through to a plain arrow and cardinality was silently dropped.
        const arrow = assoc.type === '1-*' ? '"1" --> "*"' :
                      assoc.type === '*-*' ? '"*" --> "*"' :
                      assoc.type === '1-1' ? '"1" --> "1"' : '-->';
        mermaidCode += `  ${assoc.parent} ${arrow} ${assoc.child} : ${assoc.name}\n`;
      });
    }
  } catch(e) {
    // pseudo-code parsing
    // EntityName
    //  attr: Type
    //  attr: Type
    //
    // EntityA -> EntityB : assocName
    const lines = input.split('\n');
    let currentEntity = null;
    lines.forEach(line => {
      const l = line.trim();
      if (!l) {
        currentEntity = null;
        return;
      }
      
      // Cardinality syntax: Customer [1] -- [*] Order : has
      const cardMatch = l.match(/^(\S+)\s*\[([^\]]+)\]\s*--\s*\[([^\]]+)\]\s*(\S+)\s*(?::\s*(.+))?$/);
      if (cardMatch) {
        const [, left, leftCard, rightCard, right, label] = cardMatch;
        mermaidCode += `  ${left} "${leftCard}" --> "${rightCard}" ${right}${label ? ' : ' + label.trim() : ''}\n`;
        currentEntity = null;
      } else if (l.includes('->')) {
        const parts = l.split('->');
        const left = parts[0].trim();
        const rightParts = parts[1].split(':');
        const right = rightParts[0].trim();
        const label = rightParts.length > 1 ? rightParts[1].trim() : '';
        mermaidCode += `  ${left} --> ${right} ${label ? ': ' + label : ''}\n`;
        currentEntity = null;
      } else if (!l.includes(':')) {
        currentEntity = l;
        mermaidCode += `  class ${currentEntity} {\n  }\n`;
      } else if (currentEntity && l.includes(':')) {
        const [attr, type] = l.split(':');
        mermaidCode += `  class ${currentEntity} {\n    ${type.trim()} ${attr.trim()}\n  }\n`;
      }
    });
  }
  
  archLastMermaidCode = mermaidCode;
  archRenderMermaid(mermaidCode);
}


// =========================================================================
// LIVE DB (Wave 6 R3): load the domain model straight from a Mendix database
// =========================================================================
// Progressive enhancement — with no connection this tool behaves exactly as it
// always has (paste JSON or pseudocode). The database only removes the need to
// produce that JSON by hand.
//
// A real application is far too large for one diagram (the reference app has
// 338 entities across 40 modules), so the module picker is part of the flow
// rather than a refinement: pick modules, then generate.

let archLiveModel = null;

function archEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Mirrors domainModelToArchJson() on the server so the picker can re-project
// without a round trip when the user changes the module selection.
function archProjectModel(model, moduleNames) {
  const wanted = moduleNames && moduleNames.length ? new Set(moduleNames) : null;
  const moduleOf = n => (String(n).indexOf('.') === -1 ? '(none)' : String(n).split('.')[0]);
  const shortOf = n => (String(n).indexOf('.') === -1 ? String(n) : String(n).slice(String(n).indexOf('.') + 1));
  const entities = model.entities.filter(e => !wanted || wanted.has(moduleOf(e.name)));
  const names = new Set(entities.map(e => e.name));
  return {
    entities: entities.map(e => ({
      name: e.shortName,
      fullName: e.name,
      table: e.table,
      extends: e.superName || undefined,
      attributes: e.attributes.map(a => ({ name: a.name, type: a.type }))
    })),
    associations: model.associations
      .filter(a => names.has(a.one) && names.has(a.many))
      .map(a => ({ name: a.shortName, parent: shortOf(a.one), child: shortOf(a.many), type: a.cardinality }))
  };
}

// Push the current selection into the existing textarea and render. Everything
// downstream is the unchanged paste-JSON path.
window.archApplyModules = function () {
  if (!archLiveModel) return;
  const picked = [...document.querySelectorAll('#arch-module-list input[type=checkbox]:checked')]
    .map(c => c.value);
  const projected = archProjectModel(archLiveModel, picked);
  document.getElementById('arch-input').value = JSON.stringify(projected, null, 2);
  const count = document.getElementById('arch-pick-count');
  if (count) {
    count.textContent = `${projected.entities.length} entities · ${projected.associations.length} associations selected`;
  }
  archGenerate();
};

// Above this many entities, one Mermaid diagram tends to hang or freeze the
// tab rather than render something merely large — worth a confirm before "All".
const ARCH_LARGE_MODEL_ENTITIES = 150;

window.archToggleModules = function (all) {
  if (all && archLiveModel && archLiveModel.stats && archLiveModel.stats.entityCount > ARCH_LARGE_MODEL_ENTITIES) {
    const proceed = confirm(
      `This draws all ${archLiveModel.stats.entityCount} entities on one diagram, which can be slow or unreadable ` +
      'in the browser. Pick a smaller set of modules instead, or continue anyway?'
    );
    if (!proceed) return;
  }
  document.querySelectorAll('#arch-module-list input[type=checkbox]').forEach(c => { c.checked = all; });
  window.archApplyModules();
};

function archRenderModelSummary(model) {
  const box = document.getElementById('arch-model-summary');
  if (!box) return;
  const s = model.stats;
  const meta = model.meta
    ? `<span style="color:var(--text-muted)">${archEsc(model.meta.project || '')} · Mendix ${archEsc(model.meta.mendixVersion || '')}</span>`
    : '';
  const card = `${s.cardinality['1-1'] || 0} one-to-one · ${s.cardinality['1-*'] || 0} one-to-many · ${s.cardinality['*-*'] || 0} many-to-many`;
  // Biggest modules first — that is where a developer starts reading a model.
  const boxes = model.modules.map(m => `
    <label style="display:inline-flex;align-items:center;gap:4px;font-size:0.76rem;margin:0 var(--sp-2) 4px 0;white-space:nowrap">
      <input type="checkbox" value="${archEsc(m.name)}" onchange="window.archApplyModules()">
      ${archEsc(m.name)} <span style="color:var(--text-muted)">(${m.entityCount})</span></label>`).join('');

  box.innerHTML = `
    <div style="border:1px solid var(--border);border-radius:var(--r-md);padding:var(--sp-2) var(--sp-3);background:var(--bg-elevated)">
      <div style="display:flex;gap:var(--sp-3);flex-wrap:wrap;align-items:center;font-size:0.78rem;margin-bottom:var(--sp-2)">
        <strong>${s.entityCount}</strong> entities · <strong>${s.attributeCount}</strong> attributes ·
        <strong>${s.associationCount}</strong> associations · <strong>${s.moduleCount}</strong> modules
        ${s.inheritedCount ? `· ${s.inheritedCount} inherit` : ''}
        <span style="margin-left:auto">${meta}</span>
      </div>
      <div style="font-size:0.74rem;color:var(--text-secondary);margin-bottom:var(--sp-2)">${card}</div>
      <div style="font-size:0.74rem;color:var(--text-muted);margin-bottom:4px">
        Pick the modules to draw — a whole application is unreadable as one diagram.
        <button class="btn btn-ghost btn-xs" onclick="window.archToggleModules(true)">All</button>
        <button class="btn btn-ghost btn-xs" onclick="window.archToggleModules(false)">None</button>
        <span id="arch-pick-count" style="margin-left:var(--sp-2)"></span>
      </div>
      <div id="arch-module-list" style="max-height:120px;overflow:auto">${boxes}</div>
    </div>`;
}

// =========================================================================
// Module dependency diagram (12.2) — node per module, edge per cross-module
// association. Only meaningful with a full model (Live DB), since the pasted-
// JSON/pseudocode path never carries a module list. Pure graph construction,
// separate from the mermaid string builder so it is unit-testable without mermaid.
// =========================================================================
function archModuleOf(fullName) {
  const s = String(fullName == null ? '' : fullName);
  return s.indexOf('.') === -1 ? '(none)' : s.split('.')[0];
}

function archMermaidId(name) {
  return 'm_' + String(name).replace(/[^A-Za-z0-9_]/g, '_');
}

// Builds the module graph from the FULL model (not the module-filtered
// projection used for the entity diagram) — a dependency overview is only
// useful if it can show edges to modules the user hasn't selected.
function archBuildModuleGraph(model) {
  const nodes = (model.modules || []).map(m => ({ name: m.name, entityCount: m.entityCount }));
  const edgeCounts = new Map();
  (model.associations || []).forEach(a => {
    const m1 = archModuleOf(a.one);
    const m2 = archModuleOf(a.many);
    if (m1 === m2) return;
    const key = [m1, m2].sort().join('||');
    edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
  });
  const edges = Array.from(edgeCounts.entries()).map(([key, count]) => {
    const [a, b] = key.split('||');
    return { a, b, count };
  }).sort((x, y) => y.count - x.count);
  return { nodes, edges };
}

function archModuleGraphToMermaid(graph) {
  let code = 'graph LR\n';
  graph.nodes.forEach(n => {
    code += `  ${archMermaidId(n.name)}["${archEsc(n.name)} (${n.entityCount})"]\n`;
  });
  graph.edges.forEach(e => {
    code += `  ${archMermaidId(e.a)} ---|"${e.count}"| ${archMermaidId(e.b)}\n`;
  });
  if (!graph.nodes.length) code += '  empty["No modules loaded"]\n';
  return code;
}

let archViewMode = 'entities'; // 'entities' | 'modules'

window.archSetViewMode = function (mode) {
  archViewMode = mode;
  document.querySelectorAll('#arch-view-toggle button').forEach(b => b.classList.toggle('active', b.dataset.view === mode));
  if (mode === 'modules') {
    if (!archLiveModel) { window.mtToast('Load a domain model from a live database first — the module dependency view needs the full module list.', 'warning'); archViewMode = 'entities'; return; }
    const graph = archBuildModuleGraph(archLiveModel);
    archLastMermaidCode = archModuleGraphToMermaid(graph);
    archRenderMermaid(archLastMermaidCode);
  } else {
    archGenerate();
  }
};

// =========================================================================
// Zoom & pan
// =========================================================================
// A real domain model does not fit on a screen: 40 entities around one hub lay
// out 8 592 px wide. Mermaid renders a static SVG and offers no navigation, so
// this is ours — the same hand-rolled approach as the Schema Visualizer in
// Query Intelligence, no new dependency.
//
// Zoom is a CSS transform on #arch-zoom, whose *layout* box is set to the
// scaled size so #arch-output's scrollbars keep matching what is on screen.
// Panning therefore is scrolling — which means the entity search can go on
// using scrollIntoView, and the scrollbars stay usable at every zoom level.
let archZoom = 1;
let archNaturalW = 0, archNaturalH = 0;

const ARCH_ZOOM_MIN = 0.02;  // a 8 592 px model fits a 650 px panel at 0.075
const ARCH_ZOOM_MAX = 4;

function archClampZoom(z) {
  return Math.min(ARCH_ZOOM_MAX, Math.max(ARCH_ZOOM_MIN, z));
}

// The rendered SVG's own size, read once per render. With useMaxWidth off,
// mermaid sizes the SVG naturally; the viewBox is the reliable source.
function archMeasureDiagram() {
  const svg = document.querySelector('#arch-output svg');
  if (!svg) { archNaturalW = archNaturalH = 0; return; }
  const vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
  const box = svg.getBoundingClientRect();
  archNaturalW = (vb[2] && isFinite(vb[2])) ? vb[2] : box.width;
  archNaturalH = (vb[3] && isFinite(vb[3])) ? vb[3] : box.height;
  // Belt and braces: an SVG left with max-width would resist the transform.
  svg.style.maxWidth = 'none';
  svg.style.width = archNaturalW + 'px';
  svg.style.height = archNaturalH + 'px';
}

function archApplyZoom(z) {
  archZoom = archClampZoom(z);
  const wrap = document.getElementById('arch-zoom');
  if (wrap) {
    wrap.style.transform = 'scale(' + archZoom + ')';
    wrap.style.width = (archNaturalW * archZoom) + 'px';
    wrap.style.height = (archNaturalH * archZoom) + 'px';
  }
  const label = document.getElementById('arch-zoom-level');
  if (label) label.textContent = Math.round(archZoom * 100) + '%';
}

// Zooms around a fixed point in the panel (the cursor, or the centre for the
// buttons), so the thing you were looking at stays where you were looking.
function archZoomAround(nextZoom, anchorX, anchorY) {
  const out = document.getElementById('arch-output');
  if (!out) return;
  const prev = archZoom;
  const next = archClampZoom(nextZoom);
  if (next === prev) return;
  const contentX = (out.scrollLeft + anchorX) / prev;
  const contentY = (out.scrollTop + anchorY) / prev;
  archApplyZoom(next);
  out.scrollLeft = contentX * next - anchorX;
  out.scrollTop = contentY * next - anchorY;
}

window.archZoomBy = function (factor) {
  const out = document.getElementById('arch-output');
  if (!out) return;
  archZoomAround(archZoom * factor, out.clientWidth / 2, out.clientHeight / 2);
};

window.archZoomFit = function () {
  const out = document.getElementById('arch-output');
  if (!out || !archNaturalW || !archNaturalH) return;
  // Padding is inside the scroll box, so the usable width is a little smaller.
  const pad = 32;
  const fit = Math.min((out.clientWidth - pad) / archNaturalW, (out.clientHeight - pad) / archNaturalH);
  archApplyZoom(fit);
  out.scrollLeft = 0;
  out.scrollTop = 0;
};

window.archZoomReset = function () {
  archApplyZoom(1);
};

// Wheel zooms, dragging pans. Bound once to the scroll container, which
// survives re-renders (the diagram inside it does not).
let archPanning = false, archPanX = 0, archPanY = 0, archPanScrollX = 0, archPanScrollY = 0;

function archInitPanZoom() {
  const out = document.getElementById('arch-output');
  if (!out || out.dataset.panZoomBound) return;
  out.dataset.panZoomBound = '1';
  out.style.cursor = 'grab';

  out.addEventListener('wheel', function (e) {
    if (!document.getElementById('arch-zoom')) return; // no diagram: let the page scroll
    e.preventDefault();
    const rect = out.getBoundingClientRect();
    archZoomAround(archZoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  out.addEventListener('mousedown', function (e) {
    if (e.button !== 0 || !document.getElementById('arch-zoom')) return;
    archPanning = true;
    archPanX = e.clientX; archPanY = e.clientY;
    archPanScrollX = out.scrollLeft; archPanScrollY = out.scrollTop;
    out.style.cursor = 'grabbing';
    e.preventDefault(); // otherwise the drag turns into a text/SVG selection
  });

  window.addEventListener('mousemove', function (e) {
    if (!archPanning) return;
    out.scrollLeft = archPanScrollX - (e.clientX - archPanX);
    out.scrollTop = archPanScrollY - (e.clientY - archPanY);
  });

  window.addEventListener('mouseup', function () {
    if (!archPanning) return;
    archPanning = false;
    out.style.cursor = 'grab';
  });
}

// Mermaid's palette is baked into the SVG at render time, so a theme switch
// leaves an existing diagram in the old colours — dark-theme edges on a light
// background are invisible. core.js calls this after flipping the theme.
window.archRerenderForTheme = function () {
  if (!archLastMermaidCode || !document.querySelector('#arch-output svg')) return;
  if (window.mtMermaidApplyTheme) window.mtMermaidApplyTheme();
  const keepZoom = archZoom;
  archRenderMermaid(archLastMermaidCode).then(function () {
    archApplyZoom(keepZoom);   // a re-paint is not a reason to lose the user's view
  });
};

// Mermaid is fetched on first use (3.5 MB), so this is async now. The existing
// no-mermaid branch doubles as the failure path: if the library can't be fetched
// (offline first visit), the diagram source is shown instead of nothing.
async function archRenderMermaid(mermaidCode) {
  const out = document.getElementById('arch-output');
  if (!window.mermaid && window.mtLoadMermaid) {
    out.innerHTML = '<div style="padding:var(--sp-4); color:var(--text-muted); font-size:0.85rem;">Loading the diagram renderer…</div>';
    try { await window.mtLoadMermaid(); } catch (e) { /* fall through to the source view below */ }
  }
  if (window.mermaid) {
    // The zoom wrapper is sized in layout pixels while the diagram inside is
    // scaled by a transform — that is what keeps the scrollbars honest about
    // how much diagram there is at the current zoom.
    out.innerHTML = '<div id="arch-zoom" style="transform-origin:0 0;flex:0 0 auto">'
      + `<div class="mermaid">${mermaidCode}</div></div>`;
    // Rendering is asynchronous in mermaid 11 — measuring straight after the
    // call reads a placeholder sized to the panel, not the finished diagram.
    try {
      const nodes = out.querySelectorAll('.mermaid');
      if (window.mermaid.run) await window.mermaid.run({ nodes: nodes });
      else await window.mermaid.init(undefined, nodes);
    } catch (e) {
      // Invalid diagram source: show it rather than an empty frame.
      out.innerHTML = `<pre style="font-family:var(--font-mono);font-size:0.8rem;padding:var(--sp-2);white-space:pre-wrap">${escHtml(mermaidCode)}</pre>`
        + `<div class="notice notice-warning" style="margin-top:var(--sp-2)">The renderer rejected this diagram: ${escHtml(e && e.message ? e.message : String(e))}</div>`;
      return;
    }
    archMeasureDiagram();
    archInitPanZoom();
    // A model wider than the panel opens fitted: at natural size the user would
    // be staring at the top-left corner of something they just asked to see.
    if (archNaturalW > out.clientWidth) window.archZoomFit();
    else archApplyZoom(archZoom);
  } else {
    out.innerHTML = `<pre style="font-family:var(--font-mono);font-size:0.8rem;background:var(--bg-base);padding:var(--sp-4);border-radius:var(--r-md);overflow-x:auto">${escHtml(mermaidCode)}</pre>
    <div class="notice notice-info" style="margin-top:var(--sp-2)">Mermaid.js library is not loaded. The raw syntax is shown above. To visualize, copy this into the <a href="https://mermaid.live/" target="_blank" style="color:var(--primary)">Mermaid Live Editor</a>.</div>`;
  }
}

// =========================================================================
// Entity search (12.2) — scrolls to and highlights a matching class node.
// True canvas zoom would need a pan/zoom library this diagram doesn't have
// (unlike QI's hand-rolled Schema Visualizer canvas); scroll + a temporary
// highlight is the honest equivalent for a plain Mermaid SVG.
// =========================================================================
window.archSearchEntity = function () {
  const q = (document.getElementById('arch-entity-search').value || '').trim().toLowerCase();
  const status = document.getElementById('arch-entity-search-status');
  if (!q) { if (status) status.textContent = ''; return; }
  const svg = document.querySelector('#arch-output svg');
  if (!svg) { if (status) status.textContent = 'Generate a diagram first.'; return; }
  const nodes = Array.from(svg.querySelectorAll('g.node, g.classGroup, g[class*="class"]'));
  const match = nodes.find(n => {
    const label = n.textContent || '';
    return label.toLowerCase().indexOf(q) !== -1;
  });
  if (!match) { if (status) status.textContent = `No entity matching "${q}".`; return; }
  match.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  match.classList.add('arch-search-hit');
  setTimeout(() => match.classList.remove('arch-search-hit'), 2000);
  if (status) status.textContent = 'Found.';
};

window.archLoadFromDb = async function (btn) {
  const box = document.getElementById('arch-model-summary');
  if (!window.mtDb || !window.mtDb.isConnected()) {
    if (box) {
      box.innerHTML = `<div class="notice notice-warning" style="font-size:0.8rem">Connect a database above first. Without one, paste Domain Model JSON or pseudocode into the input as usual — nothing else about this tool changes.</div>`;
    }
    return;
  }
  const old = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = 'Loading…'; }
  try {
    const resp = await fetch('http://localhost:9999/livedb/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(window.mtDb.getConfig())
    });
    const data = await resp.json();
    if (!data || data.error) {
      if (box) {
        box.innerHTML = `<div class="notice notice-warning" style="font-size:0.8rem">${archEsc((data && data.message) || 'Could not read the model.')}</div>`;
      }
      return;
    }
    archLiveModel = data;
    // Table → entity, so an error naming `eshop$order` can be reported as
    // `eShop.Order`. Published for the Error Decoder to pick up.
    window._mxTableMap = data.tableMap || {};
    archRenderModelSummary(data);
    // Preselect the largest non-System module: the app's own model is what the
    // developer came for, and System alone would be noise.
    const first = data.modules.filter(m => m.name !== 'System')[0] || data.modules[0];
    if (first) {
      const cb = document.querySelector(`#arch-module-list input[value="${CSS.escape(first.name)}"]`);
      if (cb) cb.checked = true;
    }
    window.archApplyModules();
  } catch (e) {
    if (box) {
      box.innerHTML = `<div class="notice notice-warning" style="font-size:0.8rem">Observability Bridge not reachable on http://localhost:9999. Start it with "npm run bridge" — Live DB needs the Bridge to reach PostgreSQL.</div>`;
    }
  } finally {
    if (btn && old !== null) { btn.disabled = false; btn.innerHTML = old; }
  }
};

// --- AUTO-GENERATED ESM EXPORTS ---
window.archGenerate = archGenerate;
window.archCopyMermaid = archCopyMermaid;
window.archDownloadSvg = archDownloadSvg;

// Exposed for scripts/parser-test.js (pure functions, no DOM/mermaid needed).
window.archModuleOf = archModuleOf;
window.archMermaidId = archMermaidId;
window.archBuildModuleGraph = archBuildModuleGraph;
window.archModuleGraphToMermaid = archModuleGraphToMermaid;

export function init() {}
