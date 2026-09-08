// =========================================================================
// DEPLOYMENT MODEL — the model Mendix already wrote to disk (Wave 26)
// =========================================================================
// `deployment/model/` is produced whenever an app is run or built locally, and
// the Bridge already knows the path to it (`/detect-project` returns
// `projectRoot`). It carries the one thing neither the live database nor the
// runtime log can tell us: **which page and which widget issues a given
// query**.
//
// Why this and not `mx.exe dump-mpr`, which was the original proposal
// (measured 07.09.2026 on this machine, see the wave-26 plan):
//   * `mx` 9.24 has neither `dump-mpr` nor `export-security-overview`, and an
//     11.x binary refuses a 9.x `.mpr` outright — so the two largest real
//     applications here would get nothing at all. `deployment/model/` is
//     written by every Mendix version.
//   * A full `dump-mpr` was 62 MB of JSON in 75 s from a 412 KB `.mpr`.
//     `operations.json` for a far bigger app is 3 MB and reads in milliseconds.
//   * No process to spawn, no binary version to match, no license question.
//
// TWO SHAPES, ONE NORMALIZER. Mendix moved this data between files:
//   * Mendix 10/11 — `operations.json` holds retrieves, each with `PageName`,
//     `WidgetName` and either `XPath` or `EntityPath` under `constants`.
//   * Mendix 9    — `operations.json` holds NO retrieves; they live in
//     `queries.json` with lower-cased field names (`xPath`, `pageName`, …).
// Verified on Helpdesk (10.24, 5147 operations) and myOrder (9.24, 3924
// operations + 2466 queries).
//
// Pure functions live at the top (no fs, no server) so scripts/parser-test.js
// can unit-test them from fixtures, the same arrangement as server/livedb.js.
// =========================================================================

const fsp = require('fs').promises;
const path = require('path');

// A single file that is bigger than this is not something we were meant to
// read into memory — say so rather than letting the process grow unbounded.
const MAX_FILE_BYTES = 64 * 1024 * 1024;

// ── Entity references ───────────────────────────────────────────────────────

// `Module.Entity` is the only shape Mendix emits for a qualified name. Anything
// else (a bare name, an empty string, a path fragment) is not one, and guessing
// would silently produce a table that does not exist.
const QUALIFIED_NAME = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;

function isQualifiedName(s) {
  return typeof s === 'string' && QUALIFIED_NAME.test(s);
}

// `//Module.Entity[constraint]` → `Module.Entity`.
// Measured: 1385/1385 XPaths in Helpdesk and 510/510 in myOrder start with
// `//`, so the leading slashes are required rather than tolerated — a value
// that does not have them is not an XPath we understand, and returning null
// is better than returning half of one.
function mdEntityFromXPath(xpath) {
  if (typeof xpath !== 'string') return null;
  const m = xpath.match(/^\s*\/\/([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)/);
  return m ? m[1] : null;
}

// An `EntityPath` is either a lone entity or alternating association/entity
// segments — measured segment counts are 1, 2, 4 and 6, never an odd number
// above one. Either way the LAST segment is the entity actually retrieved,
// which is the one a slow query would be about.
function mdEntityFromPath(entityPath) {
  if (typeof entityPath !== 'string' || !entityPath) return null;
  const segments = entityPath.split('/');
  const last = segments[segments.length - 1].trim();
  return isQualifiedName(last) ? last : null;
}

// `Module.Entity` → `module$entity`, which is how PostgreSQL names the table.
//
// This is a NAMING convention, not a promise that the table exists. Nothing in
// `deployment/model/` says whether an entity is persistable, and a
// non-persistable one has no table at all — measured on Calculator-MDL, 12 of
// the 162 entities reachable from `operations.json` are non-persistable. So a
// lookup that misses in the database means "unknown", never "missing table".
//
// `mxEntityForTable` in the frontend resolves the opposite direction from a
// live database when one is connected, and that path stays authoritative
// wherever both are available.
function mdTableForEntity(qualifiedName) {
  if (!isQualifiedName(qualifiedName)) return null;
  return qualifiedName.replace('.', '$').toLowerCase();
}

// ── Normalisation ───────────────────────────────────────────────────────────

// One row per client operation, in the shape the consuming tools need and
// nothing more: what kind of operation it is, what it touches, and where in
// the application it lives.
function mdRow(kind, entity, xpath, microflow, page, widget) {
  return {
    kind: kind,
    entity: entity || null,
    xpath: xpath || null,
    microflow: microflow || null,
    page: page || null,
    widget: widget || null
  };
}

// Mendix 10/11: `operations.json`.
function mdRowsFromOperations(operations) {
  if (!Array.isArray(operations)) return [];
  const rows = [];
  for (const op of operations) {
    if (!op || typeof op !== 'object') continue;
    const c = op.constants || {};
    const entity = mdEntityFromXPath(c.XPath) || mdEntityFromPath(c.EntityPath) ||
      (isQualifiedName(c.ObjectType) ? c.ObjectType : null);
    // `callMicroflow` carries only `MicroflowName` — no page. Worth stating
    // plainly: this file cannot answer "which screen calls this microflow",
    // only "this microflow is callable from the client".
    rows.push(mdRow(op.operationType, entity, c.XPath, c.MicroflowName, c.PageName, c.WidgetName));
  }
  return rows;
}

// Mendix 9: `queries.json`, same information under lower-cased names.
function mdRowsFromQueries(queries) {
  if (!Array.isArray(queries)) return [];
  const rows = [];
  for (const q of queries) {
    if (!q || typeof q !== 'object') continue;
    const entity = mdEntityFromXPath(q.xPath) || mdEntityFromPath(q.entityPath);
    // No `operationType` here — every entry in this file is a retrieve, and
    // the microflow field says which of the two kinds it is.
    rows.push(mdRow(q.microflow ? 'retrieveByMicroflow' : 'retrieve',
      entity, q.xPath, q.microflow, q.pageName, q.widgetName));
  }
  return rows;
}

function mdNormalizeOperations(input) {
  const src = input || {};
  return mdRowsFromOperations(src.operations).concat(mdRowsFromQueries(src.queries));
}

// ── Index ───────────────────────────────────────────────────────────────────

function mdPush(map, key, value) {
  if (!key) return;
  if (!map[key]) map[key] = [];
  map[key].push(value);
}

// `byTable` exists so the SQL-facing tools (Log Query Extractor, Index Advisor,
// Query Intelligence) can look up what they actually hold — a table name —
// without a live database connection standing in between. It maps table to
// entity NAME rather than to the rows themselves: this whole index is sent to
// the browser, and holding the same row objects under two keys serialised
// every operation twice (measured on Helpdesk: 1554 KB → 886 KB).
function mdBuildIndex(rows) {
  const byEntity = {};
  const byTable = {};
  const byMicroflow = {};
  const pages = new Set();
  const list = Array.isArray(rows) ? rows : [];

  for (const row of list) {
    if (row.page) pages.add(row.page);
    if (row.entity) {
      mdPush(byEntity, row.entity, row);
      const table = mdTableForEntity(row.entity);
      if (table) byTable[table] = row.entity;
    }
    if (row.microflow) mdPush(byMicroflow, row.microflow, row);
  }

  return {
    byEntity: byEntity,
    byTable: byTable,
    byMicroflow: byMicroflow,
    counts: {
      operations: list.length,
      entities: Object.keys(byEntity).length,
      microflows: Object.keys(byMicroflow).length,
      pages: pages.size
    }
  };
}

// ── Reading from disk ───────────────────────────────────────────────────────

// Every file here is optional: which ones exist depends on the Mendix version,
// and a project that has never been run locally has none of them. A missing or
// unreadable file is `null`, never a throw — the caller decides what a partial
// read means, and "no deployment model" has to stay an ordinary, quiet outcome.
async function mdReadJson(filePath) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (e) {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`${path.basename(filePath)} is ${Math.round(stat.size / 1024 / 1024)} MB, ` +
      `above the ${MAX_FILE_BYTES / 1024 / 1024} MB limit — refusing to read it into memory.`);
  }
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

// Reads `<projectRoot>/deployment/model/` and returns the index plus the few
// environment facts that live in `metadata.json`. Returns `{ ok: false }` with
// a reason when there is nothing to read, because "you have not run this app
// locally yet" is guidance, not an error.
async function mdReadDeploymentModel(projectRoot) {
  const modelDir = path.join(projectRoot, 'deployment', 'model');

  const metadata = await mdReadJson(path.join(modelDir, 'metadata.json'));
  if (!metadata) {
    return {
      ok: false,
      reason: 'No deployment model found. Run or build this app once in Studio Pro — ' +
        'Mendix writes deployment/model/ on every local run.'
    };
  }

  const [operations, queries] = await Promise.all([
    mdReadJson(path.join(modelDir, 'operations.json')),
    mdReadJson(path.join(modelDir, 'queries.json'))
  ]);

  const index = mdBuildIndex(mdNormalizeOperations({ operations: operations, queries: queries }));

  return {
    ok: true,
    runtimeVersion: metadata.RuntimeVersion || null,
    javaVersion: metadata.JavaVersion == null ? null : metadata.JavaVersion,
    projectName: metadata.ProjectName || null,
    // Which of the two shapes this app uses, so the UI can say why a Mendix 9
    // app shows retrieves and a Mendix 11 one shows them from the other file.
    source: {
      operations: Array.isArray(operations) ? operations.length : 0,
      queries: Array.isArray(queries) ? queries.length : 0
    },
    index: index
  };
}

module.exports = {
  isQualifiedName,
  mdEntityFromXPath,
  mdEntityFromPath,
  mdTableForEntity,
  mdNormalizeOperations,
  mdBuildIndex,
  mdReadDeploymentModel,
  MAX_FILE_BYTES
};
