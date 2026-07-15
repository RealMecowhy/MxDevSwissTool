// ============================================================
// UPDATE CHECKER
// ============================================================
// Once per app load (a few seconds after startup) asks the local bridge
// whether a newer GitHub Release exists. If so, shows a modal with the
// release notes and two paths: one-click automatic update (the bridge
// downloads the ZIP, restarts itself through a small updater script) or
// a manual ZIP download for machines where the automatic path is blocked.
//
// User presets/favorites live in the browser's localStorage, so neither
// path can touch them — the modal says so explicitly.

const STATE_KEY = 'mt-update-state';
const SNOOZE_MS = 24 * 60 * 60 * 1000; // "remind me later" = 24h

function loadState() {
  try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}'); } catch (e) { return {}; }
}

function saveState(patch) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({ ...loadState(), ...patch }));
  } catch (e) {}
}

// Minimal, safe renderer for GitHub release-notes markdown: everything is
// HTML-escaped first, then only headings, bold, code, lists and links are
// re-introduced. Good enough for auto-generated "What's Changed" notes.
function renderReleaseNotes(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[^"'>])(https?:\/\/[^\s<]+)/g, (m, pre, url) => {
      const label = url.length > 60 ? url.slice(0, 57) + '…' : url;
      return `${pre}<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
    });

  const out = [];
  let listOpen = false;
  esc(String(md || '')).split(/\r?\n/).forEach(line => {
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      if (!listOpen) { out.push('<ul>'); listOpen = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      return;
    }
    if (listOpen) { out.push('</ul>'); listOpen = false; }
    const h = line.match(/^\s*(#{1,4})\s+(.*)$/);
    if (h) { out.push(`<h5>${inline(h[2])}</h5>`); return; }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  });
  if (listOpen) out.push('</ul>');
  return out.join('');
}

function buildModal(info) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'update-modal';

  const releasesHtml = info.releases.map(r => {
    const when = r.publishedAt ? new Date(r.publishedAt).toLocaleDateString() : '';
    return `<div class="update-release">
      <div class="update-release-head"><strong>${r.tag}</strong>${r.name && r.name !== r.tag ? ' — ' + r.name : ''}<span class="update-release-date">${when}</span></div>
      <div class="update-release-body">${renderReleaseNotes(r.body) || '<p>No release notes.</p>'}</div>
    </div>`;
  }).join('');

  const sizeMb = info.zipSize ? (info.zipSize / (1024 * 1024)).toFixed(1) + ' MB' : '';

  overlay.innerHTML = `
  <div class="modal modal-md" role="dialog" aria-modal="true" aria-labelledby="update-modal-title">
    <div class="modal-header">
      <div class="modal-title">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--accent)" stroke-width="2" style="margin-right:var(--sp-2)"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        <span id="update-modal-title">Update available — v${info.latestVersion}</span>
      </div>
      <button class="modal-close" id="update-modal-close" aria-label="Close dialog"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:var(--sp-3);padding:var(--sp-4)">
      <div>You are on <strong>v${info.currentVersion}</strong>, the latest release is <strong>v${info.latestVersion}</strong>.</div>
      <div class="update-notes">${releasesHtml}</div>
      <div class="notice notice-info" style="margin:0">
        <span>Your favorites, presets and theme are stored in this browser — they are <strong>not affected</strong> by updating.</span>
      </div>
      <div id="update-progress" style="display:none;align-items:center;gap:var(--sp-2)">
        <span id="update-spinner" style="display:inline-block;width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite"></span>
        <span id="update-progress-text"></span>
      </div>
      <div id="update-actions" style="display:flex;flex-wrap:wrap;gap:var(--sp-2);align-items:center">
        <button class="btn btn-primary" id="update-btn-auto">Update now</button>
        <a class="btn btn-secondary" id="update-btn-zip" href="${info.zipUrl || info.releasePageUrl}" target="_blank" rel="noopener">Download ZIP${sizeMb ? ' (' + sizeMb + ')' : ''}</a>
        <button class="btn btn-secondary" id="update-btn-later">Remind me later</button>
        <button class="btn btn-secondary" id="update-btn-skip" title="Don't show this again for v${info.latestVersion}">Skip this version</button>
      </div>
      <div id="update-manual-hint" style="display:none;font-size:0.85rem;color:var(--text-muted)">
        Manual update: download the ZIP and unpack it over the current tool folder, then restart
        <code>Start-MxDevSwissTool.bat</code>. Your local settings are kept either way.
      </div>
    </div>
  </div>`;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('active'));
  return overlay;
}

function closeModal(overlay) {
  overlay.classList.remove('active');
  setTimeout(() => overlay.remove(), 250);
}

function setProgress(text) {
  const box = document.getElementById('update-progress');
  const label = document.getElementById('update-progress-text');
  if (box) box.style.display = 'flex';
  if (label) label.textContent = text;
}

async function fetchStatus() {
  const res = await fetch('/status', { cache: 'no-store' });
  if (!res.ok) throw new Error('Bridge unreachable');
  return res.json();
}

async function startAutoUpdate(info, overlay) {
  const actions = document.getElementById('update-actions');
  const closeBtn = document.getElementById('update-modal-close');
  if (actions) actions.style.display = 'none';
  if (closeBtn) closeBtn.style.display = 'none';
  setProgress('Downloading and preparing the update… (this can take a minute)');

  try {
    // Fresh token right before applying: it authenticates the POST and is the
    // restart baseline — every bridge process generates a new random token, so
    // a changed token in /status is definitive proof the new bridge is up
    // (the restart can be faster than one polling interval).
    const before = await fetchStatus();
    const data = await (await fetch('/update/apply', {
      method: 'POST',
      headers: { 'X-Bridge-Token': before.token }
    })).json();
    if (!data || data.error || !data.success) {
      throw new Error((data && data.message) || 'Update failed to start.');
    }
    setProgress('Update in progress — the local bridge is restarting…');
    waitForNewVersion(info, overlay, before.token);
  } catch (err) {
    const spinner = document.getElementById('update-spinner');
    if (spinner) spinner.style.display = 'none';
    setProgress(`Automatic update failed: ${err.message}`);
    if (actions) actions.style.display = 'flex';
    if (closeBtn) closeBtn.style.display = '';
    const hint = document.getElementById('update-manual-hint');
    if (hint) hint.style.display = 'block';
  }
}

function waitForNewVersion(info, overlay, tokenBefore) {
  const deadline = Date.now() + 120000;
  const timer = setInterval(async () => {
    try {
      const status = await fetchStatus();
      const updated = status && (status.version === info.latestVersion ||
        (status.token && status.token !== tokenBefore));
      if (updated) {
        clearInterval(timer);
        saveState({ skipVersion: null, snoozeUntil: 0 });
        setProgress(`Updated to v${info.latestVersion} — reloading…`);
        setTimeout(() => location.reload(), 800);
        return;
      }
    } catch (e) { /* bridge restarting — keep waiting */ }
    if (Date.now() > deadline) {
      clearInterval(timer);
      const spinner = document.getElementById('update-spinner');
      if (spinner) spinner.style.display = 'none';
      setProgress('The bridge did not come back with the new version. Check the updater window, or update manually with the ZIP.');
      const actions = document.getElementById('update-actions');
      const closeBtn = document.getElementById('update-modal-close');
      if (actions) actions.style.display = 'flex';
      if (closeBtn) closeBtn.style.display = '';
      const hint = document.getElementById('update-manual-hint');
      if (hint) hint.style.display = 'block';
    }
  }, 2500);
  // Prevent accidental dismissal while files are being replaced
  overlay.onclick = null;
}

function showUpdateModal(info) {
  const overlay = buildModal(info);
  const snooze = () => { saveState({ snoozeUntil: Date.now() + SNOOZE_MS }); closeModal(overlay); };

  overlay.onclick = (e) => { if (e.target === overlay) snooze(); };
  document.getElementById('update-modal-close').onclick = snooze;
  document.getElementById('update-btn-later').onclick = snooze;
  document.getElementById('update-btn-skip').onclick = () => {
    saveState({ skipVersion: info.latestVersion });
    closeModal(overlay);
  };
  document.getElementById('update-btn-auto').onclick = () => startAutoUpdate(info, overlay);
}

export async function initUpdateChecker() {
  try {
    const status = await fetchStatus();
    if (!status || !status.token) return;
    const res = await fetch('/update/check', {
      headers: { 'X-Bridge-Token': status.token },
      cache: 'no-store'
    });
    const info = await res.json();
    if (!info || !info.updateAvailable || !info.latestVersion) return;

    const state = loadState();
    if (state.skipVersion === info.latestVersion) return;
    if (state.snoozeUntil && Date.now() < state.snoozeUntil) return;

    showUpdateModal(info);
  } catch (e) {
    // Offline, corporate proxy or bridge down — the check stays invisible.
  }
}
