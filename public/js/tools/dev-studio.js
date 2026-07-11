// DEVELOPER STUDIO (Module L)

let dsPollInterval = null;
let dsIsConnected = false;
let dsProjectData = null;
let dsProjectsList = [];

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
        alert("Could not load project metadata from the specified path. Ensure the path points to the root of the Mendix project.");
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
      alert("No project selected or found.");
    }
  } catch(e) {
    console.error("Connection error:", e);
    alert("Connection failed. Ensure the Mendix Observability Bridge is running.");
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
      events.forEach(e => {
        const item = document.createElement('div');
        item.style.display = 'flex';
        item.style.justifyContent = 'space-between';
        item.innerHTML = `<span style="color:var(--text-muted)">${escHtml(e.Name)}:</span> <span>${e.Interval} ${escHtml(e.Unit)}</span>`;
        eventsList.appendChild(item);
      });
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
        issuesList.innerHTML = '<span style="color:var(--success);font-size:0.85rem">No obvious issues found in Java code! 🎉</span>';
      }
    }

  } catch(e) {
    console.error("Failed to fetch insights:", e);
  }
}



function dsInitState() {
  dsIsConnected = false;
  if (dsPollInterval) {
    clearInterval(dsPollInterval);
    dsPollInterval = null;
  }
}

function dsDisconnect() {
  dsInitState();
  dsShowOfflineView();
}

async function dsPollData() {
  if (!dsIsConnected) {
    await dsAutoDetectProject();
  }
}



function dsShowDashboard() {
  document.getElementById('ds-offline-view').style.display = 'none';
  document.getElementById('ds-dashboard-view').style.display = 'flex';
  
  const statusIndicator = document.getElementById('ds-status-indicator');
  if (statusIndicator) {
    statusIndicator.style.background = 'var(--success)';
    statusIndicator.style.boxShadow = '0 0 8px var(--success)';
  }
}

function dsShowOfflineView() {
  document.getElementById('ds-offline-view').style.display = 'flex';
  document.getElementById('ds-dashboard-view').style.display = 'none';
}

// --- AUTO-GENERATED ESM EXPORTS ---
window.dsDisconnect = dsDisconnect;
window.dsPollData = dsPollData;

export function cleanup() {
  if (dsPollInterval) {
    clearInterval(dsPollInterval);
    dsPollInterval = null;
  }
}

export function init() {
  dsInitState();
  dsPollInterval = setInterval(dsPollData, 3000);
  dsPollData();
}
