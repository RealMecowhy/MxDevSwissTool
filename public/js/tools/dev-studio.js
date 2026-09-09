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

  const mprInput = document.getElementById('ds-mpr-path');
  if (mprInput && !mprInput.value && dsProjectData && dsProjectData.projectRoot) {
    mprInput.value = dsProjectData.projectRoot;
  }
  const i18nInput = document.getElementById('ds-i18n-path');
  if (i18nInput && !i18nInput.value && dsProjectData && dsProjectData.projectRoot) {
    i18nInput.value = dsProjectData.projectRoot;
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

// ── Project file (.mpr) — the offline reader (plan 006) ─────────────────────
// A fourth model source: the .mpr is a SQLite database whose units are BSON, so
// this needs neither a database nor a local run. It reflects the LAST SAVED
// state of the project; properties left at their Mendix default are not shown
// because Mendix does not store them. A failure here is quiet by design — this
// card degrades to its own instruction line, nothing else depends on it.
async function dsFetchMprModel() {
  const box = document.getElementById('ds-mpr-body');
  const input = document.getElementById('ds-mpr-path');
  if (!box || !input) return;
  const esc = window.escHtml;
  const raw = (input.value || '').trim();
  if (!raw) {
    box.innerHTML = `<div class="notice notice-warning" style="font-size:0.8rem">Enter a path to a .mpr file or the project folder.</div>`;
    return;
  }
  box.innerHTML = `<span style="color:var(--text-muted)"><span class="spinner-sm"></span>Reading ${esc(raw)}...</span>`;
  try {
    const res = await fetch('http://localhost:9999/model/mpr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mprPath: raw, projectRoot: raw })
    });
    const data = await res.json();
    if (!data || data.error || !data.ok) {
      const reason = (data && (data.reason || data.message)) || 'Could not read the .mpr.';
      box.innerHTML = `<div class="notice notice-warning" style="font-size:0.8rem">${esc(reason)}</div>`;
      return;
    }
    const c = data.counts || {};
    const s = data.security;
    const flags = [];
    if (s) {
      if (s.securityLevel) flags.push(`Security: <strong style="color:var(--text-primary)">${esc(s.securityLevel)}</strong>`);
      flags.push(`Guest access: <strong style="color:var(--text-primary)">${s.enableGuestAccess ? 'on' : 'off'}</strong>`);
      flags.push(`Strict mode: <strong style="color:var(--text-primary)">${s.strictMode ? 'on' : 'off'}</strong>`);
      if (s.adminPasswordSet) flags.push(`<span style="color:var(--warning)">Admin password is set in the model</span>`);
      if (s.passwordPolicy && typeof s.passwordPolicy.minimumLength === 'number' && s.passwordPolicy.minimumLength < 8) {
        flags.push(`<span style="color:var(--warning)">Weak password policy (min length ${s.passwordPolicy.minimumLength})</span>`);
      }
      const godRoles = (s.userRoles || []).filter(r => r.manageAllRoles).map(r => r.name);
      if (godRoles.length) flags.push(`Roles that manage all roles: <strong style="color:var(--text-primary)">${esc(godRoles.join(', '))}</strong>`);
    }
    box.innerHTML = `
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:var(--sp-2) var(--sp-4)">
        <div><span style="color:var(--text-muted)">Format:</span> <strong style="color:var(--text-primary)">v${data.formatVersion}</strong></div>
        <div><span style="color:var(--text-muted)">Mendix:</span> <strong style="color:var(--text-primary)">${esc(data.productVersion || '—')}</strong></div>
        <div><span style="color:var(--text-muted)">Modules:</span> <strong style="color:var(--text-primary)">${c.modules || 0}</strong></div>
        <div><span style="color:var(--text-muted)">Entities:</span> <strong style="color:var(--text-primary)">${c.entities || 0}</strong></div>
        <div><span style="color:var(--text-muted)">Microflows:</span> <strong style="color:var(--text-primary)">${c.microflows || 0}</strong></div>
        <div><span style="color:var(--text-muted)">Pages:</span> <strong style="color:var(--text-primary)">${c.pages || 0}</strong></div>
      </div>
      ${flags.length ? `<div style="margin-top:var(--sp-3); display:flex; flex-direction:column; gap:2px; font-size:0.8rem">${flags.map(f => `<div>${f}</div>`).join('')}</div>` : ''}
      <div style="margin-top:var(--sp-3); color:var(--text-muted); font-size:0.78rem">
        Read straight from <span style="font-family:var(--font-mono)">${esc(data.projectName)}.mpr</span> — last saved state, no database or local run needed.
      </div>`;
  } catch (e) {
    box.innerHTML = `<div class="notice notice-warning" style="font-size:0.8rem">Bridge unreachable — the .mpr could not be read.</div>`;
  }
}

// ── Dead code — model elements nothing references (plan 007) ────────────────
// Built on the same offline .mpr reader: the Bridge walks every unit's BSON for
// qualified-name strings that resolve to a real element and reports the ones
// with no live inbound edge. The finding is conservative by design — a false
// "alive" is safe, a false "dead" is not — so this view leads with that caveat
// and never offers a delete action.
const DS_DEAD_GROUPS = [
  ['MICROFLOW', 'Microflows'],
  ['NANOFLOW', 'Nanoflows'],
  ['PAGE', 'Pages'],
  ['SNIPPET', 'Snippets'],
  ['ENTITY', 'Entities']
];

async function dsFetchDeadCode() {
  const box = document.getElementById('ds-deadcode-body');
  const input = document.getElementById('ds-deadcode-path');
  if (!box || !input) return;
  const esc = window.escHtml;
  const raw = (input.value || '').trim();
  if (!raw) {
    box.innerHTML = `<div class="notice notice-warning" style="font-size:0.8rem">Enter a path to a .mpr file or the project folder.</div>`;
    return;
  }
  box.innerHTML = `<span style="color:var(--text-muted)"><span class="spinner-sm"></span>Analysing ${esc(raw)}...</span>`;
  try {
    const res = await fetch('http://localhost:9999/model/dead-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mprPath: raw, projectRoot: raw })
    });
    const data = await res.json();
    if (!data || data.error || !data.ok) {
      const reason = (data && (data.reason || data.message)) || 'Could not analyse the .mpr.';
      box.innerHTML = `<div class="notice notice-warning" style="font-size:0.8rem">${esc(reason)}</div>`;
      return;
    }
    const dead = data.dead || [];
    const uncertain = data.uncertain || [];
    const counts = data.counts || {};
    const byGroup = {};
    for (const d of dead) (byGroup[d.objectType] = byGroup[d.objectType] || []).push(d);

    const groupHtml = DS_DEAD_GROUPS.map(([type, label]) => {
      const items = byGroup[type] || [];
      if (!items.length) return '';
      const rows = items.map(d =>
        `<div style="display:flex; justify-content:space-between; gap:var(--sp-3); padding:2px 0">
           <span style="font-family:var(--font-mono); font-size:0.78rem; color:var(--text-primary)">${esc(d.qualifiedName)}</span>
           <span style="color:var(--text-muted); font-size:0.75rem; white-space:nowrap">${esc(d.reason)}</span>
         </div>`).join('');
      return `<div class="card" style="padding:var(--sp-3) var(--sp-4)">
        <div style="font-weight:600; color:var(--text-primary); margin-bottom:var(--sp-2)">${label} <span style="color:var(--text-muted); font-weight:400">(${items.length})</span></div>
        ${rows}
      </div>`;
    }).join('');

    const uncertainHtml = uncertain.length ? `
      <div class="card" style="padding:var(--sp-3) var(--sp-4)">
        <div style="font-weight:600; color:var(--text-primary); margin-bottom:var(--sp-1)">Enumerations &amp; constants <span style="color:var(--text-muted); font-weight:400">(${uncertain.length})</span></div>
        <div style="color:var(--text-muted); font-size:0.78rem; margin-bottom:var(--sp-2)">Inbound edges for these types are not fully captured &mdash; verify before deleting.</div>
        ${uncertain.map(u => `<div style="font-family:var(--font-mono); font-size:0.78rem; color:var(--text-secondary); padding:1px 0">${esc(u.qualifiedName)}</div>`).join('')}
      </div>` : '';

    box.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:var(--sp-3)">
        <div style="color:var(--text-muted); font-size:0.8rem">
          ${counts.elements || 0} referenceable elements, ${counts.refs || 0} references &mdash;
          <strong style="color:var(--text-primary)">${dead.length}</strong> with no live inbound edge.
        </div>
        ${dead.length ? groupHtml : `<div class="notice" style="font-size:0.8rem">Nothing unreferenced was found.</div>`}
        ${uncertainHtml}
      </div>`;
  } catch (e) {
    box.innerHTML = `<div class="notice notice-warning" style="font-size:0.8rem">Bridge unreachable — the dead-code analysis could not run.</div>`;
  }
}

// ── Translation completeness (i18n tab, plan 010) ──────────────────────────
// Walks the .mpr for every translatable caption/label (`Texts$Text`) and scores
// it against the project's enabled languages. "Missing" = a language enabled in
// the project with no text for a key the default language has. "Hardcoded" is a
// heuristic — a single-language text while the project is multi-language — and
// can include intentionally-untranslated platform texts. Read-only: this view
// never edits a translation. Offline, on the plan-006 reader.
async function dsFetchI18n() {
  const box = document.getElementById('ds-i18n-body');
  const input = document.getElementById('ds-i18n-path');
  if (!box || !input) return;
  const esc = window.escHtml;
  const raw = (input.value || '').trim();
  if (!raw) {
    box.innerHTML = `<div class="notice notice-warning" style="font-size:0.8rem">Enter a path to a .mpr file or the project folder.</div>`;
    return;
  }
  box.innerHTML = `<span style="color:var(--text-muted)"><span class="spinner-sm"></span>Reading ${esc(raw)}...</span>`;
  try {
    const res = await fetch('http://localhost:9999/model/i18n', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mprPath: raw, projectRoot: raw })
    });
    const data = await res.json();
    if (!data || data.error || !data.ok) {
      const reason = (data && (data.reason || data.message)) || 'Could not read the .mpr.';
      box.innerHTML = `<div class="notice notice-warning" style="font-size:0.8rem">${esc(reason)}</div>`;
      return;
    }
    dsRenderI18n(data);
  } catch (e) {
    box.innerHTML = `<div class="notice notice-warning" style="font-size:0.8rem">Bridge unreachable — the .mpr could not be read.</div>`;
  }
}

function dsRenderI18n(data) {
  const box = document.getElementById('ds-i18n-body');
  const esc = window.escHtml;
  const langs = Object.keys(data.byLanguage || {});

  if (!langs.length) {
    box.innerHTML = `
      <div class="notice notice-info" style="font-size:0.82rem">
        <strong>${esc(data.projectName)}</strong> is a single-language project
        (<span style="font-family:var(--font-mono)">${esc(data.defaultLang || '—')}</span>),
        so there is nothing to translate. ${data.textCount} translatable texts found.
      </div>`;
    return;
  }

  const bars = langs.map(function (l) {
    const s = data.byLanguage[l];
    const pct = s.total ? Math.round((s.translated / s.total) * 100) : 100;
    const colour = pct >= 95 ? 'var(--success)' : (pct >= 60 ? 'var(--info)' : 'var(--warning)');
    return `
      <div style="display:grid; grid-template-columns:70px 1fr 120px; gap:var(--sp-2); align-items:center; font-size:0.8rem">
        <span style="font-family:var(--font-mono)">${esc(l)}</span>
        <span style="background:var(--bg-base); border-radius:var(--radius-sm); overflow:hidden; height:14px">
          <span style="display:block; height:100%; width:${pct}%; background:${colour}"></span>
        </span>
        <span style="color:var(--text-muted); text-align:right">${pct}% &middot; ${s.missing} missing</span>
      </div>`;
  }).join('');

  const missingByLang = {};
  (data.missing || []).forEach(function (m) {
    (missingByLang[m.language] = missingByLang[m.language] || []).push(m);
  });
  const missingGroups = Object.keys(missingByLang).map(function (l) {
    const rows = missingByLang[l].map(function (m) {
      return `<tr style="border-top:1px solid var(--border-subtle)">
        <td style="padding:2px var(--sp-2); color:var(--text-secondary)">${esc(m.unitName || '—')}</td>
        <td style="padding:2px var(--sp-2); font-family:var(--font-mono); color:var(--text-muted); font-size:0.72rem">${esc(m.location)}</td>
        <td style="padding:2px var(--sp-2)">${esc(m.defaultText)}</td>
      </tr>`;
    }).join('');
    return `<details style="margin-top:var(--sp-2)">
      <summary style="cursor:pointer; font-size:0.82rem"><span style="font-family:var(--font-mono)">${esc(l)}</span> — ${data.byLanguage[l].missing} missing${missingByLang[l].length < data.byLanguage[l].missing ? ` (showing ${missingByLang[l].length})` : ''}</summary>
      <div style="overflow-x:auto"><table style="width:100%; border-collapse:collapse; font-size:0.78rem; margin-top:4px">
        <thead><tr style="color:var(--text-muted); text-align:left"><th style="padding:2px var(--sp-2)">Document</th><th style="padding:2px var(--sp-2)">Location</th><th style="padding:2px var(--sp-2)">Default text</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </details>`;
  }).join('');

  const hc = data.hardcoded || [];
  const hcRows = hc.map(function (h) {
    return `<tr style="border-top:1px solid var(--border-subtle)">
      <td style="padding:2px var(--sp-2); color:var(--text-secondary)">${esc(h.unitName || '—')}</td>
      <td style="padding:2px var(--sp-2); font-family:var(--font-mono); color:var(--text-muted); font-size:0.72rem">${esc(h.location)}</td>
      <td style="padding:2px var(--sp-2)">${esc(h.text)}</td>
    </tr>`;
  }).join('');

  box.innerHTML = `
    <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:var(--sp-3)">
      <strong style="color:var(--text-primary)">${esc(data.projectName)}</strong> &middot; ${langs.length + 1} languages
      (default <span style="font-family:var(--font-mono)">${esc(data.defaultLang)}</span>) &middot;
      ${data.textCount} translatable texts &middot; ${data.missingTotal} missing translations
    </div>
    <div style="display:flex; flex-direction:column; gap:4px">${bars}</div>
    <h5 style="margin:var(--sp-4) 0 0; color:var(--text-primary)">Missing translations${data.missingTruncated ? ` <span style="color:var(--text-muted); font-weight:400; font-size:0.78rem">(first ${data.missing.length} of ${data.missingTotal})</span>` : ''}</h5>
    ${missingGroups || '<div style="font-size:0.82rem; color:var(--text-muted)">None — every enabled language is complete.</div>'}
    <h5 style="margin:var(--sp-4) 0 var(--sp-1); color:var(--text-primary)">Hardcoded / single-language texts
      <span style="color:var(--text-muted); font-weight:400; font-size:0.78rem">— heuristic: present only in the default language${data.hardcodedTruncated ? `, first ${hc.length} of ${data.hardcodedTotal}` : ''}</span></h5>
    <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:var(--sp-2)">May include platform texts that are intentionally not translated.</div>
    ${hc.length ? `<div style="overflow-x:auto"><table style="width:100%; border-collapse:collapse; font-size:0.78rem">
      <thead><tr style="color:var(--text-muted); text-align:left"><th style="padding:2px var(--sp-2)">Document</th><th style="padding:2px var(--sp-2)">Location</th><th style="padding:2px var(--sp-2)">Text</th></tr></thead>
      <tbody>${hcRows}</tbody></table></div>` : '<div style="font-size:0.82rem; color:var(--text-muted)">None.</div>'}`;
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
  document.getElementById('ds-i18n-view').style.display = 'none';
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
  document.getElementById('ds-i18n-view').style.display = tabId === 'i18n' ? 'flex' : 'none';
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
window.dsFetchI18n = dsFetchI18n;

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
