// =========================================================================
// MX TOOL RUNNER — the only place in the codebase that knows about mx.exe
// =========================================================================
// Wave 28. `mx.exe` ships with every Studio Pro install and can export a
// project's full security model as JSON — the one thing neither the live
// database nor `deployment/model/` can give us: every entity/document access
// rule, per role, with its XPath constraint and member rights.
//
// Everything measured on this machine 07.09.2026 (13 installations, 22
// projects). What those measurements forced into the design:
//
//   * THE RUN IS SLOW AND NOT INTERACTIVE. `export-security-overview` took
//     55–89 s on toy projects; the time tracks the module count, not the
//     `.mpr` size. So this is a background job with progress, never a
//     request/response call.
//
//   * THE EXIT CODE IS USELESS. `export-security-overview` returned exit 1 on
//     every one of three fully successful runs (complete, parsable JSON each
//     time); a version mismatch is exit 3 with a text message, not exit 4 as
//     the source spec claimed. Success here is decided by VALIDATING THE JSON,
//     never by the exit code.
//
//   * NO MENDIX 9. The command does not exist before Mendix 11, and an 11.x
//     binary refuses a 9.x `.mpr` outright (exit 3). Two of the largest real
//     apps here are 9.24 — they get a clear "needs Mendix 10+" message before
//     anything is spawned. `deployment/model/` (waves 26–27) is what covers
//     Mendix 9.
//
//   * THE FILE IS NOT LOCKED BY STUDIO PRO. A normal open Studio Pro does not
//     hold an exclusive lock; the export is byte-identical whether Studio Pro
//     is open or closed. `mx` reads the file, so it sees the LAST SAVED state —
//     unsaved edits in Studio Pro are invisible to the matrix (said in Help).
//
//   * `.mpr` IS A SQLite DATABASE in `journal_mode=delete` (not WAL — the spec
//     was wrong, there are no `-wal`/`-shm` sidecar files). `_MetaData`
//     carries `_ProductVersion`, readable in milliseconds through the built-in
//     `node:sqlite` — no `mx show-version` process needed for the common path.
//
// Pure functions live at the top (no fs, no child_process) so
// scripts/parser-test.js can unit-test version parsing, binary selection,
// JSON validation and the progress counter without an `mx.exe` anywhere in
// sight — the same arrangement as server/livedb.js and server/model-deployment.js.
// =========================================================================

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { execFile } = require('child_process');

// A completed export was 5.9 MB on a 552 KB / Mx 10.24 project with 2128 entity
// rules. 128 MB is far above anything a real security model reaches and still
// bounds a runaway process writing junk to stdout.
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

// Measured ceiling was 89 s; 300 s leaves headroom for a genuinely large app
// without letting a hung process live forever.
const DEFAULT_TIMEOUT_MS = 300 * 1000;

// =========================================================================
// PURE — version strings
// =========================================================================

// Version strings arrive in two shapes, both real (measured 07.09.2026):
//   * a Studio Pro install directory — four parts, `10.24.0.61922`,
//     `9.24.23.37735`;
//   * `_MetaData._ProductVersion` inside a recent `.mpr` — three parts,
//     `11.12.2` (the marketing version).
// So 2–4 numeric parts are all accepted; only `major`/`minor` drive any
// decision here. Anything else is not a version we can reason about.
const VERSION_RE = /^(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
const VERSION_LOOSE_RE = /\d+\.\d+(?:\.\d+){0,2}/;

function mxParseVersion(str) {
  if (typeof str !== 'string') return null;
  const m = str.trim().match(VERSION_RE);
  if (!m) return null;
  return {
    full: m[0],
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: m[3] != null ? parseInt(m[3], 10) : 0,
    build: m[4] != null ? parseInt(m[4], 10) : 0
  };
}

// -1 / 0 / 1, numeric part by numeric part. Accepts version strings or the
// objects mxParseVersion returns; an unparsable string sorts lowest.
function mxCompareVersions(a, b) {
  const pa = typeof a === 'string' ? mxParseVersion(a) : a;
  const pb = typeof b === 'string' ? mxParseVersion(b) : b;
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  const keys = ['major', 'minor', 'patch', 'build'];
  for (const k of keys) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  return 0;
}

// =========================================================================
// PURE — binary selection
// =========================================================================
//
// Compatibility measured 07.09.2026:
//   * `export-security-overview` does not exist before Mendix 11.
//   * An 11.12 binary reads 10.x and 11.x projects, refuses 9.x.
//   * `show-version` is the exception — every binary reads every project.
//
// `installations` is the array mxDiscoverInstallations() returns:
//   [{ mxPath, version: '10.24.0.61922', parsed: {major,...} }, ...]
//
// Returns { mxPath, version } for the binary to use, or { error } with a
// message meant to be shown to the user verbatim — BEFORE anything is spawned.

function mxPickBinary(installations, mprVersionStr, command) {
  const list = Array.isArray(installations) ? installations.filter(i => i && i.mxPath) : [];
  if (!list.length) {
    return { error: 'No Mendix Studio Pro installation was found on this machine.' };
  }

  const mpr = mxParseVersion(mprVersionStr);
  const sorted = list.slice().sort((a, b) => mxCompareVersions(a.parsed || a.version, b.parsed || b.version));
  const newest = sorted[sorted.length - 1];

  // `show-version` works with any binary and any project — used to read a
  // version we could not get from the `.mpr` directly.
  if (command === 'show-version') {
    return { mxPath: newest.mxPath, version: newest.version };
  }

  if (command === 'export-security-overview') {
    if (!mpr) {
      return { error: 'Could not determine the Mendix version of this project.' };
    }
    if (mpr.major < 10) {
      return {
        error: 'The security matrix needs a project built in Mendix 10 or newer. ' +
          'This project is ' + mpr.full + '. The deployment model (Dev Studio → ' +
          'Deployment Model) covers Mendix 9 instead.'
      };
    }
    // Need an 11+ binary whose major is at least the project's major.
    const usable = sorted.filter(i => {
      const p = i.parsed || mxParseVersion(i.version);
      return p && p.major >= 11 && p.major >= mpr.major;
    });
    if (!usable.length) {
      return {
        error: 'The security matrix needs a Mendix 11 (or newer) Studio Pro installation ' +
          'that can open a Mendix ' + mpr.major + '.x project. None was found. ' +
          'Installed: ' + sorted.map(i => i.version).join(', ') + '.'
      };
    }
    // Prefer the lowest usable major (closest to the project), newest within it.
    const targetMajor = usable[0].parsed ? usable[0].parsed.major :
      mxParseVersion(usable[0].version).major;
    const sameMajor = usable.filter(i => {
      const p = i.parsed || mxParseVersion(i.version);
      return p.major === targetMajor;
    });
    const chosen = (sameMajor.length ? sameMajor : usable);
    const pick = chosen[chosen.length - 1];
    return { mxPath: pick.mxPath, version: pick.version };
  }

  // Any other command: newest binary whose major covers the project.
  if (mpr) {
    const usable = sorted.filter(i => {
      const p = i.parsed || mxParseVersion(i.version);
      return p && p.major >= mpr.major;
    });
    if (usable.length) {
      const pick = usable[usable.length - 1];
      return { mxPath: pick.mxPath, version: pick.version };
    }
  }
  return { mxPath: newest.mxPath, version: newest.version };
}

// =========================================================================
// PURE — progress
// =========================================================================
//
// `export-security-overview` writes a line per module to stdout while it runs
// (measured phrasing: `Exporting entity access for module 'X'...`). Counting
// distinct modules against the known total is the only progress signal there
// is — there is no percentage in the output.

const PROGRESS_RE = /(?:exporting|processing)[^']*module\s+'([^']+)'/i;

// Returns the module name a line announces, or null. The caller keeps the set
// of names seen and turns |seen| / totalModules into a percentage.
function mxProgressModule(line) {
  if (typeof line !== 'string') return null;
  const m = line.match(PROGRESS_RE);
  return m ? m[1] : null;
}

// =========================================================================
// PURE — JSON validation
// =========================================================================
//
// The exit code lies (exit 1 on success, 3/3 runs). The only reliable success
// signal is a parsable document with the three arrays the export always
// carries. A file truncated mid-write parses as invalid JSON or is missing an
// array — either way this returns a reason, never a false pass.

const SECURITY_ARRAYS = ['entityAccess', 'documentAccess', 'userRoles'];

// Accepts the parsed object (or a raw string to parse). Returns
// { ok: true, doc } or { ok: false, reason }.
function mxValidateSecurityJson(input) {
  let doc = input;
  if (typeof input === 'string') {
    try {
      doc = JSON.parse(input);
    } catch (e) {
      return { ok: false, reason: 'The export is not valid JSON — the run was cut short.' };
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, reason: 'The export is not a JSON object.' };
  }
  for (const key of SECURITY_ARRAYS) {
    if (!Array.isArray(doc[key])) {
      return { ok: false, reason: 'The export is missing the "' + key + '" array — it did not finish.' };
    }
  }
  return { ok: true, doc: doc };
}

// =========================================================================
// PURE — normalisation
// =========================================================================
//
// The real shape, measured on a Mendix 11.12 export 08.09.2026
// (Calculator: 429 entityAccess / 664 documentAccess / 6 userRoles):
//
//   entityAccess[]   { userRole: { name, isAnonymousRole, isAdministratorRole },
//                      module, entity, XPath, XPathCaption, canCreate, canDelete,
//                      members: [{ name, kind: Attribute|Association,
//                                  type, access: ReadOnly|ReadWrite }] }
//                    — ONE ROW PER (role × entity) access rule. `XPath: ""`
//                      means no constraint. The file lists only entities that
//                      HAVE at least one rule; ruleless entities are absent.
//
//   documentAccess[] { module, document, documentType: Page|Microflow|Nanoflow,
//                      userRoles: [{ name, isAnonymousRole, isAdministratorRole }] }
//                    — ONE ROW PER document; `userRoles: []` means no role can
//                      reach it.
//
//   userRoles[]      { userRole (name string), isAnonymousRole,
//                      isAdministratorRole, moduleRoles: [{ module, moduleRole }] }
//
// The normalized form drops per-attribute detail (kept only as read/write
// counts) — the matrix is about rules, not attributes — and keeps everything a
// filter or a highlight needs. Short keys because a big app's export is ~6 MB
// and this whole structure crosses to the browser.

function mxCountMembers(members) {
  let read = 0, write = 0;
  const list = Array.isArray(members) ? members : [];
  for (const m of list) {
    if (!m) continue;
    read++;
    if (m.access === 'ReadWrite') write++;
  }
  return { read: read, write: write };
}

function mxNormalizeSecurity(doc) {
  const v = mxValidateSecurityJson(doc);
  if (!v.ok) throw new Error(v.reason);
  const d = v.doc;

  const roles = d.userRoles.map(r => ({
    name: r.userRole,
    admin: !!r.isAdministratorRole,
    anon: !!r.isAnonymousRole,
    moduleRoles: Array.isArray(r.moduleRoles) ?
      r.moduleRoles.map(mr => ({ module: mr.module, role: mr.moduleRole })) : []
  }));

  const entityRules = d.entityAccess.map(r => {
    const ur = r.userRole || {};
    const mc = mxCountMembers(r.members);
    const xpath = (r.XPath || '').trim();
    return {
      role: ur.name || '(unknown)',
      admin: !!ur.isAdministratorRole,
      anon: !!ur.isAnonymousRole,
      module: r.module || '',
      entity: r.entity || '',
      qname: (r.module || '') + '.' + (r.entity || ''),
      xpath: xpath,
      create: !!r.canCreate,
      del: !!r.canDelete,
      read: mc.read,
      write: mc.write
    };
  });

  const documentRules = d.documentAccess.map(r => {
    const urs = Array.isArray(r.userRoles) ? r.userRoles : [];
    return {
      module: r.module || '',
      name: r.document || '',
      type: r.documentType || '',
      roles: urs.map(u => u.name),
      anonRoles: urs.filter(u => u && u.isAnonymousRole).map(u => u.name)
    };
  });

  const entities = new Set();
  const modules = new Set();
  for (const r of entityRules) { entities.add(r.qname); modules.add(r.module); }
  for (const r of documentRules) modules.add(r.module);

  return {
    counts: {
      entityRules: entityRules.length,
      documentRules: documentRules.length,
      userRoles: roles.length,
      entities: entities.size,
      modules: modules.size
    },
    roles: roles,
    entityRules: entityRules,
    documentRules: documentRules,
    highlights: mxSecurityHighlights(entityRules, documentRules)
  };
}

// =========================================================================
// PURE — highlights (what turns the table into a review tool)
// =========================================================================
//
// Only what the export can actually support. "Entities with no access rule at
// all" is NOT here: the export lists rules, not entities, so a ruleless entity
// is simply absent from the file — that check needs the domain model and is
// done on the frontend when the deployment-model index is loaded.

function mxSecurityHighlights(entityRules, documentRules) {
  const broadWrite = [];   // non-admin role, no XPath, may create or delete
  const anonEntity = [];   // any rule granted to an anonymous role
  const anonDocument = []; // any document reachable by an anonymous role

  entityRules.forEach((r, i) => {
    if (r.anon) anonEntity.push(i);
    if (!r.admin && !r.xpath && (r.create || r.del)) broadWrite.push(i);
  });
  documentRules.forEach((r, i) => {
    if (r.anonRoles && r.anonRoles.length) anonDocument.push(i);
  });

  return {
    broadWrite: broadWrite,
    anonEntity: anonEntity,
    anonDocument: anonDocument
  };
}

// =========================================================================
// IMPURE — discovering installations
// =========================================================================

// Studio Pro installs under `C:\Program Files\Mendix\<version>\modeler\mx.exe`
// and, for per-user installs, `%LOCALAPPDATA%\Mendix\<version>\modeler\mx.exe`.
function mxInstallRoots() {
  const roots = [];
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'];
  const local = process.env.LOCALAPPDATA;
  roots.push(path.join(pf, 'Mendix'));
  if (pf86) roots.push(path.join(pf86, 'Mendix'));
  if (local) roots.push(path.join(local, 'Mendix'));
  return roots;
}

let _installCache = null;

// Returns [{ mxPath, version, parsed }], newest last. Cached in process memory;
// pass `{ refresh: true }` to rescan (the UI has a manual refresh).
async function mxDiscoverInstallations(opts) {
  if (_installCache && !(opts && opts.refresh)) return _installCache;

  const found = [];
  const seen = new Set();
  for (const root of mxInstallRoots()) {
    let entries;
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch (e) {
      continue; // root does not exist — normal
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const parsed = mxParseVersion(entry.name);
      if (!parsed) continue;
      const mxPath = path.join(root, entry.name, 'modeler', 'mx.exe');
      if (seen.has(mxPath)) continue;
      try {
        const st = await fsp.stat(mxPath);
        if (!st.isFile()) continue;
      } catch (e) {
        continue;
      }
      seen.add(mxPath);
      found.push({ mxPath: mxPath, version: entry.name, parsed: parsed });
    }
  }
  found.sort((a, b) => mxCompareVersions(a.parsed, b.parsed));
  _installCache = found;
  return found;
}

// =========================================================================
// IMPURE — the project `.mpr` and its version
// =========================================================================

// A Mendix project has exactly one `.mpr` in its root. Zero or several means
// this is not a project root (or a backup got left behind) — say which.
async function mxFindMpr(projectRoot) {
  let entries;
  try {
    entries = await fsp.readdir(projectRoot, { withFileTypes: true });
  } catch (e) {
    throw new Error('Cannot read the project directory: ' + projectRoot);
  }
  const mprs = entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.mpr'))
    .map(e => e.name);
  if (!mprs.length) {
    throw new Error('No .mpr file in ' + projectRoot + ' — point this at the root of a Mendix project.');
  }
  if (mprs.length > 1) {
    throw new Error('Several .mpr files in ' + projectRoot + ' (' + mprs.join(', ') +
      ') — remove the copies so it is unambiguous which project to read.');
  }
  return path.join(projectRoot, mprs[0]);
}

// `_MetaData._ProductVersion` through the built-in SQLite reader (milliseconds,
// zero dependencies). `node:sqlite` is experimental in Node 22 and may be
// absent or throw — fall back to `mx show-version` then.
async function mxReadMprVersion(mprPath, installations) {
  const viaSqlite = mxReadMprVersionSqlite(mprPath);
  if (viaSqlite) return { version: viaSqlite, source: 'sqlite' };

  const pick = mxPickBinary(installations, null, 'show-version');
  if (pick.error) throw new Error(pick.error);
  const outFile = path.join(os.tmpdir(), 'mxdev-showversion-' + process.pid + '.txt');
  try {
    await mxRun(pick.mxPath, ['show-version', mprPath], { outFile: outFile, timeoutMs: 60000 });
    const text = await fsp.readFile(outFile, 'utf8');
    const m = text.match(VERSION_LOOSE_RE);
    if (m) return { version: m[0], source: 'show-version' };
    throw new Error('mx show-version produced no version string.');
  } finally {
    fsp.unlink(outFile).catch(() => {});
  }
}

function mxReadMprVersionSqlite(mprPath) {
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch (e) {
    return null; // not available in this Node build
  }
  let db;
  try {
    db = new sqlite.DatabaseSync(mprPath, { readOnly: true });
  } catch (e) {
    return null;
  }
  try {
    // `_MetaData` is a single-row table with a `_ProductVersion` column.
    for (const sql of [
      'SELECT _ProductVersion AS v FROM _MetaData LIMIT 1',
      "SELECT value AS v FROM _MetaData WHERE key = '_ProductVersion' LIMIT 1"
    ]) {
      try {
        const row = db.prepare(sql).get();
        if (row && row.v && mxParseVersion(String(row.v))) return String(row.v).trim();
      } catch (e) { /* try the next shape */ }
    }
    return null;
  } finally {
    try { db.close(); } catch (e) {}
  }
}

// =========================================================================
// IMPURE — running mx.exe
// =========================================================================
//
// execFile with an ARGUMENT ARRAY, never exec with a joined string — the
// project path can contain spaces and must never be shell-parsed. The binary
// path comes only from mxDiscoverInstallations(); nothing from the request
// reaches this as an executable.

function mxRun(mxPath, args, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = execFile(mxPath, args, {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        killSignal: 'SIGKILL'
      });
    } catch (e) {
      return reject(e);
    }
    if (opts.onChild) opts.onChild(child);

    let stderr = '';
    let stdoutBytes = 0;
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    const out = opts.outFile ? fs.createWriteStream(opts.outFile) : null;
    if (out) {
      out.on('error', (e) => finish(reject, e));
      child.stdout.pipe(out);
    }

    child.stdout.on('data', (buf) => {
      stdoutBytes += buf.length;
      if (opts.onOutput) opts.onOutput(buf.toString());
    });
    // `mx` writes its per-module progress to stderr, not stdout — feed both to
    // the progress callback, keep stderr for the failure message.
    child.stderr.on('data', (buf) => {
      stderr += buf.toString();
      if (opts.onOutput) opts.onOutput(buf.toString());
    });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code, signal) => {
      const done = () => finish(resolve, {
        code: code,
        signal: signal,
        killed: !!child.killed || signal === 'SIGKILL' || signal === 'SIGTERM',
        stderr: stderr,
        stdoutBytes: stdoutBytes
      });
      if (out) { out.end(); out.on('close', done); }
      else done();
    });
  });
}

// The exact invocation, measured against `mx export-security-overview --help`
// (v11.12.2): `-t json -o OUT PROJECT`. Kept in one place so a future CLI
// change is a one-line fix.
function mxSecurityArgs(mprPath, outFile) {
  return ['export-security-overview', '-t', 'json', '-o', outFile, mprPath];
}

// =========================================================================
// IMPURE — the background job (one at a time)
// =========================================================================
// The export is 55–90 s, so the route cannot answer once at the end. A run is
// a JOB: POST starts it, GET polls it. Only one at a time — a second would
// fight the first for the same binary and neither result would be trustworthy.
// Same single-session shape as server/perf-session.js.

const crypto = require('crypto');

let _job = null;

// Progress is mostly a clock, not a module count. Measured 08.09.2026: `mx`
// spends ~20–55 s loading the model with NO output, then prints every module
// line in about two seconds, then writes the file. So the bar creeps on
// elapsed time until the module lines appear, then jumps near the end.
const PROGRESS_ESTIMATE_MS = 55 * 1000;

function mxSecurityJobView(j) {
  if (!j) return null;
  const elapsed = (j.finishedAt || Date.now()) - j.startedAt;
  let percent;
  if (j.state === 'done') percent = 100;
  else if (j.state === 'error') percent = j.percent || 0;
  else if (j.cached) percent = 99;
  else if (!j.sawModules) percent = Math.min(80, Math.round((elapsed / PROGRESS_ESTIMATE_MS) * 80));
  else percent = Math.min(98, 82 + j.seen.role.size * 2 + (j.seen.document.size ? 8 : 0));
  return {
    jobId: j.id,
    state: j.state,               // 'running' | 'done' | 'error'
    phase: j.phase,               // human label
    percent: percent,
    module: j.currentModule || null,
    projectRoot: j.projectRoot,
    startedAt: j.startedAt,
    durationMs: elapsed,
    error: j.error || null,
    result: j.state === 'done' ? j.result : null
  };
}

function mxSecurityJobStatus(jobId) {
  if (!_job) return null;
  if (jobId && _job.id !== jobId) return null;
  return mxSecurityJobView(_job);
}

function mxCancelSecurityJob(jobId) {
  if (!_job || (jobId && _job.id !== jobId) || _job.state !== 'running') return false;
  _job.state = 'error';
  _job.error = 'Cancelled.';
  _job.finishedAt = Date.now();
  if (_job.child) { try { _job.child.kill('SIGKILL'); } catch (e) {} }
  return true;
}

function mxSecurityCacheDir() {
  return path.join(os.tmpdir(), 'mxdev-swiss-tool', 'security');
}

// Starts a job for `projectRoot` (already validated by the caller). Returns the
// job view immediately; the run continues in the background.
async function mxStartSecurityJob(projectRoot, opts) {
  opts = opts || {};
  if (_job && _job.state === 'running') {
    return { started: false, reason: 'A security export is already running.', job: mxSecurityJobView(_job) };
  }
  const job = {
    id: 'sec-' + Date.now().toString(36),
    projectRoot: projectRoot,
    state: 'running',
    phase: 'Starting…',
    percent: 1,
    currentModule: null,
    startedAt: Date.now(),
    finishedAt: 0,
    error: null,
    result: null,
    child: null,
    cached: false,
    sawModules: false,
    seen: { entity: new Set(), document: new Set(), role: new Set() }
  };
  _job = job;
  runSecurityJob(job, opts).catch(e => {
    job.state = 'error';
    job.error = e && e.message ? e.message : String(e);
    job.finishedAt = Date.now();
  });
  return { started: true, job: mxSecurityJobView(job) };
}

// The module lines only start after the long silent model-load, and then all
// arrive within ~2 s — so this marks that the load is done and tracks which
// pass we are in; the percentage itself is elapsed-time based in
// mxSecurityJobView.
function mxSecurityProgress(job, line) {
  const mod = mxProgressModule(line);
  const lower = line.toLowerCase();
  job.sawModules = true;
  if (lower.indexOf('document access') !== -1) {
    if (mod) job.seen.document.add(mod);
    job.currentModule = mod;
    job.phase = 'Reading document access';
  } else if (lower.indexOf('entity access') !== -1) {
    if (mod) job.seen.entity.add(mod);
    job.currentModule = mod;
    job.phase = 'Reading entity access';
  } else if (lower.indexOf('user role') !== -1) {
    const m = line.match(/user role\s+'([^']+)'/i);
    if (m) { job.seen.role.add(m[1]); job.currentModule = m[1]; }
    job.phase = 'Reading user roles';
  }
}

async function runSecurityJob(job, opts) {
  const installations = await mxDiscoverInstallations(opts.discoverOpts);
  const mprPath = await mxFindMpr(job.projectRoot);

  const versionInfo = await mxReadMprVersion(mprPath, installations);
  const pick = mxPickBinary(installations, versionInfo.version, 'export-security-overview');
  if (pick.error) {
    job.state = 'error';
    job.error = pick.error;
    job.finishedAt = Date.now();
    return;
  }

  const stat = await fsp.stat(mprPath);
  const cacheKey = crypto.createHash('sha256')
    .update(mprPath + '|' + stat.mtimeMs + '|' + stat.size + '|' + pick.version)
    .digest('hex');
  const cacheDir = mxSecurityCacheDir();
  await fsp.mkdir(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, cacheKey + '.json');

  let raw = null;
  let cached = false;
  try {
    raw = await fsp.readFile(cacheFile, 'utf8');
    if (mxValidateSecurityJson(raw).ok) { cached = true; job.cached = true; }
    else raw = null;
  } catch (e) { raw = null; }

  if (!raw) {
    const outFile = path.join(cacheDir, cacheKey + '.partial.json');
    job.phase = 'Loading the project model…';
    const run = await mxRun(pick.mxPath, mxSecurityArgs(mprPath, outFile), {
      timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
      onChild: c => { job.child = c; },
      onOutput: chunk => {
        if (job.state !== 'running') return;
        chunk.split(/\r?\n/).forEach(l => { if (l.trim()) mxSecurityProgress(job, l); });
      }
    });
    job.child = null;
    if (job.state !== 'running') return; // cancelled
    if (run.killed && run.signal) {
      job.state = 'error';
      job.error = (run.stderr && /database is locked/i.test(run.stderr)) ?
        'The project is being saved right now — try again in a moment.' :
        'mx export-security-overview timed out or was killed.';
      job.finishedAt = Date.now();
      return;
    }
    try {
      raw = await fsp.readFile(outFile, 'utf8');
    } catch (e) {
      job.state = 'error';
      job.error = 'The export produced no output. ' + (run.stderr || '').split(/\r?\n/)[0];
      job.finishedAt = Date.now();
      return;
    }
    // Exit code is 1 even on success — validate the JSON instead.
    const v = mxValidateSecurityJson(raw);
    if (!v.ok) {
      job.state = 'error';
      job.error = v.reason + (run.stderr ? ' (' + run.stderr.split(/\r?\n/)[0] + ')' : '');
      job.finishedAt = Date.now();
      await fsp.unlink(outFile).catch(() => {});
      return;
    }
    await fsp.rename(outFile, cacheFile).catch(async () => {
      await fsp.writeFile(cacheFile, raw).catch(() => {});
    });
  }

  job.phase = 'Building the matrix…';
  job.percent = 99;
  const normalized = mxNormalizeSecurity(raw);
  job.result = {
    meta: {
      projectVersion: versionInfo.version,
      versionSource: versionInfo.source,
      binaryVersion: pick.version,
      mprName: path.basename(mprPath),
      cached: cached,
      ranAt: Date.now()
    },
    counts: normalized.counts,
    roles: normalized.roles,
    entityRules: normalized.entityRules,
    documentRules: normalized.documentRules,
    highlights: normalized.highlights
  };
  job.state = 'done';
  job.percent = 100;
  job.phase = 'Done';
  job.currentModule = null;
  job.finishedAt = Date.now();
}

module.exports = {
  // pure
  mxParseVersion,
  mxCompareVersions,
  mxPickBinary,
  mxProgressModule,
  mxValidateSecurityJson,
  mxNormalizeSecurity,
  mxSecurityHighlights,
  mxSecurityArgs,
  // impure — installations & versions
  mxDiscoverInstallations,
  mxFindMpr,
  mxReadMprVersion,
  mxRun,
  // impure — the job
  mxStartSecurityJob,
  mxSecurityJobStatus,
  mxCancelSecurityJob,
  mxSecurityCacheDir,
  // constants
  MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS
};
