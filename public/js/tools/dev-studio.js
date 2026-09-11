// DEVELOPER STUDIO (Module L)

let dsPollTimer = null;
let dsIsConnected = false;
let dsProjectData = null;
let dsProjectsList = [];
let dsReconnectAttempts = 0;

// ── Auto-reconnect with backoff (12.11) ─────────────────────────────────────
// Before this, once connected the poll loop only ever re-ran auto-detect
// while DISconnected — nothing ever checked the Bridge was still there, so a
// Bridge restart left the dashboard showing stale data forever, silently.
const DS_POLL_INTERVAL_MS = 3000;
const DS_BACKOFF_MAX_MS = 30000;

// Exponential, not fixed-interval retry — a Bridge that's down for a while
// (a rebuild, a crash needing a manual restart) shouldn't get hammered every
// 3s indefinitely. Capped at 30s so a quick restart is still picked up soon.
function dsBackoffDelay(attempts) {
  return Math.min(DS_BACKOFF_MAX_MS, 1000 * Math.pow(2, attempts));
}

// Lightweight liveness probe — /status (already used elsewhere in the app,
// e.g. the topbar Bridge indicator) rather than re-running the heavier
// /detect-project auto-detect flow just to check the Bridge is still up.
async function dsCheckAlive() {
  try {
    const res = await fetch('http://localhost:9999/status');
    return res.ok;
  } catch (e) {
    return false;
  }
}

function dsSetReconnecting(isReconnecting, attempts) {
  const indicator = document.getElementById('ds-status-indicator');
  const note = document.getElementById('ds-status-note');
  if (indicator) {
    indicator.style.background = isReconnecting ? 'var(--warning)' : 'var(--success)';
    indicator.style.boxShadow = isReconnecting ? '0 0 8px var(--warning)' : '0 0 8px var(--success)';
  }
  if (note) {
    if (isReconnecting) {
      note.textContent = 'Bridge unreachable — retrying (attempt ' + attempts + ')…';
      note.style.display = 'block';
    } else {
      note.style.display = 'none';
    }
  }
}

async function dsAutoDetectProject() {
  if (dsIsConnected) return;

  try {
    const res = await fetch('http://localhost:9999/detect-project');
    if (!res.ok) return;
    const data = await res.json();
    
    const selectEl = document.getElementById('ds-detected-projects');
    if (!selectEl) return;
    
    if (data && data.success && data.projects && data.projects.length > 0) {
      dsProjectsList = data.projects;
      
      const currentVal = selectEl.value;
      selectEl.innerHTML = '';
      
      data.projects.forEach((p, idx) => {
        const name = p.metadata?.ProjectName || p.projectName || 'Mendix App';
        const opt = document.createElement('option');
        opt.value = idx;
        opt.textContent = `${name} (${p.projectRoot})`;
        selectEl.appendChild(opt);
      });
      
      if (currentVal && selectEl.querySelector(`option[value="${currentVal}"]`)) {
         selectEl.value = currentVal;
      }
    } else {
      selectEl.innerHTML = '<option value="">No running apps detected...</option>';
      dsProjectsList = [];
    }
  } catch (e) {
    console.warn("Autodetection failed:", e);
  }
}

window.dsConnectAction = async function() {
  const manualPath = document.getElementById('ds-manual-path')?.value.trim();
  const selectEl = document.getElementById('ds-detected-projects');
  
  showLoader("Connecting to Mendix App...");
  try {
    let selectedData = null;
    
    if (manualPath) {
      // Manual override path provided, fetch from bridge via POST
      const res = await fetch('http://localhost:9999/detect-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectRoot: manualPath })
      });
      const data = await res.json();
      if (data && data.success && data.projects && data.projects.length > 0) {
        selectedData = data.projects[0];
      } else {
        window.mtToast("Could not load project metadata from the specified path. Ensure the path points to the root of the Mendix project.", 'error');
        hideLoader();
        return;
      }
    } else if (selectEl && selectEl.value !== "") {
      selectedData = dsProjectsList[parseInt(selectEl.value)];
    }
    
    if (selectedData) {
      // Connect to the selected data
      dsProjectData = {
        success: true,
        metadata: selectedData.metadata,
        config: selectedData.config,
        deploymentPath: selectedData.deploymentPath,
        projectRoot: selectedData.projectRoot,
        adminPassword: selectedData.adminPassword
      };
      
      dsIsConnected = true;
      dsShowDashboard();
      dsRenderDetectedProject();
      dsPollData(); // Immediately poll stats
    } else {
      window.mtToast("No project selected or found.", 'warning');
    }
  } catch(e) {
    console.error("Connection error:", e);
    window.mtToast("Connection failed. Ensure the Mendix Observability Bridge is running.", 'error');
  }
  hideLoader();
};

function dsRenderDetectedProject() {
  if (!dsProjectData || !dsProjectData.success) return;
  const meta = dsProjectData.metadata || {};
  const config = dsProjectData.config || {};
  
  // Header
  document.getElementById('ds-status-proj-name').textContent = meta.ProjectName || 'Mendix App';
  document.getElementById('ds-status-proj-ver').textContent = meta.RuntimeVersion || '11.x';
  
  // App Config
  document.getElementById('ds-proj-path').textContent = dsProjectData.projectRoot || '—';
  document.getElementById('ds-project-id').textContent = meta.ProjectID || '—';
  document.getElementById('ds-java-ver').textContent = meta.JavaVersion ? `Java ${meta.JavaVersion}` : '—';
  document.getElementById('ds-admin-user').textContent = meta.AdminUser || 'MxAdmin';
  
  // Database Configuration
  const dbType = (config.Configuration?.DatabaseType || 'HSQLDB').toUpperCase();
  document.getElementById('ds-db-type').textContent = dbType;
  document.getElementById('ds-db-name').textContent = config.Configuration?.DatabaseName || '—';
  document.getElementById('ds-db-host').textContent = config.Configuration?.DatabaseHost || '—';
  document.getElementById('ds-db-user').textContent = config.Configuration?.DatabaseUserName || '—';
  
  // User Roles
  const rolesList = document.getElementById('ds-roles-list');
  if (rolesList) {
    rolesList.innerHTML = '';
    const roles = Object.values(meta.Roles || {});
    if (roles.length > 0) {
      roles.forEach(r => {
        const badge = document.createElement('span');
        badge.className = 'badge badge-primary';
        badge.style.fontSize = '0.8rem';
        badge.textContent = r.Name;
        rolesList.appendChild(badge);
      });
    } else {
      rolesList.innerHTML = '<span style="color:var(--text-muted);font-size:0.85rem">No custom user roles defined.</span>';
    }
  }
  
  // Request Handlers
  const handlersList = document.getElementById('ds-handlers-list');
  if (handlersList) {
    handlersList.innerHTML = '';
    const handlers = meta.RequestHandlers || [];
    if (handlers.length > 0) {
      handlers.forEach(h => {
        const badge = document.createElement('span');
        badge.className = 'badge badge-info';
        badge.style.fontSize = '0.8rem';
        badge.textContent = h.Name;
        handlersList.appendChild(badge);
      });
    } else {
      handlersList.innerHTML = '<span style="color:var(--text-muted);font-size:0.85rem">No custom request handlers.</span>';
    }
  }
  
  // Scheduled Events
  const eventsList = document.getElementById('ds-events-list');
  if (eventsList) {
    eventsList.innerHTML = '';
    const events = meta.ScheduledEvents || [];
    if (events.length > 0) {
      // `Interval` and `Unit` were rendered here for a long time and are not in
      // this file — surveyed across 13 local applications and 84 scheduled
      // events, Mendix 9 through 11, the only keys ever present are `Name` and
      // `Description`. Every event therefore read "undefined undefined". The
      // schedule itself lives in the model, not in the deployment metadata, so
      // the honest card shows what is here and says where the rest is.
      events.forEach(e => {
        const item = document.createElement('div');
        item.style.display = 'flex';
        item.style.flexDirection = 'column';
        const desc = e.Description
          ? `<span style="color:var(--text-muted);font-size:0.78rem">${escHtml(e.Description)}</span>`
          : '';
        item.innerHTML = `<span style="font-family:var(--font-mono);font-size:0.8rem">${escHtml(e.Name || '(unnamed)')}</span>${desc}`;
        eventsList.appendChild(item);
      });
      const note = document.createElement('div');
      note.style.cssText = 'margin-top:var(--sp-2);padding-top:var(--sp-2);border-top:1px dashed var(--border);color:var(--text-muted);font-size:0.75rem';
      note.textContent = 'Interval and start time are not part of the deployment metadata — open the event in Studio Pro for its schedule.';
      eventsList.appendChild(note);
    } else {
      eventsList.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem">No scheduled events defined.</div>';
    }
  }
  
  // Constants
  const constantsTbody = document.getElementById('ds-constants-tbody');
  if (constantsTbody) {
    constantsTbody.innerHTML = '';
    const constants = meta.Constants || [];
    if (constants.length > 0) {
      constants.forEach(c => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td><strong style="color:var(--text-primary)">${escHtml(c.Name)}</strong></td>
          <td><span class="badge badge-secondary">${escHtml(c.Type)}</span></td>
          <td style="font-family:var(--font-mono);font-size:0.85rem">${escHtml(c.DefaultValue || '—')}</td>
        `;
        constantsTbody.appendChild(row);
      });
    } else {
      constantsTbody.innerHTML = `
        <tr>
          <td colspan="3" style="text-align:center;color:var(--text-muted);padding:var(--sp-3)">
            No constants defined in this application.
          </td>
        </tr>
      `;
    }
  }
  
  // Database Live Metrics triggering (if PostgreSQL)
  if (dbType === 'POSTGRESQL') {
    document.getElementById('ds-db-metrics-section').style.display = 'block';
    document.getElementById('ds-db-metrics-warning').style.display = 'none';
    dsFetchDbDetails();
  } else {
    document.getElementById('ds-db-metrics-section').style.display = 'none';
    document.getElementById('ds-db-metrics-warning').style.display = 'block';
  }

  dsFetchProjectInsights();
  dsFetchDeploymentModel();

  if (dsProjectData && dsProjectData.projectRoot) {
    DS_MODEL_PATH_INPUTS.forEach(id => {
      const input = document.getElementById(id);
      if (input && !input.value) input.value = dsProjectData.projectRoot;
    });
  }
}

// ── Deployment model ────────────────────────────────────────────────────────
// Reads the index the Bridge builds from `deployment/model/` and publishes it
// on window._mxOpsIndex, where the SQL-facing tools pick it up through
// mxOpsForTable/mxPagesForEntity. Everything downstream degrades to exactly
// what it renders today when this never runs, so a failure here is quiet by
// design — but the CARD is not: it says what is missing and what to do, rather
// than showing an empty box.
async function dsFetchDeploymentModel() {
  const box = document.getElementById('ds-model-body');
  if (!dsProjectData || !dsProjectData.projectRoot || !box) return;
  const esc = window.escHtml;
  try {
    const res = await fetch('http://localhost:9999/model/deployment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectRoot: dsProjectData.projectRoot })
    });
    const data = await res.json();

    if (!data || data.error || !data.ok) {
      window._mxOpsIndex = null;
      const reason = (data && (data.reason || data.message)) || 'Could not read the deployment model.';
      box.innerHTML = `<div class="notice notice-warning" style="font-size:0.8rem">${esc(reason)}</div>`;
      return;
    }

    window._mxOpsIndex = data.index;
    const c = data.index.counts;
    // Which file the retrieves came from is worth showing: Mendix 9 keeps them
    // in queries.json and Mendix 10+ in operations.json, so a user comparing
    // two apps sees why the numbers are shaped differently.
    const source = data.source.queries
      ? `operations.json + queries.json (${data.source.operations} + ${data.source.queries})`
      : `operations.json (${data.source.operations})`;
    box.innerHTML = `
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:var(--sp-2) var(--sp-4)">
        <div><span style="color:var(--text-muted)">Operations:</span> <strong style="color:var(--text-primary)">${c.operations}</strong></div>
        <div><span style="color:var(--text-muted)">Entities:</span> <strong style="color:var(--text-primary)">${c.entities}</strong></div>
        <div><span style="color:var(--text-muted)">Pages:</span> <strong style="color:var(--text-primary)">${c.pages}</strong></div>
        <div><span style="color:var(--text-muted)">Microflows:</span> <strong style="color:var(--text-primary)">${c.microflows}</strong></div>
      </div>
      <div style="margin-top:var(--sp-3); color:var(--text-muted); font-size:0.78rem">
        Read from <span style="font-family:var(--font-mono)">${esc(source)}</span>.
        Query tools can now name the screens behind a table.
      </div>`;
  } catch (e) {
    window._mxOpsIndex = null;
    box.innerHTML = `<div class="notice notice-warning" style="font-size:0.8rem">Bridge unreachable — the deployment model could not be read.</div>`;
  }
}

// ── Model analyses on the .mpr (plans 006/007/014/008) ──────────────────────
// The Project File card and the Dead Code / Integrations / Modules views read
// the project file through the bridge — no database, no running app — and
// reflect its LAST SAVED state. Their path fields move together (analysing in
// one fills the others), and the bridge reuses its read of the same file for a
// minute, so moving between views does not re-read a large project. A failure
// stays inside the view that asked. The result styling lives in
// styles/main.css under "Model analysis results" (.mx-*).
const DS_MODEL_PATH_INPUTS = ['ds-mpr-path', 'ds-deadcode-path', 'ds-integrations-path', 'ds-modules-path', 'ds-navigate-path'];
// Marketplace modules are hidden from Dead Code and Modules until asked for:
// their unused parts and their coupling are not the app team's to fix.
let dsShowMarketplace = false;
let dsDeadData = null;
let dsDeadFilter = { type: null, q: '' };
let dsModData = null;

// The trimmed path from one field, without the double quotes Explorer's "Copy
// as path" adds — and copied into the other model fields.
function dsModelPath(inputId) {
  const input = document.getElementById(inputId);
  const raw = input ? input.value.trim().replace(/^"(.*)"$/, '$1').trim() : '';
  if (raw) {
    DS_MODEL_PATH_INPUTS.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = raw;
    });
  }
  return raw;
}

// Validates the path, shows progress, POSTs it to a /model/* route and renders
// the answer — or the bridge's reason — into the view's body.
async function dsRunModelView(inputId, boxId, route, render) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const esc = window.escHtml;
  const raw = dsModelPath(inputId);
  if (!raw) {
    box.innerHTML = `<div class="notice notice-warning" style="font-size:0.8rem">Enter a path to a .mpr file or the project folder.</div>`;
    return;
  }
  box.innerHTML = `<span style="color:var(--text-muted)"><span class="spinner-sm"></span>Reading ${esc(raw)}&hellip; the first read of a large project can take up to a minute.</span>`;
  let data;
  try {
    const res = await fetch('http://localhost:9999' + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mprPath: raw })
    });
    data = await res.json();
  } catch (e) {
    box.innerHTML = `<div class="notice notice-warning" style="font-size:0.8rem">Bridge unreachable — the .mpr could not be read.</div>`;
    return;
  }
  if (!data || data.error || !data.ok) {
    const reason = (data && (data.reason || data.message)) || 'Could not read the .mpr.';
    box.innerHTML = `<div class="notice notice-warning" style="font-size:0.8rem">${esc(reason)}</div>`;
    return;
  }
  box.innerHTML = render(data);
}

// ── Shared result pieces ────────────────────────────────────────────────────
// A stat tile. With `onclick` it is a button (a filter or a jump to a section).
function dsStat(o) {
  const esc = window.escHtml;
  const cls = 'mx-stat' + (o.tone ? ' is-' + o.tone : '') + (o.active ? ' is-active' : '');
  const inner = `<span class="mx-stat-value">${esc(String(o.value))}</span>
      <span class="mx-stat-label">${esc(o.label)}</span>
      ${o.sub ? `<span class="mx-stat-sub">${esc(o.sub)}</span>` : ''}`;
  return o.onclick
    ? `<button type="button" class="${cls}" onclick="${o.onclick}"${o.active !== undefined ? ` aria-pressed="${o.active ? 'true' : 'false'}"` : ''}>${inner}</button>`
    : `<div class="${cls}">${inner}</div>`;
}

function dsChip(text, cls, title) {
  const esc = window.escHtml;
  return `<span class="mx-chip${cls ? ' ' + cls : ''}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
}

function dsMethod(m) {
  const v = String(m || '?').toLowerCase().replace(/[^a-z?]/g, '');
  return `<span class="mx-method m-${v}">${v.toUpperCase()}</span>`;
}

// cols: [{ label, cls }] — cls ('mono' | 'num') styles the column's cells.
// rows: [[cellHtml, …]] — cells arrive escaped.
function dsTable(cols, rows) {
  return `<div class="mx-table-wrap"><table class="mx-table">
      <thead><tr>${cols.map(c => `<th${c.cls === 'num' ? ' class="num"' : ''}>${c.label}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map((cell, i) => `<td${cols[i].cls ? ` class="${cols[i].cls}"` : ''}>${cell}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
}

function dsSection(id, title, count, inner) {
  return `<section class="mx-section" id="${id}">
      <h5 class="mx-section-title">${title} <span class="count">(${count})</span></h5>
      ${inner}
    </section>`;
}

function dsScrollTo(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// A unit the reader could not decode hides the references inside it.
function dsUndecodedNote(data) {
  const n = data.undecoded || 0;
  return n ? `<div class="notice notice-warning" style="font-size:0.8rem">${n} unit${n === 1 ? '' : 's'} of the model could not be decoded &mdash; references inside ${n === 1 ? 'it are' : 'them are'} missing, so double-check anything listed here.</div>` : '';
}

function dsMarketplaceToggle(hidden) {
  return `<label style="display:inline-flex; align-items:center; gap:6px; font-size:0.78rem; color:var(--text-secondary); cursor:pointer">
      <input type="checkbox" ${dsShowMarketplace ? 'checked' : ''} onchange="dsSetMarketplace(this.checked)">
      Include Marketplace modules${hidden ? ` <span style="color:var(--text-muted)">(${hidden} hidden)</span>` : ''}
    </label>`;
}

function dsSetMarketplace(show) {
  dsShowMarketplace = !!show;
  const dead = document.getElementById('ds-deadcode-body');
  if (dsDeadData && dead) dead.innerHTML = dsDeadRender(dsDeadData);
  const mod = document.getElementById('ds-modules-body');
  if (dsModData && mod) mod.innerHTML = dsModRender(dsModData);
  const loops = document.getElementById('ds-nav-loops-wrap');
  if (dsNavLoops && loops) loops.innerHTML = dsNavLoopsHtml();
}

// ── Project file (.mpr) card (plan 006) ──────────────────────────────────────
// Properties left at their Mendix default are not shown because Mendix does not
// store them.
function dsFetchMprModel() {
  return dsRunModelView('ds-mpr-path', 'ds-mpr-body', '/model/mpr', dsMprRender);
}

function dsMprRender(data) {
  const esc = window.escHtml;
  const c = data.counts || {};
  const s = data.security;
  const chips = [];
  if (s) {
    if (s.securityLevel) chips.push(dsChip('Security: ' + s.securityLevel));
    chips.push(s.enableGuestAccess ? dsChip('Guest access on', 'is-warn') : dsChip('Guest access off'));
    chips.push(dsChip('Strict mode ' + (s.strictMode ? 'on' : 'off')));
    if (s.adminPasswordSet) chips.push(dsChip('Admin password stored in the model', 'is-warn'));
    if (s.passwordPolicy && typeof s.passwordPolicy.minimumLength === 'number' && s.passwordPolicy.minimumLength < 8) {
      chips.push(dsChip('Weak password policy (min length ' + s.passwordPolicy.minimumLength + ')', 'is-warn'));
    }
    (s.userRoles || []).filter(r => r.manageAllRoles).forEach(r => chips.push(dsChip('Manages all roles: ' + r.name, 'mono')));
  }
  return `
    <div class="mx-stats" style="grid-template-columns:repeat(auto-fill, minmax(110px, 1fr))">
      ${dsStat({ value: c.modules || 0, label: 'Modules', sub: c.marketplaceModules ? c.marketplaceModules + ' from Marketplace' : '' })}
      ${dsStat({ value: c.entities || 0, label: 'Entities' })}
      ${dsStat({ value: c.microflows || 0, label: 'Microflows' })}
      ${dsStat({ value: c.pages || 0, label: 'Pages' })}
    </div>
    ${chips.length ? `<div class="mx-chips" style="margin-top:var(--sp-3)">${chips.join('')}</div>` : ''}
    <div class="mx-note" style="margin-top:var(--sp-3)">
      Mendix ${esc(data.productVersion || '—')} &middot; format v${data.formatVersion} &middot; read straight from
      <span style="font-family:var(--font-mono)">${esc(data.projectName)}.mpr</span> — last saved state, no database or local run needed.
    </div>`;
}

// ── Dead code — model elements nothing references (plan 007) ────────────────
// The check errs toward "alive" and cannot see Java / JavaScript code, so this
// view leads with that caveat and never offers a delete action. Results are
// grouped by module; the tiles filter by kind and the field by name.
const DS_DEAD_GROUPS = [
  ['MICROFLOW', 'Microflows', 'microflow'],
  ['NANOFLOW', 'Nanoflows', 'nanoflow'],
  ['PAGE', 'Pages', 'page'],
  ['SNIPPET', 'Snippets', 'snippet'],
  ['ENTITY', 'Entities', 'entity']
];
const DS_DEAD_UNCERTAIN_KIND = {
  ENUMERATION: 'enumeration', CONSTANT: 'constant', JAVA_ACTION: 'Java action', JS_ACTION: 'JavaScript action'
};
// Only this many module groups start expanded; the rest open on a click.
const DS_DEAD_OPEN_GROUPS = 8;

function dsFetchDeadCode() {
  return dsRunModelView('ds-deadcode-path', 'ds-deadcode-body', '/model/dead-code', data => {
    dsDeadData = data;
    dsDeadFilter = { type: null, q: '' };
    return dsDeadRender(data);
  });
}

// Marketplace filter only.
function dsDeadVisible(data) {
  const market = new Set(data.marketplace || []);
  const keep = d => dsShowMarketplace || !market.has(d.module);
  return { dead: (data.dead || []).filter(keep), uncertain: (data.uncertain || []).filter(keep) };
}

// Marketplace filter + the kind tile + the name field.
function dsDeadFiltered() {
  const { dead, uncertain } = dsDeadVisible(dsDeadData);
  const f = dsDeadFilter;
  const q = f.q.trim().toLowerCase();
  const match = d => !q || d.qualifiedName.toLowerCase().indexOf(q) !== -1;
  return {
    items: f.type === 'UNCERTAIN' ? [] : dead.filter(d => (!f.type || d.objectType === f.type) && match(d)),
    unc: (!f.type || f.type === 'UNCERTAIN') ? uncertain.filter(match) : []
  };
}

function dsDeadStats() {
  const data = dsDeadData;
  const { dead, uncertain } = dsDeadVisible(data);
  const totals = (data.counts || {}).elementsByType || {};
  const market = (data.counts || {}).elementsByTypeMarketplace || {};
  const tiles = DS_DEAD_GROUPS.map(([type, label]) => {
    const total = (totals[type] || 0) - (dsShowMarketplace ? 0 : (market[type] || 0));
    if (!total) return '';
    return dsStat({
      value: dead.filter(d => d.objectType === type).length, label: label, sub: 'unused of ' + total,
      onclick: `dsDeadSetType('${type}')`, active: dsDeadFilter.type === type
    });
  });
  if (uncertain.length) {
    tiles.push(dsStat({
      value: uncertain.length, label: 'To verify', sub: 'enums, constants, actions', tone: 'warn',
      onclick: `dsDeadSetType('UNCERTAIN')`, active: dsDeadFilter.type === 'UNCERTAIN'
    }));
  }
  return tiles.join('');
}

function dsDeadList() {
  const esc = window.escHtml;
  const { dead, uncertain } = dsDeadVisible(dsDeadData);
  const { items, unc } = dsDeadFiltered();
  if (!items.length && !unc.length) {
    const hidden = (dsDeadData.dead || []).length - dead.length;
    const msg = (dead.length + uncertain.length)
      ? 'Nothing matches the filter.'
      : 'Nothing unreferenced was found' + (hidden ? ' outside the Marketplace modules' : '') + '.';
    return `<div class="notice" style="font-size:0.8rem">${msg}</div>`;
  }
  const order = {};
  DS_DEAD_GROUPS.forEach(([t], i) => { order[t] = i; });
  const single = {};
  DS_DEAD_GROUPS.forEach(([t, , one]) => { single[t] = one; });
  const market = new Set(dsDeadData.marketplace || []);

  const byMod = {};
  items.forEach(d => { (byMod[d.module] = byMod[d.module] || []).push(d); });
  const mods = Object.keys(byMod).sort((a, b) => byMod[b].length - byMod[a].length || a.localeCompare(b));
  const groups = mods.map((m, i) => {
    const list = byMod[m].slice().sort((a, b) => order[a.objectType] - order[b.objectType] || a.qualifiedName.localeCompare(b.qualifiedName));
    const kinds = DS_DEAD_GROUPS.map(([t, label]) => {
      const n = list.filter(d => d.objectType === t).length;
      return n ? dsChip(n + ' ' + (n === 1 ? single[t] : label.toLowerCase())) : '';
    }).join('');
    const rows = list.map(d => [
      esc(d.qualifiedName.slice(m.length + 1)),
      esc(single[d.objectType] || d.objectType),
      d.reason === 'prefix suggests entry point'
        ? dsChip('entry point?', 'is-warn', 'The name prefix suggests it is called from outside the model — check before deleting')
        : ''
    ]);
    return `<details class="mx-group"${i < DS_DEAD_OPEN_GROUPS ? ' open' : ''}>
      <summary>
        <span class="mx-group-title mono">${esc(m)}</span>
        ${market.has(m) ? dsChip('Marketplace', 'is-muted') : ''}
        <span class="mx-chips">${kinds}</span>
        <span class="mx-group-count">${list.length}</span>
      </summary>
      <div class="mx-group-body">${dsTable([{ label: 'Element', cls: 'mono' }, { label: 'Kind' }, { label: '' }], rows)}</div>
    </details>`;
  }).join('');

  const uncHtml = unc.length ? `<details class="mx-group"${dsDeadFilter.type === 'UNCERTAIN' ? ' open' : ''}>
      <summary>
        <span class="mx-group-title">Enumerations, constants &amp; code actions to verify</span>
        <span class="mx-group-count">${unc.length}</span>
      </summary>
      <div class="mx-group-body">
        <div class="mx-note" style="margin-bottom:var(--sp-2)">Nothing in the model uses these, but Java or JavaScript code can without the model showing it &mdash; verify before deleting.</div>
        ${dsTable([{ label: 'Element', cls: 'mono' }, { label: 'Kind' }],
          unc.map(u => [esc(u.qualifiedName), DS_DEAD_UNCERTAIN_KIND[u.objectType] || u.objectType]))}
      </div>
    </details>` : '';

  return `<div style="display:flex; flex-direction:column; gap:var(--sp-2)">${groups}${uncHtml}</div>`;
}

function dsDeadRender(data) {
  const esc = window.escHtml;
  const counts = data.counts || {};
  const { dead, uncertain } = dsDeadVisible(data);
  const hidden = (data.dead || []).length + (data.uncertain || []).length - dead.length - uncertain.length;
  return `
    <div style="display:flex; flex-direction:column; gap:var(--sp-3)">
      ${dsUndecodedNote(data)}
      <div class="mx-stats" id="ds-dead-stats">${dsDeadStats()}</div>
      <div class="mx-toolbar">
        <input type="search" class="input" id="ds-dead-q" placeholder="Filter by name or module&hellip;" aria-label="Filter the dead-code list"
          value="${esc(dsDeadFilter.q)}" oninput="dsDeadSetQuery(this.value)" style="flex:1; min-width:180px; max-width:340px; font-size:0.8rem">
        ${(data.marketplace || []).length ? dsMarketplaceToggle(dsShowMarketplace ? 0 : hidden) : ''}
        ${dead.length + uncertain.length ? `<button class="btn btn-secondary" style="font-size:0.75rem; padding:2px 10px; margin-left:auto" onclick="dsDeadCopy()">Copy list</button>` : ''}
      </div>
      <div id="ds-dead-list">${dsDeadList()}</div>
      <div class="mx-note">${counts.elements || 0} elements and ${counts.refs || 0} references checked in the last saved
        <span style="font-family:var(--font-mono)">${esc(data.projectName || '')}.mpr</span>.</div>
    </div>`;
}

function dsDeadRefresh(withStats) {
  const list = document.getElementById('ds-dead-list');
  if (list) list.innerHTML = dsDeadList();
  const stats = document.getElementById('ds-dead-stats');
  if (withStats && stats) stats.innerHTML = dsDeadStats();
}

function dsDeadSetType(type) {
  if (!dsDeadData) return;
  dsDeadFilter.type = dsDeadFilter.type === type ? null : type;
  dsDeadRefresh(true);
}

function dsDeadSetQuery(q) {
  if (!dsDeadData) return;
  dsDeadFilter.q = q || '';
  dsDeadRefresh(false);
}

// What is on screen, tab-separated, so it pastes into a spreadsheet or a
// ticket as a table.
function dsDeadCopy() {
  if (!dsDeadData) return;
  const { items, unc } = dsDeadFiltered();
  const rows = items.concat(unc).map(d => d.objectType + '\t' + d.qualifiedName + '\t' + d.reason);
  window.copyToClipboard(['Type\tElement\tReason'].concat(rows).join('\n'));
  if (window.mtToast) window.mtToast(`Copied ${rows.length} rows.`, 'success');
}

// ── Integrations (plan 014) ─────────────────────────────────────────────────
// The audit-surface inventory: what the app publishes and whether it asks for
// sign-in, and where its microflows call out to — with any password or token
// typed straight into a microflow flagged (the value is never sent here).
function dsFetchIntegrations() {
  return dsRunModelView('ds-integrations-path', 'ds-integrations-body', '/model/integrations', dsIntRender);
}

// Sign-in status, then the allowed roles.
function dsIntAuth(s, types) {
  const chips = [];
  if (!s.authenticated) {
    chips.push(dsChip('No sign-in required', 'is-warn', 'Requires authentication: No — anyone who can reach the app can call it'));
  } else {
    chips.push(dsChip('Sign-in: ' + (types.length ? types.join(', ') : 'required'), 'is-ok'));
  }
  if (s.noRoles) chips.push(dsChip('No allowed roles', 'is-danger', 'Sign-in is required but no role may call it, so every call is refused'));
  (s.allowedRoles || []).forEach(r => chips.push(dsChip(r, 'mono is-muted', 'Allowed role')));
  if (s.authenticationMicroflow) chips.push(dsChip('auth microflow: ' + s.authenticationMicroflow, 'mono'));
  return `<div class="mx-chips">${chips.join('')}</div>`;
}

function dsIntService(s, meta, auth, table) {
  const esc = window.escHtml;
  return `<div class="card" style="padding:var(--sp-3) var(--sp-4); display:flex; flex-direction:column; gap:var(--sp-2)">
      <div style="display:flex; flex-wrap:wrap; align-items:baseline; gap:var(--sp-2)">
        <strong style="color:var(--text-primary)">${esc(s.name || '(unnamed)')}</strong>
        ${meta ? `<span style="font-family:var(--font-mono); font-size:0.74rem; color:var(--text-muted)">${esc(meta)}</span>` : ''}
      </div>
      ${auth}
      ${table}
    </div>`;
}

function dsIntRender(data) {
  const esc = window.escHtml;
  const rest = data.publishedRest || [];
  const odata = data.publishedOData || [];
  const soap = data.publishedSoap || [];
  const calls = data.restCalls || [];
  const consumed = data.consumedRest || [];
  const events = data.businessEvents || [];

  const total = rest.length + odata.length + soap.length + calls.length + consumed.length + events.length;
  if (total === 0) {
    return `${dsUndecodedNote(data)}<div class="notice" style="font-size:0.82rem">No published services, outgoing REST calls or Business Events were found in <span style="font-family:var(--font-mono)">${esc(data.projectName || '')}.mpr</span>. Consumed SOAP and OData services are not covered by this view.</div>`;
  }

  const published = rest.concat(odata, soap);
  const open = published.filter(s => !s.authenticated).length;
  const secrets = calls.filter(c => c.hardcodedCredentials).length;
  const byTarget = {};
  for (const c of calls) (byTarget[c.target] = byTarget[c.target] || []).push(c);
  const targets = Object.keys(byTarget);
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const opsOf = list => list.reduce((n, s) => n + (s.operationCount != null ? s.operationCount : (s.operations || []).length), 0);

  const stats = [
    rest.length ? dsStat({ value: rest.length, label: 'Published REST', sub: plural(opsOf(rest), 'operation', 'operations'), onclick: "dsScrollTo('ds-int-rest')" }) : '',
    odata.length ? dsStat({ value: odata.length, label: 'Published OData', sub: plural(odata.reduce((n, s) => n + (s.entitySets || []).length, 0), 'entity set', 'entity sets'), onclick: "dsScrollTo('ds-int-odata')" }) : '',
    soap.length ? dsStat({ value: soap.length, label: 'Published SOAP', sub: plural(opsOf(soap), 'operation', 'operations'), onclick: "dsScrollTo('ds-int-soap')" }) : '',
    published.length ? dsStat({ value: open, label: 'No sign-in required', sub: open ? 'anyone can call' : 'every service asks for sign-in', tone: open ? 'warn' : 'ok' }) : '',
    calls.length ? dsStat({ value: calls.length, label: 'Outgoing REST calls', sub: plural(targets.length, 'target', 'targets'), onclick: "dsScrollTo('ds-int-calls')" }) : '',
    calls.length ? dsStat({ value: secrets, label: 'Credentials in microflows', sub: secrets ? 'typed in as text' : 'none typed in', tone: secrets ? 'danger' : 'ok' }) : '',
    consumed.length ? dsStat({ value: consumed.length, label: 'Consumed REST', onclick: "dsScrollTo('ds-int-consumed')" }) : '',
    events.length ? dsStat({ value: events.length, label: 'Business Events', onclick: "dsScrollTo('ds-int-events')" }) : ''
  ].join('');

  const restHtml = rest.map(s => {
    const rows = [];
    (s.resources || []).forEach(r => (r.operations || []).forEach(o => rows.push([
      dsMethod(o.httpMethod),
      esc('/' + [r.name, o.path].filter(Boolean).join('/')),
      esc(o.microflow || '—')
    ])));
    const meta = '/' + (s.path || '') + (s.version ? ' · v' + s.version : '');
    return dsIntService(s, meta, dsIntAuth(s, s.authenticationTypes || []),
      rows.length ? dsTable([{ label: 'Method' }, { label: 'Resource', cls: 'mono' }, { label: 'Microflow', cls: 'mono' }], rows) : '');
  }).join('');

  const odataHtml = odata.map(s => {
    const rows = (s.entitySets || []).map(e => [esc(e.name || '—'), esc(e.entity || '—')]);
    const meta = '/' + (s.path || '') + (s.odataVersion ? ' · ' + s.odataVersion : '');
    return dsIntService(s, meta, dsIntAuth(s, s.authenticationTypes || []),
      rows.length ? dsTable([{ label: 'Entity set', cls: 'mono' }, { label: 'Entity', cls: 'mono' }], rows) : '');
  }).join('');

  const soapHtml = soap.map(s => {
    const rows = (s.operations || []).map(o => [esc(o.name || '—'), esc(o.microflow || '—')]);
    return dsIntService(s, s.caption || '', dsIntAuth(s, s.headerAuthentication ? [s.headerAuthentication] : []),
      rows.length ? dsTable([{ label: 'Operation', cls: 'mono' }, { label: 'Microflow', cls: 'mono' }], rows) : '');
  }).join('');

  // Outgoing calls, grouped by where they go; a group carrying credentials opens.
  const callsHtml = targets.map(t => {
    const list = byTarget[t];
    const flagged = list.some(c => c.hardcodedCredentials);
    const rows = list.map(c => [
      dsMethod(c.httpMethod),
      esc(c.location || '—') + ((c.locationParams || []).length
        ? `<span class="sub">${c.locationParams.map((p, i) => '{' + (i + 1) + '} = ' + esc(p)).join(' &middot; ')}</span>` : ''),
      esc(c.microflow),
      c.hardcodedCredentials ? dsChip('credentials in microflow', 'is-danger', 'A password or token is typed into this microflow as text') : ''
    ]);
    return `<details class="mx-group"${flagged || targets.length <= 3 ? ' open' : ''}>
      <summary>
        <span class="mx-group-title mono">${esc(t)}</span>
        ${flagged ? dsChip('credentials in microflow', 'is-danger') : ''}
        <span class="mx-group-count">${plural(list.length, 'call', 'calls')}</span>
      </summary>
      <div class="mx-group-body">${dsTable([{ label: 'Method' }, { label: 'URL', cls: 'mono' }, { label: 'Microflow', cls: 'mono' }, { label: '' }], rows)}</div>
    </details>`;
  }).join('');

  const consumedHtml = consumed.length ? dsTable(
    [{ label: 'Service' }, { label: 'Base URL', cls: 'mono' }, { label: 'Authentication' }, { label: 'Operations', cls: 'num' }],
    consumed.map(s => [
      esc(s.name || '(unnamed)'),
      esc(s.baseUrl || '—') + (s.baseUrlIsReference ? ' ' + dsChip('Constant', 'is-muted') : ''),
      esc(s.authenticationScheme || '—'),
      String((s.operations || []).length)
    ])) : '';

  const eventsHtml = events.length ? dsTable(
    [{ label: 'Service' }, { label: 'Channels' }, { label: 'Messages' }],
    events.map(s => [
      esc(s.name || '(unnamed)') + (s.eventNamePrefix ? `<span class="sub">${esc(s.eventNamePrefix)}</span>` : ''),
      `<div class="mx-chips">${(s.channels || []).map(c => dsChip(c.name || '(channel)', 'mono')).join('')}</div>`,
      `<div class="mx-chips">${(s.messages || []).map(m => dsChip(m.name || '(message)', 'mono')).join('')}</div>`
    ])) : '';

  const list = (html) => `<div style="display:flex; flex-direction:column; gap:var(--sp-2)">${html}</div>`;
  return `
    <div style="display:flex; flex-direction:column; gap:var(--sp-4)">
      ${dsUndecodedNote(data)}
      <div class="mx-stats">${stats}</div>
      ${secrets ? `<div class="notice notice-warning" style="font-size:0.82rem">${plural(secrets, 'outgoing REST call has', 'outgoing REST calls have')} a password or token typed straight into the microflow. It travels with the model into version control and every deployment package &mdash; move it to a constant or a secret store. The value is not shown here.</div>` : ''}
      ${open ? `<div class="notice notice-warning" style="font-size:0.82rem">${plural(open, 'published service is', 'published services are')} set to <strong>Requires authentication: No</strong> &mdash; anyone who can reach the app can call ${open === 1 ? 'it' : 'them'}. Right for a public API; worth confirming otherwise.</div>` : ''}
      ${rest.length ? dsSection('ds-int-rest', 'Published REST', rest.length, list(restHtml)) : ''}
      ${odata.length ? dsSection('ds-int-odata', 'Published OData', odata.length, list(odataHtml)) : ''}
      ${soap.length ? dsSection('ds-int-soap', 'Published SOAP', soap.length, list(soapHtml)) : ''}
      ${calls.length ? dsSection('ds-int-calls', 'Outgoing REST calls', calls.length, list(callsHtml)) : ''}
      ${consumed.length ? dsSection('ds-int-consumed', 'Consumed REST services', consumed.length, consumedHtml) : ''}
      ${events.length ? dsSection('ds-int-events', 'Business Events', events.length, eventsHtml) : ''}
      <div class="mx-note">Read from the last saved <span style="font-family:var(--font-mono)">${esc(data.projectName || '')}.mpr</span> — a URL built from a Constant shows the Constant, not its per-environment value.</div>
    </div>`;
}

// ── Modules (plan 008) ──────────────────────────────────────────────────────
// The reference graph (same walk as Dead Code), collapsed to modules: dependency
// cycles with the lightest links inside each (where to start untangling),
// topological layers, orphan modules and cross-module inheritance — the hard
// blocker for a split. Behavioural, not the association diagram in Domain
// Model & Architecture.
function dsFetchModules() {
  return dsRunModelView('ds-modules-path', 'ds-modules-body', '/model/modules', data => {
    dsModData = data;
    return dsModRender(data);
  });
}

function dsModRender(data) {
  const esc = window.escHtml;
  const c = data.counts || {};
  const market = new Set(data.marketplace || []);
  const mine = (m) => dsShowMarketplace || !market.has(m);
  const modChip = (m) => market.has(m) ? dsChip(m, 'mono is-muted', 'Marketplace module') : dsChip(m, 'mono');
  const card = (title, count, inner) => `<div class="card" style="padding:var(--sp-3) var(--sp-4); display:flex; flex-direction:column; gap:var(--sp-2)">
      <h5 class="mx-section-title">${esc(title)}${count == null ? '' : ` <span class="count">(${count})</span>`}</h5>
      ${inner}
    </div>`;

  const cycles = data.cycles || [];
  const edges = data.edges || [];
  const largest = cycles.reduce((n, g) => Math.max(n, g.length), 0);
  const blockers = (data.blockers || []).filter(b => mine(b.fromModule));
  const orphans = (data.orphans || []).filter(mine);

  const stats = [
    dsStat({ value: c.modules || 0, label: 'Modules', sub: market.size ? market.size + ' from Marketplace' : '' }),
    dsStat({ value: c.edges || 0, label: 'Module dependencies', sub: 'one module using another' }),
    dsStat({ value: cycles.length, label: 'Dependency cycles', sub: cycles.length ? 'largest: ' + largest + ' modules' : 'none', tone: cycles.length ? 'warn' : 'ok' }),
    dsStat({ value: blockers.length, label: 'Inheritance blockers', tone: blockers.length ? 'warn' : 'ok' }),
    dsStat({ value: orphans.length, label: 'Orphan modules' })
  ].join('');

  // Each cycle: its members, then its lightest links — the cheapest places to
  // start breaking it — with an element-level example of each.
  const cycleBlock = (g) => {
    const set = new Set(g);
    const links = edges.filter(e => set.has(e.from) && set.has(e.to))
      .sort((a, b) => a.count - b.count || (a.from + a.to).localeCompare(b.from + b.to))
      .slice(0, 8)
      .map(e => {
        const s = (e.samples || [])[0];
        return [
          esc(e.from) + ' &rarr; ' + esc(e.to),
          String(e.count),
          esc((e.kinds || []).join(', ')),
          s ? esc(s.from) + ' &rarr; ' + esc(s.to) : ''
        ];
      });
    return `<div style="display:flex; flex-direction:column; gap:var(--sp-2)">
        <div class="mx-chips">${g.slice().sort().map(modChip).join('')}</div>
        ${links.length ? `<div class="mx-note">Lightest dependencies inside this cycle &mdash; the cheapest ones to remove when untangling it:</div>
          ${dsTable([{ label: 'Dependency', cls: 'mono' }, { label: 'References', cls: 'num' }, { label: 'Kind' }, { label: 'For example', cls: 'mono' }], links)}` : ''}
      </div>`;
  };
  const cyclesHtml = card('Dependency cycles', cycles.length || null, cycles.length
    ? cycles.map(cycleBlock).join('<hr style="border:0; border-top:1px solid var(--border-subtle); margin:var(--sp-2) 0">') +
      `<div class="mx-note">Modules in a cycle deploy and version together &mdash; none can be extracted without the others. A Marketplace module in a cycle usually means it was customised to use your modules.</div>`
    : `<div class="mx-note">No dependency cycles.</div>`);

  const blockersHtml = blockers.length ? card('Inheritance blockers', blockers.length,
    dsTable([{ label: 'Entity', cls: 'mono' }, { label: 'Extends', cls: 'mono' }, { label: 'Cannot be split without a data migration' }],
      blockers.map(b => [esc(b.from), esc(b.to), esc(b.fromModule) + ' &harr; ' + esc(b.toModule)]))) : '';

  const layers = data.layers || {};
  const byLayer = {};
  Object.keys(layers).filter(mine).forEach(m => { (byLayer[layers[m]] = byLayer[layers[m]] || []).push(m); });
  const layerNums = Object.keys(byLayer).map(Number).sort((a, b) => a - b);
  const maxLayer = layerNums.length ? layerNums[layerNums.length - 1] : 0;
  const layersHtml = layerNums.length ? card('Layers', null,
    dsTable([{ label: 'Layer' }, { label: 'Modules' }], layerNums.map(n => [
      `<span style="white-space:nowrap">${n === 0 ? 'Foundational' : (n === maxLayer ? 'Leaf' : 'Layer ' + n)}</span>`,
      `<div class="mx-chips">${byLayer[n].sort().map(modChip).join('')}</div>`
    ])) + `<div class="mx-note">Layer 0 references nothing outside itself; each step up depends on the layer below. Modules in one cycle share a layer.</div>`) : '';

  const orphansHtml = orphans.length ? card('Orphan modules', orphans.length,
    `<div class="mx-chips">${orphans.map(modChip).join('')}</div>
     <div class="mx-note">No reference edge either way. A pluggable widget, a theme or Java code can still use them without the model showing it.</div>`) : '';

  const cohesion = (data.cohesion || []).filter(r => mine(r.module));
  const cohesionHtml = cohesion.length ? card('Cohesion', null,
    `<div class="mx-note">Share of a module's references that stay inside it &mdash; low means entangled with other modules.</div>` +
    dsTable([{ label: 'Module', cls: 'mono' }, { label: 'Internal', cls: 'num' }, { label: 'External', cls: 'num' }, { label: 'Cohesion', cls: 'num' }],
      cohesion.map(r => {
        const pct = r.cohesionPct;
        const tone = pct == null ? '' : (pct < 34 ? ' is-low' : (pct < 67 ? ' is-mid' : ' is-high'));
        return [
          esc(r.module),
          String(r.intra),
          String(r.inter),
          pct == null ? '—' : `<span class="mx-bar${tone}" aria-hidden="true"><span style="width:${pct}%"></span></span> ${pct}%`
        ];
      }))) : '';

  return `
    <div style="display:flex; flex-direction:column; gap:var(--sp-3)">
      ${dsUndecodedNote(data)}
      <div class="mx-stats">${stats}</div>
      ${market.size ? `<div class="mx-toolbar">${dsMarketplaceToggle(dsShowMarketplace ? 0 : market.size)}</div>` : ''}
      ${cyclesHtml}
      ${blockersHtml}
      ${layersHtml}
      ${orphansHtml}
      ${cohesionHtml}
      <div class="mx-note">Read from the last saved <span style="font-family:var(--font-mono)">${esc(data.projectName || '')}.mpr</span> — the behavioural reference graph, not the association diagram.</div>
    </div>`;
}

// ── Navigate (plan 011) ─────────────────────────────────────────────────────
// Callers / callees / impact / context for one element over the bridge's
// PRECISE reference graph (a property value that names an element, never a
// caption), and the database queries repeated inside loops. Analyse loads the
// element list and the loop check together; each question afterwards is one
// small call against the bridge's cached read. Clicks go through one delegated
// handler on the view body (names and query buttons carry data-* attributes).
const DS_NAV_ROW_CAP = 1000;
const DS_NAV_KINDS = {
  call: 'calls', retrieve: 'retrieves', create: 'creates', change: 'changes', delete: 'deletes',
  commit: 'commits', show_page: 'opens', action: 'button', menu_item: 'menu', home_page: 'home page',
  schedule: 'scheduled event', settings: 'project settings', datasource: 'data source',
  generalize: 'generalizes', associate: 'association', calculate: 'calculated attribute',
  event_handler: 'event handler', parameter: 'parameter', type: 'variable type', expression: 'expression',
  xpath: 'XPath', attribute: 'attribute', snippet: 'snippet', layout: 'layout', mapping: 'mapping',
  publish: 'published', ref: 'uses'
};
const DS_NAV_TYPES = {
  MICROFLOW: 'microflow', NANOFLOW: 'nanoflow', PAGE: 'page', SNIPPET: 'snippet', ENTITY: 'entity',
  ASSOCIATION: 'association', ENUMERATION: 'enumeration', CONSTANT: 'constant', JAVA_ACTION: 'Java action',
  JS_ACTION: 'JavaScript action', OTHER: 'other'
};
const DS_NAV_QUERIES = [['callers', 'Callers'], ['callees', 'Callees'], ['impact', 'Impact'], ['context', 'Context']];
let dsNavPath = '';
let dsNavData = null;          // the `elements` answer
let dsNavTypeOf = new Map();   // qualified name -> objectType
let dsNavLoops = null;         // the `loops` answer
let dsNavQuery = 'callers';
let dsNavSeq = 0;              // the newest request wins; older answers are dropped

async function dsNavPost(body) {
  const res = await fetch('http://localhost:9999/model/refs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

function dsNavNotice(html) {
  return `<div class="notice notice-warning" style="font-size:0.8rem">${html}</div>`;
}

async function dsNavLoad() {
  const box = document.getElementById('ds-navigate-body');
  if (!box) return;
  const esc = window.escHtml;
  const raw = dsModelPath('ds-navigate-path');
  if (!raw) {
    box.innerHTML = dsNavNotice('Enter a path to a .mpr file or the project folder.');
    return;
  }
  const ticket = ++dsNavSeq;
  box.innerHTML = `<span style="color:var(--text-muted)"><span class="spinner-sm"></span>Reading ${esc(raw)}&hellip; the first read of a large project can take up to a minute.</span>`;
  let answers;
  try {
    answers = await Promise.all([
      dsNavPost({ mprPath: raw, query: 'elements' }),
      dsNavPost({ mprPath: raw, query: 'loops' })
    ]);
  } catch (e) {
    if (ticket === dsNavSeq) box.innerHTML = dsNavNotice('Bridge unreachable — the .mpr could not be read.');
    return;
  }
  if (ticket !== dsNavSeq) return;
  const bad = answers.find(d => !d || d.error || !d.ok);
  if (bad) {
    box.innerHTML = dsNavNotice(esc((bad && (bad.reason || bad.message)) || 'Could not read the .mpr.'));
    return;
  }
  dsNavPath = raw;
  dsNavData = answers[0];
  dsNavLoops = answers[1];
  dsNavTypeOf = new Map((dsNavData.elements || []).map(e => [e.qn, e.type]));
  box.onclick = dsNavClick;
  box.onkeydown = function (e) {
    if (e.key === 'Enter' && e.target && e.target.id === 'ds-nav-element') dsNavRun(dsNavQuery);
  };
  box.innerHTML = dsNavRender();
}

function dsNavClick(e) {
  const t = e.target && e.target.closest ? e.target.closest('[data-nav-qn],[data-nav-query]') : null;
  if (!t) return;
  if (t.dataset.navQuery) { dsNavRun(t.dataset.navQuery); return; }
  dsNavRun(dsNavQuery, t.dataset.navQn);
  const controls = document.getElementById('ds-nav-controls');
  if (controls) controls.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function dsNavVisibleFindings() {
  const market = new Set((dsNavData && dsNavData.marketplace) || []);
  return ((dsNavLoops && dsNavLoops.findings) || []).filter(f => dsShowMarketplace || !market.has(f.microflow.split('.')[0]));
}

function dsNavRender() {
  const esc = window.escHtml;
  const data = dsNavData;
  const s = data.stats || {};
  const loops = dsNavVisibleFindings();
  const stats = [
    dsStat({ value: s.elements || 0, label: 'Elements' }),
    dsStat({ value: s.edges || 0, label: 'References', sub: s.system ? s.system + ' more into System' : '' }),
    dsStat({ value: s.unresolved || 0, label: 'Unresolved references', sub: (s.unresolvedPct || 0) + '% of all', tone: s.unresolved ? 'warn' : 'ok' }),
    dsStat({ value: loops.length, label: 'Queries in loops', tone: loops.length ? 'warn' : 'ok', onclick: loops.length ? "dsScrollTo('ds-nav-loops')" : '' })
  ].join('');
  const samples = (s.unresolvedSamples || []).slice(0, 5);
  const unresolvedNote = s.unresolved ? `<div class="mx-note">Unresolved: a reference property naming something that is not in the model, e.g. ${samples.map(x => `<span style="font-family:var(--font-mono)">${esc(x.from)} &rarr; ${esc(x.value)}</span>`).join(', ')}. Results are a lower bound.</div>` : '';
  const options = (data.elements || []).map(e => `<option value="${esc(e.qn)}">${esc(DS_NAV_TYPES[e.type] || e.type)}</option>`).join('');
  const buttons = DS_NAV_QUERIES.map(([q, label]) =>
    `<button type="button" class="btn btn-secondary" style="font-size:0.8rem" data-nav-query="${q}" aria-pressed="${q === dsNavQuery ? 'true' : 'false'}">${label}</button>`).join('');
  return `
    <div style="display:flex; flex-direction:column; gap:var(--sp-3)">
      ${dsUndecodedNote(data)}
      <div class="mx-stats">${stats}</div>
      ${unresolvedNote}
      <div class="card" id="ds-nav-controls" style="padding:var(--sp-3) var(--sp-4); display:flex; flex-direction:column; gap:var(--sp-3)">
        <div class="mx-toolbar" style="flex-wrap:wrap">
          <input type="text" id="ds-nav-element" list="ds-nav-elements" autocomplete="off" placeholder="Element — type part of a name, e.g. ACT_Save"
            style="flex:1; min-width:240px; font-family:var(--font-mono); font-size:0.78rem; padding:var(--sp-2); background:var(--bg-base); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--text-primary)">
          <datalist id="ds-nav-elements">${options}</datalist>
          <label style="display:inline-flex; align-items:center; gap:6px; font-size:0.78rem; color:var(--text-secondary)">Depth
            <select id="ds-nav-depth" style="font-size:0.78rem">
              <option value="">Direct (Impact: all levels)</option>
              <option value="2">2 levels</option>
              <option value="3">3 levels</option>
              <option value="5">5 levels</option>
              <option value="0">All levels</option>
            </select>
          </label>
          ${buttons}
        </div>
        <div id="ds-nav-result"><span style="color:var(--text-muted)">Pick an element, then press Callers, Callees, Impact or Context.</span></div>
      </div>
      <div id="ds-nav-loops-wrap">${dsNavLoopsHtml()}</div>
      <div class="mx-note">Read from the last saved <span style="font-family:var(--font-mono)">${esc(data.projectName || '')}.mpr</span>. Only values that name an element count — captions, documentation and excluded documents do not.</div>
    </div>`;
}

// The "Database queries in loops" section — hidden when the check found none.
function dsNavLoopsHtml() {
  const esc = window.escHtml;
  const all = (dsNavLoops && dsNavLoops.findings) || [];
  if (!all.length) return '';
  const market = new Set((dsNavData && dsNavData.marketplace) || []);
  const shown = dsNavVisibleFindings().slice().sort((a, b) => a.microflow.localeCompare(b.microflow) || a.id.localeCompare(b.id));
  const rows = shown.map(f => [
    dsChip(f.id, f.id === 'PERF03' ? 'mono is-warn' : 'mono'),
    dsNavName(f.microflow),
    `<span style="font-family:var(--font-mono)">${f.loop === 'while' ? 'while loop' : 'each ' + esc(f.loop)}</span>`,
    f.id === 'PERF02'
      ? `retrieves ${f.entity ? dsNavName(f.entity) : 'from the database'}${f.count > 1 ? ` <span style="color:var(--text-muted)">(${f.count} places)</span>` : ''}`
      : `calls ${f.chain.map(dsNavName).join(' &rarr; ')} &mdash; ${f.what === 'commit' ? 'commits' : 'retrieves'} ${f.entity ? dsNavName(f.entity) : ''}`
  ]);
  const inner = `
    ${market.size ? `<div class="mx-toolbar">${dsMarketplaceToggle(dsShowMarketplace ? 0 : market.size)}</div>` : ''}
    ${rows.length
      ? dsTable([{ label: 'Check' }, { label: 'Microflow', cls: 'mono' }, { label: 'Loop' }, { label: 'Query on every iteration' }], rows)
      : `<div class="mx-note">None in your own modules &mdash; tick <em>Include Marketplace modules</em> to see the ${all.length} in Marketplace modules.</div>`}
    <div class="mx-note"><strong>PERF02</strong> &mdash; a retrieve from the database inside a loop: one query per iteration. <strong>PERF03</strong> &mdash; a loop calls a microflow that, directly or further down its calls, retrieves from the database or commits: the same cost, hidden behind the call. Studio Pro's Best Practice check looks at one microflow at a time and flags neither. Association retrieves are left out.</div>`;
  return dsSection('ds-nav-loops', 'Database queries in loops', shown.length, inner);
}

// An element name that re-centres the current question on it when clicked; a
// project-level document (`Navigation$NavigationDocument`) is plain text.
function dsNavName(qn) {
  const esc = window.escHtml;
  if (dsNavTypeOf.has(qn)) {
    return `<button type="button" data-nav-qn="${esc(qn)}" style="background:none; border:0; padding:0; cursor:pointer; color:var(--accent); font-family:var(--font-mono); font-size:0.8rem; text-align:left">${esc(qn)}</button>`;
  }
  const s = String(qn || '');
  const label = s.indexOf('$') !== -1 ? s.split('$')[1].replace(/([a-z])([A-Z])/g, '$1 $2') : s;
  return `<span style="font-family:var(--font-mono); font-size:0.8rem; color:var(--text-secondary)">${esc(label)}</span>`;
}

function dsNavTypeChip(qn) {
  const t = dsNavTypeOf.get(qn);
  const market = new Set((dsNavData && dsNavData.marketplace) || []);
  return (t ? dsChip(DS_NAV_TYPES[t] || t, 'is-muted') : dsChip('project', 'is-muted')) +
    (market.has(String(qn).split('.')[0]) ? dsChip('Marketplace', 'is-muted') : '');
}

// items: [{ qn, kinds, depth, via }] from a breadth-first walk rooted at `root`,
// drawn as an indented tree — each element once, under the one it was first
// reached from.
function dsNavTree(root, items) {
  const kids = new Map();
  for (const it of items) {
    if (!kids.has(it.via)) kids.set(it.via, []);
    kids.get(it.via).push(it);
  }
  for (const list of kids.values()) list.sort((a, b) => a.qn.localeCompare(b.qn));
  const rows = [];
  const stack = (kids.get(root) || []).slice().reverse();
  while (stack.length && rows.length < DS_NAV_ROW_CAP) {
    const it = stack.pop();
    rows.push(it);
    const ch = kids.get(it.qn);
    if (ch) for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]);
  }
  const html = rows.map(it => `<div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:2px 0 2px ${(it.depth - 1) * 18}px">
      ${it.depth > 1 ? '<span style="color:var(--text-muted)">&#8627;</span>' : ''}
      ${it.kinds.map(k => dsChip(DS_NAV_KINDS[k] || k, 'is-muted')).join('')}
      ${dsNavName(it.qn)}
      ${dsNavTypeChip(it.qn)}
    </div>`).join('');
  const more = items.length > rows.length ? `<div class="mx-note">Showing the first ${rows.length} of ${items.length}.</div>` : '';
  return `<div style="display:flex; flex-direction:column">${html}</div>${more}`;
}

async function dsNavRun(query, qn) {
  const out = document.getElementById('ds-nav-result');
  const input = document.getElementById('ds-nav-element');
  if (!out || !input || !dsNavData) return;
  const esc = window.escHtml;
  if (query) dsNavQuery = query;
  if (qn) input.value = qn;
  document.querySelectorAll('#ds-nav-controls [data-nav-query]').forEach(b => {
    b.setAttribute('aria-pressed', b.dataset.navQuery === dsNavQuery ? 'true' : 'false');
  });
  const element = input.value.trim();
  if (!element) {
    out.innerHTML = dsNavNotice('Pick an element first &mdash; type part of its name and choose it from the list.');
    return;
  }
  if (!dsNavTypeOf.has(element)) {
    out.innerHTML = dsNavNotice(`No element named <span style="font-family:var(--font-mono)">${esc(element)}</span> in ${esc(dsNavData.projectName || 'this project')} &mdash; choose one from the list.`);
    return;
  }
  const body = { mprPath: dsNavPath, query: dsNavQuery, element: element };
  const sel = document.getElementById('ds-nav-depth');
  if (sel && sel.value !== '') body.depth = Number(sel.value);
  const ticket = ++dsNavSeq;
  out.innerHTML = `<span style="color:var(--text-muted)"><span class="spinner-sm"></span>Following the references of ${esc(element)}&hellip;</span>`;
  let data;
  try {
    data = await dsNavPost(body);
  } catch (e) {
    if (ticket === dsNavSeq) out.innerHTML = dsNavNotice('Bridge unreachable.');
    return;
  }
  if (ticket !== dsNavSeq) return;
  if (!data || data.error || !data.ok) {
    out.innerHTML = dsNavNotice(esc((data && (data.reason || data.message)) || 'The question could not be answered.'));
    return;
  }
  out.innerHTML = dsNavResultHtml(data);
}

function dsNavResultHtml(data) {
  const r = data.result || {};
  const el = data.element;
  const name = dsNavName(el);
  const levels = data.depth === 0 ? 'all levels' : (data.depth === 1 ? 'direct only' : data.depth + ' levels');
  const capNote = (r.truncated || (r.callers && r.callers.truncated) || (r.callees && r.callees.truncated))
    ? dsNavNotice('Stopped after 5,000 elements &mdash; lower the depth to see the nearest part.') : '';

  if (data.query === 'callers' || data.query === 'callees') {
    const items = r.items || [];
    if (!items.length) {
      return `<div class="mx-note">${data.query === 'callers'
        ? `Nothing in the model references ${name}. Java or JavaScript code, a pluggable widget or a name built at runtime can still use it.`
        : `${name} references no other element.`}</div>`;
    }
    const how = data.query === 'callers' ? 'each line references the one it is indented under' : 'each line is referenced by the one it is indented under';
    return `${capNote}<div class="mx-note">${items.length} element${items.length === 1 ? '' : 's'} ${data.query === 'callers' ? 'reference' : 'referenced by'} ${name} &mdash; ${levels}; ${how}.</div>
      ${dsNavTree(el, items)}`;
  }

  if (data.query === 'impact') {
    const all = (r.direct || []).concat(r.transitive || []);
    if (!all.length) {
      return `<div class="mx-note">Nothing in the model references ${name} &mdash; changing it breaks nothing the model can see. Java or JavaScript code, widgets and names built at runtime are out of reach.</div>`;
    }
    const byType = r.byType || {};
    const typeSummary = Object.keys(byType).sort((a, b) => byType[b] - byType[a])
      .map(t => {
        const word = DS_NAV_TYPES[t] || t.toLowerCase();
        return byType[t] + ' ' + (byType[t] === 1 ? word : word.replace(/y$/, 'ie') + 's');
      }).join(' · ');
    const byKind = r.byKind || {};
    const kindRows = Object.keys(byKind).sort((a, b) => byKind[b].length - byKind[a].length).map(k => {
      const list = byKind[k];
      return [
        `<span style="white-space:nowrap">${window.escHtml(DS_NAV_KINDS[k] || k)}</span>`,
        String(list.length),
        list.slice(0, 40).map(dsNavName).join(', ') + (list.length > 40 ? ` <span style="color:var(--text-muted)">+${list.length - 40} more</span>` : '')
      ];
    });
    return `${capNote}
      <div class="mx-stats">
        ${dsStat({ value: all.length, label: 'Affected elements', sub: levels })}
        ${dsStat({ value: (r.direct || []).length, label: 'Reference it directly' })}
      </div>
      <div class="mx-note">${window.escHtml(typeSummary)}</div>
      ${dsTable([{ label: 'Used as' }, { label: 'Direct', cls: 'num' }, { label: 'By', cls: 'mono' }], kindRows)}
      <div class="mx-note">Everything that reaches ${name} &mdash; each line references the one it is indented under:</div>
      ${dsNavTree(el, all)}`;
  }

  // context
  const esc = window.escHtml;
  const e = r.element || {};
  const facts = [];
  facts.push(`<strong>${esc(DS_NAV_TYPES[e.objectType] || e.objectType || 'element')}</strong> in module <span style="font-family:var(--font-mono)">${esc(e.module || '')}</span>${e.marketplace ? ' (Marketplace)' : ''}`);
  if (typeof e.activities === 'number') facts.push(`${e.activities} activit${e.activities === 1 ? 'y' : 'ies'}, ${e.loops} loop${e.loops === 1 ? '' : 's'}`);
  if (typeof e.attributes === 'number') facts.push(`${e.attributes} attribute${e.attributes === 1 ? '' : 's'}`);
  if (e.generalization) facts.push(`generalizes ${dsNavName(e.generalization)}`);
  else if (e.persistable === false) facts.push('non-persistable');
  const params = (e.parameters || []).length
    ? dsTable([{ label: 'Parameter', cls: 'mono' }, { label: 'Type', cls: 'mono' }], e.parameters.map(p => [esc(p.name), p.type && dsNavTypeOf.has(p.type) ? dsNavName(p.type) : esc(p.type)]))
    : '';
  const callers = (r.callers && r.callers.items) || [];
  const callees = (r.callees && r.callees.items) || [];
  const part = r.participates || [];
  return `${capNote}
    <div style="display:flex; flex-direction:column; gap:var(--sp-2)">
      <div>${name} &mdash; ${facts.join(' · ')}</div>
      ${e.documentation ? `<div class="mx-note" style="white-space:pre-wrap">${esc(e.documentation)}</div>` : ''}
      ${params}
      <h5 class="mx-section-title">Referenced by <span class="count">(${callers.length})</span></h5>
      ${callers.length ? dsNavTree(el, callers) : '<div class="mx-note">Nothing in the model.</div>'}
      <h5 class="mx-section-title">References <span class="count">(${callees.length})</span></h5>
      ${callees.length ? dsNavTree(el, callees) : '<div class="mx-note">No other element.</div>'}
      ${part.length ? `<h5 class="mx-section-title">Associations and generalizations <span class="count">(${part.length})</span></h5>
        ${dsTable([{ label: 'From', cls: 'mono' }, { label: 'Link' }, { label: 'To', cls: 'mono' }], part.map(p => [dsNavName(p.from), esc(DS_NAV_KINDS[p.kind] || p.kind), dsNavName(p.to)]))}` : ''}
    </div>`;
}

// ── Handover summary (plan 020) ─────────────────────────────────────────────
// One self-contained HTML page to hand to a client or attach to an audit: what
// the Project File, Dead Code, Integrations and Modules views show (plus the
// Security Matrix shortcuts, if that matrix was already generated for this
// project), through the shared exporter. No score and no new analysis. A check
// that found nothing is named in the note instead of printing an empty table.
const DS_SUMMARY_ROW_CAP = 500;
const DS_SUMMARY_ROUTES = [['mpr', '/model/mpr'], ['dead', '/model/dead-code'], ['int', '/model/integrations'], ['mod', '/model/modules']];

// results: { mpr, dead, int, mod } — each a route's answer, or { failed: reason }.
// sec: dsSecData for the same project, or null. Returns mtExportToHtml opts.
function dsSummaryBuild(results, sec, source) {
  const p = results.mpr;
  const c = p.counts || {};
  const market = new Set((p.modules || []).filter(m => m.fromMarketplace).map(m => m.name));
  const mine = m => !market.has(m);
  const sections = [];
  const nothing = [];
  const missing = [];
  const add = (s, rows) => {
    if (!rows.length) { nothing.push(s.title.split(' — ')[0].toLowerCase()); return; }
    s.rows = rows.slice(0, DS_SUMMARY_ROW_CAP);
    if (rows.length > DS_SUMMARY_ROW_CAP) {
      s.note = (s.note ? s.note + ' ' : '') + `Showing the first ${DS_SUMMARY_ROW_CAP} of ${rows.length} — the full list is in the tab.`;
    }
    sections.push(s);
  };
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

  const s = p.security;
  if (s) {
    const pp = s.passwordPolicy || {};
    const rows = [
      ['Security level', s.securityLevel || '—'],
      ['Guest access', s.enableGuestAccess ? 'on' : 'off'],
      ['Strict mode', s.strictMode ? 'on' : 'off'],
      ['Admin password stored in the model', s.adminPasswordSet ? 'yes' : 'no']
    ];
    if (typeof pp.minimumLength === 'number') rows.push(['Password minimum length', pp.minimumLength + (pp.minimumLength < 8 ? ' (weak)' : '')]);
    (s.userRoles || []).filter(r => r.manageAllRoles).forEach(r => rows.push(['Role that manages all roles', r.name]));
    add({ title: 'Project security settings', columns: ['Setting', 'Value'] }, rows);
  }

  const dead = results.dead;
  if (dead.failed) {
    missing.push('dead code (' + dead.failed + ')');
  } else {
    const kind = t => (DS_DEAD_GROUPS.find(g => g[0] === t) || [])[2] || t;
    const short = d => d.qualifiedName.slice(d.module.length + 1);
    const list = (dead.dead || []).filter(d => mine(d.module))
      .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
    add({
      title: 'Dead code — nothing in the model references these',
      subtitle: plural(list.length, 'element', 'elements') + ' across ' + plural(new Set(list.map(d => d.module)).size, 'module', 'modules'),
      columns: ['Module', 'Element', 'Kind', 'Note'],
      note: 'Java / JavaScript code and names built at runtime are invisible to this check — review every entry before deleting.'
    }, list.map(d => [d.module, short(d), kind(d.objectType), d.reason === 'prefix suggests entry point' ? 'name suggests an entry point' : '']));
    const unc = (dead.uncertain || []).filter(d => mine(d.module))
      .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
    add({
      title: 'To verify — unused in the model, but code can use them',
      columns: ['Module', 'Element', 'Kind']
    }, unc.map(d => [d.module, short(d), DS_DEAD_UNCERTAIN_KIND[d.objectType] || d.objectType]));
  }

  const int = results.int;
  if (int.failed) {
    missing.push('integrations (' + int.failed + ')');
  } else {
    const auth = x => !x.authenticated ? 'NO SIGN-IN REQUIRED'
      : (x.noRoles ? 'sign-in, but no allowed roles' : 'sign-in: ' + ((x.authenticationTypes || []).join(', ') || x.headerAuthentication || 'required'));
    const rest = int.publishedRest || [];
    const odata = int.publishedOData || [];
    const soap = int.publishedSoap || [];
    const consumed = int.consumedRest || [];
    const events = int.businessEvents || [];
    const byTarget = {};
    (int.restCalls || []).forEach(x => { (byTarget[x.target] = byTarget[x.target] || []).push(x); });
    const rows = [];
    rest.forEach(x => rows.push(['Published', 'REST', x.name || '(unnamed)', '/' + (x.path || '') + (x.version ? ' v' + x.version : ''), auth(x)]));
    odata.forEach(x => rows.push(['Published', 'OData', x.name || '(unnamed)', '/' + (x.path || '') + (x.odataVersion ? ' ' + x.odataVersion : ''), auth(x)]));
    soap.forEach(x => rows.push(['Published', 'SOAP', x.name || '(unnamed)', x.caption || '', auth(x)]));
    consumed.forEach(x => rows.push(['Consumed', 'REST service', x.name || '(unnamed)', x.baseUrl || '—', x.authenticationScheme || '—']));
    Object.keys(byTarget).sort().forEach(t => {
      const calls = byTarget[t];
      const secrets = calls.filter(x => x.hardcodedCredentials).length;
      rows.push(['Outgoing', 'REST calls', t, plural(calls.length, 'call', 'calls') + ' from ' + plural(new Set(calls.map(x => x.microflow)).size, 'microflow', 'microflows'),
        secrets ? 'CREDENTIALS TYPED IN ' + plural(secrets, 'CALL', 'CALLS') : '']);
    });
    events.forEach(x => rows.push(['Business events', 'service', x.name || '(unnamed)', plural((x.channels || []).length, 'channel', 'channels'), '']));
    const open = rest.concat(odata, soap).filter(x => !x.authenticated).length;
    const secrets = (int.restCalls || []).filter(x => x.hardcodedCredentials).length;
    add({
      title: 'Integrations — what the app exposes and calls',
      subtitle: `${rest.length + odata.length + soap.length} published (${open} without sign-in), ${consumed.length} consumed, ` +
        `${plural(Object.keys(byTarget).length, 'outgoing REST target', 'outgoing REST targets')}; ${plural(secrets, 'call', 'calls')} with credentials typed into the microflow`,
      columns: ['Direction', 'Type', 'Name', 'Where', 'Authentication'],
      note: 'A URL built from a Constant shows the Constant, not its per-environment value. Credential values are never read out.'
    }, rows);
  }

  const mod = results.mod;
  if (mod.failed) {
    missing.push('modules (' + mod.failed + ')');
  } else {
    const label = m => market.has(m) ? m + ' (Marketplace)' : m;
    add({
      title: 'Module dependency cycles',
      subtitle: 'Modules that reference each other — they deploy and version together; none can be extracted without the rest.',
      columns: ['Cycle', 'Modules', 'Members']
    }, (mod.cycles || []).map((g, i) => [String(i + 1), String(g.length), g.slice().sort().map(label).join(', ')]));
    add({
      title: 'Inheritance blockers',
      subtitle: 'An entity extending one in another module — separating those modules needs a data migration.',
      columns: ['Entity', 'Extends', 'Modules']
    }, (mod.blockers || []).filter(b => mine(b.fromModule)).map(b => [b.from, b.to, b.fromModule + ' ↔ ' + b.toModule]));
  }

  if (sec && sec.highlights) {
    const h = sec.highlights;
    const rows = [];
    h.broadWrite.forEach(i => {
      const e = sec.entityRules[i];
      rows.push(['Broad write access', e.role, e.qname, [e.create ? 'create' : '', e.del ? 'delete' : ''].filter(Boolean).join(' + ') + ' with no XPath']);
    });
    h.anonEntity.forEach(i => {
      const e = sec.entityRules[i];
      rows.push(['Anonymous entity access', e.role, e.qname, e.xpath ? 'XPath: ' + e.xpath : 'no XPath']);
    });
    h.anonDocument.forEach(i => {
      const d = sec.documentRules[i];
      rows.push(['Anonymous document', (d.anonRoles || []).join(', '), d.module + '.' + d.name, d.type]);
    });
    add({
      title: 'Security matrix — review shortcuts',
      subtitle: `${sec.entityRules.length} entity rules, ${sec.documentRules.length} document rules (exported by mx.exe ${sec.meta.binaryVersion})`,
      columns: ['Finding', 'Role', 'Element', 'Detail']
    }, rows);
  }

  const note = ['Read from the last saved project file, offline — no database or running app was involved.'];
  if (market.size) note.push(plural(market.size, 'Marketplace module is', 'Marketplace modules are') + ' left out of dead code and inheritance blockers.');
  if (nothing.length) note.push('Checked, nothing found: ' + nothing.join(', ') + '.');
  if (missing.length) note.push('Not available: ' + missing.join('; ') + '.');
  if (!sec) note.push('Security matrix not included — generate it on the Security Matrix tab first to add its review shortcuts.');
  note.push('Contains module, entity, role and endpoint names — review before sharing.');

  return {
    title: 'Model handover summary — ' + (p.projectName || 'project'),
    subtitle: source,
    meta: [
      { label: 'Mendix', value: p.productVersion || '—' },
      { label: 'Modules', value: (c.modules || 0) + (market.size ? ' (' + market.size + ' Marketplace)' : '') },
      { label: 'Entities', value: c.entities || 0 },
      { label: 'Microflows', value: c.microflows || 0 },
      { label: 'Pages', value: c.pages || 0 }
    ],
    note: note.join(' '),
    sections: sections
  };
}

// The Security Matrix belongs to the connected project; only fold it in when
// the summary is for that same project (its folder, or a .mpr inside it).
function dsSummarySameProject(raw, projectRoot) {
  if (!raw || !projectRoot) return false;
  const norm = v => String(v).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const root = norm(projectRoot);
  const target = norm(raw);
  return target === root || target.indexOf(root + '/') === 0;
}

async function dsExportSummary(btn) {
  const box = document.getElementById('ds-mpr-body');
  const esc = window.escHtml;
  const raw = dsModelPath('ds-mpr-path');
  if (!raw) {
    if (box) box.innerHTML = `<div class="notice notice-warning" style="font-size:0.8rem">Enter a path to a .mpr file or the project folder.</div>`;
    return;
  }
  const label = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = 'Exporting&hellip;'; }
  try {
    const settled = await Promise.allSettled(DS_SUMMARY_ROUTES.map(([, route]) =>
      fetch('http://localhost:9999' + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mprPath: raw })
      }).then(res => res.json())));
    const results = {};
    DS_SUMMARY_ROUTES.forEach(([key], i) => {
      const d = settled[i].status === 'fulfilled' ? settled[i].value : null;
      results[key] = (d && d.ok && !d.error) ? d : { failed: (d && (d.reason || d.message)) || 'bridge unreachable' };
    });
    // Without the project header there is nothing to summarise — and the other
    // routes read the same file, so they failed for the same reason.
    if (results.mpr.failed) {
      if (box) box.innerHTML = `<div class="notice notice-warning" style="font-size:0.8rem">${esc(results.mpr.failed)}</div>`;
      return;
    }
    const sec = dsSecData && dsProjectData && dsSummarySameProject(raw, dsProjectData.projectRoot) ? dsSecData : null;
    const opts = dsSummaryBuild(results, sec, raw);
    window.mtExport.downloadHtml('handover-summary-' + results.mpr.projectName + '.html', opts);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = label; }
  }
}

async function dsFetchDbDetails() {
  if (!dsProjectData || !dsProjectData.success) return;
  const config = dsProjectData.config || {};
  const dbType = (config.Configuration?.DatabaseType || 'HSQLDB').toUpperCase();
  if (dbType !== 'POSTGRESQL') return;

  const hostParts = (config.Configuration?.DatabaseHost || 'localhost:5432').split(':');
  const dbConfig = {
    host: hostParts[0] || 'localhost',
    port: hostParts[1] || '5432',
    database: config.Configuration?.DatabaseName || '',
    user: config.Configuration?.DatabaseUserName || '',
    password: config.Configuration?.DatabasePassword || ''
  };

  try {
    const res = await fetch('http://localhost:9999/postgres', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dbConfig)
    });
    if (!res.ok) throw new Error("DB Query failed");
    const data = await res.json();
    if (data.error) throw new Error(data.message);

    // Render metrics
    const sizeBytes = data.stats?.size_bytes || 0;
    const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
    document.getElementById('ds-db-size').textContent = `${sizeMB} MB`;
    document.getElementById('ds-db-tables-count').textContent = data.stats?.tables_count || '0';

    const tablesTbody = document.getElementById('ds-db-top-tables');
    if (tablesTbody && data.top_tables) {
      tablesTbody.innerHTML = '';
      data.top_tables.forEach(t => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--border-subtle)';
        const tableSizeMB = (t.total_size / 1024 / 1024).toFixed(2);
        tr.innerHTML = `
          <td style="padding:var(--sp-1) 0; font-family:var(--font-mono); font-size:0.75rem; color:var(--text-secondary)">${escHtml(t.table_name)}</td>
          <td style="padding:var(--sp-1) 0; text-align:right; font-family:var(--font-mono); font-size:0.75rem; color:var(--text-muted)">${tableSizeMB} MB</td>
        `;
        tablesTbody.appendChild(tr);
      });
    }
  } catch (e) {
    console.error("Failed to fetch database details:", e);
  }
}



async function dsFetchProjectInsights() {
  if (!dsProjectData || !dsProjectData.projectRoot) return;
  try {
    const res = await fetch('http://localhost:9999/project-insights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectRoot: dsProjectData.projectRoot })
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.success) return;

    // Bundle Size
    document.getElementById('ds-bundle-total').textContent = `${data.bundleSize.totalMB} MB`;
    document.getElementById('ds-bundle-js').textContent = `${data.bundleSize.jsMB} MB`;

    // Widgets
    const widgetsList = document.getElementById('ds-widgets-list');
    if (widgetsList) {
      widgetsList.innerHTML = '';
      if (data.widgets && data.widgets.length > 0) {
        data.widgets.forEach(w => {
          const badge = document.createElement('span');
          badge.className = 'badge badge-secondary';
          badge.textContent = w;
          widgetsList.appendChild(badge);
        });
      } else {
        widgetsList.innerHTML = '<span style="color:var(--text-muted);font-size:0.85rem">No custom widgets found.</span>';
      }
    }

    // Java Issues
    const issuesList = document.getElementById('ds-java-issues-list');
    if (issuesList) {
      issuesList.innerHTML = '';
      if (data.javaIssues && data.javaIssues.length > 0) {
        data.javaIssues.forEach(i => {
          const div = document.createElement('div');
          div.style.padding = 'var(--sp-2)';
          div.style.background = 'var(--bg-elevated)';
          div.style.borderLeft = '3px solid var(--warning)';
          div.style.marginBottom = 'var(--sp-1)';
          div.style.fontSize = '0.8rem';
          div.innerHTML = `<strong style="color:var(--text-primary)">${i.file}:${i.line}</strong> <br> <span style="color:var(--text-secondary)">${i.issue}</span>`;
          issuesList.appendChild(div);
        });
      } else {
        issuesList.innerHTML = '<span style="color:var(--success);font-size:0.85rem">No obvious issues found in Java code! <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></span>';
      }
    }

  } catch(e) {
    console.error("Failed to fetch insights:", e);
  }
}



function dsInitState() {
  dsIsConnected = false;
  dsReconnectAttempts = 0;
  if (dsPollTimer) {
    clearTimeout(dsPollTimer);
    dsPollTimer = null;
  }
  dsSecStopTimers();
  dsSecJobId = null;
  dsSecData = null;
}

function dsDisconnect() {
  dsInitState();
  dsShowOfflineView();
}

function dsSchedulePoll(delayMs) {
  if (dsPollTimer) clearTimeout(dsPollTimer);
  dsPollTimer = setTimeout(dsPollData, delayMs);
}

async function dsPollData() {
  if (!dsIsConnected) {
    await dsAutoDetectProject();
    dsSchedulePoll(DS_POLL_INTERVAL_MS);
    return;
  }
  // Connected: confirm the Bridge is still alive. A restart (rebuild, crash,
  // manual stop/start) previously left the dashboard showing stale data with
  // no indication anything was wrong — this is the fix.
  const alive = await dsCheckAlive();
  if (alive) {
    if (dsReconnectAttempts > 0) { dsReconnectAttempts = 0; dsSetReconnecting(false); }
    dsSchedulePoll(DS_POLL_INTERVAL_MS);
  } else {
    dsReconnectAttempts++;
    dsSetReconnecting(true, dsReconnectAttempts);
    dsSchedulePoll(dsBackoffDelay(dsReconnectAttempts));
  }
}



function dsShowDashboard() {
  document.getElementById('ds-offline-view').style.display = 'none';
  document.getElementById('ds-tabs').style.display = 'flex';
  dsSetTab('dashboard', document.querySelector('#ds-tabs .tab'));
  dsSetReconnecting(false);
}

function dsShowOfflineView() {
  document.getElementById('ds-offline-view').style.display = 'flex';
  document.getElementById('ds-tabs').style.display = 'none';
  document.getElementById('ds-dashboard-view').style.display = 'none';
  document.getElementById('ds-security-view').style.display = 'none';
  document.getElementById('ds-deadcode-view').style.display = 'none';
  document.getElementById('ds-integrations-view').style.display = 'none';
  document.getElementById('ds-modules-view').style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════════════════
// TABS  —  Dashboard | Security Matrix  (wave 28)
// ═══════════════════════════════════════════════════════════════════════════

function dsSetTab(tabId, el) {
  document.querySelectorAll('#ds-tabs .tab').forEach(function (t) {
    t.classList.remove('active');
    t.setAttribute('aria-selected', 'false');
  });
  if (el) { el.classList.add('active'); el.setAttribute('aria-selected', 'true'); }
  document.getElementById('ds-dashboard-view').style.display = tabId === 'dashboard' ? 'flex' : 'none';
  document.getElementById('ds-security-view').style.display = tabId === 'security' ? 'flex' : 'none';
  document.getElementById('ds-deadcode-view').style.display = tabId === 'deadcode' ? 'flex' : 'none';
  document.getElementById('ds-integrations-view').style.display = tabId === 'integrations' ? 'flex' : 'none';
  document.getElementById('ds-modules-view').style.display = tabId === 'modules' ? 'flex' : 'none';
  document.getElementById('ds-navigate-view').style.display = tabId === 'navigate' ? 'flex' : 'none';
}

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY MATRIX  (wave 28)
// ═══════════════════════════════════════════════════════════════════════════
// The export is a 55–90 s background job on the Bridge. This drives it: POST to
// start, poll GET until done, then render the normalized matrix into a virtual
// list. Everything mx.exe-related lives in server/mx-tool.js; this file only
// talks to /model/security.

const DS_SEC_POLL_MS = 1500;

let dsSecJobId = null;
let dsSecPollTimer = null;
let dsSecClockTimer = null;
let dsSecStartedAt = 0;
let dsSecData = null;      // the last completed result payload
let dsSecView = 'entities';
let dsSecVList = null;
let dsSecMemberIdx = -1;   // entityRules index currently drilled into, or -1

function dsSecEl(id) { return document.getElementById(id); }

function dsSecStopTimers() {
  if (dsSecPollTimer) { clearTimeout(dsSecPollTimer); dsSecPollTimer = null; }
  if (dsSecClockTimer) { clearInterval(dsSecClockTimer); dsSecClockTimer = null; }
}

function dsSecShow(which) {
  // style.display, not the [hidden] attribute — the app's .notice / .card rules
  // set display and would win over [hidden].
  dsSecEl('ds-sec-intro').style.display = which === 'intro' ? 'block' : 'none';
  dsSecEl('ds-sec-progress').style.display = which === 'progress' ? 'block' : 'none';
  dsSecEl('ds-sec-error').style.display = which === 'error' ? 'block' : 'none';
  dsSecEl('ds-sec-result').style.display = which === 'result' ? 'flex' : 'none';
}

window.dsSecGenerate = async function () {
  if (!dsProjectData || !dsProjectData.projectRoot) {
    window.mtToast('Connect to a project first.', 'warning');
    return;
  }
  dsSecEl('ds-sec-generate-btn').disabled = true;
  dsSecShow('progress');
  dsSecEl('ds-sec-progress-phase').textContent = 'Starting…';
  dsSecEl('ds-sec-progress-bar').style.width = '2%';
  try {
    const res = await fetch('http://localhost:9999/model/security', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectRoot: dsProjectData.projectRoot })
    });
    const data = await res.json();
    if (!res.ok || !data.ok || !data.job) {
      throw new Error((data && (data.message || data.reason)) || 'Could not start the security export.');
    }
    dsSecJobId = data.job.jobId;
    dsSecStartedAt = data.job.startedAt || Date.now();
    dsSecClockTimer = setInterval(dsSecTick, 1000);
    dsSecTick();
    dsSecPoll();
  } catch (e) {
    dsSecFail(e.message);
  }
};

function dsSecTick() {
  const s = Math.max(0, Math.round((Date.now() - dsSecStartedAt) / 1000));
  dsSecEl('ds-sec-progress-note').textContent = 'Elapsed ' + s + 's — this usually takes 40–90 seconds';
}

async function dsSecPoll() {
  if (!dsSecJobId) return;
  try {
    const res = await fetch('http://localhost:9999/model/security?jobId=' + encodeURIComponent(dsSecJobId));
    if (res.status === 404) { dsSecFail('The export job is no longer available — start it again.'); return; }
    const data = await res.json();
    const job = data && data.job;
    if (!job) { dsSecFail('The Bridge returned no job status.'); return; }

    dsSecEl('ds-sec-progress-bar').style.width = Math.max(2, job.percent || 0) + '%';
    if (job.phase) dsSecEl('ds-sec-progress-phase').textContent = job.phase;

    if (job.state === 'done') {
      dsSecStopTimers();
      dsSecData = job.result;
      dsSecData._durationMs = job.durationMs;
      dsSecEl('ds-sec-generate-btn').disabled = false;
      dsSecRender();
      return;
    }
    if (job.state === 'error') { dsSecFail(job.error || 'The export failed.'); return; }
    dsSecPollTimer = setTimeout(dsSecPoll, DS_SEC_POLL_MS);
  } catch (e) {
    dsSecFail('Bridge unreachable — ' + e.message);
  }
}

function dsSecFail(msg) {
  dsSecStopTimers();
  dsSecJobId = null;
  dsSecEl('ds-sec-generate-btn').disabled = false;
  dsSecEl('ds-sec-error').textContent = msg;
  dsSecShow('error');
}

window.dsSecCancel = async function () {
  const id = dsSecJobId;
  dsSecStopTimers();
  dsSecJobId = null;
  dsSecEl('ds-sec-generate-btn').disabled = false;
  dsSecShow('intro');
  if (id) {
    try {
      await fetch('http://localhost:9999/model/security/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: id })
      });
    } catch (e) { /* best effort */ }
  }
};

// ── Rendering ──────────────────────────────────────────────────────────────

function dsSecRender() {
  const d = dsSecData;
  if (!d) return;
  dsSecShow('result');
  dsSecCloseMembers();

  dsSecEl('ds-sec-c-entity').textContent = d.counts.entityRules + ' entity rules';
  dsSecEl('ds-sec-c-doc').textContent = d.counts.documentRules + ' document rules';
  dsSecEl('ds-sec-c-roles').textContent = d.counts.userRoles + ' roles';
  const took = d.meta.cached ? 'from cache' : Math.round((d._durationMs || 0) / 1000) + 's';
  dsSecEl('ds-sec-meta').textContent =
    'mx ' + d.meta.binaryVersion + ' · project ' + d.meta.projectVersion + ' · ' + took +
    ' · reflects the last saved state';

  // Filter dropdowns.
  const roleSel = dsSecEl('ds-sec-f-role');
  const modSel = dsSecEl('ds-sec-f-module');
  roleSel.innerHTML = '<option value="">All roles</option>';
  d.roles.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (r) {
    const o = document.createElement('option');
    o.value = r.name;
    o.textContent = r.name + (r.admin ? '  (admin)' : '') + (r.anon ? '  (anonymous)' : '');
    roleSel.appendChild(o);
  });
  const mods = {};
  d.entityRules.forEach(function (r) { mods[r.module] = 1; });
  d.documentRules.forEach(function (r) { mods[r.module] = 1; });
  modSel.innerHTML = '<option value="">All modules</option>';
  Object.keys(mods).sort().forEach(function (m) {
    const o = document.createElement('option');
    o.value = m; o.textContent = m;
    modSel.appendChild(o);
  });

  dsSecRenderHighlights();
  dsSecApplyFilter();
}

function dsSecHighlightCard(kind, count, label, sub) {
  const div = document.createElement('button');
  div.type = 'button';
  div.className = 'card';
  div.style.cssText = 'padding:var(--sp-3); text-align:left; cursor:pointer; border-left:3px solid ' +
    (count ? 'var(--warning)' : 'var(--success)') + '; background:var(--bg-elevated)';
  div.onclick = function () { dsSecFocusHighlight(kind); };
  div.innerHTML =
    '<div style="font-size:1.3rem; font-weight:700; color:var(--text-primary)">' + count + '</div>' +
    '<div style="font-size:0.82rem; color:var(--text-primary); margin-top:2px">' + escHtml(label) + '</div>' +
    '<div style="font-size:0.72rem; color:var(--text-muted); margin-top:2px">' + escHtml(sub) + '</div>';
  return div;
}

function dsSecRenderHighlights() {
  const h = dsSecData.highlights;
  const box = dsSecEl('ds-sec-highlights');
  box.innerHTML = '';
  box.appendChild(dsSecHighlightCard('broadWrite', h.broadWrite.length,
    'Broad write access',
    'Non-admin roles that can create or delete with no XPath filter'));
  box.appendChild(dsSecHighlightCard('anonEntity', h.anonEntity.length,
    'Anonymous entity access',
    'Entity rules granted to an anonymous (guest) role'));
  box.appendChild(dsSecHighlightCard('anonDocument', h.anonDocument.length,
    'Anonymous pages & microflows',
    'Documents an anonymous role can reach'));
}

function dsSecFocusHighlight(kind) {
  if (kind === 'anonDocument') {
    dsSecSetView('documents', dsSecEl('ds-sec-view-documents'));
  } else {
    dsSecSetView('entities', dsSecEl('ds-sec-view-entities'));
  }
  dsSecEl('ds-sec-f-role').value = '';
  dsSecEl('ds-sec-f-module').value = '';
  dsSecEl('ds-sec-f-text').value = '';
  dsSecEl('ds-sec-f-flagged').checked = true;
  dsSecApplyFilter();
}

function dsSecSetView(v, el) {
  dsSecView = v;
  ['ds-sec-view-entities', 'ds-sec-view-documents'].forEach(function (id) {
    dsSecEl(id).classList.remove('active');
  });
  if (el) el.classList.add('active');
  if (v === 'documents') dsSecCloseMembers();
  dsSecApplyFilter();
}

function dsSecFlaggedSet() {
  const h = dsSecData.highlights;
  if (dsSecView === 'documents') return new Set(h.anonDocument);
  return new Set(h.broadWrite.concat(h.anonEntity));
}

function dsSecApplyFilter() {
  if (!dsSecData) return;
  const role = dsSecEl('ds-sec-f-role').value;
  const mod = dsSecEl('ds-sec-f-module').value;
  const text = dsSecEl('ds-sec-f-text').value.trim().toLowerCase();
  const flaggedOnly = dsSecEl('ds-sec-f-flagged').checked;
  const flagged = flaggedOnly ? dsSecFlaggedSet() : null;

  const source = dsSecView === 'documents' ? dsSecData.documentRules : dsSecData.entityRules;
  const rows = [];
  source.forEach(function (r, i) {
    if (flagged && !flagged.has(i)) return;
    if (mod && r.module !== mod) return;
    if (role) {
      if (dsSecView === 'documents') { if (r.roles.indexOf(role) === -1) return; }
      else if (r.role !== role) return;
    }
    if (text) {
      const hay = dsSecView === 'documents'
        ? (r.module + '.' + r.name + ' ' + r.type).toLowerCase()
        : (r.qname + ' ' + r.role + ' ' + r.xpath).toLowerCase();
      if (hay.indexOf(text) === -1) return;
    }
    rows.push({ r: r, i: i });
  });

  dsSecEl('ds-sec-count-text').textContent =
    rows.length + ' of ' + source.length + (dsSecView === 'documents' ? ' documents' : ' rules') +
    (flaggedOnly ? ' · flagged only' : '');
  dsSecEl('ds-sec-count-hint').style.display = dsSecView === 'documents' ? 'none' : '';

  dsSecPaintList(rows);
  // A drill-down open on a row now filtered out would be stale — close it.
  if (dsSecMemberIdx !== -1 && !rows.some(function (e) { return e.i === dsSecMemberIdx; })) {
    dsSecCloseMembers();
  }
}

// ── Member drill-down ──────────────────────────────────────────────────────

function dsSecShowMembers(idx) {
  if (!dsSecData || !dsSecData.entityRules[idx]) return;
  dsSecMemberIdx = idx;
  const r = dsSecData.entityRules[idx];
  dsSecEl('ds-sec-detail-head').innerHTML =
    '<span class="badge ' + (r.admin ? 'badge-secondary' : 'badge-primary') + '">' + escHtml(r.role) + '</span> ' +
    '<strong style="color:var(--text-primary)">' + escHtml(r.qname) + '</strong><br>' +
    '<span style="color:var(--text-muted)">' +
      (r.xpath ? 'XPath: <span style="font-family:var(--font-mono)">' + escHtml(r.xpath) + '</span>' : 'no XPath constraint') +
      ' · ' + (r.create ? 'can create' : 'no create') + ' · ' + (r.del ? 'can delete' : 'no delete') +
      ' · ' + r.read + ' readable, ' + r.write + ' writable</span>';
  dsSecEl('ds-sec-detail').style.display = 'block';
  dsSecRenderMembers();
  dsSecEl('ds-sec-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function dsSecRenderMembers() {
  if (dsSecMemberIdx === -1) return;
  const r = dsSecData.entityRules[dsSecMemberIdx];
  const wOnly = dsSecEl('ds-sec-detail-wonly').checked;
  // writable first, then by name — the writable ones are the point of the drill-down.
  const rows = (r.m || []).slice()
    .filter(function (t) { return !wOnly || t[3] === 'w'; })
    .sort(function (a, b) {
      if ((a[3] === 'w') !== (b[3] === 'w')) return a[3] === 'w' ? -1 : 1;
      return a[0].localeCompare(b[0]);
    });
  const tb = dsSecEl('ds-sec-detail-tbody');
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="4" style="padding:var(--sp-3); color:var(--text-muted); text-align:center">' +
      (wOnly ? 'No writable members in this rule.' : 'This rule grants no member access.') + '</td></tr>';
    return;
  }
  tb.innerHTML = rows.map(function (t) {
    const write = t[3] === 'w';
    return '<tr style="border-bottom:1px solid var(--border-subtle)">' +
      '<td style="padding:var(--sp-2) var(--sp-3); color:var(--text-primary)">' + escHtml(t[0]) + '</td>' +
      '<td style="padding:var(--sp-2) var(--sp-3); color:var(--text-muted)">' + (t[1] === 's' ? 'Association' : 'Attribute') + '</td>' +
      '<td style="padding:var(--sp-2) var(--sp-3); color:var(--text-muted)">' + escHtml(t[2]) + '</td>' +
      '<td style="padding:var(--sp-2) var(--sp-3)"><span style="padding:1px 6px; border-radius:4px; font-size:0.7rem; background:' +
        (write ? 'color-mix(in srgb, var(--warning) 25%, transparent)' : 'var(--bg-surface)') +
        '; color:' + (write ? 'var(--text-primary)' : 'var(--text-muted)') + '">' +
        (write ? 'Read / Write' : 'Read only') + '</span></td></tr>';
  }).join('');
}

function dsSecCloseMembers() {
  dsSecMemberIdx = -1;
  dsSecEl('ds-sec-detail').style.display = 'none';
}

function dsSecRowEl(entry) {
  const r = entry.r;
  const flagged = dsSecFlaggedSet().has(entry.i);
  const el = document.createElement('div');
  el.style.cssText = 'display:flex; align-items:center; gap:var(--sp-3); padding:0 var(--sp-3); ' +
    'font-size:0.78rem; border-bottom:1px solid var(--border-subtle); border-left:3px solid ' +
    (flagged ? 'var(--warning)' : 'transparent') + '; white-space:nowrap; overflow:hidden';

  if (dsSecView === 'documents') {
    const anon = (r.anonRoles || []).length > 0;
    el.innerHTML =
      '<span class="badge badge-secondary" style="flex:0 0 auto">' + escHtml(r.type) + '</span>' +
      '<span style="flex:0 0 260px; overflow:hidden; text-overflow:ellipsis; color:var(--text-primary)">' +
        escHtml(r.module) + '.' + escHtml(r.name) + '</span>' +
      '<span style="flex:1; overflow:hidden; text-overflow:ellipsis; color:' +
        (anon ? 'var(--danger)' : 'var(--text-secondary)') + '">' +
        (r.roles.length ? escHtml(r.roles.join(', ')) : '— no role can reach this —') + '</span>';
    return el;
  }

  el.style.cursor = 'pointer';
  el.onclick = function () { dsSecShowMembers(entry.i); };
  if (entry.i === dsSecMemberIdx) el.style.background = 'color-mix(in srgb, var(--primary) 12%, transparent)';
  const pill = function (on, txt) {
    return '<span style="flex:0 0 auto; padding:1px 6px; border-radius:4px; font-size:0.68rem; background:' +
      (on ? 'color-mix(in srgb, var(--warning) 25%, transparent)' : 'var(--bg-surface)') +
      '; color:' + (on ? 'var(--text-primary)' : 'var(--text-muted)') + '">' + txt + '</span>';
  };
  el.innerHTML =
    '<span class="badge ' + (r.admin ? 'badge-secondary' : 'badge-primary') +
      '" style="flex:0 0 130px; overflow:hidden; text-overflow:ellipsis">' + escHtml(r.role) + '</span>' +
    '<span style="flex:0 0 240px; overflow:hidden; text-overflow:ellipsis; color:var(--text-primary)">' +
      escHtml(r.qname) + '</span>' +
    '<span style="flex:1; overflow:hidden; text-overflow:ellipsis; font-family:var(--font-mono); color:var(--text-muted)">' +
      (r.xpath ? escHtml(r.xpath)
        : '<span style="font-family:var(--font-sans, inherit); color:' +
          (flagged ? 'var(--warning)' : 'var(--text-muted)') + '">no XPath constraint</span>') + '</span>' +
    pill(r.create, 'create') + pill(r.del, 'delete') +
    '<span style="flex:0 0 auto; color:var(--text-muted)">' + r.read + 'R / ' + r.write + 'W ›</span>';
  return el;
}

function dsSecPaintList(rows) {
  const container = dsSecEl('ds-sec-list');
  if (!dsSecVList) {
    dsSecVList = window.createVirtualList({
      container: container,
      renderRow: function (entry) { return dsSecRowEl(entry); }
    });
  }
  dsSecVList.setItems(rows);
  if (!rows.length) {
    container.innerHTML = '<div style="padding:var(--sp-4); color:var(--text-muted); font-size:0.82rem">' +
      'Nothing matches these filters.</div>';
  }
}

// ── Export ─────────────────────────────────────────────────────────────────

window.dsSecExport = function (fmt) {
  if (!dsSecData) return;
  const isDoc = dsSecView === 'documents';
  const header = isDoc
    ? ['Type', 'Module', 'Document', 'Roles', 'Anonymous roles']
    : ['Role', 'Admin', 'Module', 'Entity', 'XPath', 'Create', 'Delete', 'Readable members', 'Writable members'];
  const src = isDoc ? dsSecData.documentRules : dsSecData.entityRules;
  const flagged = dsSecEl('ds-sec-f-flagged').checked ? dsSecFlaggedSet() : null;
  const role = dsSecEl('ds-sec-f-role').value;
  const mod = dsSecEl('ds-sec-f-module').value;
  const rows = [];
  src.forEach(function (r, i) {
    if (flagged && !flagged.has(i)) return;
    if (mod && r.module !== mod) return;
    if (role && (isDoc ? r.roles.indexOf(role) === -1 : r.role !== role)) return;
    rows.push(isDoc
      ? [r.type, r.module, r.name, r.roles.join('; '), (r.anonRoles || []).join('; ')]
      : [r.role, r.admin ? 'yes' : 'no', r.module, r.entity, r.xpath, r.create ? 'yes' : 'no',
         r.del ? 'yes' : 'no', r.read, r.write]);
  });
  const base = 'security-matrix-' + (isDoc ? 'documents' : 'entities');
  if (fmt === 'csv') {
    window.mtExport.downloadCsv(base + '.csv', header, rows);
  } else {
    window.mtExport.downloadHtml(base + '.html', {
      title: 'Mendix Security Matrix — ' + (isDoc ? 'Document access' : 'Entity access'),
      subtitle: dsProjectData && dsProjectData.projectRoot ? dsProjectData.projectRoot : '',
      meta: [
        { label: 'mx.exe', value: dsSecData.meta.binaryVersion },
        { label: 'Project', value: dsSecData.meta.projectVersion },
        { label: 'Rows', value: rows.length }
      ],
      note: 'Exported from the last saved state of the project. Contains entity, role and endpoint ' +
        'names — treat as a map of the system.',
      columns: header,
      rows: rows
    });
  }
};

// --- AUTO-GENERATED ESM EXPORTS ---
window.dsDisconnect = dsDisconnect;
window.dsPollData = dsPollData;
window.dsSetTab = dsSetTab;
window.dsSecSetView = dsSecSetView;
window.dsSecApplyFilter = dsSecApplyFilter;
window.dsSecCloseMembers = dsSecCloseMembers;
window.dsSecRenderMembers = dsSecRenderMembers;
window.dsFetchMprModel = dsFetchMprModel;
window.dsFetchDeadCode = dsFetchDeadCode;
window.dsSetMarketplace = dsSetMarketplace;
window.dsDeadCopy = dsDeadCopy;
window.dsDeadSetType = dsDeadSetType;
window.dsDeadSetQuery = dsDeadSetQuery;
window.dsScrollTo = dsScrollTo;
window.dsFetchIntegrations = dsFetchIntegrations;
window.dsFetchModules = dsFetchModules;
window.dsNavLoad = dsNavLoad;
window.dsExportSummary = dsExportSummary;
window.dsSummaryBuild = dsSummaryBuild;
window.dsSummarySameProject = dsSummarySameProject;

// Exposed for scripts/parser-test.js (pure function, no DOM).
window.dsBackoffDelay = dsBackoffDelay;

export function cleanup() {
  if (dsPollTimer) {
    clearTimeout(dsPollTimer);
    dsPollTimer = null;
  }
  dsSecStopTimers();
  if (dsSecVList) { dsSecVList.destroy(); dsSecVList = null; }
}

export function init() {
  dsInitState();
  dsPollData();
}
