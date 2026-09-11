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

module.exports = {
  QN,
  ENTRY_PREFIXES,
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
