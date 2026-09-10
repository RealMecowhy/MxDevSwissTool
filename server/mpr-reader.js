// =========================================================================
// MPR READER — a Mendix .mpr project file, read directly (Plan 006)
// =========================================================================
// A .mpr is a SQLite database; its model units are standard BSON. This module
// reads it with no database connection, no Studio Pro, no local run — the one
// gap the other three model sources (live DB, deployment/model/, mx.exe) all
// share. Works on Mendix 8-11, format v1 (units inline in SQLite) and v2
// (units in mprcontents/*.mxunit).
//
// Zero npm dependencies on purpose: the release ZIP ships no node_modules, so
// BSON is decoded by the small decoder below and SQLite comes from Node itself
// (`node:sqlite`, loaded lazily so an older Node still starts the bridge).
//
// Pure functions live at the top (no fs, no sqlite) so scripts/parser-test.js
// can unit-test them from hand-built BSON buffers — the model-deployment.js
// arrangement. Nothing here is copied out of a real project.
// =========================================================================
'use strict';
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');

// A single unit above this size is not something we were meant to read into
// memory — say so rather than letting the process grow unbounded.
const MAX_UNIT_BYTES = 32 * 1024 * 1024;
// A v1 .mpr keeps every unit inside the SQLite file; the largest real one
// measured here is 175 MB, so the file can be large but not unbounded.
const MAX_V1_DB_BYTES = 512 * 1024 * 1024;
// v2 units are separate files; reading a handful at once instead of one by one
// is what makes a cold read of a 4000-unit project bearable.
const READ_BATCH = 16;
// The model views ask for the same project one after another; one read serves
// them all for this long (and while the .mpr file itself is unchanged).
const LOAD_CACHE_TTL_MS = 60 * 1000;

// ── BSON decoding ───────────────────────────────────────────────────────────
// Only the element types a Mendix unit uses — measured over seven real
// projects (Mendix 9.24-11.12, v1 and v2) on 2026-09-10: double, string,
// document, array, binary, boolean, datetime, null, int32, int64. Anything else
// throws, and the caller counts that unit as undecoded rather than guessing.
// Binary values (Mendix uses them only for $ID and pointer GUIDs) come back as
// lowercase hex strings, datetimes as Date, int64 as Number.
function bsonDecode(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 5) throw new Error('BSON: buffer too short');
  if (buf.readInt32LE(0) > buf.length) throw new Error('BSON: truncated document');
  return bsonReadDoc(buf, 0, false);
}

function bsonReadDoc(buf, start, asArray) {
  const end = start + buf.readInt32LE(start) - 1; // the trailing 0x00
  const out = asArray ? [] : {};
  let i = start + 4;
  while (i < end) {
    const type = buf[i++];
    const nameEnd = buf.indexOf(0, i);
    if (nameEnd === -1 || nameEnd >= end) throw new Error('BSON: malformed element name');
    const name = asArray ? null : buf.toString('utf8', i, nameEnd);
    i = nameEnd + 1;
    let v, n;
    switch (type) {
      case 0x01: v = buf.readDoubleLE(i); i += 8; break;
      case 0x02: n = buf.readInt32LE(i); v = buf.toString('utf8', i + 4, i + 3 + n); i += 4 + n; break;
      case 0x03: case 0x04: n = buf.readInt32LE(i); v = bsonReadDoc(buf, i, type === 0x04); i += n; break;
      case 0x05: n = buf.readInt32LE(i); v = buf.toString('hex', i + 5, i + 5 + n); i += 5 + n; break;
      case 0x08: v = buf[i] === 1; i += 1; break;
      case 0x09: v = new Date(Number(buf.readBigInt64LE(i))); i += 8; break;
      case 0x0A: v = null; break;
      case 0x10: v = buf.readInt32LE(i); i += 4; break;
      case 0x12: v = Number(buf.readBigInt64LE(i)); i += 8; break;
      default: throw new Error('BSON: unsupported element type 0x' + type.toString(16));
    }
    if (asArray) out.push(v); else out[name] = v;
  }
  return out;
}

// ── UUID <-> blob (Microsoft GUID byte order) ────────────────────────────────
// Unit.UnitID is a 16-byte blob. The display UUID and the .mxunit filename
// reverse the first three groups (little-endian) and leave the last two as-is.
function blobToUuid(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== 16) return null;
  const h = buf.toString('hex');
  const b = [];
  for (let i = 0; i < 32; i += 2) b.push(h.slice(i, i + 2));
  return (
    b[3] + b[2] + b[1] + b[0] + '-' +
    b[5] + b[4] + '-' +
    b[7] + b[6] + '-' +
    b[8] + b[9] + '-' +
    b[10] + b[11] + b[12] + b[13] + b[14] + b[15]
  );
}

function uuidToBlob(uuid) {
  if (typeof uuid !== 'string') return null;
  const h = uuid.replace(/-/g, '').toLowerCase();
  if (h.length !== 32 || /[^0-9a-f]/.test(h)) return null;
  const b = [];
  for (let i = 0; i < 32; i += 2) b.push(h.slice(i, i + 2));
  const swapped = [
    b[3], b[2], b[1], b[0],
    b[5], b[4],
    b[7], b[6],
    b[8], b[9],
    b[10], b[11], b[12], b[13], b[14], b[15]
  ];
  return Buffer.from(swapped.join(''), 'hex');
}

// ── BSON reading helpers ────────────────────────────────────────────────────
// A property absent from a unit is at its Mendix default — Studio Pro does not
// write defaults. Never assume absence means a specific value; read through a
// helper that takes the Mendix default explicitly.
function mprBool(doc, key, mendixDefault) {
  return (doc && typeof doc[key] === 'boolean') ? doc[key] : mendixDefault;
}

// Studio Pro's storage name differs from the SDK name in a few places.
const FIELD_ALIASES = { Type: 'NewType', CaseValue: 'NewCaseValue', Layout: 'Form' };
function mprField(doc, key) {
  if (doc && doc[key] !== undefined) return doc[key];
  const alias = FIELD_ALIASES[key];
  return (alias && doc) ? doc[alias] : undefined;
}

// Model arrays carry an int32 version marker at index 0 — real values start at
// index 1. A non-array (an absent field) is an empty list.
function mprArray(v) {
  return Array.isArray(v) ? v.slice(1) : [];
}

function typeName(v) {
  if (v && typeof v === 'object' && typeof v.$Type === 'string') return v.$Type;
  return (typeof v === 'string') ? v : null;
}

// ── Shaping the model for consumers ─────────────────────────────────────────

// One access rule, with the entity-level READ/WRITE that Mendix does NOT store
// as a flag — it is derived from member access (any member ReadOnly/ReadWrite
// => entity READ; any ReadWrite => entity WRITE), falling back to
// DefaultMemberAccessRights when MemberAccesses is empty.
function mprShapeAccessRule(rule) {
  const roles = mprArray(rule.AllowedModuleRoles || rule.ModuleRoleNames)
    .filter(r => typeof r === 'string');
  const xpath = typeof rule.XPathConstraint === 'string' ? rule.XPathConstraint.trim() : '';
  const members = mprArray(rule.MemberAccesses);
  let read = false, write = false;
  if (members.length) {
    for (const m of members) {
      const r = m && m.AccessRights;
      if (r === 'ReadOnly' || r === 'ReadWrite') read = true;
      if (r === 'ReadWrite') write = true;
    }
  } else {
    const d = rule.DefaultMemberAccessRights;
    if (d === 'ReadOnly' || d === 'ReadWrite') read = true;
    if (d === 'ReadWrite') write = true;
  }
  return {
    moduleRoles: roles,
    constrained: xpath.length > 0,
    read: read,
    write: write,
    create: mprBool(rule, 'AllowCreate', false),
    delete: mprBool(rule, 'AllowDelete', false)
  };
}

function mprShapeEntity(ent, moduleName) {
  const gen = ent.MaybeGeneralization || {};
  const isNoGen = typeName(gen) === 'DomainModels$NoGeneralization';
  const attributes = mprArray(ent.Attributes).map(a => ({
    name: a.Name || null,
    type: typeName(mprField(a, 'Type')) || null
  }));
  const accessRules = mprArray(ent.AccessRules).map(mprShapeAccessRule);
  return {
    name: ent.Name || null,
    qualifiedName: (moduleName && ent.Name) ? moduleName + '.' + ent.Name : (ent.Name || null),
    // Persistable lives on NoGeneralization; a specialised entity inherits it,
    // so "unknown" (null) is the honest answer there rather than a guess.
    persistable: isNoGen ? mprBool(gen, 'Persistable', true) : null,
    generalization: isNoGen ? null : (typeof gen.Generalization === 'string' ? gen.Generalization : null),
    attributes: attributes,
    accessRules: accessRules,
    accessRuleCount: accessRules.length
  };
}

// Given the decoded DomainModels$DomainModel doc + its module name, return the
// entities and associations shaped for consumers.
function mprShapeDomainModel(doc, moduleName) {
  const d = doc || {};
  const entities = mprArray(d.Entities).map(e => mprShapeEntity(e, moduleName));
  const associations = mprArray(d.Associations).map(a => ({
    name: a.Name || null,
    type: typeName(a.Type),
    owner: typeof a.Owner === 'string' ? a.Owner : null
  }));
  return {
    module: moduleName || null,
    entities: entities,
    associations: associations
  };
}

function mprShapePasswordPolicy(p) {
  const pp = p || {};
  return {
    minimumLength: typeof pp.MinimumLength === 'number' ? pp.MinimumLength : null,
    requireDigit: mprBool(pp, 'RequireDigit', false),
    requireMixedCase: mprBool(pp, 'RequireMixedCase', false),
    requireSymbol: mprBool(pp, 'RequireSymbol', false)
  };
}

// Given the decoded Security$ProjectSecurity doc, return a shape that never
// carries a secret value — only "is set" flags for AdminPassword and demo-user
// passwords.
function mprShapeSecurity(doc) {
  const d = doc || {};
  const userRoles = mprArray(d.UserRoles).map(r => ({
    name: r.Name || null,
    moduleRoles: mprArray(r.ModuleRoles).filter(x => typeof x === 'string'),
    manageAllRoles: mprBool(r, 'ManageAllRoles', false)
  }));
  const demoUsers = mprArray(d.DemoUsers).map(u => ({
    userName: u.UserName || null,
    hasPassword: !!u.Password,
    userRoles: mprArray(u.UserRoles).filter(x => typeof x === 'string')
  }));
  return {
    securityLevel: d.SecurityLevel || null,
    checkSecurity: mprBool(d, 'CheckSecurity', true),
    strictMode: mprBool(d, 'StrictMode', false),
    enableGuestAccess: mprBool(d, 'EnableGuestAccess', false),
    enableDemoUsers: mprBool(d, 'EnableDemoUsers', false),
    guestUserRole: typeof d.GuestUserRole === 'string' ? d.GuestUserRole : null,
    adminUserName: typeof d.AdminUserName === 'string' ? d.AdminUserName : null,
    adminPasswordSet: !!d.AdminPassword,
    passwordPolicy: mprShapePasswordPolicy(d.PasswordPolicySettings),
    userRoles: userRoles,
    demoUsers: demoUsers
  };
}

// ── Reading from disk ───────────────────────────────────────────────────────

// `node:sqlite` arrived in Node 22.5. Loaded on first use so an older Node
// still starts the bridge — only the .mpr views then report what is missing.
let DatabaseSync = null;
function sqliteDatabase() {
  if (!DatabaseSync) {
    try {
      DatabaseSync = require('node:sqlite').DatabaseSync;
    } catch (e) {
      throw new Error(`Reading a .mpr needs Node.js 22.5 or newer; the bridge is running on ${process.version}. ` +
        'Install a current Node.js LTS, or put a portable node.exe in the runtime folder next to the launcher.');
    }
  }
  return DatabaseSync;
}

function unitTableHasColumn(db, col) {
  const rows = db.prepare('PRAGMA table_info(Unit)').all();
  return rows.some(r => r.name === col);
}

// Opens the .mpr SQLite database READ-ONLY and detects the storage format.
// Returns a context object, or throws a plain Error with a human message when
// the path is not a readable .mpr. The connection is opened read-only on every
// path so _Transaction.LastTransactionID (Studio Pro's F4-sync marker) is never
// touched.
async function mprOpen(mprPath) {
  let stat;
  try {
    stat = await fsp.stat(mprPath);
  } catch (e) {
    throw new Error(`Not a file: ${mprPath}`);
  }
  if (!stat.isFile()) throw new Error(`Not a file: ${mprPath}`);

  const Database = sqliteDatabase();
  let db;
  try {
    db = new Database(mprPath, { readOnly: true });
  } catch (e) {
    throw new Error(`Could not open as SQLite (not a .mpr?): ${e.message}`);
  }

  try {
    const hasUnit = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='Unit'"
    ).get();
    if (!hasUnit) throw new Error(`Not a Mendix .mpr (no Unit table): ${mprPath}`);

    let productVersion = null, buildVersion = null, schemaHash = null;
    try {
      const meta = db.prepare(
        'SELECT _ProductVersion, _BuildVersion, _SchemaHash FROM _MetaData LIMIT 1'
      ).get();
      if (meta) {
        productVersion = meta._ProductVersion || null;
        buildVersion = meta._BuildVersion || null;
        schemaHash = meta._SchemaHash || null;
      }
    } catch (e) {
      // _MetaData shape varies across versions; missing it is not fatal.
    }

    const hasContents = unitTableHasColumn(db, 'Contents');
    const contentsDir = path.join(path.dirname(mprPath), 'mprcontents');
    const v2 = !hasContents || fs.existsSync(contentsDir);
    if (!v2 && stat.size > MAX_V1_DB_BYTES) {
      throw new Error(`${path.basename(mprPath)} is ${Math.round(stat.size / 1024 / 1024)} MB, above ` +
        `the ${MAX_V1_DB_BYTES / 1024 / 1024} MB limit for an inline (v1) .mpr.`);
    }

    return {
      db: db,
      mprPath: mprPath,
      v2: v2,
      contentsDir: contentsDir,
      productVersion: productVersion,
      buildVersion: buildVersion,
      schemaHash: schemaHash
    };
  } catch (e) {
    try { db.close(); } catch (_) {}
    throw e;
  }
}

// Raw BSON bytes for one unit. v1: the Contents column. v2: the .mxunit file
// under mprcontents/<xx>/<yy>/<display-uuid>.mxunit.
async function mprUnitBytes(ctx, unitIdBlob) {
  const idBlob = Buffer.isBuffer(unitIdBlob) ? unitIdBlob : Buffer.from(unitIdBlob);
  if (ctx.v2) {
    const uuid = blobToUuid(idBlob);
    if (!uuid) return null;
    const p = path.join(ctx.contentsDir, uuid.slice(0, 2), uuid.slice(2, 4), uuid + '.mxunit');
    let st;
    try {
      st = await fsp.stat(p);
    } catch (e) {
      return null;
    }
    if (st.size > MAX_UNIT_BYTES) {
      throw new Error(`Unit ${uuid} is ${Math.round(st.size / 1024 / 1024)} MB, above the ` +
        `${MAX_UNIT_BYTES / 1024 / 1024} MB limit — refusing to read it.`);
    }
    return fsp.readFile(p);
  }
  if (!ctx.contentsStmt) ctx.contentsStmt = ctx.db.prepare('SELECT Contents FROM Unit WHERE UnitID = ?');
  const row = ctx.contentsStmt.get(idBlob);
  if (!row || row.Contents == null) return null;
  return Buffer.isBuffer(row.Contents) ? row.Contents : Buffer.from(row.Contents);
}

// Every unit, decoded: [{ id, containerId, containmentName, type, name, doc }].
// A unit that cannot be read or decoded keeps doc = null — callers count those.
// Reads in small batches and hands the event loop back between them, so a
// large project does not freeze log tailing and the other tools meanwhile.
async function mprListUnits(ctx) {
  const rows = ctx.db.prepare(
    'SELECT UnitID, ContainerID, ContainmentName FROM Unit'
  ).all();
  const readRow = async function (r) {
    const idBlob = Buffer.isBuffer(r.UnitID) ? r.UnitID : Buffer.from(r.UnitID);
    let doc = null;
    try {
      const bytes = await mprUnitBytes(ctx, idBlob);
      if (bytes) doc = bsonDecode(bytes);
    } catch (e) {
      doc = null;
    }
    return {
      id: blobToUuid(idBlob),
      containerId: r.ContainerID ? blobToUuid(Buffer.isBuffer(r.ContainerID) ? r.ContainerID : Buffer.from(r.ContainerID)) : null,
      containmentName: r.ContainmentName || null,
      type: doc ? (doc.$Type || null) : null,
      name: doc ? (doc.Name || null) : null,
      doc: doc
    };
  };
  const out = [];
  for (let i = 0; i < rows.length; i += READ_BATCH) {
    const batch = await Promise.all(rows.slice(i, i + READ_BATCH).map(readRow));
    for (const u of batch) out.push(u);
    await yieldToEventLoop();
  }
  return out;
}

function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

// Opens, lists and closes in one go, and remembers the result: the model views
// ask for the same project one after another, and a cold read of a large v2
// project takes tens of seconds. One project is kept; the entry is reused while
// the .mpr file is unchanged and for at most LOAD_CACHE_TTL_MS after the read
// finished (a v2 save can change a unit file without touching the .mpr).
// Concurrent callers share the in-flight read. `memo` is scratch space for the
// analyses built on these units, so they are not recomputed either.
const loadCache = new Map();
async function mprLoad(mprPath) {
  let st;
  try {
    st = await fsp.stat(mprPath);
  } catch (e) {
    throw new Error(`Not a file: ${mprPath}`);
  }
  const key = st.size + ':' + st.mtimeMs;
  const hit = loadCache.get(mprPath);
  if (hit && hit.key === key && (hit.doneAt === null || Date.now() - hit.doneAt < LOAD_CACHE_TTL_MS)) {
    return hit.promise;
  }
  const entry = { key: key, doneAt: null, promise: null };
  entry.promise = (async function () {
    const ctx = await mprOpen(mprPath);
    try {
      const units = await mprListUnits(ctx);
      return {
        mprPath: mprPath,
        projectName: path.basename(mprPath).replace(/\.mpr$/i, ''),
        formatVersion: ctx.v2 ? 2 : 1,
        productVersion: ctx.productVersion,
        buildVersion: ctx.buildVersion,
        schemaHash: ctx.schemaHash,
        units: units,
        undecoded: units.filter(u => !u.doc).length,
        memo: {}
      };
    } finally {
      try { ctx.db.close(); } catch (_) {}
    }
  })();
  loadCache.clear();
  loadCache.set(mprPath, entry);
  entry.promise.then(
    function () { entry.doneAt = Date.now(); },
    function () { if (loadCache.get(mprPath) === entry) loadCache.delete(mprPath); }
  );
  return entry.promise;
}

// The public entry point. Returns { ok:false, reason } when the path is not a
// readable .mpr, otherwise the shaped project.
async function mprReadProject(mprPath) {
  let loaded;
  try {
    loaded = await mprLoad(mprPath);
  } catch (e) {
    return { ok: false, reason: e.message };
  }

  try {
    const units = loaded.units;
    const byId = {};
    for (const u of units) byId[u.id] = u;

    // module id -> name
    const moduleName = {};
    const marketplace = new Set();
    for (const u of units) {
      if (u.type === 'Projects$ModuleImpl' && u.name) {
        moduleName[u.id] = u.name;
        if (u.doc && u.doc.FromAppStore === true) marketplace.add(u.name);
      }
    }

    // Resolve a DomainModel's module by walking ContainerID up through folders.
    const resolveModule = function (unit) {
      let cur = unit;
      for (let hop = 0; hop < 20 && cur; hop++) {
        if (cur.containerId && moduleName[cur.containerId]) return moduleName[cur.containerId];
        cur = cur.containerId ? byId[cur.containerId] : null;
      }
      return null;
    };

    const domainModels = [];
    let entityCount = 0;
    for (const u of units) {
      if (u.type !== 'DomainModels$DomainModel' || !u.doc) continue;
      const mod = resolveModule(u);
      const shaped = mprShapeDomainModel(u.doc, mod);
      entityCount += shaped.entities.length;
      domainModels.push(shaped);
    }

    const secUnit = units.find(u => u.type === 'Security$ProjectSecurity' && u.doc);
    const security = secUnit ? mprShapeSecurity(secUnit.doc) : null;

    const counts = {
      units: units.length,
      undecoded: loaded.undecoded,
      modules: Object.keys(moduleName).length,
      marketplaceModules: marketplace.size,
      entities: entityCount,
      microflows: units.filter(u => u.type === 'Microflows$Microflow').length,
      nanoflows: units.filter(u => u.type === 'Microflows$Nanoflow').length,
      pages: units.filter(u => u.type === 'Forms$Page').length
    };

    return {
      ok: true,
      productVersion: loaded.productVersion,
      buildVersion: loaded.buildVersion,
      schemaHash: loaded.schemaHash,
      formatVersion: loaded.formatVersion,
      projectName: loaded.projectName,
      modules: Object.keys(moduleName)
        .map(id => ({ name: moduleName[id], fromMarketplace: marketplace.has(moduleName[id]) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      domainModels: domainModels,
      security: security,
      counts: counts
    };
  } catch (e) {
    return { ok: false, reason: `MPR read failed: ${e.message}` };
  }
}

module.exports = {
  bsonDecode,
  blobToUuid,
  uuidToBlob,
  mprBool,
  mprField,
  mprArray,
  mprShapeAccessRule,
  mprShapeDomainModel,
  mprShapeSecurity,
  mprOpen,
  mprUnitBytes,
  mprListUnits,
  mprLoad,
  mprReadProject,
  MAX_UNIT_BYTES
};
