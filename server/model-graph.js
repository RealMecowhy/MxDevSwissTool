// =========================================================================
// MODEL GRAPH — a cheap "what references what" pass over unit BSON (Plan 007)
// =========================================================================
// Studio Pro has no "find unused". This builds a loose reference graph from
// the decoded model units the plan-006 reader hands back and reports the
// referenceable elements with no live inbound edge — dead microflows, pages,
// snippets, entities.
//
// The reference heuristic is DELIBERATELY loose: any qualified-name string
// (`Module.Element`) that appears anywhere in a unit's BSON and resolves to a
// real element is treated as a reference. It over-collects (a string literal
// that happens to look like a name) but never misses a real edge — the right
// trade for a "dead code" finding: a false "alive" is safe, a false "dead" is
// not.
//
// Pure functions only — no fs, no sqlite. scripts/parser-test.js unit-tests
// them from hand-built decoded-BSON objects. The caller (the Bridge) opens the
// .mpr with server/mpr-reader.js and passes the units in.
// =========================================================================
'use strict';
const { mprArray } = require('./mpr-reader');

// A qualified name: Module.Element, optionally Module.Element.Member.
const QN = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

// Unit $Type -> the objectType we classify it as.
const MG_TYPE_MAP = {
  'Microflows$Microflow': 'MICROFLOW',
  'Microflows$Nanoflow': 'NANOFLOW',
  'Forms$Page': 'PAGE',
  'Forms$Snippet': 'SNIPPET',
  'Enumerations$Enumeration': 'ENUMERATION',
  'Constants$Constant': 'CONSTANT'
};

// Unit $Types that are not themselves elements but do reference elements, with
// the edge kind to assume while walking them (activity-level $Types below can
// still refine it).
const MG_SOURCE_KINDS = {
  'Navigation$NavigationDocument': 'menu_item',
  'Menus$MenuDocument': 'menu_item',
  'ScheduledEvents$ScheduledEvent': 'schedule',
  'Settings$ProjectSettings': 'settings'
};

const ENTRY_PREFIXES = ['ACT_', 'SCH_', 'WS_', 'REST_', 'OData_'];
const MF_LIVE_KINDS = ['call', 'schedule', 'datasource', 'action', 'calculate', 'settings'];
const PAGE_LIVE_KINDS = ['show_page', 'home_page', 'login_page', 'menu_item', 'action'];
// The classified-as-potentially-dead set. Enumerations / constants are reported
// separately because their inbound edges are not fully captured.
const MG_CLASSIFY = ['MICROFLOW', 'NANOFLOW', 'PAGE', 'SNIPPET', 'ENTITY'];

// ── module-name resolution ──────────────────────────────────────────────────
// mprListUnits gives { id, containerId, containmentName, type, name, doc } — the
// module a unit lives in is found by walking ContainerID up through
// Projects$Folder units to the Projects$ModuleImpl, exactly as mprReadProject
// does. Returns a new list of { id, type, name, moduleName, doc }.
function mgResolveModuleNames(rawUnits) {
  const list = Array.isArray(rawUnits) ? rawUnits : [];
  const byId = {};
  for (const u of list) byId[u.id] = u;
  const moduleName = {};
  for (const u of list) {
    if (u.type === 'Projects$ModuleImpl' && u.name) moduleName[u.id] = u.name;
  }
  return list.map(function (u) {
    let cur = u;
    let mod = null;
    for (let hop = 0; hop < 20 && cur; hop++) {
      if (cur.containerId && moduleName[cur.containerId]) { mod = moduleName[cur.containerId]; break; }
      cur = cur.containerId ? byId[cur.containerId] : null;
    }
    return { id: u.id, type: u.type, name: u.name, moduleName: mod, doc: u.doc };
  });
}

// ── element inventory ───────────────────────────────────────────────────────
// units: [{ id, type, name, moduleName, doc }]. Entities live inside a
// DomainModels$DomainModel unit's doc, not as their own unit, so they are
// pulled from there.
function mgCollectElements(units) {
  const list = Array.isArray(units) ? units : [];
  const out = [];
  for (const u of list) {
    const ot = MG_TYPE_MAP[u.type];
    if (ot && u.name && u.moduleName) {
      out.push({ qualifiedName: u.moduleName + '.' + u.name, objectType: ot });
    }
    if (u.type === 'DomainModels$DomainModel' && u.doc && u.moduleName) {
      for (const e of mprArray(u.doc.Entities)) {
        if (e && typeof e.Name === 'string' && e.Name) {
          out.push({ qualifiedName: u.moduleName + '.' + e.Name, objectType: 'ENTITY' });
        }
      }
    }
  }
  return out;
}

// ── reference extraction ────────────────────────────────────────────────────

// Every QN-shaped string anywhere in `value`, pushed onto `out`.
function mgStringsIn(value, out) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) mgStringsIn(value[i], out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const k in value) {
      if (Object.prototype.hasOwnProperty.call(value, k)) mgStringsIn(value[k], out);
    }
    return;
  }
  if (typeof value === 'string' && QN.test(value)) out.push(value);
}

// The edge kind implied by an activity/element $Type, or null when it says
// nothing.
function mgKindForType(t) {
  if (typeof t !== 'string' || !t) return null;
  if (t.endsWith('MicroflowCallAction') || t.endsWith('NanoflowCallAction')) return 'call';
  if (t === 'Forms$CallMicroflowClientAction' || t === 'Forms$CallNanoflowClientAction') return 'call';
  if (t.endsWith('RetrieveAction')) return 'retrieve';
  if (t.endsWith('CreateObjectAction')) return 'create';
  if (t.endsWith('ChangeObjectAction')) return 'change';
  if (t.endsWith('DeleteAction')) return 'delete';
  if (t.endsWith('ShowPageAction') || t.endsWith('ShowFormAction')) return 'show_page';
  if (t === 'DomainModels$Generalization') return 'generalize';
  if (t === 'Navigation$HomePage') return 'home_page';
  if (t.endsWith('MicroflowSource') || t.endsWith('XPathSource') || t.endsWith('EntitySource')) return 'datasource';
  if (t === 'Forms$FormAction' || t === 'Forms$MicroflowAction' || t === 'Forms$NanoflowAction') return 'action';
  if (t.endsWith('MicroflowValue')) return 'calculate';
  return null;
}

// Walk a decoded doc, emitting { from, to, kind } for every QN string that is a
// known element. `kind` is the nearest enclosing $Type that implies one, else
// the source default, else 'ref'.
function mgWalkRefs(node, kind, from, elements, refs, seen) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) mgWalkRefs(node[i], kind, from, elements, refs, seen);
    return;
  }
  if (node && typeof node === 'object') {
    let here = kind;
    const inferred = mgKindForType(node.$Type);
    if (inferred) here = inferred;
    for (const k in node) {
      if (Object.prototype.hasOwnProperty.call(node, k)) {
        mgWalkRefs(node[k], here, from, elements, refs, seen);
      }
    }
    return;
  }
  if (typeof node === 'string' && QN.test(node) && elements.has(node)) {
    const finalKind = kind || 'ref';
    const sig = from + ' -> ' + node + ' :: ' + finalKind;
    if (!seen.has(sig)) {
      seen.add(sig);
      refs.push({ from: from, to: node, kind: finalKind });
    }
  }
}

// units: [{ id, type, name, moduleName, doc }].
// Returns { elements: Set<qualifiedName>, refs: [{ from, to, kind }] }.
function mgExtractRefs(units) {
  const list = Array.isArray(units) ? units : [];
  const typed = mgCollectElements(list);
  const elements = new Set();
  for (const e of typed) elements.add(e.qualifiedName);

  const refs = [];
  const seen = new Set();

  for (const u of list) {
    if (!u.doc) continue;

    if (u.type === 'DomainModels$DomainModel') {
      const mod = u.moduleName ? u.moduleName + '.' : '';
      for (const ent of mprArray(u.doc.Entities)) {
        if (!ent || typeof ent.Name !== 'string' || !ent.Name) continue;
        mgWalkRefs(ent, null, mod + ent.Name, elements, refs, seen);
      }
      continue;
    }

    const ot = MG_TYPE_MAP[u.type];
    if (ot) {
      if (!u.name || !u.moduleName) continue;
      mgWalkRefs(u.doc, null, u.moduleName + '.' + u.name, elements, refs, seen);
      continue;
    }

    const sourceKind = MG_SOURCE_KINDS[u.type];
    if (sourceKind) {
      const from = (u.moduleName && u.name) ? (u.moduleName + '.' + u.name) : u.type;
      mgWalkRefs(u.doc, sourceKind, from, elements, refs, seen);
    }
  }

  return { elements: elements, refs: refs };
}

// ── dead-asset classification ───────────────────────────────────────────────
// elements: [{ qualifiedName, objectType }] (from mgCollectElements or the
// caller). refs: from mgExtractRefs.
// Returns { dead: [{ qualifiedName, objectType, reason }],
//           uncertain: [{ qualifiedName, objectType, reason }] }.
function mgFindDeadAssets(elements, refs) {
  const list = Array.isArray(elements) ? elements : [];
  const edges = Array.isArray(refs) ? refs : [];

  const inbound = {};
  for (const r of edges) {
    if (!r || typeof r.to !== 'string') continue;
    if (!inbound[r.to]) inbound[r.to] = new Set();
    inbound[r.to].add(r.kind);
  }

  const dead = [];
  const uncertain = [];

  for (const el of list) {
    if (!el || typeof el.qualifiedName !== 'string') continue;
    const kinds = inbound[el.qualifiedName];
    const kindList = kinds ? Array.from(kinds) : [];
    const shortName = el.qualifiedName.split('.').pop();

    if (el.objectType === 'ENUMERATION' || el.objectType === 'CONSTANT') {
      if (!kinds || kinds.size === 0) {
        uncertain.push({
          qualifiedName: el.qualifiedName,
          objectType: el.objectType,
          reason: 'inbound edges for this type are not fully captured — verify before deleting'
        });
      }
      continue;
    }

    if (MG_CLASSIFY.indexOf(el.objectType) === -1) continue;

    if (el.objectType === 'MICROFLOW' || el.objectType === 'NANOFLOW') {
      const live = kindList.some(function (k) {
        return k === 'ref' || MF_LIVE_KINDS.indexOf(k) !== -1;
      });
      if (live) continue;
      const isEntry = ENTRY_PREFIXES.some(function (p) { return shortName.indexOf(p) === 0; });
      dead.push({
        qualifiedName: el.qualifiedName,
        objectType: el.objectType,
        reason: isEntry ? 'prefix suggests entry point' : 'no inbound reference'
      });
    } else if (el.objectType === 'PAGE' || el.objectType === 'SNIPPET') {
      const live = kindList.some(function (k) {
        return k === 'ref' || PAGE_LIVE_KINDS.indexOf(k) !== -1;
      });
      if (live) continue;
      dead.push({
        qualifiedName: el.qualifiedName,
        objectType: el.objectType,
        reason: 'no inbound reference'
      });
    } else if (el.objectType === 'ENTITY') {
      if (kinds && kinds.size > 0) continue;
      dead.push({
        qualifiedName: el.qualifiedName,
        objectType: el.objectType,
        reason: 'no inbound reference'
      });
    }
  }

  return { dead: dead, uncertain: uncertain };
}

// ── one-shot: units in -> report out ────────────────────────────────────────
// rawUnits: straight from mprReader.mprListUnits (no moduleName yet).
function mgAnalyzeUnits(rawUnits) {
  const units = mgResolveModuleNames(rawUnits);
  const elements = mgCollectElements(units);
  const { refs } = mgExtractRefs(units);
  const { dead, uncertain } = mgFindDeadAssets(elements, refs);

  const byType = {};
  for (const e of elements) byType[e.objectType] = (byType[e.objectType] || 0) + 1;

  return {
    dead: dead,
    uncertain: uncertain,
    counts: {
      elements: elements.length,
      elementsByType: byType,
      refs: refs.length,
      dead: dead.length,
      uncertain: uncertain.length
    }
  };
}

module.exports = {
  QN,
  ENTRY_PREFIXES,
  MF_LIVE_KINDS,
  PAGE_LIVE_KINDS,
  mgResolveModuleNames,
  mgCollectElements,
  mgStringsIn,
  mgKindForType,
  mgExtractRefs,
  mgFindDeadAssets,
  mgAnalyzeUnits
};
