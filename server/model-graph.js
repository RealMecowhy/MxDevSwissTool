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

// =========================================================================
// MODULE DEPENDENCY GRAPH — cycles, layers, orphans, blockers (Plan 008)
// =========================================================================
// The same reference walk that finds dead code (mgExtractRefs) also answers
// "can these modules be separated?". Collapse every element-level edge
// `ModuleA.X -> ModuleB.Y` to its module and you have a DIRECTED module
// dependency graph — one that reflects real behaviour (a microflow call, a
// retrieve, a page open, a generalization), not just domain-model associations.
// An edge `X -> Y` means X references something in Y, i.e. X depends on Y.
//
// This is intentionally NOT the association graph the Domain Model &
// Architecture "Modules" diagram draws — that one is undirected and needs a
// live database. This one is offline, directed, and carries the edge kinds.
//
// Pure functions only. The one-shot mgAnalyzeModules takes raw mprListUnits
// output; the Bridge route /model/modules is the only caller.
// =========================================================================

// "Sales.Order" -> "Sales"; a string with no dot is returned unchanged.
function mgModuleOf(qn) {
  const s = String(qn == null ? '' : qn);
  const i = s.indexOf('.');
  return i === -1 ? s : s.slice(0, i);
}

// elements: [{ qualifiedName }] — the full node set, so a module with no edge
// still appears. refs: [{ from, to, kind }], already filtered to endpoints
// whose module is known (mgAnalyzeModules does this).
// Returns { nodes: [moduleName] (sorted),
//           edges: [{ from, to, kinds:[...] (sorted), count }] (cross-module,
//                    directed, de-duplicated, most-referenced first) }.
function mgModuleGraph(elements, refs) {
  const nodes = new Set();
  for (const el of (Array.isArray(elements) ? elements : [])) {
    if (el && typeof el.qualifiedName === 'string') nodes.add(mgModuleOf(el.qualifiedName));
  }
  const edgeMap = {};
  for (const r of (Array.isArray(refs) ? refs : [])) {
    if (!r || typeof r.from !== 'string' || typeof r.to !== 'string') continue;
    const fm = mgModuleOf(r.from);
    const tm = mgModuleOf(r.to);
    nodes.add(fm);
    nodes.add(tm);
    if (fm === tm) continue;
    const key = fm + '~' + tm;
    if (!edgeMap[key]) edgeMap[key] = { from: fm, to: tm, kinds: new Set(), count: 0 };
    edgeMap[key].kinds.add(r.kind || 'ref');
    edgeMap[key].count++;
  }
  const edges = Object.keys(edgeMap).map(function (k) {
    const e = edgeMap[k];
    return { from: e.from, to: e.to, kinds: Array.from(e.kinds).sort(), count: e.count };
  }).sort(function (a, b) {
    return b.count - a.count || (a.from + '>' + a.to).localeCompare(b.from + '>' + b.to);
  });
  return { nodes: Array.from(nodes).sort(), edges: edges };
}

// Iterative Tarjan's SCC (a large app can have 100+ modules and a deep chain
// would overflow a recursive version). nodes: string[]; edges: [{from,to}].
// Returns [[moduleName, ...], ...] — one array per cycle: every SCC of size >= 2,
// plus any single module with a self-edge. Members are in discovery order.
function mgTarjanSCC(nodes, edges) {
  const adj = {};
  const selfLoop = {};
  const add = function (n) { if (!adj[n]) adj[n] = []; };
  for (const n of (Array.isArray(nodes) ? nodes : [])) add(n);
  for (const e of (Array.isArray(edges) ? edges : [])) {
    if (!e || e.from == null || e.to == null) continue;
    add(e.from);
    add(e.to);
    if (e.from === e.to) { selfLoop[e.from] = true; continue; }
    adj[e.from].push(e.to);
  }

  const index = {};
  const low = {};
  const onStack = {};
  const stack = [];
  let counter = 0;
  const out = [];

  for (const start of Object.keys(adj)) {
    if (index[start] !== undefined) continue;
    const work = [{ v: start, i: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      const v = frame.v;
      if (frame.i === 0) {
        index[v] = counter;
        low[v] = counter;
        counter++;
        stack.push(v);
        onStack[v] = true;
      }
      let descended = false;
      while (frame.i < adj[v].length) {
        const w = adj[v][frame.i];
        frame.i++;
        if (index[w] === undefined) {
          work.push({ v: w, i: 0 });
          descended = true;
          break;
        } else if (onStack[w] && index[w] < low[v]) {
          low[v] = index[w];
        }
      }
      if (descended) continue;
      if (low[v] === index[v]) {
        const comp = [];
        let w;
        do {
          w = stack.pop();
          onStack[w] = false;
          comp.push(w);
        } while (w !== v);
        if (comp.length > 1 || selfLoop[v]) out.push(comp);
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].v;
        if (low[v] < low[parent]) low[parent] = low[v];
      }
    }
  }
  return out;
}

// Longest-path layer per module on the SCC-condensed DAG.
// layer 0 = the module references nothing outside itself (foundational);
// layer N = the longest chain of outward references from it (leaf).
// Modules in one cycle share a layer. Returns { moduleName: layer }.
function mgTopoLayers(nodes, edges) {
  const nodeSet = new Set(Array.isArray(nodes) ? nodes : []);
  for (const e of (Array.isArray(edges) ? edges : [])) {
    if (!e || e.from == null || e.to == null) continue;
    nodeSet.add(e.from);
    nodeSet.add(e.to);
  }

  const compOf = {};
  let cid = 0;
  for (const comp of mgTarjanSCC(Array.from(nodeSet), edges)) {
    const id = 'c' + cid++;
    for (const m of comp) compOf[m] = id;
  }
  for (const m of nodeSet) {
    if (compOf[m] === undefined) compOf[m] = 'c' + cid++;
  }

  const cadj = {};
  for (const id of Object.values(compOf)) { if (!cadj[id]) cadj[id] = new Set(); }
  for (const e of (Array.isArray(edges) ? edges : [])) {
    if (!e || e.from == null || e.to == null) continue;
    const a = compOf[e.from];
    const b = compOf[e.to];
    if (a !== b) cadj[a].add(b);
  }

  const memo = {};
  const layerOf = function (id) {
    if (memo[id] !== undefined) return memo[id];
    memo[id] = 0; // guard against a stray cycle in the condensation
    let best = 0;
    for (const nxt of cadj[id]) best = Math.max(best, 1 + layerOf(nxt));
    memo[id] = best;
    return best;
  };

  const out = {};
  for (const m in compOf) {
    if (Object.prototype.hasOwnProperty.call(compOf, m)) out[m] = layerOf(compOf[m]);
  }
  return out;
}

// Per module that emits at least one reference: { module, intra, inter,
// cohesionPct }. cohesionPct = round(100 * intra / (intra + inter)) — low means
// the module's behaviour is entangled with other modules. Least cohesive first.
function mgCohesion(refs) {
  const stat = {};
  for (const r of (Array.isArray(refs) ? refs : [])) {
    if (!r || typeof r.from !== 'string' || typeof r.to !== 'string') continue;
    const fm = mgModuleOf(r.from);
    const tm = mgModuleOf(r.to);
    if (!stat[fm]) stat[fm] = { module: fm, intra: 0, inter: 0 };
    if (fm === tm) stat[fm].intra++;
    else stat[fm].inter++;
  }
  return Object.keys(stat).map(function (m) {
    const s = stat[m];
    const total = s.intra + s.inter;
    return {
      module: s.module,
      intra: s.intra,
      inter: s.inter,
      cohesionPct: total ? Math.round(100 * s.intra / total) : null
    };
  }).sort(function (a, b) {
    const pa = a.cohesionPct == null ? 101 : a.cohesionPct;
    const pb = b.cohesionPct == null ? 101 : b.cohesionPct;
    return pa - pb || a.module.localeCompare(b.module);
  });
}

// Modules with no cross-module reference edge in either direction. They may
// still be wired by a domain-model association or a widget this walk does not
// cover — the help text says so.
function mgOrphanModules(nodes, edges) {
  const connected = new Set();
  for (const e of (Array.isArray(edges) ? edges : [])) {
    if (!e || e.from == null || e.to == null) continue;
    connected.add(e.from);
    connected.add(e.to);
  }
  return (Array.isArray(nodes) ? nodes : []).filter(function (n) {
    return !connected.has(n);
  }).sort();
}

// generalize edges that cross a module boundary — inheritance across modules,
// the hard blocker for separating them (breaking it needs a data migration).
// refs: [{ from, to, kind }]. Returns [{ from, to, fromModule, toModule }].
function mgBlockers(refs) {
  const out = [];
  for (const r of (Array.isArray(refs) ? refs : [])) {
    if (!r || r.kind !== 'generalize') continue;
    const fm = mgModuleOf(r.from);
    const tm = mgModuleOf(r.to);
    if (fm !== tm) out.push({ from: r.from, to: r.to, fromModule: fm, toModule: tm });
  }
  return out;
}

// One-shot: rawUnits straight from mprReader.mprListUnits -> the module report.
function mgAnalyzeModules(rawUnits) {
  const units = mgResolveModuleNames(rawUnits);
  const elements = mgCollectElements(units);

  const known = new Set();
  for (const el of elements) known.add(mgModuleOf(el.qualifiedName));

  // Keep only edges whose BOTH endpoints resolve to a real module — mgExtractRefs
  // can emit a `from` of a project-level unit ($Type string) for navigation /
  // scheduled events / settings, which are not modules.
  const refs = mgExtractRefs(units).refs.filter(function (r) {
    return r && known.has(mgModuleOf(r.from)) && known.has(mgModuleOf(r.to));
  });

  const graph = mgModuleGraph(elements, refs);
  const cycles = mgTarjanSCC(graph.nodes, graph.edges);
  const layers = mgTopoLayers(graph.nodes, graph.edges);
  const cohesion = mgCohesion(refs);
  const orphans = mgOrphanModules(graph.nodes, graph.edges);
  const blockers = mgBlockers(refs);

  return {
    modules: graph.nodes,
    edges: graph.edges,
    cycles: cycles,
    layers: layers,
    orphans: orphans,
    blockers: blockers,
    cohesion: cohesion,
    counts: {
      modules: graph.nodes.length,
      edges: graph.edges.length,
      cycles: cycles.length,
      orphans: orphans.length,
      blockers: blockers.length
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
  mgAnalyzeUnits,
  mgModuleOf,
  mgModuleGraph,
  mgTarjanSCC,
  mgTopoLayers,
  mgCohesion,
  mgOrphanModules,
  mgBlockers,
  mgAnalyzeModules
};
