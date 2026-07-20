// DOMAIN MODEL & ARCHITECTURE
// Generates Mermaid class diagrams from JSON payloads or pseudo-code

let archLastMermaidCode = '';

function archCopyMermaid() {
  if (!archLastMermaidCode) {
    alert('Generate a diagram first.');
    return;
  }
  window.copyToClipboard(archLastMermaidCode);
}

function archDownloadSvg() {
  const svg = document.querySelector('#arch-output svg');
  if (!svg) {
    alert('Generate a diagram first.');
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

  // Render using Mermaid API if loaded
  if (window.mermaid) {
    out.innerHTML = `<div class="mermaid">${mermaidCode}</div>`;
    mermaid.init(undefined, document.querySelectorAll('.mermaid'));
  } else {
    out.innerHTML = `<pre style="font-family:var(--font-mono);font-size:0.8rem;background:var(--bg-base);padding:var(--sp-4);border-radius:var(--r-md);overflow-x:auto">${escHtml(mermaidCode)}</pre>
    <div class="notice notice-info" style="margin-top:var(--sp-2)">Mermaid.js library is not loaded. The raw syntax is shown above. To visualize, copy this into the <a href="https://mermaid.live/" target="_blank" style="color:var(--primary)">Mermaid Live Editor</a>.</div>`;
  }
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

export function init() {}
