// =========================================================================
// Shared PostgreSQL connection (Live DB — Wave 6)
// =========================================================================
// One optional, read-only DB connection shared by all Live DB features
// (EXPLAIN live now; Index Advisor / Domain Model later). Live DB is
// PROGRESSIVE ENHANCEMENT: with no connection every tool keeps working on
// pasted/loaded data — a connection only *unlocks* the live actions. Users
// on Mendix Cloud (no DB) or a locked-down environment simply never connect.
//
// The password lives ONLY in memory for the session — it is never persisted.
// Any element carrying `data-mt-db-connection` becomes a connection bar; all
// bars share one state and stay in sync.
// =========================================================================

const AGENT_URL = 'http://localhost:9999';

const state = {
  config: { host: 'localhost', port: '5432', database: '', user: 'postgres', password: '' },
  status: 'none',   // 'none' | 'testing' | 'connected' | 'error'
  message: ''       // version string when connected, error text when error
};

const mounts = new Set();
const listeners = new Set();

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function statusPill() {
  const map = {
    none:      ['var(--text-muted)',  'var(--bg-sunken)',      'Not connected'],
    testing:   ['var(--info)',        'var(--info-subtle)',    'Connecting…'],
    connected: ['var(--success)',     'var(--success-subtle)', '● Connected'],
    error:     ['var(--danger)',      'var(--danger-subtle)',  '● Error']
  };
  const [color, bg, label] = map[state.status] || map.none;
  return `<span style="font-size:0.72rem;font-weight:600;color:${color};background:${bg};padding:1px 8px;border-radius:999px;white-space:nowrap">${label}</span>`;
}

function field(key, label, type, width) {
  return `<label style="display:flex;flex-direction:column;gap:2px;font-size:0.68rem;color:var(--text-secondary)">${label}
    <input class="input input-sm" type="${type}" data-f="${key}" value="${esc(state.config[key])}"
      ${key === 'password' ? 'autocomplete="off"' : ''} style="width:${width}"></label>`;
}

function renderBar(el) {
  const connected = state.status === 'connected';
  const msg = state.message
    ? `<div style="margin-top:var(--sp-2);font-size:0.72rem;color:${state.status === 'error' ? 'var(--danger)' : 'var(--text-muted)'};font-family:var(--font-mono);word-break:break-word">${esc(state.message)}</div>`
    : '';
  el.innerHTML = `
    <div style="border:1px solid var(--border);border-radius:var(--r-md);padding:var(--sp-2) var(--sp-3);background:var(--bg-elevated)">
      <div style="display:flex;align-items:center;gap:var(--sp-2);margin-bottom:var(--sp-2);flex-wrap:wrap">
        <strong style="font-size:0.8rem">Live database <span style="color:var(--text-muted);font-weight:400">(optional, read-only)</span></strong>
        ${statusPill()}
        <span style="margin-left:auto;font-size:0.7rem;color:var(--text-muted)">No connection? Every tool still works on pasted / loaded data.</span>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:var(--sp-2);align-items:flex-end">
        ${field('host', 'Host', 'text', '120px')}
        ${field('port', 'Port', 'text', '64px')}
        ${field('database', 'Database', 'text', '130px')}
        ${field('user', 'User', 'text', '110px')}
        ${field('password', 'Password', 'password', '110px')}
        <button class="btn ${connected ? 'btn-secondary' : 'btn-primary'} btn-sm" data-connect
          ${state.status === 'testing' ? 'disabled' : ''}>${connected ? 'Reconnect' : 'Connect'}</button>
      </div>
      ${msg}
    </div>`;

  el.querySelectorAll('input[data-f]').forEach(input => {
    input.addEventListener('input', () => { state.config[input.getAttribute('data-f')] = input.value; });
  });
  const btn = el.querySelector('[data-connect]');
  if (btn) btn.addEventListener('click', () => mtDb.test());
}

function notify() {
  mounts.forEach(el => renderBar(el));
  listeners.forEach(cb => { try { cb(mtDb.getStatus()); } catch (e) {} });
}

const mtDb = {
  getConfig() {
    return {
      host: state.config.host || 'localhost',
      port: parseInt(state.config.port, 10) || 5432,
      database: state.config.database || '',
      user: state.config.user || 'postgres',
      password: state.config.password || ''
    };
  },
  isConnected() { return state.status === 'connected'; },
  getStatus() { return state.status; },
  onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  async test() {
    state.status = 'testing';
    state.message = '';
    notify();
    try {
      const resp = await fetch(`${AGENT_URL}/livedb/ping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mtDb.getConfig())
      });
      const data = await resp.json();
      if (data && data.ok) {
        state.status = 'connected';
        state.message = 'Connected to ' + (data.database || mtDb.getConfig().database) + ' — ' + String(data.version || '').split(',')[0];
      } else {
        state.status = 'error';
        state.message = (data && data.message) || 'Connection failed.';
      }
    } catch (e) {
      state.status = 'error';
      state.message = 'Observability Bridge not reachable on ' + AGENT_URL + '. Start it (npm run bridge) — Live DB needs the Bridge to reach PostgreSQL.';
    }
    notify();
    return mtDb.isConnected();
  }
};

window.mtDb = mtDb;

export function initDbConnection() {
  document.querySelectorAll('[data-mt-db-connection]').forEach(el => {
    mounts.add(el);
    renderBar(el);
  });
}
