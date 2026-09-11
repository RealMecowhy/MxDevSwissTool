// =========================================================================
// MODEL GRAPH — a cheap "what references what" pass over unit BSON (Plan 007)
// =========================================================================
// Studio Pro has no "find unused". This builds a loose reference graph from
// the decoded model units the plan-006 reader hands back and reports the
// referenceable elements with no inbound edge — dead microflows, pages,
// snippets, entities.
//
// The reference heuristic is DELIBERATELY loose, and it runs over EVERY unit
// in the model (published services, mappings, layouts, Java action
// definitions, navigation — not a hand-picked list): any string that is, or
// contains, a qualified name (`Module.Element`) of a real element counts as a
// reference to it — so a microflow named in an expression (`'Jobs.RunLater'`),
// a constant (`@Mod.Url`) or an XPath path is seen too. It over-collects (a
// caption that happens to read like a name) but misses only what lives outside
// the model: Java / JavaScript source and names built at runtime. A false
// "alive" is safe; a false "dead" is not.
//
// Pure functions only — no fs, no sqlite. scripts/parser-test.js unit-tests
// them from hand-built decoded-BSON objects. The caller (the Bridge) opens the
// .mpr with server/mpr-reader.js and passes the units in.
// =========================================================================
'use strict';
const { mprArray } = require('./mpr-reader');

// A qualified name: Module.Element, optionally Module.Element.Member.
const QN = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
// A Module.Element token anywhere inside a longer string (an expression, an
// XPath, a string literal).
const QN_TOKEN = /[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*/g;

// Unit $Type -> the objectType we classify it as. Any other named unit inside a
// module (a layout, a Java action, a mapping, a published service …) is still
// an element — something can reference it — with objectType 'OTHER'.
const MG_TYPE_MAP = {
  'Microflows$Microflow': 'MICROFLOW',
  'Microflows$Nanoflow': 'NANOFLOW',
  'Forms$Page': 'PAGE',
  'Forms$Snippet': 'SNIPPET',
  'Enumerations$Enumeration': 'ENUMERATION',
  'Constants$Constant': 'CONSTANT',
  'JavaActions$JavaAction': 'JAVA_ACTION',
  'JavaScriptActions$JavaScriptAction': 'JS_ACTION'
};

// Project-level units whose references carry a known edge kind (activity-level
// $Types below can still refine it). Only the label differs — every unit is
// walked.
const MG_SOURCE_KINDS = {
  'Navigation$NavigationDocument': 'menu_item',
  'Menus$MenuDocument': 'menu_item',
  'ScheduledEvents$ScheduledEvent': 'schedule',
  'Settings$ProjectSettings': 'settings'
};

const ENTRY_PREFIXES = ['ACT_', 'SCH_', 'WS_', 'REST_', 'OData_'];
// The classified-as-potentially-dead set. Enumerations / constants / Java and
// JavaScript actions are reported separately because references to them from
// Java or JavaScript code are invisible.
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

// Modules installed from the Marketplace (Projects$ModuleImpl.FromAppStore).
// Their dead code and coupling are not the app team's to fix, so the views
// hide them by default. Sorted names.
function mgMarketplaceModules(rawUnits) {
  const out = [];
  for (const u of (Array.isArray(rawUnits) ? rawUnits : [])) {
    if (u && u.type === 'Projects$ModuleImpl' && u.name && u.doc && u.doc.FromAppStore === true) out.push(u.name);
  }
  return out.sort();
}

// ── element inventory ───────────────────────────────────────────────────────
// units: [{ id, type, name, moduleName, doc }]. Entities and associations live
// inside a DomainModels$DomainModel unit's doc, not as their own unit, so they
// are pulled from there. Projects$* units (folders, module settings) are
// containers, not elements.
function mgCollectElements(units) {
  const list = Array.isArray(units) ? units : [];
  const out = [];
  for (const u of list) {
    if (!u || !u.moduleName) continue;
    if (u.type === 'DomainModels$DomainModel') {
      if (!u.doc) continue;
      for (const e of mprArray(u.doc.Entities)) {
        if (e && typeof e.Name === 'string' && e.Name) {
          out.push({ qualifiedName: u.moduleName + '.' + e.Name, objectType: 'ENTITY' });
        }
      }
      for (const a of mprArray(u.doc.Associations).concat(mprArray(u.doc.CrossAssociations))) {
        if (a && typeof a.Name === 'string' && a.Name) {
          out.push({ qualifiedName: u.moduleName + '.' + a.Name, objectType: 'ASSOCIATION' });
        }
      }
      continue;
    }
    if (!u.name || typeof u.type !== 'string' || u.type.indexOf('Projects$') === 0) continue;
    out.push({ qualifiedName: u.moduleName + '.' + u.name, objectType: MG_TYPE_MAP[u.type] || 'OTHER' });
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
  if (t === 'DomainModels$Association' || t === 'DomainModels$CrossAssociation') return 'associate';
  if (t === 'Navigation$HomePage') return 'home_page';
  if (t.endsWith('MicroflowSource') || t.endsWith('XPathSource') || t.endsWith('EntitySource')) return 'datasource';
  if (t === 'Forms$FormAction' || t === 'Forms$MicroflowAction' || t === 'Forms$NanoflowAction') return 'action';
  if (t.endsWith('MicroflowValue')) return 'calculate';
  return null;
}

// Pushes { from, to, kind } once per distinct triple; never a self-edge (a
// recursive microflow or a page naming itself does not keep itself alive).
function mgAddRef(from, to, kind, refs, seen) {
  if (from === to) return;
  const sig = from + ' -> ' + to + ' :: ' + kind;
  if (seen.has(sig)) return;
  seen.add(sig);
  refs.push({ from: from, to: to, kind: kind });
}

// Walk a decoded doc, emitting an edge for every string that is — or contains —
// a known element's qualified name. `kind` is the nearest enclosing $Type that
// implies one, else the source default, else 'ref'.
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
      if (k === '$ID' || k === '$Type') continue;
      if (Object.prototype.hasOwnProperty.call(node, k)) {
        mgWalkRefs(node[k], here, from, elements, refs, seen);
      }
    }
    return;
  }
  if (typeof node !== 'string' || node.length < 3) return;
  if (elements.has(node)) {
    mgAddRef(from, node, kind || 'ref', refs, seen);
    return;
  }
  if (node.indexOf('.') === -1) return;
  QN_TOKEN.lastIndex = 0;
  let m;
  while ((m = QN_TOKEN.exec(node)) !== null) {
    if (elements.has(m[0])) mgAddRef(from, m[0], kind || 'ref', refs, seen);
  }
}

// units: [{ id, type, name, moduleName, doc }].
// Returns { elements: Set<qualifiedName>, refs: [{ from, to, kind }] }.
// `from` is the referencing element (Module.Name), or the unit $Type for a
// project-level unit (navigation, settings, security) that belongs to no module.
function mgExtractRefs(units) {
  const list = Array.isArray(units) ? units : [];
  const typed = mgCollectElements(list);
  const elements = new Set();
  for (const e of typed) elements.add(e.qualifiedName);

  const refs = [];
  const seen = new Set();

  for (const u of list) {
    if (!u || !u.doc) continue;

    if (u.type === 'DomainModels$DomainModel') {
      const mod = u.moduleName ? u.moduleName + '.' : '';
      const entityById = {};
      for (const ent of mprArray(u.doc.Entities)) {
        if (!ent || typeof ent.Name !== 'string' || !ent.Name) continue;
        if (typeof ent.$ID === 'string') entityById[ent.$ID] = mod + ent.Name;
        mgWalkRefs(ent, null, mod + ent.Name, elements, refs, seen);
      }
      // An association points at its entities by $ID (same module) or by
      // qualified name (a cross-module child). Either way both ends are in use.
      for (const a of mprArray(u.doc.Associations).concat(mprArray(u.doc.CrossAssociations))) {
        if (!a || typeof a.Name !== 'string' || !a.Name) continue;
        const from = mod + a.Name;
        for (const end of [a.Parent, a.Child]) {
          if (typeof end === 'string' && entityById[end]) mgAddRef(from, entityById[end], 'associate', refs, seen);
        }
        mgWalkRefs(a, 'associate', from, elements, refs, seen);
      }
      continue;
    }

    const from = (u.moduleName && u.name) ? (u.moduleName + '.' + u.name) : u.type;
    mgWalkRefs(u.doc, MG_SOURCE_KINDS[u.type] || null, from, elements, refs, seen);
  }

  return { elements: elements, refs: refs };
}

// ── dead-asset classification ───────────────────────────────────────────────
// elements: [{ qualifiedName, objectType }] (from mgCollectElements or the
// caller). refs: from mgExtractRefs. Any inbound edge from something else keeps
// an element alive — what kind of edge it is does not matter.
// Returns { dead: [{ qualifiedName, objectType, reason }],
//           uncertain: [{ qualifiedName, objectType, reason }] }.
function mgFindDeadAssets(elements, refs) {
  const list = Array.isArray(elements) ? elements : [];
  const edges = Array.isArray(refs) ? refs : [];

  const inbound = new Set();
  for (const r of edges) {
    if (!r || typeof r.to !== 'string' || r.from === r.to) continue;
    inbound.add(r.to);
  }

  const dead = [];
  const uncertain = [];

  for (const el of list) {
    if (!el || typeof el.qualifiedName !== 'string') continue;
    if (inbound.has(el.qualifiedName)) continue;

    if (el.objectType === 'ENUMERATION' || el.objectType === 'CONSTANT') {
      uncertain.push({
        qualifiedName: el.qualifiedName,
        objectType: el.objectType,
        reason: 'Java code can reference this type without the model showing it — verify before deleting'
      });
      continue;
    }
    if (el.objectType === 'JAVA_ACTION' || el.objectType === 'JS_ACTION') {
      uncertain.push({
        qualifiedName: el.qualifiedName,
        objectType: el.objectType,
        reason: 'Java or JavaScript code can call this action without the model showing it — verify before deleting'
      });
      continue;
    }
    if (MG_CLASSIFY.indexOf(el.objectType) === -1) continue;

    const shortName = el.qualifiedName.split('.').pop();
    const isFlow = el.objectType === 'MICROFLOW' || el.objectType === 'NANOFLOW';
    const isEntry = isFlow && ENTRY_PREFIXES.some(function (p) { return shortName.indexOf(p) === 0; });
    dead.push({
      qualifiedName: el.qualifiedName,
      objectType: el.objectType,
      reason: isEntry ? 'prefix suggests entry point' : 'no inbound reference'
    });
  }

  return { dead: dead, uncertain: uncertain };
}

// ── one-shot helpers ────────────────────────────────────────────────────────
// The expensive part — resolving modules and walking every unit — shared by the
// dead-code and module reports so one read of a project serves both.
// rawUnits: straight from mprReader.mprListUnits (no moduleName yet).
function mgPrepare(rawUnits) {
  const units = mgResolveModuleNames(rawUnits);
  const elements = mgCollectElements(units);
  const refs = mgExtractRefs(units).refs;
  return { units: units, elements: elements, refs: refs, marketplace: mgMarketplaceModules(rawUnits) };
}

function mgAnalyzeUnits(rawUnits, prepared) {
  const prep = prepared || mgPrepare(rawUnits);
  const { dead, uncertain } = mgFindDeadAssets(prep.elements, prep.refs);
  const withModule = function (d) {
    return Object.assign({ module: mgModuleOf(d.qualifiedName) }, d);
  };

  // What the view can list: the classified kinds plus enumerations / constants,
  // with the Marketplace share apart so "X of Y" follows the view's filter.
  const market = new Set(prep.marketplace);
  const byType = {};
  const byTypeMarketplace = {};
  let listable = 0;
  for (const e of prep.elements) {
    if (e.objectType === 'OTHER' || e.objectType === 'ASSOCIATION') continue;
    byType[e.objectType] = (byType[e.objectType] || 0) + 1;
    if (market.has(mgModuleOf(e.qualifiedName))) {
      byTypeMarketplace[e.objectType] = (byTypeMarketplace[e.objectType] || 0) + 1;
    }
    listable++;
  }

  return {
    dead: dead.map(withModule),
    uncertain: uncertain.map(withModule),
    marketplace: prep.marketplace,
    counts: {
      elements: listable,
      elementsByType: byType,
      elementsByTypeMarketplace: byTypeMarketplace,
      refs: prep.refs.length,
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

// Element-level examples kept per module edge, so a cycle can be traced back
// to the microflow or page that closes it.
const EDGE_SAMPLES = 3;

// elements: [{ qualifiedName }] — the full node set, so a module with no edge
// still appears. refs: [{ from, to, kind }], already filtered to endpoints
// whose module is known (mgAnalyzeModules does this).
// Returns { nodes: [moduleName] (sorted),
//           edges: [{ from, to, kinds:[...] (sorted), count, samples:[{from,to}] }]
//                  (cross-module, directed, de-duplicated, most-referenced first) }.
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
    if (!edgeMap[key]) edgeMap[key] = { from: fm, to: tm, kinds: new Set(), count: 0, samples: [] };
    const e = edgeMap[key];
    e.kinds.add(r.kind || 'ref');
    e.count++;
    if (e.samples.length < EDGE_SAMPLES) e.samples.push({ from: r.from, to: r.to });
  }
  const edges = Object.keys(edgeMap).map(function (k) {
    const e = edgeMap[k];
    return { from: e.from, to: e.to, kinds: Array.from(e.kinds).sort(), count: e.count, samples: e.samples };
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
// still be wired by a pluggable widget or by Java code this walk does not see —
// the help text says so.
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
function mgAnalyzeModules(rawUnits, prepared) {
  const prep = prepared || mgPrepare(rawUnits);
  const elements = prep.elements;

  const known = new Set();
  for (const el of elements) known.add(mgModuleOf(el.qualifiedName));

  // Keep only edges whose BOTH endpoints resolve to a real module — mgExtractRefs
  // emits a `from` of a project-level unit ($Type string) for navigation /
  // scheduled events / settings, which are not modules.
  const refs = prep.refs.filter(function (r) {
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
    marketplace: prep.marketplace,
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

// =========================================================================
// PRECISE REFERENCE GRAPH + NAVIGATION — callers / callees / impact (Plan 011)
// =========================================================================
// The dead-code walk above counts a name found anywhere, a caption included —
// safe for "is it used?", wrong for "what breaks if I change it?", where a false
// edge sends someone to test the wrong thing. This graph only takes a property
// VALUE that names an element outright:
//   - the whole string is a qualified name (`Mod.ACT_Save`), or a member of one
//     (`Mod.Order.Total` -> the entity, `Mod.Status.Open` -> the enumeration,
//     `Mod.Page.Param` -> the page);
//   - it is the `$ID` of an entity, attribute or association (the pointers an
//     association keeps to its two entities);
//   - it is a token inside an expression or an XPath constraint.
// Captions, documentation and names never make an edge. The edge kind is the
// nearest enclosing $Type that implies one (a retrieve, a call, a button ...).
//
// Matching on values rather than on a per-$Type property table keeps it working
// across Mendix versions — Studio Pro 11 still stores Mendix 9's type names
// (`ShowFormAction`, `CreateChangeAction`, `ChangeAction`), and a table would
// miss whatever it did not list. What a table is good for — "did we fail to
// resolve something?" — is kept: a value in a known reference property that
// names nothing in the model is counted as unresolved.
// =========================================================================

// Properties that hold a by-name reference. A non-empty value here that
// resolves to nothing is counted as unresolved (the health metric).
const MG_REF_PROPS = new Set([
  'Microflow', 'Nanoflow', 'Page', 'Form', 'Snippet', 'Layout', 'Entity',
  'JavaAction', 'JavaScriptAction', 'Generalization', 'Enumeration', 'Constant',
  'Rule', 'Attribute', 'Association', 'AssociationId', 'Workflow',
  'AfterStartupMicroflow', 'BeforeShutdownMicroflow', 'HealthCheckMicroflow'
]);
// Free text that can look like a name but never references anything.
const MG_TEXT_PROPS = new Set(['Documentation', 'Name', 'Text', 'Caption', 'GUID', 'ExportLevel']);
// Expression / XPath properties — scanned for name tokens.
const MG_EXPR_PROP = /^(xpathconstraint|expression|value|initialvalue|argument|returnvalue)$/i;
const MG_HEX_ID = /^[0-9a-f]{32}$/;
// Every breadth-first walk stops after this many elements and says so.
const MG_NODE_CAP = 5000;
const MG_SAMPLE_CAP = 20;

// The edge kind a $Type implies, beyond what mgKindForType knows: the storage
// names Studio Pro actually writes, and the non-activity references.
function mgPreciseKind(t) {
  if (typeof t !== 'string' || !t) return null;
  if (t === 'Microflows$CreateChangeAction') return 'create';
  if (t === 'Microflows$ChangeAction') return 'change';
  if (t === 'Microflows$CommitAction') return 'commit';
  if (t === 'Microflows$JavaActionCallAction' || t === 'Microflows$JavaScriptActionCallAction') return 'call';
  if (t === 'Microflows$RuleCall' || t === 'Microflows$MicroflowParameterValue') return 'call';
  if (t === 'Mappings$MappingMicroflowCallImpl') return 'call';
  if (t === 'DomainModels$EventHandler') return 'event_handler';
  if (t === 'DomainModels$CalculatedValue') return 'calculate';
  if (t === 'Forms$SnippetCall') return 'snippet';
  if (t === 'Forms$LayoutCall') return 'layout';
  if (t === 'Forms$AttributeRef') return 'attribute';
  if (t === 'Microflows$MicroflowParameter' || t === 'Microflows$MicroflowParameterObject') return 'parameter';
  if (t === 'Forms$PageParameter' || t === 'Forms$SnippetParameter') return 'parameter';
  if (t.endsWith('MappingElement')) return 'mapping';
  if (t.indexOf('$Published') !== -1) return 'publish';
  if (/^(Forms|CustomWidgets)\$\w*Source$/.test(t)) return 'datasource';
  return mgKindForType(t);
}

// $ID -> qualified name, for the references Mendix stores by id: entities,
// their attributes (-> the entity), associations, and named module units.
function mgIdMap(units) {
  const map = {};
  for (const u of (Array.isArray(units) ? units : [])) {
    if (!u || !u.doc || !u.moduleName) continue;
    if (u.type === 'DomainModels$DomainModel') {
      for (const e of mprArray(u.doc.Entities)) {
        if (!e || typeof e.Name !== 'string' || !e.Name) continue;
        const qn = u.moduleName + '.' + e.Name;
        if (typeof e.$ID === 'string') map[e.$ID] = qn;
        for (const a of mprArray(e.Attributes)) {
          if (a && typeof a.$ID === 'string') map[a.$ID] = qn;
        }
      }
      for (const a of mprArray(u.doc.Associations).concat(mprArray(u.doc.CrossAssociations))) {
        if (a && typeof a.Name === 'string' && a.Name && typeof a.$ID === 'string') map[a.$ID] = u.moduleName + '.' + a.Name;
      }
      continue;
    }
    if (u.name && typeof u.doc.$ID === 'string') map[u.doc.$ID] = u.moduleName + '.' + u.name;
  }
  return map;
}

// units: [{ id, type, name, moduleName, doc }] (mgResolveModuleNames output).
// Returns { types: { qn: objectType }, refs: [{ from, to, kind }],
//           unresolved, unresolvedSamples: [{ from, prop, value }], system }.
// `system` counts references into the System module, which has no unit in the
// .mpr — they are real, just not navigable, so they are not "unresolved".
function mgExtractRefsPrecise(units) {
  const list = Array.isArray(units) ? units : [];
  const types = {};
  for (const e of mgCollectElements(list)) types[e.qualifiedName] = e.objectType;
  const idMap = mgIdMap(list);

  const refs = [];
  const seen = new Set();
  const stat = { unresolved: 0, unresolvedSamples: [], system: 0 };

  const resolve = function (s) {
    if (Object.prototype.hasOwnProperty.call(types, s)) return s;
    if (MG_HEX_ID.test(s)) return idMap[s] || null;
    if (QN.test(s)) {
      const parts = s.split('.');
      if (parts.length === 3) {
        const owner = parts[0] + '.' + parts[1];
        if (Object.prototype.hasOwnProperty.call(types, owner)) return owner;
      }
    }
    return null;
  };

  const visit = function (node, kind, locked, from, prop) {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) visit(node[i], kind, locked, from, prop);
      return;
    }
    if (node && typeof node === 'object') {
      if (node.Disabled === true && node.$Type === 'Microflows$ActionActivity') return;
      let here = kind;
      const inferred = mgPreciseKind(node.$Type);
      if (locked) here = inferred === 'home_page' ? inferred : locked;
      else if (inferred) here = inferred;
      else if (!kind && typeof node.$Type === 'string' && node.$Type.indexOf('DataTypes$') === 0) here = 'type';
      // A layout argument's `Parameter` names the layout's placeholder; the
      // widgets it holds are the page's own content, not "layout" references.
      const isLayoutArg = node.$Type === 'Forms$FormCallArgument';
      for (const k in node) {
        if (k === '$ID' || k === '$Type' || MG_TEXT_PROPS.has(k)) continue;
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        visit(node[k], (isLayoutArg && k !== 'Parameter' && !locked) ? null : here, locked, from, k);
      }
      return;
    }
    if (typeof node !== 'string' || node.length < 3) return;
    const target = resolve(node);
    if (target) {
      mgAddRef(from, target, kind || 'ref', refs, seen);
      return;
    }
    if (MG_REF_PROPS.has(prop) && (QN.test(node) || MG_HEX_ID.test(node))) {
      if (node.indexOf('System.') === 0) { stat.system++; return; }
      stat.unresolved++;
      if (stat.unresolvedSamples.length < MG_SAMPLE_CAP) stat.unresolvedSamples.push({ from: from, prop: prop, value: node });
      return;
    }
    if (prop && MG_EXPR_PROP.test(prop) && node.indexOf('.') !== -1) {
      const tokenKind = /xpath/i.test(prop) ? 'xpath' : 'expression';
      QN_TOKEN.lastIndex = 0;
      let m;
      while ((m = QN_TOKEN.exec(node)) !== null) {
        if (Object.prototype.hasOwnProperty.call(types, m[0])) mgAddRef(from, m[0], tokenKind, refs, seen);
      }
    }
  };

  for (const u of list) {
    if (!u || !u.doc || u.doc.Excluded === true) continue;
    if (u.type === 'DomainModels$DomainModel') {
      if (!u.moduleName) continue;
      const mod = u.moduleName + '.';
      for (const ent of mprArray(u.doc.Entities)) {
        if (ent && typeof ent.Name === 'string' && ent.Name) visit(ent, null, null, mod + ent.Name, null);
      }
      for (const a of mprArray(u.doc.Associations).concat(mprArray(u.doc.CrossAssociations))) {
        if (a && typeof a.Name === 'string' && a.Name) visit(a, 'associate', null, mod + a.Name, null);
      }
      continue;
    }
    const from = (u.moduleName && u.name) ? (u.moduleName + '.' + u.name) : u.type;
    if (!from) continue;
    visit(u.doc, null, MG_SOURCE_KINDS[u.type] || null, from, null);
  }

  return {
    types: types,
    refs: refs,
    unresolved: stat.unresolved,
    unresolvedSamples: stat.unresolvedSamples,
    system: stat.system
  };
}

// Adjacency in both directions: Map<qn, Map<neighbour, kinds[]>>.
function mgRefIndex(refs) {
  const out = new Map();
  const inb = new Map();
  const add = function (m, a, b, kind) {
    if (!m.has(a)) m.set(a, new Map());
    const n = m.get(a);
    if (!n.has(b)) n.set(b, []);
    if (n.get(b).indexOf(kind) === -1) n.get(b).push(kind);
  };
  for (const r of (Array.isArray(refs) ? refs : [])) {
    if (!r || typeof r.from !== 'string' || typeof r.to !== 'string') continue;
    add(out, r.from, r.to, r.kind || 'ref');
    add(inb, r.to, r.from, r.kind || 'ref');
  }
  return { out: out, in: inb };
}

// Breadth-first from `start` over one direction of the index. opts.depth: how
// many hops (default 1; 0 = no limit); opts.cap: node cap (MG_NODE_CAP).
// Returns { items: [{ qn, kinds, depth, via }], truncated } — `via` is the
// element it was reached from, so the caller can draw the walk as a tree.
function mgBfs(adj, start, opts) {
  const o = opts || {};
  const maxDepth = (typeof o.depth === 'number' && o.depth > 0) ? o.depth : (o.depth === 0 ? Infinity : 1);
  const cap = (typeof o.cap === 'number' && o.cap > 0) ? o.cap : MG_NODE_CAP;
  const seen = new Set([start]);
  const items = [];
  let frontier = [start];
  let truncated = false;
  for (let d = 1; d <= maxDepth && frontier.length && !truncated; d++) {
    const next = [];
    for (const cur of frontier) {
      const nb = adj.get(cur);
      if (!nb) continue;
      for (const [qn, kinds] of nb) {
        if (seen.has(qn)) continue;
        if (items.length >= cap) { truncated = true; break; }
        seen.add(qn);
        items.push({ qn: qn, kinds: kinds.slice(), depth: d, via: cur });
        next.push(qn);
      }
      if (truncated) break;
    }
    frontier = next;
  }
  return { items: items, truncated: truncated };
}

// nav: mgNavPrepare output. What references `qn` (directly, or up to opts.depth).
function mgCallers(nav, qn, opts) {
  return mgBfs(nav.index.in, qn, opts);
}

// What `qn` references (directly, or up to opts.depth).
function mgCallees(nav, qn, opts) {
  return mgBfs(nav.index.out, qn, opts);
}

// Everything that can break when `qn` changes: every element that references it,
// transitively (default: no depth limit, node cap applies). `byKind` groups the
// DIRECT references by how they use it — for an entity that is who retrieves /
// creates / changes / deletes it, which entities generalize it, and which
// associations and pages point at it. `byType` counts the whole impact set.
function mgImpact(nav, qn, opts) {
  const o = Object.assign({ depth: 0 }, opts || {});
  const walk = mgBfs(nav.index.in, qn, o);
  const direct = walk.items.filter(i => i.depth === 1);
  const byKind = {};
  for (const i of direct) {
    for (const k of i.kinds) (byKind[k] = byKind[k] || []).push(i.qn);
  }
  for (const k in byKind) byKind[k].sort();
  const byType = {};
  for (const i of walk.items) {
    const t = nav.types[i.qn] || 'PROJECT';
    byType[t] = (byType[t] || 0) + 1;
  }
  return {
    direct: direct,
    transitive: walk.items.filter(i => i.depth > 1),
    byKind: byKind,
    byType: byType,
    truncated: walk.truncated
  };
}

// A short, factual description of one element from its own document.
function mgElementSummary(nav, qn) {
  const type = nav.types[qn] || null;
  const doc = nav.docs.get(qn) || null;
  const out = {
    qualifiedName: qn,
    objectType: type,
    module: mgModuleOf(qn),
    marketplace: nav.marketplace.has(mgModuleOf(qn))
  };
  if (!doc) return out;
  if (typeof doc.Documentation === 'string' && doc.Documentation.trim()) {
    out.documentation = doc.Documentation.trim().slice(0, 400);
  }
  if (type === 'MICROFLOW' || type === 'NANOFLOW') {
    const params = [];
    let activities = 0;
    let loops = 0;
    const walk = function (n) {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== 'object') return;
      if (n.$Type === 'Microflows$MicroflowParameter' || n.$Type === 'Microflows$MicroflowParameterObject') {
        const t = n.VariableType || n.Type || {};
        params.push({ name: n.Name || '', type: (t && (t.Entity || (typeof t.$Type === 'string' ? t.$Type.replace(/^DataTypes\$/, '').replace(/Type$/, '') : ''))) || '' });
      }
      if (n.$Type === 'Microflows$ActionActivity') activities++;
      if (n.$Type === 'Microflows$LoopedActivity') loops++;
      for (const k in n) { if (k !== '$ID' && k !== '$Type') walk(n[k]); }
    };
    walk(doc.ObjectCollection);
    out.parameters = params;
    out.activities = activities;
    out.loops = loops;
  } else if (type === 'ENTITY') {
    out.attributes = mprArray(doc.Attributes).length;
    const g = doc.MaybeGeneralization || doc.Generalization;
    if (g && typeof g.Generalization === 'string' && g.Generalization) out.generalization = g.Generalization;
    else if (g && typeof g.Persistable === 'boolean') out.persistable = g.Persistable;
  }
  return out;
}

// The "one package" view of an element: what it is, what references it, what
// it references (both up to opts.depth, default 1), and the structural links it
// takes part in (associations, generalizations) in either direction.
function mgContext(nav, qn, opts) {
  const participates = [];
  const pick = function (adj, outward) {
    const nb = adj.get(qn);
    if (!nb) return;
    for (const [other, kinds] of nb) {
      for (const k of kinds) {
        if (k === 'associate' || k === 'generalize') {
          participates.push(outward ? { from: qn, to: other, kind: k } : { from: other, to: qn, kind: k });
        }
      }
    }
  };
  pick(nav.index.out, true);
  pick(nav.index.in, false);
  return {
    element: mgElementSummary(nav, qn),
    callers: mgCallers(nav, qn, opts),
    callees: mgCallees(nav, qn, opts),
    participates: participates
  };
}

// One pass for the navigation queries. prep: mgPrepare output (resolved units +
// marketplace). Returns the precise graph, both adjacency maps, each element's
// own document (for summaries and the loop check) and the reference health
// figures the view reports.
function mgNavPrepare(prep) {
  const graph = mgExtractRefsPrecise(prep.units);
  const docs = new Map();
  for (const u of prep.units) {
    if (!u || !u.doc || !u.moduleName) continue;
    if (u.type === 'DomainModels$DomainModel') {
      for (const e of mprArray(u.doc.Entities)) {
        if (e && typeof e.Name === 'string' && e.Name) docs.set(u.moduleName + '.' + e.Name, e);
      }
      continue;
    }
    if (u.name) docs.set(u.moduleName + '.' + u.name, u.doc);
  }
  const elements = Object.keys(graph.types).sort().map(qn => ({ qn: qn, type: graph.types[qn] }));
  const total = graph.refs.length + graph.unresolved;
  return {
    types: graph.types,
    refs: graph.refs,
    index: mgRefIndex(graph.refs),
    docs: docs,
    marketplace: new Set(prep.marketplace || []),
    elements: elements,
    stats: {
      elements: elements.length,
      edges: graph.refs.length,
      unresolved: graph.unresolved,
      unresolvedPct: total ? Math.round(1000 * graph.unresolved / total) / 10 : 0,
      unresolvedSamples: graph.unresolvedSamples,
      system: graph.system
    }
  };
}

// ── N+1 from the model (Plan 011 step 6) ─────────────────────────────────────
// Studio Pro's Best Practice Bot flags a commit in a loop and XPath problems,
// one microflow at a time. It does not flag a DATABASE RETRIEVE inside a loop
// (PERF02), nor a loop that calls a sub-microflow which — directly or further
// down — retrieves from or commits to the database (PERF03): one query per
// iteration hidden behind a call. "Inside a loop" = anywhere in the loop's own
// object collection (a split in a loop is a sibling there, not a container).
// Association retrieves are left out — they are often served from memory.

// The loop variable a LoopedActivity iterates, or 'while' for a while-loop.
function mgLoopLabel(loop) {
  const s = loop && loop.LoopSource;
  if (s && typeof s.ListVariableName === 'string' && s.ListVariableName) return s.ListVariableName;
  return 'while';
}

// Calls fn(action) for every enabled action activity under `node`.
function mgEachAction(node, fn) {
  if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) mgEachAction(node[i], fn); return; }
  if (!node || typeof node !== 'object') return;
  if (node.$Type === 'Microflows$ActionActivity') {
    if (node.Disabled !== true && node.Action) fn(node.Action);
    return;
  }
  for (const k in node) { if (k !== '$ID' && k !== '$Type') mgEachAction(node[k], fn); }
}

function mgActionsIn(node) {
  const out = [];
  mgEachAction(node, function (a) { out.push(a); });
  return out;
}

function mgIsDbRetrieve(a) {
  return a && a.$Type === 'Microflows$RetrieveAction' && a.RetrieveSource &&
    a.RetrieveSource.$Type === 'Microflows$DatabaseRetrieveSource';
}

// The first database hit anywhere in a microflow: { what, entity } or null.
function mgDbHit(doc) {
  let hit = null;
  mgEachAction(doc && doc.ObjectCollection, function (a) {
    if (hit) return;
    if (mgIsDbRetrieve(a)) { hit = { what: 'retrieve', entity: a.RetrieveSource.Entity || null }; return; }
    if (a.$Type === 'Microflows$CommitAction') { hit = { what: 'commit', entity: null }; return; }
    const changes = a.$Type === 'Microflows$CreateChangeAction' || a.$Type === 'Microflows$ChangeAction' ||
      a.$Type === 'Microflows$CreateObjectAction' || a.$Type === 'Microflows$ChangeObjectAction';
    if (changes && typeof a.Commit === 'string' && a.Commit !== 'No') hit = { what: 'commit', entity: a.Entity || null };
  });
  return hit;
}

// The microflows a microflow calls directly (enabled call activities only).
function mgCalledFlows(doc) {
  const out = [];
  mgEachAction(doc && doc.ObjectCollection, function (a) {
    if (a.$Type === 'Microflows$MicroflowCallAction' && a.MicroflowCall && typeof a.MicroflowCall.Microflow === 'string') {
      if (out.indexOf(a.MicroflowCall.Microflow) === -1) out.push(a.MicroflowCall.Microflow);
    }
  });
  return out;
}

// Every LoopedActivity in a microflow doc, outermost first.
function mgLoopsIn(node, out) {
  if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) mgLoopsIn(node[i], out); return out; }
  if (!node || typeof node !== 'object') return out;
  if (node.$Type === 'Microflows$LoopedActivity') out.push(node);
  for (const k in node) { if (k !== '$ID' && k !== '$Type') mgLoopsIn(node[k], out); }
  return out;
}

// nav: mgNavPrepare output.
// Returns { findings: [{ id, microflow, loop, entity, what, chain, count }],
//           counts: { PERF02, PERF03, microflows, loops } }.
function mgLoopDbAccess(nav, opts) {
  const cap = (opts && opts.cap > 0) ? opts.cap : MG_NODE_CAP;
  const flows = [];
  for (const qn in nav.types) {
    if (nav.types[qn] === 'MICROFLOW' && nav.docs.has(qn)) flows.push(qn);
  }
  flows.sort();

  const hitMemo = new Map();
  const hitOf = function (qn) {
    if (!hitMemo.has(qn)) hitMemo.set(qn, nav.docs.has(qn) ? mgDbHit(nav.docs.get(qn)) : null);
    return hitMemo.get(qn);
  };
  const callMemo = new Map();
  const callsOf = function (qn) {
    if (!callMemo.has(qn)) callMemo.set(qn, nav.docs.has(qn) ? mgCalledFlows(nav.docs.get(qn)) : []);
    return callMemo.get(qn);
  };
  // Shortest call chain from `start` to a microflow that hits the database.
  const chainTo = function (start) {
    const prev = new Map([[start, null]]);
    const queue = [start];
    for (let i = 0; i < queue.length && prev.size <= cap; i++) {
      const cur = queue[i];
      const hit = hitOf(cur);
      if (hit) {
        const chain = [];
        for (let n = cur; n !== null; n = prev.get(n)) chain.unshift(n);
        return { chain: chain, hit: hit };
      }
      for (const nxt of callsOf(cur)) {
        if (!prev.has(nxt)) { prev.set(nxt, cur); queue.push(nxt); }
      }
    }
    return null;
  };

  const findings = [];
  let loopCount = 0;
  for (const mf of flows) {
    // Innermost first: an action inside nested loops is reported once, under
    // the loop that directly holds it.
    const loops = mgLoopsIn(nav.docs.get(mf).ObjectCollection, []).reverse();
    loopCount += loops.length;
    const seenActions = new Set();
    const perf02 = new Map();
    const perf03 = new Map();
    for (const loop of loops) {
      const label = mgLoopLabel(loop);
      for (const a of mgActionsIn(loop.ObjectCollection)) {
        if (seenActions.has(a)) continue;
        seenActions.add(a);
        if (mgIsDbRetrieve(a)) {
          const ent = a.RetrieveSource.Entity || '';
          const key = label + '|' + ent;
          if (perf02.has(key)) perf02.get(key).count++;
          else perf02.set(key, { id: 'PERF02', microflow: mf, loop: label, entity: ent || null, what: 'retrieve', chain: [], count: 1 });
          continue;
        }
        if (a.$Type === 'Microflows$MicroflowCallAction' && a.MicroflowCall && typeof a.MicroflowCall.Microflow === 'string') {
          const callee = a.MicroflowCall.Microflow;
          if (callee === mf || perf03.has(callee)) continue;
          const found = chainTo(callee);
          if (found) {
            perf03.set(callee, { id: 'PERF03', microflow: mf, loop: label, entity: found.hit.entity, what: found.hit.what, chain: found.chain, count: 1 });
          }
        }
      }
    }
    for (const f of perf02.values()) findings.push(f);
    for (const f of perf03.values()) findings.push(f);
  }
  return {
    findings: findings,
    counts: {
      PERF02: findings.filter(f => f.id === 'PERF02').length,
      PERF03: findings.filter(f => f.id === 'PERF03').length,
      microflows: flows.length,
      loops: loopCount
    }
  };
}

module.exports = {
  QN,
  ENTRY_PREFIXES,
  MG_NODE_CAP,
  mgIdMap,
  mgExtractRefsPrecise,
  mgRefIndex,
  mgCallers,
  mgCallees,
  mgImpact,
  mgContext,
  mgNavPrepare,
  mgLoopDbAccess,
  mgResolveModuleNames,
  mgMarketplaceModules,
  mgCollectElements,
  mgStringsIn,
  mgKindForType,
  mgExtractRefs,
  mgFindDeadAssets,
  mgPrepare,
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
