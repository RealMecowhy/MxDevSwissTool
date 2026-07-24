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

function mtStateLoadAll() {
  try { return JSON.parse(localStorage.getItem(MT_STATE_KEY) || '{}'); } catch (e) { return {}; }
}

function mtStateSaveAll(all) {
  try { localStorage.setItem(MT_STATE_KEY, JSON.stringify(all)); } catch (e) {}
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

const MT_STATE_GLOBAL = (typeof window !== 'undefined' ? window : self);
MT_STATE_GLOBAL.mtStateGet = mtStateGet;
MT_STATE_GLOBAL.mtStateSet = mtStateSet;
MT_STATE_GLOBAL.mtStateSetFileMeta = mtStateSetFileMeta;
MT_STATE_GLOBAL.mtStateGetFileMeta = mtStateGetFileMeta;

export function init() {}
