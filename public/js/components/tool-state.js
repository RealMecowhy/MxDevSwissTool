// TOOL STATE PERSISTENCE (opt-in, per-tool) · component
// ============================================================
// Shared, minimal persistence for "small" per-tool state: last-used settings
// (filters, thresholds, toggles) and metadata about the last file loaded into
// a tool (name/size/format). Deliberately NEVER file/log content — that's the
// whole reason this exists as one audited chokepoint instead of every tool
// inventing its own localStorage key with its own (possibly looser) contract.
//
// One JSON blob, keyed by toolId then by field name, so a single localStorage
// read/write covers every tool instead of one key per tool per field.
const MT_STATE_KEY = 'mt-tool-state';

// One warning per session; a failing write usually fails on every keystroke.
let mtStateWarned = false;

function mtStateLoadAll() {
  try { return JSON.parse(localStorage.getItem(MT_STATE_KEY) || '{}'); } catch (e) {
    // A corrupted blob silently wiped every tool's saved settings — returning {}
    // and carrying on means the next write overwrites the damaged value with a
    // fresh one, so the loss is real and permanent. Still recover (the app must
    // not be bricked by bad storage), but say so once.
    if (!mtStateWarned && typeof window !== 'undefined' && window.mtToast) {
      mtStateWarned = true;
      window.mtToast('Saved tool settings could not be read and have been reset. Anything you had customised is back to defaults.', 'warning');
    }
    return {};
  }
}

function mtStateSaveAll(all) {
  try {
    localStorage.setItem(MT_STATE_KEY, JSON.stringify(all));
    return true;
  } catch (e) {
    // Swallowing this made a full quota look like a successful save: the UI
    // confirmed, and the setting was gone on the next visit.
    if (!mtStateWarned && typeof window !== 'undefined' && window.mtToast) {
      mtStateWarned = true;
      window.mtToast('Could not save settings — browser storage is full or blocked. Your current work is unaffected, but preferences will not be remembered.', 'warning');
    }
    return false;
  }
}

function mtStateGet(toolId, key, fallback) {
  const tool = mtStateLoadAll()[toolId];
  return (tool && Object.prototype.hasOwnProperty.call(tool, key)) ? tool[key] : fallback;
}

function mtStateSet(toolId, key, value) {
  const all = mtStateLoadAll();
  if (!all[toolId]) all[toolId] = {};
  all[toolId][key] = value;
  mtStateSaveAll(all);
}

// Metadata only — name/size/format of the last file loaded into `toolId`.
// Tools that load files call this from their own load handler; never pass
// the file's actual content here.
function mtStateSetFileMeta(toolId, meta) {
  mtStateSet(toolId, 'lastFile', {
    name: (meta && meta.name) || null,
    size: (meta && typeof meta.size === 'number') ? meta.size : null,
    format: (meta && meta.format) || null,
    at: Date.now()
  });
}

function mtStateGetFileMeta(toolId) {
  return mtStateGet(toolId, 'lastFile', null);
}

// ── Portable settings ───────────────────────────────────────────────────────
// The app is handed around as a ZIP, and the update modal tells the user their
// data is safe *because* it lives in the browser. That is true right up to the
// moment they clear the profile, switch browser, or move machine — at which
// point favourites, presets and theme are gone with no way back. These two
// functions are the recovery path, and the only way to carry a setup to a
// second machine.
//
// Every key this app owns, and nothing else — an export must never scoop up
// another app's localStorage from a shared origin.
const MT_OWNED_KEYS = [
  'mt-tool-state',   // per-tool settings + last-file metadata
  'mt-favorites',    // pinned tools
  'mt-theme',        // light/dark
  'mt-sb',           // sidebar collapsed
  'mt-last-tool',    // resume where you left off
  'tm-chart-groups', // Telemetry Monitor chart layout
  'perfLabPreset'    // REST Load Tester saved request
];
const MT_SETTINGS_FORMAT = 1;

// Versioned on purpose: nothing stored today carries a schema marker, so a future
// change to any of these shapes has no way to detect an old file. Starting the
// count now means the next change can migrate instead of guessing.
function mtExportSettings() {
  const data = {};
  MT_OWNED_KEYS.forEach(k => {
    const v = localStorage.getItem(k);
    if (v !== null) data[k] = v;
  });
  return {
    format: MT_SETTINGS_FORMAT,
    app: 'mxdev-swiss-tool',
    exportedAt: new Date().toISOString(),
    data: data
  };
}

// Returns { ok, imported, skipped, error } rather than throwing, so the caller
// can report precisely what happened. Unknown keys are skipped, not trusted:
// the file is user-supplied and may come from a newer version.
function mtImportSettings(payload) {
  let parsed = payload;
  if (typeof payload === 'string') {
    try { parsed = JSON.parse(payload); }
    catch (e) { return { ok: false, error: 'That file is not valid JSON.' }; }
  }
  if (!parsed || parsed.app !== 'mxdev-swiss-tool' || !parsed.data || typeof parsed.data !== 'object') {
    return { ok: false, error: 'That is not a MxDev Swiss Tool settings file.' };
  }
  if (parsed.format > MT_SETTINGS_FORMAT) {
    return { ok: false, error: 'That settings file was written by a newer version of the toolkit.' };
  }
  let imported = 0, skipped = 0;
  Object.keys(parsed.data).forEach(k => {
    if (MT_OWNED_KEYS.indexOf(k) === -1) { skipped++; return; }
    const v = parsed.data[k];
    if (typeof v !== 'string') { skipped++; return; }
    try { localStorage.setItem(k, v); imported++; } catch (e) { skipped++; }
  });
  return { ok: true, imported: imported, skipped: skipped };
}

const MT_STATE_GLOBAL = (typeof window !== 'undefined' ? window : self);
MT_STATE_GLOBAL.mtStateGet = mtStateGet;
MT_STATE_GLOBAL.mtStateSet = mtStateSet;
MT_STATE_GLOBAL.mtStateSetFileMeta = mtStateSetFileMeta;
MT_STATE_GLOBAL.mtStateGetFileMeta = mtStateGetFileMeta;
MT_STATE_GLOBAL.mtExportSettings = mtExportSettings;
MT_STATE_GLOBAL.mtImportSettings = mtImportSettings;
MT_STATE_GLOBAL.MT_OWNED_KEYS = MT_OWNED_KEYS;

export function init() {}
