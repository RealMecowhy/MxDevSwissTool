// DOMAIN MODEL & ARCHITECTURE
// Generates Mermaid class diagrams from JSON payloads or pseudo-code

let archLastMermaidCode = '';

// =========================================================================
// Colours
// =========================================================================
// Literal hex, never var(--…): `Copy Mermaid` has to render natively in
// GitHub and Confluence, where none of our CSS custom properties exist. The
// cost is that a theme switch must REGENERATE the code, not just repaint it
// (see archRerenderForTheme).
//
// Deliberately not built from the app's semantic tokens: --accent, --warning
// and --danger all collapse into one orange-red band in the light theme, so
// three of the eight modules would be indistinguishable there.
const ARCH_MODULE_PALETTE = {
  dark: [
    { fill: '#17324a', stroke: '#4da3e0', text: '#dceaf5' },
    { fill: '#1a3b28', stroke: '#4caf72', text: '#dcf0e4' },
    { fill: '#33244a', stroke: '#a77ee0', text: '#ece2f8' },
    { fill: '#123c3c', stroke: '#3fb8b0', text: '#d9f2f0' },
    { fill: '#45213a', stroke: '#d472b8', text: '#f8e2f1' },
    { fill: '#45350f', stroke: '#d9a531', text: '#f8eed4' },
    { fill: '#232a52', stroke: '#7b8ae0', text: '#e2e6f8' },
    { fill: '#33400f', stroke: '#9cb944', text: '#eef4d8' }
  ],
  light: [
    { fill: '#e3f0fa', stroke: '#2b7cb8', text: '#123249' },
    { fill: '#e2f4e8', stroke: '#2e8b52', text: '#14351f' },
    { fill: '#f0e8fa', stroke: '#7a4fb0', text: '#2f1c47' },
    { fill: '#dff2f1', stroke: '#1f8b84', text: '#0e3634' },
    { fill: '#fae4f2', stroke: '#b34d92', text: '#4a1a3a' },
    { fill: '#fbf0d8', stroke: '#ab7c14', text: '#4a3608' },
    { fill: '#e6e9fa', stroke: '#4f5cb0', text: '#1e2347' },
    { fill: '#eef4d9', stroke: '#6e8a1e', text: '#2f3a09' }
  ]
};

// System (and anything past the palette) stays neutral: it is infrastructure,
// not the application's own model — the same reason the loader preselects the
// largest non-System module.
const ARCH_NEUTRAL = {
  dark: { fill: '#262626', stroke: '#5a5a5a', text: '#c8c8c8' },
  light: { fill: '#f0f0f0', stroke: '#a8a8a8', text: '#444444' }
};

const ARCH_FOCUS_STROKE = { dark: '#ff8700', light: '#e67e00' };

// Attribute rows are what turns a real model into a 13 000 px canvas, so above
// this many entities they are dropped unless the user asks for them.
const ARCH_ATTR_AUTO_LIMIT = 12;

let archAttrMode = 'auto';   // 'auto' | 'all' | 'none'

function archCurrentTheme() {
  return (typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-theme') === 'light') ? 'light' : 'dark';
}

function archResolveAttrMode(mode, entityCount) {
  if (mode === 'all' || mode === 'none') return mode;
  return entityCount > ARCH_ATTR_AUTO_LIMIT ? 'none' : 'all';
}

// One palette slot per module actually present in this drawing — not per
// module in the model. Eight hues is already past what the eye separates
// reliably, and a 40-module application would just be noise.
function archAssignModuleColors(entities, theme) {
  const pal = ARCH_MODULE_PALETTE[theme] || ARCH_MODULE_PALETTE.dark;
  const neutral = ARCH_NEUTRAL[theme] || ARCH_NEUTRAL.dark;
  const counts = new Map();
  (entities || []).forEach(e => {
    if (!e.fullName || String(e.fullName).indexOf('.') === -1) return;
    const m = String(e.fullName).split('.')[0];
    counts.set(m, (counts.get(m) || 0) + 1);
  });
  const colors = new Map();
  Array.from(counts.entries())
    .filter(function (kv) { return kv[0] !== 'System'; })
    .sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : 1); })
    .forEach(function (kv, i) { colors.set(kv[0], i < pal.length ? pal[i] : neutral); });
  if (counts.has('System')) colors.set('System', neutral);
  return colors;
}

function archStyleClassId(moduleName) {
  return 'mod_' + String(moduleName).replace(/[^A-Za-z0-9_]/g, '_');
}

// Pure: JSON model -> mermaid classDiagram source. Split out of archGenerate
// so the colouring and attribute rules are testable without a DOM.
function archBuildClassDiagram(json, opts) {
  opts = opts || {};
  const theme = opts.theme === 'light' ? 'light' : 'dark';
  const entities = json.entities || [];
  const showAttrs = archResolveAttrMode(opts.attrMode, entities.length) === 'all';
  const colors = archAssignModuleColors(entities, theme);

  let code = 'classDiagram\n';
  const used = new Set();

  entities.forEach(ent => {
    const mod = (ent.fullName && String(ent.fullName).indexOf('.') !== -1)
      ? String(ent.fullName).split('.')[0] : null;
    const styleId = (mod && colors.has(mod)) ? archStyleClassId(mod) : null;
    if (styleId) used.add(mod);
    const decl = `class ${ent.name}${styleId ? ':::' + styleId : ''}`;
    // Mermaid reads parentheses in a class member as a method signature, so
    // `String(200) Name` renders as a method rather than a field (visibly
    // inconsistent with unparameterised types next to it). The precise type
    // stays in the JSON; only the label drops the ().
    const rows = (showAttrs && ent.attributes ? ent.attributes : []).map(attr => {
      const type = String(attr.type == null ? '' : attr.type).replace(/\s*\(([^)]*)\)/, ' $1');
      return `    ${type.trim()} ${attr.name}\n`;
    });
    // An empty `{ }` body is a parse error — "Expecting 'MEMBER', got
    // 'STRUCT_STOP'" — which rejects the WHOLE diagram, not just this class.
    // A bodyless `class Foo` is the valid form and the only one that works
    // when attributes are hidden.
    code += rows.length ? `  ${decl} {\n${rows.join('')}  }\n` : `  ${decl}\n`;
  });

  // Generalization, as supplied by the live-database loader. `extends` holds
  // the fully qualified name so it stays unambiguous across modules; the
  // arrow is only drawn when that super entity is actually in the diagram,
  // otherwise Mermaid would invent a bare node for a filtered-out class.
  const byFullName = {};
  entities.forEach(ent => {
    if (ent.fullName) byFullName[ent.fullName] = ent.name;
    byFullName[ent.name] = ent.name;
  });
  entities.forEach(ent => {
    const superName = ent.extends && byFullName[ent.extends];
    if (superName) code += `  ${superName} <|-- ${ent.name}\n`;
  });

  (json.associations || []).forEach(assoc => {
    // The cardinality labels used to be compared against '1-*)' etc. — with
    // a stray ')' that no input could ever match, so every association fell
    // through to a plain arrow and cardinality was silently dropped.
    const arrow = assoc.type === '1-*' ? '"1" --> "*"' :
                  assoc.type === '*-*' ? '"*" --> "*"' :
                  assoc.type === '1-1' ? '"1" --> "1"' : '-->';
    code += `  ${assoc.parent} ${arrow} ${assoc.child} : ${assoc.name}\n`;
  });

  // Order below is not cosmetic. mermaid's defineClass applies styles by
  // walking the classes declared SO FAR that already carry the name, while
  // ::: and cssClass only ATTACH the name without pulling styles. So every
  // classDef has to come after everything that names it, or it silently
  // styles nothing. Also no trailing ';' — mermaid truncates `#hex;`.
  const hasFocus = json.focus && entities.some(e => e.name === json.focus);
  if (hasFocus) code += `  cssClass "${json.focus}" archFocus\n`;

  used.forEach(mod => {
    const c = colors.get(mod);
    code += `  classDef ${archStyleClassId(mod)} fill:${c.fill},stroke:${c.stroke},color:${c.text},stroke-width:1.5px\n`;
  });
  // Last of all: the focus entity also carries a module class, and the styles
  // that land later win, so this is what makes the highlight beat the module's
  // own thinner stroke.
  if (hasFocus) code += `  classDef archFocus stroke:${ARCH_FOCUS_STROKE[theme]},stroke-width:4px\n`;
  return code;
}

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

function archGenerate(preserveExplore) {
  const input = document.getElementById('arch-input').value.trim();
  const out = document.getElementById('arch-output');
  // A genuine content change (module pick, typed pseudocode) ends the explore
  // trail — archExploreFrom re-sets it right after calling this function, so
  // exploring stays intact across THAT call. archSetViewMode's 'entities'
  // branch passes preserveExplore=true for the other case: just switching to
  // look at the Diagram tab of whatever is already loaded, which must not
  // make Explore forget where it was when the user switches back.
  if (!preserveExplore) archExploreState = null;
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
    const theme = archCurrentTheme();
    mermaidCode = archBuildClassDiagram(json, { theme: theme, attrMode: archAttrMode });
    archRenderLegend(json.entities || [], theme);
  } catch(e) {
    archRenderLegend([], archCurrentTheme());
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
  // Returned so callers that need the finished SVG (theme re-render, explore
  // centring) can await it — rendering is async since mermaid 11.
  return archRenderMermaid(mermaidCode);
}

// archGenerate() clears the explore trail by design. These callers redraw the
// SAME view for a different reason (attribute mode, theme, pane width), so the
// trail has to survive them.
function archRegenerate() {
  const keep = archExploreState;
  const p = archGenerate();
  archExploreState = keep;
  return p;
}

window.archSetAttrMode = function (mode) {
  archAttrMode = mode;
  archRegenerate();
};

// Reuses the app-wide split manager (core.js) that seven other tools already
// use, then refits: the SVG was measured against the previous pane width, so
// without this the diagram keeps the old scale in a differently sized panel.
window.archSetPaneView = function (mode, btn) {
  if (window.uiSetView) window.uiSetView('arch-split', mode, btn);
  if (document.querySelector('#arch-output svg')) {
    archMeasureDiagram();
    window.archZoomFit();
  }
};

// Which modules are in the current picture, and in what colour. Only rendered
// when there is something to explain.
function archRenderLegend(entities, theme) {
  const box = document.getElementById('arch-legend');
  if (!box) return;
  const colors = archAssignModuleColors(entities, theme);
  if (!colors.size) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'flex';
  box.innerHTML = Array.from(colors.entries()).map(([mod, c]) => `
    <span style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap">
      <span style="width:10px;height:10px;border-radius:2px;background:${c.fill};border:1.5px solid ${c.stroke};display:inline-block"></span>
      ${archEsc(mod)}</span>`).join('');
}

// Mermaid draws relation lines in a low-contrast grey that vanishes on a large
// diagram. Per-edge colouring is not available — classDiagram has no
// linkStyle — but the whole set can at least be made visible.
function archEnhanceEdges() {
  const svg = document.querySelector('#arch-output svg');
  if (!svg) return;
  const color = archCurrentTheme() === 'light' ? '#6b6b6b' : '#9a9a9a';
  svg.querySelectorAll('g.edgePaths path, path.relation').forEach(p => {
    p.style.stroke = color;
    p.style.strokeWidth = '1.6px';
  });
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

// Set only while the current diagram came from archExploreFrom — lets a
// click on a node re-center the explore instead of doing nothing (or, on a
// module-picked diagram, being ignored — see archInitPanZoom).
let archExploreState = null;

function archEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function archShortOf(n) {
  return String(n).indexOf('.') === -1 ? String(n) : String(n).slice(String(n).indexOf('.') + 1);
}

// Mirrors domainModelToArchJson() on the server so the picker (module-based
// or neighborhood-based) can re-project without a round trip. `entityNames`
// is a Set of full names to keep, or null for the whole model.
function archProjectEntities(model, entityNames) {
  const wanted = entityNames;
  const entities = model.entities.filter(e => !wanted || wanted.has(e.name));
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
      .map(a => ({ name: a.shortName, parent: archShortOf(a.one), child: archShortOf(a.many), type: a.cardinality }))
  };
}

function archProjectModel(model, moduleNames) {
  const wantedModules = moduleNames && moduleNames.length ? new Set(moduleNames) : null;
  if (!wantedModules) return archProjectEntities(model, null);
  const moduleOf = n => (String(n).indexOf('.') === -1 ? '(none)' : String(n).split('.')[0]);
  const entityNames = new Set(model.entities.filter(e => wantedModules.has(moduleOf(e.name))).map(e => e.name));
  return archProjectEntities(model, entityNames);
}

// Pure BFS over the association graph (same edges archBuildModuleGraph
// walks, one hop = one association) — the start entity plus everything
// reachable within `radius` hops. A disconnected entity yields just itself.
function archEntityNeighborhood(model, startFullName, radius) {
  const adj = new Map();
  (model.associations || []).forEach(a => {
    if (!adj.has(a.one)) adj.set(a.one, new Set());
    if (!adj.has(a.many)) adj.set(a.many, new Set());
    adj.get(a.one).add(a.many);
    adj.get(a.many).add(a.one);
  });
  const visited = new Set([startFullName]);
  let frontier = [startFullName];
  for (let hop = 0; hop < radius; hop++) {
    const next = [];
    frontier.forEach(n => {
      (adj.get(n) || new Set()).forEach(nb => {
        if (!visited.has(nb)) { visited.add(nb); next.push(nb); }
      });
    });
    frontier = next;
  }
  return visited;
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
    // Sits in the <summary>, so it stays readable while the picker is collapsed.
    count.textContent = `${picked.length} of ${archLiveModel.modules.length} selected · ${projected.entities.length} entities · ${projected.associations.length} associations`;
  }
  return archGenerate();
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

// Resolves a typed/picked entity name (full name from the datalist, or a
// unique short name typed by hand) to the full name, draws it plus its
// neighborhood, and — unlike the module picker — leaves a trail
// (archExploreState) so clicking a node in the result can recenter there.
window.archExploreFrom = async function (query, radius) {
  const status = document.getElementById('arch-explore-status');
  const setStatus = msg => { if (status) status.textContent = msg; };
  if (!archLiveModel) return;
  const q = String(query || '').trim();
  if (!q) { setStatus('Type or pick an entity first.'); return; }
  const hops = parseInt(radius, 10) === 2 ? 2 : 1;

  let start = archLiveModel.entities.find(e => e.name === q);
  if (!start) {
    const qLower = q.toLowerCase();
    const matches = archLiveModel.entities.filter(e => e.shortName.toLowerCase() === qLower);
    if (matches.length === 1) start = matches[0];
    else if (matches.length > 1) { setStatus(`"${q}" matches ${matches.length} entities in different modules — pick one from the list.`); return; }
  }
  if (!start) { setStatus(`No entity named "${q}".`); return; }

  const neighborhood = archEntityNeighborhood(archLiveModel, start.name, hops);
  if (neighborhood.size > ARCH_LARGE_MODEL_ENTITIES) {
    const proceed = confirm(
      `${start.shortName} has ${neighborhood.size} entities within ${hops} hop(s), which can be slow or unreadable ` +
      'in the browser. Try 1 hop instead, or continue anyway?'
    );
    if (!proceed) return;
  }

  const projected = archProjectEntities(archLiveModel, neighborhood);
  // Carried inside the JSON rather than through a side channel, so it travels
  // the existing "JSON -> #arch-input -> archGenerate" pipeline, survives
  // Copy Mermaid, and works for a hand-pasted model too.
  projected.focus = start.shortName;
  document.getElementById('arch-input').value = JSON.stringify(projected, null, 2);
  // Awaited on purpose: archRenderMermaid is async (it may fetch the 3.5 MB
  // renderer on first use), and it overwrites #arch-output when it finally
  // resolves. Switching to the canvas below before this settles was a real
  // race — the canvas would render, then the Diagram render would land late
  // and silently wipe it back out to a stale Mermaid SVG.
  await archGenerate();

  const shortToFull = new Map();
  archLiveModel.entities.forEach(e => { if (neighborhood.has(e.name)) shortToFull.set(e.shortName, e.name); });
  archExploreState = { radius: hops, shortToFull, center: start.name };
  setStatus(`${start.shortName} + ${neighborhood.size - 1} neighbor(s) within ${hops} hop(s) — ${projected.entities.length} entities · ${projected.associations.length} associations.`);

  // "Explore" now means the interactive canvas, not the Mermaid diagram —
  // archGenerate() above only kept the Diagram tab and Copy Mermaid working
  // in the background. archSetViewMode owns what "entering canvas mode"
  // means, so it is the one place, not duplicated here.
  window.archSetViewMode('canvas');
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

  // Three compact rows instead of six stacked blocks: this strip is now
  // permanently on screen (it moved out of the collapsible DB panel), so every
  // pixel it takes is a pixel the diagram does not get.
  box.innerHTML = `
    <div style="border:1px solid var(--border);border-radius:var(--r-md);padding:var(--sp-2) var(--sp-3);background:var(--bg-elevated)">
      <div style="display:flex;gap:var(--sp-3);flex-wrap:wrap;align-items:center;font-size:0.76rem;margin-bottom:4px">
        <span><strong>${s.entityCount}</strong> entities · <strong>${s.attributeCount}</strong> attributes ·
        <strong>${s.associationCount}</strong> associations · <strong>${s.moduleCount}</strong> modules
        ${s.inheritedCount ? `· ${s.inheritedCount} inherit` : ''}</span>
        <span style="color:var(--text-secondary)">${card}</span>
        <span style="margin-left:auto">${meta}</span>
      </div>
      <div style="display:flex;gap:var(--sp-4);flex-wrap:wrap;align-items:flex-start;margin-bottom:4px">
        ${archRenderModelInsights(model)}
        <details style="font-size:0.74rem;color:var(--text-secondary)">
          <summary style="cursor:pointer;color:var(--text-muted)">Modules — <span id="arch-pick-count">pick what to draw</span></summary>
          <div style="margin-top:4px">
            <button class="btn btn-ghost btn-xs" onclick="window.archToggleModules(true)">All</button>
            <button class="btn btn-ghost btn-xs" onclick="window.archToggleModules(false)">None</button>
            <div id="arch-module-list" style="max-height:110px;overflow:auto;margin-top:4px">${boxes}</div>
          </div>
        </details>
      </div>
      <div style="font-size:0.74rem;color:var(--text-muted);display:flex;gap:4px;flex-wrap:wrap;align-items:center">
        Explore one entity:
        <input list="arch-entity-datalist" id="arch-explore-input" placeholder="Entity name…" style="width:180px;font-size:0.76rem;padding:1px 4px"
          onkeydown="if(event.key==='Enter'){window.archExploreFrom(this.value, document.getElementById('arch-explore-radius').value);event.preventDefault();}">
        <datalist id="arch-entity-datalist">${model.entities.map(e => `<option value="${archEsc(e.name)}">${archEsc(e.shortName)} (${archEsc(e.module)})</option>`).join('')}</datalist>
        <select id="arch-explore-radius" style="font-size:0.76rem">
          <option value="1">1 hop</option>
          <option value="2">2 hops</option>
        </select>
        <button class="btn btn-ghost btn-xs" onclick="window.archExploreFrom(document.getElementById('arch-explore-input').value, document.getElementById('arch-explore-radius').value)">Explore</button>
        <span id="arch-explore-status"></span>
      </div>
    </div>`;
}

// Answers "where do I start reading this model" before the user draws
// anything — most-coupled module pairs, hub entities, orphan entities. All
// three are cheap tallies over data already in `model`, not new server work.
function archRenderModelInsights(model) {
  if (!model.modules || !model.modules.length) return '';
  const edges = archBuildModuleGraph(model).edges.slice(0, 5);
  const counts = archEntityAssocCounts(model);
  const hubs = counts.slice(0, 5).filter(c => c.count > 0);
  const orphans = archOrphanEntities(model, counts);

  const couplingList = edges.length
    ? edges.map(e => `<li>${archEsc(e.a)} &harr; ${archEsc(e.b)} <span style="color:var(--text-muted)">(${e.count})</span></li>`).join('')
    : '<li style="color:var(--text-muted)">No cross-module associations.</li>';
  const hubList = hubs.length
    ? hubs.map(h => `<li>${archEsc(h.name)} <span style="color:var(--text-muted)">(${h.count})</span></li>`).join('')
    : '<li style="color:var(--text-muted)">No entities with associations.</li>';
  const orphanNames = orphans.map(n => `<li>${archEsc(n)}</li>`).join('');

  return `
    <details style="font-size:0.74rem;color:var(--text-secondary)">
      <summary style="cursor:pointer;color:var(--text-muted)">Model insights — most-coupled modules, hub &amp; orphan entities</summary>
      <div style="display:flex;gap:var(--sp-4);flex-wrap:wrap;margin-top:var(--sp-2)">
        <div><strong>Most-coupled modules</strong><ul style="margin:4px 0 0 1.1em;padding:0">${couplingList}</ul></div>
        <div><strong>Hub entities</strong><ul style="margin:4px 0 0 1.1em;padding:0">${hubList}</ul></div>
        <div><strong>Orphan entities (${orphans.length})</strong>${orphanNames ? `<ul style="margin:4px 0 0 1.1em;padding:0">${orphanNames}</ul>` : ''}</div>
      </div>
    </details>`;
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

// Per-entity association count, sorted desc — the hub entities (widest blast
// radius for a schema change) sit at the top. Same tally shape as the module
// graph above, just keyed by entity instead of module.
function archEntityAssocCounts(model) {
  const counts = new Map();
  (model.associations || []).forEach(a => {
    counts.set(a.one, (counts.get(a.one) || 0) + 1);
    counts.set(a.many, (counts.get(a.many) || 0) + 1);
  });
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((x, y) => y.count - x.count);
}

// Entities with zero associations — set-difference against the tally above,
// not a separate pass over associations.
function archOrphanEntities(model, counts) {
  const withAssoc = new Set(counts.map(c => c.name));
  return (model.entities || []).map(e => e.name).filter(name => !withAssoc.has(name));
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

let archViewMode = 'entities'; // 'entities' (Diagram, mermaid) | 'modules' (mermaid) | 'canvas' (Explore, owned SVG)

window.archSetViewMode = function (mode) {
  archViewMode = mode;
  document.querySelectorAll('#arch-view-toggle button').forEach(b => b.classList.toggle('active', b.dataset.view === mode));
  // The left pane follows the right one: Details only means anything next to
  // the canvas, Source (the JSON/pseudocode textarea) is what drives Diagram
  // and Modules — and is what a no-database user needs, so it stays the
  // fallback rather than a blank Details pane.
  const leftBtn = document.getElementById(mode === 'canvas' ? 'arch-leftpane-details-btn' : 'arch-leftpane-source-btn');
  if (window.archSetLeftPane) window.archSetLeftPane(mode === 'canvas' ? 'details' : 'source', leftBtn);
  if (mode === 'modules') {
    if (!archLiveModel) { window.mtToast('Load a domain model from a live database first — the module dependency view needs the full module list.', 'warning'); archViewMode = 'entities'; return; }
    // NOT clearing archExploreState here (unlike before canvas existed):
    // it now also carries WHERE Explore was, so switching to canvas() can
    // resume there — clearing it here made "peek at Modules, then click
    // Explore again" forget the last-explored entity. The legacy mermaid
    // click-to-recenter handler that archExploreState used to gate is now
    // gated on archViewMode itself instead (see archInitPanZoom's mouseup).
    const graph = archBuildModuleGraph(archLiveModel);
    archLastMermaidCode = archModuleGraphToMermaid(graph);
    archRenderMermaid(archLastMermaidCode);
  } else if (mode === 'canvas') {
    if (!archLiveModel) { window.mtToast('Load a domain model from a live database first — Explore needs the full model.', 'warning'); archViewMode = 'entities'; return; }
    // Nothing explored yet this session: a blank canvas explains nothing, so
    // guide the user to the control that starts one instead of drawing
    // anything (same "no empty states" rule the rest of the tool follows).
    if (!archExploreState || !archExploreState.center) {
      if (window.archCanvasRenderEmpty) window.archCanvasRenderEmpty();
      return;
    }
    if (window.archCanvasRender) window.archCanvasRender(archLiveModel, archExploreState.center, archExploreState.radius);
  } else {
    // Just switching to look at the Diagram tab, not a content change —
    // preserve the explore trail so switching back to Explore resumes it.
    archGenerate(true);
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

  window.addEventListener('mouseup', function (e) {
    if (!archPanning) return;
    archPanning = false;
    out.style.cursor = 'grab';
    // A click (negligible movement between mousedown and mouseup) on a node,
    // while an explore trail is active, recenters there — otherwise this
    // control is a one-shot filter, not something you can actually walk.
    // Gated on archViewMode, not just archExploreState: the latter now
    // survives switching to Modules (so Explore can resume there later),
    // so without this a click on a MODULE node could match a stray entity
    // short name and misfire. This whole branch is Mermaid-specific anyway
    // (text-prefix matching a node's label) — the canvas has real node
    // identity and its own click handling in arch-canvas.js.
    if (archViewMode === 'entities' && archExploreState && Math.hypot(e.clientX - archPanX, e.clientY - archPanY) < 5) {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const node = target && target.closest('g.node, g.classGroup, g[class*="class"]');
      const text = node ? (node.textContent || '').trim() : '';
      // Longest name first: "UserToken" must not be shadowed by a "User" prefix match.
      const shortName = Array.from(archExploreState.shortToFull.keys())
        .sort((a, b) => b.length - a.length)
        .find(name => text.startsWith(name));
      if (shortName) window.archExploreFrom(archExploreState.shortToFull.get(shortName), archExploreState.radius);
    }
  });
}

// Mermaid's palette is baked into the SVG at render time, so a theme switch
// leaves an existing diagram in the old colours — dark-theme edges on a light
// background are invisible. core.js calls this after flipping the theme.
window.archRerenderForTheme = function () {
  if (archViewMode === 'canvas') {
    if (window.archCanvasRerenderForTheme) window.archCanvasRerenderForTheme();
    return;
  }
  if (!archLastMermaidCode || !document.querySelector('#arch-output svg')) return;
  if (window.mtMermaidApplyTheme) window.mtMermaidApplyTheme();
  const keepZoom = archZoom;
  // The module graph carries no colours of ours, so a repaint is enough. An
  // entity diagram has the palette baked in as literal hex (so Copy Mermaid
  // stays portable), which means the source itself has to be rebuilt.
  const redraw = archViewMode === 'modules'
    ? archRenderMermaid(archLastMermaidCode)
    : archRegenerate();
  if (redraw && redraw.then) {
    redraw.then(function () {
      archApplyZoom(keepZoom);   // a re-paint is not a reason to lose the user's view
    });
  }
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
    archEnhanceEdges();
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
    // Awaited: this kicks off an async Mermaid render (module-picker diagram)
    // that overwrites #arch-output when it resolves. The auto-explore below
    // does the same into the same element — without waiting here, whichever
    // one finishes last wins the race and the other's render is silently lost.
    await window.archApplyModules();
    // Explore (the canvas) is the working view now — default to the biggest
    // hub so it opens with something meaningful rather than an empty prompt.
    // archExploreFrom's own >150-entity confirm() guard still applies, same
    // as a manual Explore — no separate, stricter cutoff here: on a real
    // 277-entity application the actual top hub had 60 direct neighbours,
    // comfortably under 150 but well past an over-cautious lower cap that
    // was tried first and silently did nothing for exactly this case.
    const hub = archEntityAssocCounts(data).find(c => c.count > 0);
    if (hub) await window.archExploreFrom(hub.name, '1');
    // The connection form is setup you touch once — with a model loaded it is
    // only taking vertical space from the diagram. Collapsed on success only:
    // on failure the form is exactly what the user needs to reach.
    const livedb = document.getElementById('arch-livedb');
    if (livedb) livedb.open = false;
    // The JSON pane now holds a machine-generated projection, not something
    // being typed — give its half of the width to the diagram.
    const diagramBtn = document.querySelector('#panel-architecture .tool-actions .btn-group .btn:last-child');
    window.archSetPaneView('result', diagramBtn);
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
window.archEntityAssocCounts = archEntityAssocCounts;
window.archOrphanEntities = archOrphanEntities;
window.archProjectModel = archProjectModel;
window.archProjectEntities = archProjectEntities;
window.archEntityNeighborhood = archEntityNeighborhood;
window.archBuildClassDiagram = archBuildClassDiagram;
window.archResolveAttrMode = archResolveAttrMode;
window.archAssignModuleColors = archAssignModuleColors;

// Exposed so arch-canvas.js (a separate module, own closure) can draw into the
// SAME #arch-output/#arch-zoom container and get pan/zoom/theme-on-repaint for
// free, instead of re-implementing navigation that already exists here.
window.archMeasureDiagram = archMeasureDiagram;
window.archApplyZoom = archApplyZoom;
window.archInitPanZoom = archInitPanZoom;
window.archCurrentTheme = archCurrentTheme;
window.archRenderLegend = archRenderLegend;
window.ARCH_FOCUS_STROKE = ARCH_FOCUS_STROKE;
window.ARCH_LARGE_MODEL_ENTITIES = ARCH_LARGE_MODEL_ENTITIES;
Object.defineProperty(window, 'archZoom', { get: function () { return archZoom; } });
Object.defineProperty(window, 'archOutClientWidth', { get: function () {
  const el = document.getElementById('arch-output'); return el ? el.clientWidth : 0;
} });

export function init() {}
