// =========================================================================
// DATA FACTORY — 4-STEP WIZARD (orchestrator) · prefix `dfw`
// =========================================================================
// One flow, three sources. The old panel had three disconnected sections (a
// flat generator, a schema importer, a relational seed); they shared no state
// and each re-invented value generation. This wizard unifies them:
//
//   ① Source   — Manual · One table from the DB · Multiple linked tables
//   ② Select   — paste DDL / pick one entity / pick many + shape their links
//   ③ Columns  — review every column; the GENERATOR and its PARAMETERS are the
//                heart. Each generator declares its params (Country → region,
//                Date → from/to, Pattern → mask, Custom/Enum → value list), and
//                this step renders them generically from that declaration.
//   ④ Output   — format depends on source: one table → CSV/JSON/XML/SQL, a
//                relational set → a single linked SQL script. `id` is emitted
//                only for SQL (a flat file's rows get runtime ids on import).
//
// Everything here is UI + orchestration. The value engine
// (data-factory-generators.js → dfgGenerate/dfgList), the serializers
// (data-factory-output.js → dfoSerialize), the schema inference
// (data-factory-import.js → dfParseDdl/dfInferAttribute/dfSchemaFromEntity) and
// the relational maths (data-factory-seed.js → seedTopoOrder/seedDistribute/
// seedSqlLiteral/…) are the tested pure layers this file drives. They attach to
// window before any handler runs, so they are read as window.* on use.
// =========================================================================

const DFW = (typeof window !== 'undefined' ? window : self);
const DFW_AGENT_URL = 'http://localhost:9999';

const MODE_LABEL = { manual: 'Manual', single: 'One table', multi: 'Multiple linked tables' };
const SINGLE_KEY = '_single'; // entity key for the manual/single single-table column set

// Whole-wizard state. Reset by dfwReset(); persists while the tool stays open.
const dfw = {
  step: 1,
  maxReachable: 1,
  mode: null,               // 'manual' | 'single' | 'multi'
  format: null,             // 'csv' | 'json' | 'xml' | 'sql'
  model: null,              // /livedb/model result
  module: '',
  filter: '',
  colsByEntity: {},         // entityKey -> [col]; SINGLE_KEY for manual/single
  order: [],                // entity keys in review/emit order (topo for multi)
  tableName: '',            // single mode: physical table for SQL
  entityType: '',           // single mode: full "Module.Entity" for the Mendix REST format
  sel: {},                  // multi: entityName -> { count }
  assoc: {},                // multi: assocIndex -> { mode, skew, orphanPct, useExisting }
  detail: null,             // cached /livedb/seed-schema contract
  count: 1000,              // single/manual row count
  repro: false,
  seed: 1,
  ddlTables: []             // manual: parsed DDL tables awaiting a pick
};

// A column: { field, source, generator, params:{}, role, meta, unique,
//   emptyPercent, isEnum, enumValues, fk:{parent} }.

// =========================================================================
// small helpers
// =========================================================================
function dfwEl(id) { return document.getElementById(id); }
function dfwEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function dfwAttr(s) { return dfwEsc(s).replace(/'/g, '&#39;'); }
function dfwNote(html, kind) {
  return '<div class="dfw-notice dfw-' + (kind || 'info') + '">' + html + '</div>';
}
function dfwShort(name) { return name && name.indexOf('.') !== -1 ? name.split('.')[1] : name; }
function dfwRng() {
  return dfw.repro && DFW.seedRng ? DFW.seedRng(parseInt(dfw.seed, 10) || 1) : Math.random;
}

// =========================================================================
// SHELL — stepper + panels + footer, rendered once into #dfw-root
// =========================================================================
function dfwStepperHtml() {
  const labels = ['Source', 'Select', 'Columns & types', 'Output'];
  let h = '';
  for (let i = 0; i < 4; i++) {
    const n = i + 1;
    const cls = 'dfw-stp' + (n === dfw.step ? ' active' : '') +
      (n < dfw.maxReachable && n !== dfw.step ? ' done' : '') +
      (n <= dfw.maxReachable ? ' reachable' : '');
    h += '<button type="button" class="' + cls + '"' + (n > dfw.maxReachable ? ' disabled' : '') +
      ' onclick="dfwGoto(' + n + ')"><span class="dfw-stp-num">' + n + '</span>' +
      '<span class="dfw-stp-txt"><span class="dfw-stp-eyebrow">Step ' + n + '</span>' +
      '<span class="dfw-stp-label">' + labels[i] + '</span></span></button>';
    if (i < 3) h += '<span class="dfw-stp-line"></span>';
  }
  return h;
}

function dfwRender() {
  const root = dfwEl('dfw-root');
  if (!root) return;
  root.innerHTML =
    '<div class="dfw-card">' +
      '<div class="dfw-stepper" id="dfw-stepper"></div>' +
      '<div class="dfw-body" id="dfw-panel"></div>' +
      '<div class="dfw-foot">' +
        '<button type="button" class="btn btn-ghost" id="dfw-back" onclick="dfwBack()">&larr; Back</button>' +
        '<span class="dfw-foot-hint" id="dfw-hint"></span>' +
        '<span style="flex:1"></span>' +
        '<button type="button" class="btn btn-primary" id="dfw-next" onclick="dfwNext()">Next &rarr;</button>' +
      '</div>' +
    '</div>';
  DFW.dfwGoto(dfw.step);
}

// =========================================================================
// NAVIGATION
// =========================================================================
DFW.dfwGoto = function (n) {
  if (n < 1 || n > 4 || n > dfw.maxReachable) return;
  dfw.step = n;
  dfwEl('dfw-stepper').innerHTML = dfwStepperHtml();
  const panel = dfwEl('dfw-panel');
  if (n === 1) panel.innerHTML = dfwStep1Html();
  else if (n === 2) dfwRenderStep2();
  else if (n === 3) dfwRenderStep3();
  else if (n === 4) dfwRenderStep4();

  dfwEl('dfw-back').disabled = n === 1;
  const next = dfwEl('dfw-next');
  next.style.display = n === 4 ? 'none' : '';
  dfwUpdateGuard();
  dfwEl('dfw-hint').textContent = dfwHint(n);
};

DFW.dfwNext = function () {
  if (dfw.step === 1 && !dfw.mode) return;
  dfw.maxReachable = Math.max(dfw.maxReachable, dfw.step + 1);
  DFW.dfwGoto(dfw.step + 1);
};
DFW.dfwBack = function () { DFW.dfwGoto(dfw.step - 1); };

function dfwHint(n) {
  const name = MODE_LABEL[dfw.mode] || '';
  if (n === 1) return dfw.mode ? name + ' selected' : 'Choose a source to begin';
  if (n === 2) return name + ' · select what to generate';
  if (n === 3) return 'Adjust generators; enum columns take a value list';
  return 'Ready to generate';
}

// The Next button is only enabled when the current step has what it needs.
function dfwUpdateGuard() {
  const next = dfwEl('dfw-next');
  if (!next) return;
  let ok = true;
  if (dfw.step === 1) ok = !!dfw.mode;
  else if (dfw.step === 2) ok = dfwHasColumns();
  next.disabled = !ok;
}

function dfwHasColumns() {
  // Multi builds its column sets on entering step 3, so at step 2 the gate is
  // simply "at least one entity has a positive row count".
  if (dfw.mode === 'multi') {
    return Object.keys(dfw.sel).filter(function (n) { return dfw.sel[n].count > 0; }).length > 0;
  }
  return (dfw.colsByEntity[SINGLE_KEY] || []).length > 0;
}

// =========================================================================
// STEP 1 — SOURCE
// =========================================================================
function dfwSourceCard(mode, title, desc, icon, tag) {
  return '<button type="button" class="dfw-source' + (dfw.mode === mode ? ' sel' : '') +
    '" onclick="dfwSetMode(\'' + mode + '\')">' +
    '<span class="dfw-sc-icon">' + icon + '</span>' +
    '<span class="dfw-sc-title">' + title + '</span>' +
    '<span class="dfw-sc-desc">' + desc + '</span>' +
    (tag ? '<span class="dfw-sc-tag">' + tag + '</span>' : '') + '</button>';
}

function dfwStep1Html() {
  const iManual = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  const iSingle = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/></svg>';
  const iMulti = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7l3 9M16 7l-3 9"/></svg>';
  return '<div class="dfw-head"><h2 class="dfw-title">How do you want to generate data?</h2>' +
    '<p class="dfw-sub">Pick a source. Everything after this adapts to your choice — the flat generator, a single entity, or a whole set of linked entities.</p></div>' +
    '<div class="dfw-source-grid">' +
      dfwSourceCard('manual', 'Manual', 'Define columns by hand. Optionally paste a <code>CREATE TABLE</code> script to start from.', iManual, '') +
      dfwSourceCard('single', 'One table from the database', 'Read a single Mendix entity&rsquo;s real attributes and generate rows for just that table.', iSingle, '') +
      dfwSourceCard('multi', 'Multiple linked tables', 'Pick several related entities; foreign keys are filled with a realistic distribution.', iMulti, 'relational') +
    '</div>' +
    '<div class="dfw-usecases"><span class="dfw-uc-label">What you get out of it</span>' +
      '<div class="dfw-uc-items">' +
        '<span><i>&#9889;</i> Load &amp; performance testing at realistic data volumes</span>' +
        '<span><i>&#128269;</i> Reproduce N+1 and index-selectivity issues before prod</span>' +
        '<span><i>&#127916;</i> Fill a demo or dev environment with believable data</span>' +
        '<span><i>&#10003;</i> Sanity-check an importer, a mapping, or a new report</span>' +
      '</div></div>';
}

DFW.dfwSetMode = function (mode) {
  if (dfw.mode !== mode) {
    dfw.mode = mode;
    dfw.format = null;
    // Switching source invalidates any picked columns/selection.
    dfw.colsByEntity = {};
    dfw.order = [];
    dfw.sel = {};
    dfw.assoc = {};
    dfw.tableName = '';
    dfw.entityType = '';
    dfw.detail = null;
    dfw.maxReachable = 2;
    // Manual mode can proceed with a default schema and needs no load.
    if (mode === 'manual' && !(dfw.colsByEntity[SINGLE_KEY] || []).length) {
      dfw.colsByEntity[SINGLE_KEY] = dfwDefaultManualCols();
      dfw.order = [SINGLE_KEY];
    }
  }
  dfwEl('dfw-panel').innerHTML = dfwStep1Html();
  dfwEl('dfw-hint').textContent = dfwHint(1);
  dfwUpdateGuard();
};

function dfwDefaultManualCols() {
  return [
    dfwMkCol('ID', 'manual', 'UUID'),
    dfwMkCol('FullName', 'manual', 'FullName'),
    dfwMkCol('EmailAddress', 'manual', 'Email')
  ];
}

function dfwMkCol(field, source, generator, extra) {
  const c = { field: field, source: source, generator: generator, params: {},
    role: 'attr', meta: null, unique: false, emptyPercent: 0, isEnum: generator === 'Enum', enumValues: [] };
  if (extra) Object.keys(extra).forEach(function (k) { c[k] = extra[k]; });
  return c;
}

// =========================================================================
// STEP 2 — SELECT
// =========================================================================
function dfwRenderStep2() {
  let title = 'Select what to generate', sub = '';
  if (dfw.mode === 'manual') { title = 'Start your schema'; sub = 'Nothing to load — optionally paste DDL, or continue and build the columns in the next step.'; }
  else if (dfw.mode === 'single') { title = 'Pick one entity'; sub = 'Read a single Mendix entity and generate rows for just that table.'; }
  else { title = 'Pick entities and how they link'; sub = 'Choose several related entities, set a row count for each, and shape how their foreign keys are distributed.'; }

  let body = '<div class="dfw-head"><h2 class="dfw-title">' + title + '</h2><p class="dfw-sub">' + sub + '</p></div>';
  if (dfw.mode === 'manual') body += dfwStep2ManualHtml();
  else body += '<div id="dfw-conn" data-mt-db-connection style="margin-bottom:var(--sp-3)"></div>' +
    '<button class="btn btn-primary btn-sm" onclick="dfwLoadModel(this)">Load entities from database</button>' +
    '<button class="btn btn-ghost btn-sm" style="margin-left:var(--sp-2)" onclick="dfwReset()">Reset</button>' +
    '<div id="dfw-select-area" style="margin-top:var(--sp-3)"></div>';
  dfwEl('dfw-panel').innerHTML = body;

  // The shared DB-connection component auto-mounts on [data-mt-db-connection]
  // inserted into the DOM; nudge it if the host exposes a re-scan hook.
  if (DFW.mtDb && typeof DFW.mtDb.mount === 'function') { try { DFW.mtDb.mount(); } catch (e) { /* auto-mount */ } }
  if (dfw.model) { dfwRenderSelectArea(); }
}

function dfwStep2ManualHtml() {
  return dfwNote('Manual mode has nothing to load. Optionally paste a <code>CREATE TABLE</code> script to pre-fill the columns — otherwise continue and add them in step 3.', 'info') +
    '<div class="dfw-subhead" style="margin-top:var(--sp-3)">Paste CREATE TABLE (optional)</div>' +
    '<textarea class="code-area" id="dfw-ddl" style="width:100%;min-height:120px;font-family:var(--font-mono);font-size:0.78rem" ' +
    'placeholder="CREATE TABLE &quot;eshop$customer&quot; (&#10;  id bigint NOT NULL,&#10;  fullname character varying(200),&#10;  emailaddress character varying(255),&#10;  status character varying(50),&#10;  createddate timestamp&#10;);"></textarea>' +
    '<div style="margin-top:var(--sp-2)"><button class="btn btn-sm" onclick="dfwParseDdl()">Parse DDL</button>' +
    '<span id="dfw-ddl-msg" style="margin-left:var(--sp-2);font-size:0.76rem;color:var(--text-muted)"></span></div>';
}

DFW.dfwParseDdl = function () {
  const ta = dfwEl('dfw-ddl');
  const text = ta ? ta.value : '';
  const msg = dfwEl('dfw-ddl-msg');
  if (!text.trim()) { if (msg) msg.textContent = 'Paste a CREATE TABLE script first.'; return; }
  const parsed = DFW.dfParseDdl(text);
  if (!parsed.tables.length) {
    if (msg) msg.innerHTML = '<span style="color:var(--warning)">' + dfwEsc((parsed.warnings[0]) || 'No CREATE TABLE found.') + '</span>';
    return;
  }
  const t = parsed.tables[0];
  const res = DFW.dfSchemaFromTable(t);
  const cols = res.schema.map(function (s) {
    const src = dfwDdlSource(t, s.name);
    return dfwMkCol(s.name, src, s.type);
  });
  dfw.colsByEntity[SINGLE_KEY] = cols;
  dfw.order = [SINGLE_KEY];
  dfw.tableName = t.name;
  if (msg) msg.innerHTML = 'Parsed <strong>' + cols.length + '</strong> column' + (cols.length === 1 ? '' : 's') +
    ' from <code>' + dfwEsc(t.fullName) + '</code>' + (parsed.tables.length > 1 ? ' (first of ' + parsed.tables.length + ' tables)' : '') + '.';
  dfwUpdateGuard();
};

function dfwDdlSource(table, colName) {
  const col = (table.columns || []).filter(function (c) { return c.name === colName; })[0];
  if (!col) return 'manual';
  return (col.rawType || col.sqlType || '?') + (col.length ? '(' + col.length + (col.scale ? ',' + col.scale : '') + ')' : '');
}

// ── model load (single + multi) ──────────────────────────────────────────
DFW.dfwLoadModel = async function (btn) {
  if (!DFW.mtDb || !DFW.mtDb.isConnected()) {
    dfwEl('dfw-select-area').innerHTML = dfwNote(
      'Connect a database above first. This source reads the live Mendix model to know which entities exist' +
      (dfw.mode === 'multi' ? ' and how they are linked' : '') + '. On Mendix Cloud without DB access, use <strong>Manual</strong> instead.', 'warn');
    return;
  }
  const old = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = 'Loading…'; }
  try {
    const resp = await fetch(DFW_AGENT_URL + '/livedb/model', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(DFW.mtDb.getConfig())
    });
    const data = await resp.json();
    if (!data || data.error) {
      dfwEl('dfw-select-area').innerHTML = dfwNote(dfwEsc((data && data.message) || 'Could not read the model.'), 'warn');
      return;
    }
    dfw.model = data;
    const first = (data.modules || []).filter(function (m) { return m.name !== 'System'; })[0] || (data.modules || [])[0];
    dfw.module = first ? first.name : '';
    dfw.filter = '';
    dfwRenderSelectArea();
  } catch (e) {
    dfwEl('dfw-select-area').innerHTML = dfwNote(
      'Observability Bridge not reachable on ' + DFW_AGENT_URL + '. Start it with <code>npm run bridge</code>.', 'warn');
  } finally {
    if (btn && old !== null) { btn.disabled = false; btn.innerHTML = old; }
  }
};

DFW.dfwSetModule = function (name) { dfw.module = name; dfwRenderSelectArea(); };
DFW.dfwSetFilter = function (value) { dfw.filter = value; dfwRenderEntityList(); };

function dfwModuleEntities() {
  const model = dfw.model;
  if (!model) return [];
  const q = dfw.filter.trim().toLowerCase();
  return (model.entities || []).filter(function (e) {
    // A search term looks across ALL modules (big models: you never scroll all
    // of them); with no term we scope to the chosen module.
    if (q) return String(e.name).toLowerCase().indexOf(q) !== -1;
    return !dfw.module || e.module === dfw.module;
  });
}

function dfwRenderSelectArea() {
  const model = dfw.model;
  if (!model) return;
  const meta = model.meta
    ? '<span style="color:var(--text-muted);margin-left:auto">' + dfwEsc(model.meta.project || '') +
      ' · Mendix ' + dfwEsc(model.meta.mendixVersion || '') + '</span>' : '';
  const options = (model.modules || []).map(function (m) {
    return '<option value="' + dfwAttr(m.name) + '"' + (m.name === dfw.module ? ' selected' : '') + '>' +
      dfwEsc(m.name) + ' (' + m.entityCount + ')</option>';
  }).join('');
  const counts = model.stats ? ('<strong>' + model.stats.entityCount + '</strong> entities · <strong>' +
    model.stats.moduleCount + '</strong> modules' + (dfw.mode === 'multi' ? ' · <strong>' +
    (model.stats.associationCount || 0) + '</strong> associations' : '')) : '';

  const browse = '<div style="display:flex;gap:var(--sp-2);align-items:flex-end;margin-bottom:var(--sp-2);flex-wrap:wrap">' +
      '<label class="dfw-minilabel">Module<select class="select select-sm" style="width:200px" onchange="dfwSetModule(this.value)">' + options + '</select></label>' +
      '<label class="dfw-minilabel">Find entity<input class="input input-sm" style="width:200px" placeholder="name contains… (all modules)" value="' + dfwAttr(dfw.filter) + '" oninput="dfwSetFilter(this.value)"></label>' +
    '</div>' +
    '<div id="dfw-entity-list" class="dfw-entity-list"></div>';

  let html = '<div style="display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap;font-size:0.78rem;margin-bottom:var(--sp-2)">' + counts + meta + '</div>';

  if (dfw.mode === 'multi') {
    // Two columns side by side: browse/pick on the left, the running selection
    // (tray) on the right — so ticking an entity and seeing it land in the tray
    // happen without scrolling past each other.
    html += '<div class="dfw-two-col"><div>' + browse + '</div><div id="dfw-tray-wrap"></div></div>' +
      '<div id="dfw-links" style="margin-top:var(--sp-3)"></div>';
  } else {
    html += browse;
  }
  dfwEl('dfw-select-area').innerHTML = html;
  dfwRenderEntityList();
  if (dfw.mode === 'multi') { dfwRenderTray(); dfwRenderLinks(); }
}

function dfwRenderEntityList() {
  const box = dfwEl('dfw-entity-list');
  if (!box) return;
  const entities = dfwModuleEntities();
  const CAP = 200;
  const shown = entities.slice(0, CAP);
  if (!entities.length) { box.innerHTML = '<div style="padding:var(--sp-3);font-size:0.76rem;color:var(--text-muted)">No entity matches this filter.</div>'; return; }

  let rows = shown.map(function (e) {
    const idx = dfw.model.entities.indexOf(e);
    if (dfw.mode === 'single') {
      const on = dfw.tableName && e.table === dfw.tableName;
      return '<label class="dfw-ent' + (on ? ' on' : '') + '"><input type="radio" name="dfw-single"' + (on ? ' checked' : '') +
        ' onchange="dfwPickEntity(' + idx + ', this)"><span class="dfw-ent-name">' + dfwEsc(e.shortName || e.name) + '</span>' +
        '<span class="dfw-ent-attr">' + e.attributes.length + ' attr · ' + dfwEsc(e.module) + '</span></label>';
    }
    const on = !!dfw.sel[e.name];
    return '<label class="dfw-ent' + (on ? ' on' : '') + '"><input type="checkbox"' + (on ? ' checked' : '') +
      ' onchange="dfwToggleEntity(' + idx + ', this.checked)"><span class="dfw-ent-name">' + dfwEsc(e.shortName || e.name) + '</span>' +
      '<span class="dfw-ent-attr">' + e.attributes.length + ' attr · ' + dfwEsc(e.module) + '</span></label>';
  }).join('');
  if (entities.length > CAP) rows += '<div class="dfw-ent" style="color:var(--text-muted);font-style:italic">Showing ' + CAP + ' of ' + entities.length + ' — refine the search to narrow it.</div>';
  box.innerHTML = rows;
}

// ── single mode: pick one entity, read its contract, build columns ────────
DFW.dfwPickEntity = async function (index) {
  const e = dfw.model && dfw.model.entities[index];
  if (!e || !e.table) return;
  showLoader('Reading schema…');
  try {
    const detail = await dfwFetchSchema([e.table], {});
    if (detail.error) { hideLoader(); alert(detail.message || 'Could not read the schema.'); return; }
    dfw.detail = detail;
    dfw.tableName = e.table;
    dfw.entityType = e.name || '';
    dfw.colsByEntity[SINGLE_KEY] = dfwColsFromEntity(e, detail);
    dfw.order = [SINGLE_KEY];
    hideLoader();
    dfwRenderEntityList();
    dfwUpdateGuard();
  } catch (err) { hideLoader(); alert('Failed: ' + err.message); }
};

// ── multi mode selection ──────────────────────────────────────────────────
DFW.dfwToggleEntity = function (index, checked) {
  const e = dfw.model && dfw.model.entities[index];
  if (!e) return;
  if (checked) { if (!dfw.sel[e.name]) dfw.sel[e.name] = { count: dfwDefaultRows() }; }
  else { delete dfw.sel[e.name]; }
  dfwRenderEntityList();
  dfwRenderTray();
  dfwRenderLinks();
  dfwUpdateGuard();
};
DFW.dfwSetCount = function (name, value) { if (dfw.sel[name]) dfw.sel[name].count = Math.max(0, parseInt(value, 10) || 0); dfwUpdateGuard(); };
DFW.dfwRemoveEntity = function (name) { delete dfw.sel[name]; dfwRenderEntityList(); dfwRenderTray(); dfwRenderLinks(); dfwUpdateGuard(); };
DFW.dfwSetDefaultRows = function (v) { dfw._defaultRows = Math.max(0, parseInt(v, 10) || 0); };
function dfwDefaultRows() { return dfw._defaultRows != null ? dfw._defaultRows : 1000; }

function dfwRenderTray() {
  const wrap = dfwEl('dfw-tray-wrap');
  if (!wrap) return;
  const names = Object.keys(dfw.sel);
  const byName = {};
  (dfw.model.entities || []).forEach(function (e) { byName[e.name] = e; });
  const head = '<div class="dfw-tray-head"><div class="dfw-subhead" style="margin:0">Selected <span class="dfw-badge-num">' + names.length + '</span></div>' +
    '<label class="dfw-mini2">Default rows <input type="number" class="input input-sm" style="width:82px" value="' + dfwDefaultRows() + '" onchange="dfwSetDefaultRows(this.value)"></label></div>';
  if (!names.length) { wrap.innerHTML = head + '<div class="dfw-tray dfw-tray-empty">Nothing selected yet — tick entities on the left.</div>'; return; }
  const rows = names.map(function (n) {
    const e = byName[n];
    return '<div class="dfw-tray-row"><span class="dfw-tr-name">' + dfwEsc(e ? (e.shortName || e.name) : n) + '</span>' +
      '<span class="dfw-tr-mod">' + dfwEsc(e ? e.module : '') + '</span>' +
      '<input type="number" class="input input-sm" style="width:82px;margin-left:auto" min="0" value="' + dfw.sel[n].count +
      '" onchange="dfwSetCount(\'' + dfwAttr(n) + '\', this.value)"><span class="dfw-tr-x" title="Remove" onclick="dfwRemoveEntity(\'' + dfwAttr(n) + '\')">&times;</span></div>';
  }).join('');
  wrap.innerHTML = head + '<div class="dfw-tray">' + rows + '</div>';
}

function dfwApplicableAssociations() {
  const model = dfw.model;
  if (!model) return [];
  const out = [];
  (model.associations || []).forEach(function (a, i) {
    if (a.storage !== 'column') return;
    if (!dfw.sel[a.many]) return;
    out.push({ index: i, assoc: a });
  });
  return out;
}

DFW.dfwSetAssoc = function (index, field, value) {
  const cfg = dfw.assoc[index] || (dfw.assoc[index] = { mode: 'skew', skew: 1.1, orphanPct: 20, useExisting: false });
  if (field === 'mode') cfg.mode = value;
  else if (field === 'skew') cfg.skew = parseFloat(value);
  else if (field === 'orphanPct') cfg.orphanPct = Math.max(0, Math.min(90, parseInt(value, 10) || 0));
  else if (field === 'useExisting') cfg.useExisting = !!value;
  dfwRenderLinks();
};

function dfwRenderLinks() {
  const box = dfwEl('dfw-links');
  if (!box) return;
  const apps = dfwApplicableAssociations();
  if (!apps.length) {
    box.innerHTML = Object.keys(dfw.sel).length
      ? dfwNote('No column-stored association links the selected entities yet. Add both sides of a relationship (e.g. Order and Customer) to shape how they link.', 'info')
      : '';
    return;
  }
  const rows = apps.map(function (item) {
    const a = item.assoc, i = item.index;
    const cfg = dfw.assoc[i] || (dfw.assoc[i] = { mode: 'skew', skew: 1.1, orphanPct: 20, useExisting: false });
    const oneSelected = !!dfw.sel[a.one];
    const existingForced = !oneSelected;
    return '<div class="dfw-assoc"><div class="dfw-assoc-title"><strong>' + dfwEsc(dfwShort(a.many)) + '</strong> &rarr; ' +
      dfwEsc(dfwShort(a.one)) + ' <span style="color:var(--text-muted)">(' + dfwEsc(a.cardinality) + ', via <code>' + dfwEsc(a.columns[0]) + '</code>)</span></div>' +
      '<div class="dfw-assoc-ctl">' +
        '<label class="dfw-minilabel">Distribution<select class="select select-sm" style="width:150px" onchange="dfwSetAssoc(' + i + ',\'mode\',this.value)">' +
          '<option value="skew"' + (cfg.mode === 'skew' ? ' selected' : '') + '>Realistic (skewed)</option>' +
          '<option value="uniform"' + (cfg.mode === 'uniform' ? ' selected' : '') + '>Uniform</option></select></label>' +
        (cfg.mode === 'skew'
          ? '<label class="dfw-minilabel">Skew<input type="range" min="0.4" max="2" step="0.1" value="' + cfg.skew + '" style="width:110px" oninput="dfwSetAssoc(' + i + ',\'skew\',this.value)"></label>' +
            '<label class="dfw-minilabel">Parents with none %<input type="number" min="0" max="90" class="input input-sm" style="width:80px" value="' + cfg.orphanPct + '" onchange="dfwSetAssoc(' + i + ',\'orphanPct\',this.value)"></label>'
          : '') +
        '<label class="dfw-check-inline"><input type="checkbox"' + (cfg.useExisting || existingForced ? ' checked' : '') + (existingForced ? ' disabled' : '') +
          ' onchange="dfwSetAssoc(' + i + ',\'useExisting\',this.checked)"> link to existing ' + dfwEsc(dfwShort(a.one)) + ' rows</label>' +
      '</div>' +
      (existingForced ? '<div style="font-size:0.68rem;color:var(--text-muted);margin-top:4px">' + dfwEsc(dfwShort(a.one)) + ' is not selected, so children link to rows already in the database.</div>' : '') +
    '</div>';
  }).join('');
  box.innerHTML = '<div class="dfw-subhead">How to link them</div>' + rows;
}

// =========================================================================
// COLUMN BUILDING (from a live entity + its physical contract)
// =========================================================================
function dfwFetchSchema(tables, sampleExisting) {
  return fetch(DFW_AGENT_URL + '/livedb/seed-schema', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({}, DFW.mtDb.getConfig(), { tables: tables, sampleExisting: sampleExisting || {} }))
  }).then(function (r) { return r.json(); });
}

// Turn one entity + the /livedb/seed-schema contract into review columns.
function dfwColsFromEntity(entity, detail) {
  const table = entity.table;
  const columnsByTable = detail.columns || {};
  const uniqueSet = new Set((detail.uniqueColumns || []).map(function (u) { return String(u).toLowerCase(); }));
  const cm = {};
  (columnsByTable[table] || []).forEach(function (c) {
    cm[String(c.column).toLowerCase()] = {
      column: c.column, dataType: c.dataType, udtName: c.udtName, maxLength: c.maxLength,
      numericScale: c.numericScale, isNullable: c.isNullable, hasDefault: c.hasDefault,
      family: DFW.seedColumnFamily ? DFW.seedColumnFamily(c) : 'text'
    };
  });
  const cols = [];
  const used = new Set();

  // id first — generated, shown read-only (auto from MAX(id)+1 for SQL).
  const idMeta = cm.id || { column: 'id', family: 'bigint', isNullable: 'NO' };
  cols.push({ field: idMeta.column, source: idMeta.dataType || 'bigint', generator: 'Positive value',
    params: {}, role: 'id', meta: idMeta, unique: true, emptyPercent: 0, isEnum: false, enumValues: [] });
  used.add('id');

  (entity.attributes || []).forEach(function (attr) {
    const key = String(attr.column || '').toLowerCase();
    if (!key || used.has(key)) return;
    const meta = cm[key];
    if (!meta || meta.family === 'binary') return;
    const isEnum = /^enum/i.test(String(attr.type || ''));
    let generator;
    if (isEnum) generator = 'Enum';
    else {
      const inf = DFW.dfInferAttribute ? DFW.dfInferAttribute({ name: attr.name, type: attr.type }) : { type: 'String' };
      generator = inf.type || 'String';
    }
    cols.push({ field: meta.column, source: String(attr.type || meta.dataType), generator: generator,
      params: dfwSeedParams(generator, meta), role: 'attr', meta: meta,
      unique: uniqueSet.has((table + '|' + meta.column).toLowerCase()),
      emptyPercent: meta.isNullable === 'NO' ? 0 : 0, isEnum: isEnum, enumValues: [] });
    used.add(key);
  });
  return cols;
}

// Seed a few params from the column contract so defaults are sensible
// (a numeric scale becomes the Decimal's scale; a maxLength caps String).
function dfwSeedParams(generator, meta) {
  const p = {};
  if (generator === 'Decimal' && meta && meta.numericScale != null) p.scale = meta.numericScale;
  if (generator === 'String' && meta && meta.maxLength) p.maxLen = Math.min(meta.maxLength, 40);
  return p;
}

// =========================================================================
// STEP 3 — COLUMNS & TYPES (declarative generator params)
// =========================================================================
function dfwRenderStep3() {
  const head = '<div class="dfw-head"><h2 class="dfw-title">Review columns &amp; types</h2>' +
    '<p class="dfw-sub">Every generator is inferred from the name and the real column type — change any of them. Enum columns get a value list you can type or pull from the data.</p></div>';

  if (dfw.mode === 'multi') {
    // The physical column contract (types, length, nullability) is what turns an
    // entity's attributes into review columns; without it only the id survives.
    // Fetch it on entering step 3, then build and render the accordions.
    dfwEl('dfw-panel').innerHTML = head + '<div id="dfw-review">' + dfwNote('Reading the schema for the selected tables…', 'info') + '</div>';
    dfwBuildMultiThenRender();
    return;
  }
  let body = head + '<div class="dfw-table-scroll">' + dfwReviewTable(SINGLE_KEY) + '</div>';
  if (dfw.mode === 'manual') body += '<button class="btn btn-sm" style="margin-top:var(--sp-2)" onclick="dfwAddCol()">&#43; Add column</button>';
  dfwEl('dfw-panel').innerHTML = body;
}

async function dfwBuildMultiThenRender() {
  const names = Object.keys(dfw.sel).filter(function (n) { return dfw.sel[n].count > 0; });
  const topo = DFW.seedTopoOrder(names, dfw.model.associations);
  dfw.order = topo.order;
  dfw._cyclic = topo.cyclic;
  const byName = {};
  (dfw.model.entities || []).forEach(function (e) { byName[e.name] = e; });

  // Do we already have the contract for every selected table?
  const missing = dfw.order.some(function (n) {
    const t = byName[n] && byName[n].table;
    return !(dfw.detail && dfw.detail.columns && dfw.detail.columns[t]);
  });
  if (missing) {
    showLoader('Reading schema…');
    let ok = false;
    try { ok = await dfwEnsureMultiDetail(); } catch (e) { ok = false; }
    hideLoader();
    if (!ok) {
      const box = dfwEl('dfw-review');
      if (box) box.innerHTML = dfwNote('Could not read the schema for the selected tables. Check the Live DB connection and try again.', 'warn');
      return;
    }
  }
  // Build columns for any entity not built yet (dfwColsFromEntity now has the
  // real contract); keep existing edits on re-entry.
  dfw.order.forEach(function (n) {
    if (!dfw.colsByEntity[n]) dfw.colsByEntity[n] = dfwColsFromEntity(byName[n], dfw.detail || { columns: {}, uniqueColumns: [] });
  });
  dfwRenderMultiAccordions();
}

function dfwRenderMultiAccordions() {
  const box = dfwEl('dfw-review');
  if (!box) return;
  box.innerHTML = dfw.order.map(function (key, oi) {
    const e = dfwEntityByKey(key);
    const cols = dfw.colsByEntity[key] || [];
    const open = true; // every entity expanded on open — the review is the point
    return '<div class="dfw-acc">' +
      '<div class="dfw-acc-head' + (open ? ' open' : '') + '" onclick="dfwToggleAcc(this)"><span class="dfw-caret">&#9654;</span>' +
        dfwEsc(e ? (e.shortName || e.name) : key) + ' <span class="dfw-acc-count">' + cols.length + ' columns · ' + dfwEsc(e ? e.table : '') + '</span></div>' +
      '<div class="dfw-acc-body' + (open ? ' open' : '') + '"><div class="dfw-table-scroll">' + dfwReviewTable(key) + '</div></div></div>';
  }).join('');
}

DFW.dfwToggleAcc = function (head) {
  head.classList.toggle('open');
  const body = head.nextElementSibling;
  if (body) body.classList.toggle('open');
};

function dfwEntityByKey(key) {
  if (!dfw.model) return null;
  return (dfw.model.entities || []).filter(function (e) { return e.name === key; })[0] || null;
}

function dfwReviewTable(key) {
  const cols = dfw.colsByEntity[key] || [];
  const oi = dfw.order.indexOf(key);
  const rows = cols.map(function (c, i) { return dfwColRow(key, oi, i, c); }).join('');
  return '<table class="dfw-review"><thead><tr><th>Field</th><th>Source type</th><th style="width:180px">Generator</th><th>Options</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function dfwGenList() { return DFW.dfgList ? DFW.dfgList() : []; }
function dfwGenMeta(id) {
  const list = dfwGenList();
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return { id: id, label: id, family: 'text', params: [] };
}

function dfwColRow(key, oi, i, c) {
  const editable = dfw.mode === 'manual';
  let field;
  if (editable) field = '<input class="input input-sm" style="width:100%;min-width:120px" value="' + dfwAttr(c.field) + '" onchange="dfwSetField(' + oi + ',' + i + ',this.value)">';
  else {
    field = '<span class="dfw-fld">' + dfwEsc(c.field) + '</span>';
    if (c.isEnum) field += '<span class="dfw-badge dfw-badge-enum">enum</span>';
    if (c.role === 'fk') field += '<span class="dfw-badge dfw-badge-fk">FK</span>';
  }
  const src = '<span class="dfw-src">' + dfwEsc(c.source || 'manual') + '</span>';

  let gen, opts;
  if (c.role === 'fk') {
    gen = '<span style="color:var(--text-muted);font-size:0.72rem">set by link (step 2)</span>';
    opts = '<span style="color:var(--text-muted);font-size:0.72rem">&mdash;</span>';
  } else if (c.role === 'id') {
    gen = dfwGenSelect(oi, i, c.generator, true);
    opts = '<span style="color:var(--text-muted);font-size:0.72rem">auto from MAX(id)+1 (SQL only)</span>';
  } else {
    gen = dfwGenSelect(oi, i, c.generator, false);
    opts = dfwOptionsHtml(key, oi, i, c, editable);
  }
  return '<tr><td>' + field + '</td><td>' + src + '</td><td>' + gen + '</td><td>' + opts + '</td></tr>';
}

function dfwGenSelect(oi, i, sel, disabled) {
  const list = dfwGenList();
  const o = list.map(function (g) { return '<option value="' + dfwAttr(g.id) + '"' + (g.id === sel ? ' selected' : '') + '>' + dfwEsc(g.label) + '</option>'; }).join('');
  return '<select class="select select-sm dfw-gen"' + (disabled ? ' disabled' : '') + ' onchange="dfwSetGen(' + oi + ',' + i + ',this.value)">' + o + '</select>';
}

// The Options cell: render the selected generator's declared params generically,
// then the cross-cutting empty% (+ unique when the column carries a UNIQUE index).
function dfwOptionsHtml(key, oi, i, c, editable) {
  const meta = dfwGenMeta(c.generator);
  let h = '<div class="dfw-opts">';
  meta.params.forEach(function (p) {
    const val = c.params[p.key] !== undefined ? c.params[p.key] : p.default;
    h += dfwParamInput(oi, i, p, val, key);
  });
  // Enum/Custom list also offer a sniff-from-data button in live modes.
  if ((c.isEnum || c.generator === 'Enum' || c.generator === 'Custom list') && dfw.mode !== 'manual' && c.meta) {
    h += '<button class="btn btn-ghost btn-sm dfw-opt-btn" title="SELECT DISTINCT from the live column" onclick="dfwSniff(' + oi + ',' + i + ',this)">&#10515; Sniff</button>';
  }
  // cross-cutting controls, visually grouped to the right of the params
  h += '<span class="dfw-opt-group">' +
    '<label class="dfw-opt"><span>empty %</span><input type="number" class="input input-sm" style="width:58px" min="0" max="100" value="' + (c.emptyPercent || 0) + '" onchange="dfwSetEmpty(' + oi + ',' + i + ',this.value)"></label>' +
    '<label class="dfw-check-inline"><input type="checkbox"' + (c.unique ? ' checked' : '') + ' onchange="dfwSetUnique(' + oi + ',' + i + ',this.checked)"> unique</label>' +
    (editable ? '<button class="btn btn-ghost btn-sm dfw-rmcol" title="Remove column" onclick="dfwRemoveCol(' + oi + ',' + i + ')">Remove</button>' : '') +
    '</span>';
  h += '</div>';
  return h;
}

function dfwParamInput(oi, i, p, val, key) {
  const set = 'onchange="dfwSetParam(' + oi + ',' + i + ',\'' + dfwAttr(p.key) + '\',this.value)"';
  if (p.type === 'select') {
    const o = (p.options || []).map(function (opt) {
      return '<option value="' + dfwAttr(opt.value) + '"' + (String(opt.value) === String(val) ? ' selected' : '') + '>' + dfwEsc(opt.label) + '</option>';
    }).join('');
    return '<label class="dfw-opt"><span>' + dfwEsc(p.label) + '</span><select class="select select-sm" ' + set + '>' + o + '</select></label>';
  }
  if (p.type === 'number') return '<label class="dfw-opt"><span>' + dfwEsc(p.label) + '</span><input type="number" class="input input-sm" style="width:74px" value="' + dfwAttr(val) + '" ' + set + '></label>';
  if (p.type === 'date') return '<label class="dfw-opt"><span>' + dfwEsc(p.label) + '</span><input type="date" class="input input-sm" value="' + dfwAttr(val) + '" ' + set + '></label>';
  // list / weights / text
  const ph = p.type === 'list' ? 'a, b, c' : (p.type === 'weights' ? '1, 2, 1' : '');
  const shown = Array.isArray(val) ? val.join(', ') : (val == null ? '' : val);
  return '<label class="dfw-opt"><span>' + dfwEsc(p.label) + '</span><input type="text" class="input input-sm" style="width:150px" placeholder="' + ph + '" value="' + dfwAttr(shown) + '" ' + set + '></label>';
}

function dfwColAt(oi, i) {
  const key = dfw.order[oi];
  const cols = dfw.colsByEntity[key];
  return cols ? cols[i] : null;
}

DFW.dfwSetGen = function (oi, i, gen) {
  const c = dfwColAt(oi, i);
  if (!c) return;
  c.generator = gen;
  c.params = {};                 // fresh defaults for the new generator
  c.isEnum = gen === 'Enum';
  dfwRenderStep3();
};
DFW.dfwSetParam = function (oi, i, pkey, value) {
  const c = dfwColAt(oi, i);
  if (!c) return;
  const meta = dfwGenMeta(c.generator);
  const pdef = meta.params.filter(function (p) { return p.key === pkey; })[0];
  if (pdef && (pdef.type === 'list' || pdef.type === 'weights')) {
    c.params[pkey] = DFW.dfgToList ? DFW.dfgToList(value) : String(value).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (pkey === 'values') c.enumValues = c.params[pkey];
  } else c.params[pkey] = value;
};
DFW.dfwSetEmpty = function (oi, i, v) { const c = dfwColAt(oi, i); if (c) c.emptyPercent = Math.max(0, Math.min(100, parseInt(v, 10) || 0)); };
DFW.dfwSetUnique = function (oi, i, checked) { const c = dfwColAt(oi, i); if (c) c.unique = !!checked; };
DFW.dfwSetField = function (oi, i, v) { const c = dfwColAt(oi, i); if (c) c.field = v; };
DFW.dfwAddCol = function () {
  const cols = dfw.colsByEntity[SINGLE_KEY] || (dfw.colsByEntity[SINGLE_KEY] = []);
  cols.push(dfwMkCol('Column' + (cols.length + 1), 'manual', 'String'));
  dfwRenderStep3();
};
DFW.dfwRemoveCol = function (oi, i) {
  const key = dfw.order[oi];
  const cols = dfw.colsByEntity[key];
  if (cols) { cols.splice(i, 1); dfwRenderStep3(); }
};

DFW.dfwSniff = async function (oi, i, btn) {
  const c = dfwColAt(oi, i);
  if (!c || !c.meta || !DFW.mtDb) return;
  const key = dfw.order[oi];
  const e = dfwEntityByKey(key);
  const table = dfw.mode === 'single' ? dfw.tableName : (e && e.table);
  if (!table) return;
  const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = 'Sniffing…';
  try {
    const resp = await fetch(DFW_AGENT_URL + '/livedb/distinct', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, DFW.mtDb.getConfig(), { table: table, column: c.meta.column, limit: 50 }))
    });
    const data = await resp.json();
    if (data && !data.error && data.values && data.values.length) {
      c.generator = 'Enum'; c.isEnum = true;
      c.enumValues = data.values.map(String);
      c.params.values = c.enumValues.slice();
      dfwRenderStep3();
      return;
    }
    // Surface the real reason instead of a silent shrug. A 404 here means the
    // running Bridge predates the /livedb/distinct route — it needs a restart.
    let label = 'Empty', title = 'No distinct values found in this column.';
    if (data && data.error) {
      title = data.message || 'Sniff failed.';
      label = /not\s*found/i.test(title) ? 'Restart Bridge' : 'Failed';
    }
    btn.innerHTML = label; btn.title = title;
    setTimeout(function () { btn.disabled = false; btn.innerHTML = old; btn.title = 'SELECT DISTINCT from the live column'; }, 2600);
  } catch (err) {
    btn.innerHTML = 'Failed'; btn.title = String(err && err.message || err);
    setTimeout(function () { btn.disabled = false; btn.innerHTML = old; }, 2600);
  }
};

// =========================================================================
// STEP 4 — OUTPUT
// =========================================================================
const DFW_FORMATS = {
  single: [
    { id: 'csv', name: 'CSV', desc: 'flat file' },
    { id: 'json', name: 'JSON', desc: 'array of rows' },
    { id: 'xml', name: 'XML', desc: 'records' },
    { id: 'sql', name: 'SQL', desc: 'INSERT script' },
    { id: 'mendix-rest', name: 'Mendix REST', desc: '$entityType payload' }
  ],
  multi: [
    { id: 'sql', name: 'SQL', desc: 'linked INSERTs' }
  ]
};
DFW_FORMATS.manual = DFW_FORMATS.single;

function dfwRenderStep4() {
  const list = DFW_FORMATS[dfw.mode] || DFW_FORMATS.single;
  if (!dfw.format || !list.some(function (f) { return f.id === dfw.format; })) dfw.format = list[0].id;
  const sub = dfw.mode === 'multi'
    ? 'Relational sets export as a single linked SQL script.'
    : 'One table exports to any of CSV, JSON, XML, or a SQL INSERT script.';
  const grid = list.map(function (f) {
    return '<button type="button" class="dfw-fmt' + (f.id === dfw.format ? ' sel' : '') + '" onclick="dfwSetFormat(\'' + f.id + '\')">' +
      '<div class="dfw-fmt-name">' + f.name + '</div><div class="dfw-fmt-desc">' + f.desc + '</div></button>';
  }).join('');

  const cntCtl = dfw.mode === 'multi' ? '' :
    '<label class="dfw-mini2">Rows <input type="number" class="input input-sm" style="width:100px" value="' + dfw.count + '" onchange="dfwSetCountFlat(this.value)"></label>';

  const entityTypeCtl = dfw.format === 'mendix-rest'
    ? dfwNote('<strong>$entityType</strong> — the fully qualified entity every object in the payload will be created as.' +
        '<div style="margin-top:var(--sp-2)"><input class="input input-sm" style="width:280px" placeholder="Module.Entity" value="' +
        dfwAttr(dfw.entityType) + '" oninput="dfwSetEntityType(this.value)"></div>', dfw.entityType ? 'info' : 'warn')
    : '';

  dfwEl('dfw-panel').innerHTML =
    '<div class="dfw-head"><h2 class="dfw-title">Output</h2><p class="dfw-sub">' + sub + '</p></div>' +
    '<div class="dfw-fmt-grid">' + grid + '</div>' +
    '<div id="dfw-sqlnote">' + (dfw.format === 'sql' ? dfwSqlNote() : '') + entityTypeCtl + '</div>' +
    '<div class="dfw-subhead" style="margin-top:var(--sp-3)">Preview</div>' +
    '<pre class="dfw-preview" id="dfw-preview"></pre>' +
    '<div style="margin-top:var(--sp-3);display:flex;gap:var(--sp-3);align-items:center;flex-wrap:wrap">' +
      '<button class="btn btn-primary" id="dfw-gen" onclick="dfwGenerate(this)">Generate &amp; download</button>' + cntCtl +
      '<label class="dfw-mini2" style="margin-left:auto" title="Same seed → identical data every run"><input type="checkbox"' + (dfw.repro ? ' checked' : '') +
        ' onchange="dfwSetRepro(this.checked)"> Reproducible <input type="number" class="input input-sm" style="width:70px" value="' + dfw.seed + '"' + (dfw.repro ? '' : ' disabled') + ' onchange="dfwSetSeed(this.value)"></label>' +
    '</div>';
  dfwPreview();
}

function dfwSqlNote() {
  return dfwNote('<strong>You commit — not the tool.</strong> The script opens a transaction and stops <em>before</em> committing, so nothing is saved until you decide. Run it, check the rows, then run <code>COMMIT;</code> when sure — or <code>ROLLBACK;</code>. Ids come from <code>MAX(id)+1</code>: stop the app and use a dev/test database.', 'warn');
}

DFW.dfwSetFormat = function (f) {
  dfw.format = f;
  document.querySelectorAll('.dfw-fmt').forEach(function (b) { b.classList.remove('sel'); });
  dfwRenderStep4();
};
DFW.dfwSetCountFlat = function (v) { dfw.count = Math.max(1, parseInt(v, 10) || 1); dfwPreview(); };
DFW.dfwSetEntityType = function (v) { dfw.entityType = v; dfwPreview(); };
DFW.dfwSetRepro = function (checked) { dfw.repro = !!checked; dfwRenderStep4(); };
DFW.dfwSetSeed = function (v) { dfw.seed = parseInt(v, 10) || 1; };

// ── value generation shared by preview + emit ────────────────────────────
function dfwRawValue(c, rowIndex, rng) {
  if (c.generator === 'Enum' || c.isEnum) {
    return DFW.dfgGenerate('Enum', { values: c.enumValues && c.enumValues.length ? c.enumValues : (c.params.values || []), weights: c.params.weights || [] },
      { rowIndex: rowIndex, emptyPercent: c.emptyPercent }, rng);
  }
  return DFW.dfgGenerate(c.generator, c.params, { rowIndex: rowIndex, unique: c.unique, emptyPercent: c.emptyPercent }, rng);
}

// Flat output columns: everything except the runtime id (a flat file's rows get
// ids when imported) and FK columns (only meaningful in a relational SQL set).
function dfwFlatCols(key) {
  return (dfw.colsByEntity[key] || []).filter(function (c) { return c.role !== 'id' && c.role !== 'fk'; });
}

function dfwPreview() {
  const el = dfwEl('dfw-preview');
  if (!el) return;
  const rng = Math.random; // preview is always a fresh sample
  if (dfw.format === 'sql') { el.textContent = dfwBuildSql(3, true); return; }
  const cols = dfwFlatCols(SINGLE_KEY);
  if (!cols.length) { el.textContent = '(no columns)'; return; }
  const names = cols.map(function (c) { return c.field; });
  const rows = [];
  const n = Math.min(3, dfw.count);
  for (let r = 0; r < n; r++) rows.push(cols.map(function (c) { return dfwRawValue(c, r, rng); }));
  el.textContent = DFW.dfoSerialize(dfw.format, names, rows, { root: 'Data', record: 'Record', entityType: dfw.entityType });
}

// =========================================================================
// GENERATE
// =========================================================================
DFW.dfwGenerate = async function (btn) {
  if (dfw.format === 'sql') { await dfwGenerateSql(btn); return; }
  await dfwGenerateFlat(btn);
};

async function dfwGenerateFlat(btn) {
  const cols = dfwFlatCols(SINGLE_KEY);
  if (!cols.length) { alert('No columns to generate.'); return; }
  const names = cols.map(function (c) { return c.field; });
  const count = dfw.count;
  const rng = dfwRng();
  const old = btn.innerHTML; btn.disabled = true;
  showLoader('Generating… 0%');
  try {
    const rows = new Array(count);
    const CHUNK = 5000;
    for (let start = 0; start < count; start += CHUNK) {
      const end = Math.min(start + CHUNK, count);
      for (let r = start; r < end; r++) rows[r] = cols.map(function (c) { return dfwRawValue(c, r, rng); });
      showLoader('Generating… ' + Math.round((end / count) * 100) + '%');
      await new Promise(function (res) { setTimeout(res, 0); });
    }
    const text = DFW.dfoSerialize(dfw.format, names, rows, { root: 'Data', record: 'Record', entityType: dfw.entityType });
    hideLoader();
    const ext = dfw.format === 'mendix-rest' ? 'json' : dfw.format;
    downloadText(text, 'mock-data.' + ext);
  } catch (e) {
    hideLoader(); alert('Generation failed: ' + e.message);
  } finally { btn.disabled = false; btn.innerHTML = old; }
}

// ── SQL (single + multi) ──────────────────────────────────────────────────
async function dfwGenerateSql(btn) {
  const old = btn.innerHTML; btn.disabled = true;
  showLoader('Building script…');
  try {
    // Multi may need the ONE-side existing ids for "link to existing".
    if (dfw.mode === 'multi') { const ok = await dfwEnsureMultiDetail(); if (!ok) { hideLoader(); btn.disabled = false; btn.innerHTML = old; return; } }
    const script = dfwBuildSql(0, false);
    hideLoader();
    const dbName = (DFW.mtDb && DFW.mtDb.getConfig && DFW.mtDb.getConfig().database) || (dfw.tableName || 'mendix');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadText(script, 'seed-' + dbName + '-' + stamp + '.sql');
  } catch (e) { hideLoader(); alert('Build failed: ' + e.message); }
  finally { btn.disabled = false; btn.innerHTML = old; }
}

// Make sure we have a schema contract covering every table we insert into, plus
// existing-id samples for any parent we link children to but do not generate.
async function dfwEnsureMultiDetail() {
  const byName = {};
  (dfw.model.entities || []).forEach(function (e) { byName[e.name] = e; });
  const tables = [], seen = new Set(), sampleExisting = {};
  function want(t) { if (t && !seen.has(t)) { seen.add(t); tables.push(t); } }
  dfw.order.forEach(function (n) { want(byName[n] && byName[n].table); });
  dfwApplicableAssociations().forEach(function (item) {
    const a = item.assoc, cfg = dfw.assoc[item.index] || {};
    const oneSelected = !!dfw.sel[a.one];
    if (!oneSelected || cfg.useExisting) { const t = byName[a.one] && byName[a.one].table; if (t) { want(t); sampleExisting[t] = 5000; } }
  });
  const detail = await dfwFetchSchema(tables, sampleExisting);
  if (detail.error) { alert(detail.message || 'Could not read the schema.'); return false; }
  // Merge so previously loaded single-table contract is not lost.
  dfw.detail = detail;
  // Rebuild any missing column sets against the fuller contract.
  dfw.order.forEach(function (n) {
    if (!dfw.colsByEntity[n]) dfw.colsByEntity[n] = dfwColsFromEntity(byName[n], detail);
  });
  return true;
}

// Build the whole SQL script. `sampleRows` > 0 → a short preview (no download);
// preview=true also caps each table to `sampleRows`.
function dfwBuildSql(sampleRows, preview) {
  if (dfw.mode === 'multi') return dfwBuildSqlMulti(sampleRows, preview);
  return dfwBuildSqlSingle(sampleRows, preview);
}

function dfwSqlHeader(rowsTotal, tableCount, startId, endId) {
  const dbName = (DFW.mtDb && DFW.mtDb.getConfig && DFW.mtDb.getConfig().database) || '(manual)';
  return [
    '-- =====================================================================',
    '-- Test data generated by MxDev Swiss Tool — Data Factory',
    '-- Database : ' + dbName,
    '-- Generated: ' + new Date().toISOString(),
    '-- Rows     : ' + rowsTotal + ' across ' + tableCount + ' table' + (tableCount === 1 ? '' : 's'),
    (startId ? '-- Id range : ' + startId + '–' + endId + ' (single global counter, from MAX(id)+1)' : '-- Ids     : none (no id column)'),
    '--',
    '-- BEFORE YOU RUN THIS:',
    '--   1. STOP the Mendix app — ids come from MAX(id)+1 and a running runtime',
    '--      would allocate the same ids and collide.',
    '--   2. Run ONLY against a dev/test database you can reset.',
    '--   3. This bypasses the runtime: no microflows or before-commit logic run.',
    '--',
    '-- Everything runs in ONE transaction this script does NOT commit. Run it,',
    '-- check the rows, then COMMIT yourself (or ROLLBACK). Nothing is saved until you do.',
    '-- =====================================================================',
    '',
    'BEGIN;'
  ].join('\n');
}

const DFW_SQL_FOOTER = [
  '',
  '-- =====================================================================',
  '-- REVIEW, THEN COMMIT YOURSELF — nothing above is saved yet.',
  '--   COMMIT;     -- keep the data',
  '--   ROLLBACK;   -- discard everything',
  '-- =====================================================================',
  '-- COMMIT;',
  '-- ROLLBACK;',
  ''
].join('\n');

// A pseudo-contract for manual columns so seedSqlLiteral can type the value.
function dfwMetaFor(c) {
  if (c.meta) return c.meta;
  const fam = DFW.dfgFamily ? DFW.dfgFamily(c.generator) : 'text';
  const map = { text: 'text', number: 'exact', bool: 'bool', date: 'date', uuid: 'uuid' };
  return { family: map[fam] || 'text', numericScale: 0, maxLength: null };
}

function dfwBuildSqlSingle(sampleRows, preview) {
  const cols = dfw.colsByEntity[SINGLE_KEY] || [];
  if (!cols.length) return '(no columns)';
  const table = dfw.tableName || 'my_table';
  const rng = preview ? Math.random : dfwRng();
  const detail = dfw.detail || {};
  const startId = Number(detail.startId) || null;
  const count = preview ? Math.min(sampleRows || 3, dfw.count) : dfw.count;
  const idBase = startId || 1;

  // Physical column contract for the table (live single mode; empty for manual).
  const cm = {};
  ((detail.columns || {})[table] || []).forEach(function (c) {
    cm[String(c.column).toLowerCase()] = { column: c.column, family: DFW.seedColumnFamily(c),
      isNullable: c.isNullable, hasDefault: c.hasDefault, maxLength: c.maxLength, numericScale: c.numericScale, dataType: c.dataType, udtName: c.udtName };
  });

  // Emit list: id + reviewed columns, then any required NOT-NULL-without-default
  // system column the review did not cover (createddate/changeddate…). Level 0:
  // owner / changedBy are left to the database (never given an invented user id).
  const emit = [];
  const used = new Set();
  cols.forEach(function (c) {
    const key = String(c.field).toLowerCase();
    if (used.has(key)) return;
    emit.push(c.role === 'id' ? { role: 'id', field: c.field } : { role: 'attr', field: c.field, col: c, meta: c.meta || dfwMetaFor(c) });
    used.add(key);
  });
  ((detail.columns || {})[table] || []).forEach(function (c) {
    const key = String(c.column).toLowerCase();
    if (used.has(key)) return;
    const meta = cm[key];
    if (!meta || meta.family === 'binary') return;
    if (/^(owner|changedby)$/i.test(c.column)) { used.add(key); return; }
    if (meta.isNullable === 'NO' && !meta.hasDefault) { emit.push({ role: 'system', field: meta.column, meta: meta }); used.add(key); }
  });

  const colNames = emit.map(function (x) { return x.field; });
  const rows = [];
  for (let r = 0; r < count; r++) {
    rows.push(emit.map(function (x) {
      if (x.role === 'id') return String(idBase + r);
      if (x.role === 'system') return DFW.seedSqlLiteral(dfwSystemValue(x.meta, rng, r), x.meta);
      return DFW.seedSqlLiteral(dfwRawValue(x.col, r, rng), x.meta || dfwMetaFor(x.col));
    }));
  }
  const insert = DFW.seedInsertStatement(table, colNames, rows);
  const parts = [dfwSqlHeader(count, 1, startId, startId ? (idBase + count - 1) : null),
    '', '-- ' + table + '  (' + count + ' rows)', insert];
  if (preview) return parts.join('\n') + '\n' + (count < dfw.count ? '-- …' + (dfw.count - count) + ' more rows\n' : '') + DFW_SQL_FOOTER;
  return parts.join('\n') + '\n' + DFW_SQL_FOOTER;
}

// Multi: reuse the relational maths (topo already in dfw.order; skewed FK
// distribution; Level-0 owner/changedBy; uniqueness) but drive per-column
// generators from the wizard's reviewed columns.
function dfwBuildSqlMulti(sampleRows, preview) {
  const model = dfw.model;
  const byName = {};
  (model.entities || []).forEach(function (e) { byName[e.name] = e; });
  const detail = dfw.detail || { columns: {}, existingIds: {}, startId: 1 };
  const columnsByTable = detail.columns || {};
  const existingIds = detail.existingIds || {};
  const rng = preview ? Math.random : dfwRng();

  // id pools on one shared counter, parents before children (dfw.order).
  let nextId = Number(detail.startId) || 1;
  const startId = nextId;
  const idPool = {};
  dfw.order.forEach(function (n) {
    const count = dfw.sel[n] ? dfw.sel[n].count : 0;
    const ids = new Array(count);
    for (let i = 0; i < count; i++) ids[i] = nextId++;
    idPool[n] = ids;
  });

  // FK assignment per applicable association.
  const fkByEntity = {};
  dfw.order.forEach(function (n) { fkByEntity[n] = []; });
  const apps = dfwApplicableAssociations();
  const cmCache = {};
  function colMap(table) {
    if (cmCache[table]) return cmCache[table];
    const map = {};
    (columnsByTable[table] || []).forEach(function (c) {
      map[String(c.column).toLowerCase()] = { column: c.column, family: DFW.seedColumnFamily(c), isNullable: c.isNullable, hasDefault: c.hasDefault, maxLength: c.maxLength, numericScale: c.numericScale, dataType: c.dataType, udtName: c.udtName };
    });
    cmCache[table] = map;
    return map;
  }
  for (let ai = 0; ai < apps.length; ai++) {
    const a = apps[ai].assoc;
    if (!dfw.sel[a.many] || dfw.sel[a.many].count <= 0) continue;
    const cfg = dfw.assoc[apps[ai].index] || { mode: 'skew', skew: 1.1, orphanPct: 20, useExisting: false };
    const manyTable = byName[a.many].table;
    const fkMeta = colMap(manyTable)[String(a.columns[0]).toLowerCase()] || { column: a.columns[0], family: 'bigint', isNullable: 'YES' };
    const nullable = fkMeta.isNullable !== 'NO';
    let oneIds = [];
    const oneSelected = !!(dfw.sel[a.one] && dfw.sel[a.one].count > 0);
    if (oneSelected) oneIds = oneIds.concat(idPool[a.one] || []);
    if (!oneSelected || cfg.useExisting) { const t = byName[a.one] && byName[a.one].table; oneIds = oneIds.concat((existingIds[t] || []).map(Number)); }
    if (!oneIds.length) { if (!nullable) return '-- Cannot build: ' + dfwShort(a.many) + ' → ' + dfwShort(a.one) + ' is required but has no parent rows.'; continue; }
    const assignment = DFW.seedDistribute(oneIds, dfw.sel[a.many].count, {
      mode: cfg.mode, cardinality: a.cardinality === '1-1' ? '1-1' : '1-*',
      optional: nullable, nullFraction: nullable ? 0.05 : 0, orphanFraction: (cfg.orphanPct || 0) / 100, skew: cfg.skew
    }, rng);
    fkByEntity[a.many].push({ column: fkMeta.column, meta: fkMeta, values: assignment });
  }

  // Emit, parents first.
  const parts = [];
  let rowsTotal = 0;
  dfw.order.forEach(function (n) { rowsTotal += dfw.sel[n] ? dfw.sel[n].count : 0; });
  parts.push(dfwSqlHeader(rowsTotal, dfw.order.length, startId, nextId - 1));

  dfw.order.forEach(function (n) {
    const e = byName[n];
    const table = e.table;
    const cm = colMap(table);
    const reviewed = dfw.colsByEntity[n] || [];
    const used = new Set();
    const emit = [];
    // id
    emit.push({ role: 'id', field: (cm.id ? cm.id.column : 'id') });
    used.add('id');
    // reviewed attrs (skip the id row we already added)
    reviewed.forEach(function (c) {
      const key = String(c.field).toLowerCase();
      if (used.has(key) || c.role === 'id') return;
      emit.push({ role: 'attr', field: c.column || c.field, col: c, meta: c.meta || cm[key] });
      used.add(key);
    });
    // FK columns
    (fkByEntity[n] || []).forEach(function (fk) {
      const key = String(fk.column).toLowerCase();
      if (used.has(key)) return;
      emit.push({ role: 'fk', field: fk.column, meta: fk.meta, values: fk.values });
      used.add(key);
    });
    // remaining NOT-NULL-without-default system columns (Level 0 owner/changedBy → NULL)
    (columnsByTable[table] || []).forEach(function (c) {
      const key = String(c.column).toLowerCase();
      if (used.has(key)) return;
      const meta = cm[key];
      if (!meta || meta.family === 'binary') return;
      if (/^(owner|changedby)$/i.test(c.column)) { used.add(key); return; }
      if (meta.isNullable === 'NO' && !meta.hasDefault) { emit.push({ role: 'system', field: meta.column, meta: meta }); used.add(key); }
    });

    const ids = idPool[n];
    const count = preview ? Math.min(sampleRows || 2, dfw.sel[n].count) : dfw.sel[n].count;
    const colNames = emit.map(function (x) { return x.field; });
    const rowsLit = [];
    for (let r = 0; r < count; r++) {
      rowsLit.push(emit.map(function (x) {
        if (x.role === 'id') return String(ids[r]);
        if (x.role === 'fk') return DFW.seedSqlLiteral(x.values[r], x.meta);
        if (x.role === 'system') return DFW.seedSqlLiteral(dfwSystemValue(x.meta, rng, r), x.meta);
        return DFW.seedSqlLiteral(dfwRawValue(x.col, r, rng), x.meta || dfwMetaFor(x.col));
      }));
    }
    parts.push('', '-- ' + n + '  (' + dfw.sel[n].count + ' rows)', DFW.seedInsertStatement(table, colNames, rowsLit));
    if (preview && count < dfw.sel[n].count) parts.push('-- …' + (dfw.sel[n].count - count) + ' more rows');
  });
  if (dfw._cyclic && dfw._cyclic.length) parts.push('', '-- NOTE: dependency cycle among ' + dfw._cyclic.map(dfwShort).join(', ') + ' — review back-reference FKs.');
  parts.push(DFW_SQL_FOOTER);
  return parts.join('\n');
}

function dfwSystemValue(meta, rng, rowIndex) {
  switch (meta.family) {
    case 'date': return DFW.dfgGenerate('Date', {}, { rowIndex: rowIndex || 0 }, rng);
    case 'bool': return false;
    case 'int': case 'bigint': case 'exact': case 'float': return 0;
    case 'uuid': return DFW.dfgGenerate('UUID', {}, {}, rng);
    default: return '';
  }
}

// =========================================================================
// RESET + INIT
// =========================================================================
DFW.dfwReset = function () {
  dfw.model = null; dfw.module = ''; dfw.filter = '';
  dfw.sel = {}; dfw.assoc = {}; dfw.detail = null;
  if (dfw.mode !== 'manual') { dfw.colsByEntity = {}; dfw.order = []; dfw.tableName = ''; dfw.entityType = ''; }
  if (dfw.step === 2) dfwRenderStep2();
};

export function init() {
  const root = dfwEl('dfw-root');
  if (!root) return;
  if (!root.dataset.dfwReady) {
    root.dataset.dfwReady = '1';
    dfwRender();
  }
}
