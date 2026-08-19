// DOMAIN MODEL CANVAS
// =========================================================================
// The interactive working view: one entity and its neighbourhood, drawn as
// SVG we own rather than a Mermaid image we can only look at.
//
// Why our own renderer, when the measurements said Mermaid was not to blame
// for diagram width (72% of the canvas was our own edge labels): the reason
// is the interaction ceiling, not the layout. A Mermaid SVG has no node
// identity — architecture.js has to recognise a clicked node by matching the
// longest entity name that prefixes the node's text, because Mermaid renders
// the class title and its attribute rows as one text run. Expanding one
// entity, dragging it, or highlighting just its edges are all impossible
// there. Here every node is a <g data-entity="Module.Entity">.
//
// SVG DOM rather than <canvas> 2D: hit-testing and text come free, the theme
// resolves through CSS, and the existing `.arch-search-hit` rule targets
// rect/polygon — a 2D canvas would silently invalidate it. The scale this
// view is for (tens of nodes, never thousands) makes the tradeoff obvious.
//
// Mermaid keeps the export role: versionable text that renders natively in
// GitHub and Confluence.
// =========================================================================

const ARCH_CANVAS = {
  MIN_W: 120,
  MAX_W: 320,
  HEADER_H: 34,
  ROW_H: 17,
  PAD_X: 12,
  PAD_BOTTOM: 8,
  // Text is measured arithmetically, never through the DOM: the layout has to
  // stay a pure function so parser-test.js can assert on the coordinates.
  CHAR_W_TITLE: 7.2,
  CHAR_W_ROW: 6.0,
  GAP: 34,
  RING_GAP: 70,
  MARGIN: 60
};

function archNodeSize(entity, expanded) {
  const C = ARCH_CANVAS;
  const title = String(entity.shortName || entity.name || '');
  let w = title.length * C.CHAR_W_TITLE + C.PAD_X * 2;
  let h = C.HEADER_H;
  if (expanded) {
    const attrs = entity.attributes || [];
    attrs.forEach(function (a) {
      const line = String(a.name) + ' : ' + String(a.type);
      w = Math.max(w, line.length * C.CHAR_W_ROW + C.PAD_X * 2);
    });
    h += attrs.length * C.ROW_H + C.PAD_BOTTOM;
  }
  return {
    w: Math.min(C.MAX_W, Math.max(C.MIN_W, Math.round(w))),
    h: Math.round(h)
  };
}

// Hop distance from the focus entity, over the same undirected association
// graph archEntityNeighborhood walks.
function archHopDistances(associations, focus) {
  const adj = new Map();
  function link(a, b) {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  }
  (associations || []).forEach(function (a) { link(a.one, a.many); link(a.many, a.one); });
  const dist = new Map([[focus, 0]]);
  let frontier = [focus];
  while (frontier.length) {
    const next = [];
    frontier.forEach(function (n) {
      (adj.get(n) || new Set()).forEach(function (nb) {
        if (!dist.has(nb)) { dist.set(nb, dist.get(n) + 1); next.push(nb); }
      });
    });
    frontier = next;
  }
  return dist;
}

// Pure layout: focus in the middle, each hop on its own ring. Deterministic
// on purpose — a layout that reshuffles when you expand a node is unusable,
// and a non-deterministic one cannot be asserted on.
function archLayoutRadial(model, opts) {
  opts = opts || {};
  const C = ARCH_CANVAS;
  const allEntities = (model && model.entities) || [];
  const associations = (model && model.associations) || [];
  const focus = opts.focus || (allEntities[0] && allEntities[0].name) || null;
  const expanded = opts.expanded || new Set();
  const overrides = opts.overrides || new Map();

  const dist = archHopDistances(associations, focus);
  // maxHops scopes a large live model down to a neighbourhood (Explore's own
  // job) — without it every caller gets the "draw exactly what you handed me,
  // including anything unreachable" behaviour the module-picker path needs.
  const entities = (opts.maxHops == null) ? allEntities
    : allEntities.filter(function (e) { return dist.has(e.name) && dist.get(e.name) <= opts.maxHops; });

  const nodes = entities.map(function (e) {
    const isExp = expanded.has(e.name);
    const size = archNodeSize(e, isExp);
    return {
      id: e.name,
      shortName: e.shortName || e.name,
      module: String(e.name).indexOf('.') !== -1 ? String(e.name).split('.')[0] : '',
      // Anything the BFS never reached sits on an outer ring rather than on
      // top of the focus — it is still part of the picture.
      ring: dist.has(e.name) ? dist.get(e.name) : 99,
      expanded: isExp,
      attributes: e.attributes || [],
      table: e.table || '',
      w: size.w, h: size.h, x: 0, y: 0
    };
  });

  const byRing = new Map();
  nodes.forEach(function (n) {
    if (!byRing.has(n.ring)) byRing.set(n.ring, []);
    byRing.get(n.ring).push(n);
  });
  // Module then name: stable, and it groups a module's entities into a wedge.
  byRing.forEach(function (list) {
    list.sort(function (a, b) {
      if (a.module !== b.module) return a.module < b.module ? -1 : 1;
      if (a.shortName !== b.shortName) return a.shortName < b.shortName ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  });

  const diag = function (n) { return Math.sqrt(n.w * n.w + n.h * n.h); };
  const ringKeys = Array.from(byRing.keys()).sort(function (a, b) { return a - b; });
  let prevR = 0, prevHalf = 0;

  ringKeys.forEach(function (k) {
    const list = byRing.get(k);
    const maxDiag = Math.max.apply(null, list.map(diag));
    if (k === 0) {
      list.forEach(function (n) { n.x = -n.w / 2; n.y = -n.h / 2; });
      prevR = 0;
      prevHalf = maxDiag / 2;
      return;
    }
    const slots = list.map(function (n) { return diag(n) + C.GAP; });
    const total = slots.reduce(function (a, c) { return a + c; }, 0);
    const n = list.length;
    // Three constraints, largest wins: fit every node's slot on the
    // circumference; keep even the widest pair apart when there are only a
    // few of them (where an arc is a poor proxy for the chord); and clear the
    // ring inside this one.
    const rCircumference = total / (2 * Math.PI);
    const rSpread = n >= 2 ? (maxDiag + C.GAP) / (2 * Math.sin(Math.PI / n)) : 0;
    const rStack = prevR + prevHalf + maxDiag / 2 + C.RING_GAP;
    const r = Math.max(rCircumference, rSpread, rStack);
    let cum = 0;
    list.forEach(function (node, i) {
      // -PI/2 so the first node starts at the top, which reads as "12 o'clock".
      const theta = 2 * Math.PI * ((cum + slots[i] / 2) / total) - Math.PI / 2;
      cum += slots[i];
      node.x = Math.round(r * Math.cos(theta) - node.w / 2);
      node.y = Math.round(r * Math.sin(theta) - node.h / 2);
    });
    prevR = r;
    prevHalf = maxDiag / 2;
  });

  // Shift into positive space BEFORE honouring dragged positions: overrides
  // are stored in the coordinates the user actually sees, so re-running the
  // layout must not drift them.
  let minX = Infinity, minY = Infinity;
  nodes.forEach(function (n) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); });
  if (!nodes.length) { minX = 0; minY = 0; }
  const dx = C.MARGIN - minX, dy = C.MARGIN - minY;
  nodes.forEach(function (n) { n.x += dx; n.y += dy; });

  nodes.forEach(function (n) {
    const o = overrides.get(n.id);
    if (o) {
      n.x = Math.max(0, Math.round(o.x));
      n.y = Math.max(0, Math.round(o.y));
      n.overridden = true;
    }
  });

  let maxX = 0, maxY = 0;
  nodes.forEach(function (n) {
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  });

  const byId = new Map(nodes.map(function (n) { return [n.id, n]; }));
  const edges = associations.filter(function (a) {
    return byId.has(a.one) && byId.has(a.many);
  }).map(function (a) {
    return {
      from: a.one, to: a.many, name: a.shortName || a.name,
      cardinality: a.cardinality, storage: a.storage,
      table: a.table, columns: a.columns
    };
  });

  return {
    nodes: nodes, edges: edges, focus: focus,
    width: Math.round(maxX + C.MARGIN),
    height: Math.round(maxY + C.MARGIN)
  };
}

// Where a line towards (tx,ty) leaves this node's rectangle — so edges touch
// the border instead of vanishing under the box.
function archEdgeAnchor(node, tx, ty) {
  const cx = node.x + node.w / 2, cy = node.y + node.h / 2;
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const hw = node.w / 2, hh = node.h / 2;
  const scale = Math.min(
    dx ? hw / Math.abs(dx) : Infinity,
    dy ? hh / Math.abs(dy) : Infinity
  );
  return { x: cx + dx * scale, y: cy + dy * scale };
}

// =========================================================================
// Rendering + interaction (DOM). Everything above this line is pure and unit
// tested; everything below is only exercisable in a browser.
// =========================================================================

const SVG_NS = 'http://www.w3.org/2000/svg';

function acEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// One place for state, mirroring how architecture.js itself keeps a handful
// of module-level `let`s rather than a class — same file, same convention.
const acState = {
  model: null,      // the untouched archLiveModel — full fidelity, never the
                     // lossy {name,type}-only projection the Mermaid path uses
  focus: null,
  maxHops: 1,
  expanded: new Set(),
  overrides: new Map(),   // fullName -> {x,y}, dragged positions
  selected: null,
  layout: null,
  dragId: null, dragDX: 0, dragDY: 0, dragMoved: false
};

// Deliberately NOT named "node", "classGroup", or containing "class" anywhere
// in a class attribute: architecture.js's own click-to-recenter handler
// (bound once, permanently, on window — see archInitPanZoom) matches
// `g.node, g.classGroup, g[class*="class"]` against archExploreState, which
// stays set while the canvas is showing. Reusing any of those tokens would
// make that legacy Mermaid-node matcher fire a second, redundant explore on
// every canvas click. Naming it out of reach is simpler and more robust than
// fighting DOM event ordering between two independently-bound listeners.
const AC_NODE_CLASS = 'ac-entity';

function acSvgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
  return el;
}

function acEntityByName(name) {
  return acState.model ? acState.model.entities.find(function (e) { return e.name === name; }) : null;
}

// Every association touching this entity, regardless of whether the other
// side is currently drawn — the details panel answers "what references me",
// which is a bigger question than "what's on screen right now".
function acAssociationsOf(fullName) {
  if (!acState.model) return [];
  return acState.model.associations.filter(function (a) { return a.one === fullName || a.many === fullName; });
}

function acBuildNodeGroup(node, theme, colors) {
  const isFocus = node.id === acState.focus;
  const mod = node.module;
  const c = (colors.get(mod)) || (window.ARCH_FOCUS_STROKE ? { fill: '#262626', stroke: '#5a5a5a', text: '#c8c8c8' } : {});
  const g = acSvgEl('g', {
    class: AC_NODE_CLASS, 'data-entity': node.id,
    transform: 'translate(' + node.x + ',' + node.y + ')'
  });
  g.style.cursor = 'grab';

  const rect = acSvgEl('rect', {
    width: node.w, height: node.h, rx: 5, ry: 5,
    fill: c.fill || (theme === 'light' ? '#f0f0f0' : '#262626'),
    stroke: isFocus ? (window.ARCH_FOCUS_STROKE ? window.ARCH_FOCUS_STROKE[theme] : '#ff8700') : (c.stroke || '#5a5a5a'),
    'stroke-width': isFocus ? 3 : 1.5
  });
  g.appendChild(rect);

  const title = acSvgEl('text', {
    x: ARCH_CANVAS.PAD_X, y: 21, 'font-size': 12.5, 'font-weight': 600,
    fill: c.text || (theme === 'light' ? '#111' : '#eee')
  });
  title.textContent = node.shortName;
  g.appendChild(title);

  // A collapsed node still shows how many fields it has and whether it has
  // any associations at all beyond the ones drawn — cheap orientation before
  // the user commits to expanding it.
  const hint = acSvgEl('text', {
    x: node.w - 8, y: 21, 'font-size': 10, 'text-anchor': 'end',
    fill: c.text || (theme === 'light' ? '#111' : '#eee'), opacity: 0.65
  });
  const attrCount = (node.attributes || []).length;
  hint.textContent = node.expanded ? '−' : (attrCount ? attrCount + ' ▸' : '');
  g.appendChild(hint);

  if (node.expanded) {
    const line = acSvgEl('line', {
      x1: 0, y1: ARCH_CANVAS.HEADER_H, x2: node.w, y2: ARCH_CANVAS.HEADER_H,
      stroke: c.stroke || '#5a5a5a', 'stroke-width': 1, opacity: 0.5
    });
    g.appendChild(line);
    (node.attributes || []).forEach(function (a, i) {
      const y = ARCH_CANVAS.HEADER_H + (i + 1) * ARCH_CANVAS.ROW_H - 4;
      const row = acSvgEl('text', {
        x: ARCH_CANVAS.PAD_X, y: y, 'font-size': 10.5, 'font-family': 'var(--font-mono, monospace)',
        fill: c.text || (theme === 'light' ? '#111' : '#eee')
      });
      row.textContent = a.name + ' : ' + a.type;
      g.appendChild(row);
    });
  }

  return g;
}

function acCardMark(cardinality, atStart) {
  // "1" or "*" next to the edge end, same information Mermaid's arrow labels
  // carried — cardinality is read from real UNIQUE indexes, not guessed, and
  // that fact deserves to stay visible in the owned renderer too.
  if (cardinality === '1-1') return '1';
  if (cardinality === '1-*') return atStart ? '1' : '*';
  if (cardinality === '*-*') return '*';
  return '';
}

function acBuildEdge(edge, byId, theme) {
  const from = byId.get(edge.from), to = byId.get(edge.to);
  if (!from || !to) return null;
  const a = archEdgeAnchor(from, to.x + to.w / 2, to.y + to.h / 2);
  const b = archEdgeAnchor(to, from.x + from.w / 2, from.y + from.h / 2);
  const g = acSvgEl('g', { class: 'ac-edge', 'data-from': edge.from, 'data-to': edge.to });
  const line = acSvgEl('line', {
    x1: a.x, y1: a.y, x2: b.x, y2: b.y,
    stroke: theme === 'light' ? '#8a8a8a' : '#7a7a7a', 'stroke-width': 1.4
  });
  g.appendChild(line);
  const startMark = acCardMark(edge.cardinality, true), endMark = acCardMark(edge.cardinality, false);
  if (startMark) {
    const t = acSvgEl('text', { x: a.x + (b.x - a.x) * 0.14, y: a.y + (b.y - a.y) * 0.14 - 4, 'font-size': 10, fill: theme === 'light' ? '#555' : '#aaa' });
    t.textContent = startMark; g.appendChild(t);
  }
  if (endMark) {
    const t = acSvgEl('text', { x: a.x + (b.x - a.x) * 0.86, y: a.y + (b.y - a.y) * 0.86 - 4, 'font-size': 10, fill: theme === 'light' ? '#555' : '#aaa' });
    t.textContent = endMark; g.appendChild(t);
  }
  return g;
}

// Repositions one node's group and every edge touching it, without touching
// anything else — used during a drag, where re-running the full layout+DOM
// rebuild on every mousemove would be wasteful for no visible benefit.
function acRepositionLive(id, x, y) {
  const svg = document.querySelector('#arch-output svg');
  if (!svg) return;
  const g = svg.querySelector('g.' + AC_NODE_CLASS + '[data-entity="' + CSS.escape(id) + '"]');
  if (g) g.setAttribute('transform', 'translate(' + x + ',' + y + ')');
  const node = acState.layout.nodes.find(function (n) { return n.id === id; });
  if (!node) return;
  // Mutating the layout's own node is deliberate and safe here: this is a
  // live visual position during an in-progress drag, not yet the committed
  // one (that happens in acEndDrag via acState.overrides), and the next full
  // acRender() rebuilds this layout object from scratch regardless.
  node.x = x; node.y = y;
  const byId = new Map(acState.layout.nodes.map(function (n) { return [n.id, n]; }));
  const theme = window.archCurrentTheme ? window.archCurrentTheme() : 'dark';
  acState.layout.edges.forEach(function (edge) {
    if (edge.from !== id && edge.to !== id) return;
    const existing = svg.querySelector('g.ac-edge[data-from="' + CSS.escape(edge.from) + '"][data-to="' + CSS.escape(edge.to) + '"]');
    const fresh = acBuildEdge(edge, byId, theme);
    if (existing && fresh) existing.replaceWith(fresh);
  });
}

function acRender(preserveZoom) {
  const out = document.getElementById('arch-output');
  if (!out || !acState.model || !acState.focus) return;
  const theme = window.archCurrentTheme ? window.archCurrentTheme() : 'dark';
  const layout = archLayoutRadial(acState.model, {
    focus: acState.focus, expanded: acState.expanded,
    overrides: acState.overrides, maxHops: acState.maxHops
  });
  acState.layout = layout;

  const colors = window.archAssignModuleColors
    ? window.archAssignModuleColors(layout.nodes.map(function (n) { return { fullName: n.id }; }), theme)
    : new Map();
  if (window.archRenderLegend) {
    window.archRenderLegend(layout.nodes.map(function (n) { return { fullName: n.id }; }), theme);
  }

  const svg = acSvgEl('svg', {
    viewBox: '0 0 ' + layout.width + ' ' + layout.height,
    width: layout.width, height: layout.height
  });
  const edgeLayer = acSvgEl('g', { class: 'ac-edges' });
  const nodeLayer = acSvgEl('g', { class: 'ac-nodes' });
  const byId = new Map(layout.nodes.map(function (n) { return [n.id, n]; }));
  layout.edges.forEach(function (e) {
    const el = acBuildEdge(e, byId, theme);
    if (el) edgeLayer.appendChild(el);
  });
  layout.nodes.forEach(function (n) {
    const g = acBuildNodeGroup(n, theme, colors);
    if (n.id === acState.selected) g.classList.add('arch-search-hit');
    nodeLayer.appendChild(g);
  });
  svg.appendChild(edgeLayer);
  svg.appendChild(nodeLayer);

  out.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.id = 'arch-zoom';
  wrap.style.transformOrigin = '0 0';
  wrap.style.flex = '0 0 auto';
  wrap.appendChild(svg);
  out.appendChild(wrap);

  acBindInteractions(out);
  if (window.archMeasureDiagram) window.archMeasureDiagram();
  if (window.archInitPanZoom) window.archInitPanZoom();
  const zoom = window.archZoom || 1;
  if (preserveZoom && window.archApplyZoom) {
    window.archApplyZoom(zoom);
  } else if (window.archOutClientWidth != null && layout.width > window.archOutClientWidth && window.archZoomFit) {
    window.archZoomFit();
  } else if (window.archApplyZoom) {
    window.archApplyZoom(1);
  }
  acRenderDetails();
}

function acToggleExpand(id) {
  if (acState.expanded.has(id)) acState.expanded.delete(id); else acState.expanded.add(id);
  acRender(true);
}

function acSelect(id) {
  acState.selected = id;
  const prev = document.querySelector('#arch-output .arch-search-hit');
  if (prev) prev.classList.remove('arch-search-hit');
  const g = document.querySelector('#arch-output g.' + AC_NODE_CLASS + '[data-entity="' + CSS.escape(id) + '"]');
  if (g) g.classList.add('arch-search-hit');
  acRenderDetails();
}

function acStartDrag(id, e) {
  const node = acState.layout.nodes.find(function (n) { return n.id === id; });
  if (!node) return;
  acState.dragId = id;
  acState.dragMoved = false;
  const zoom = window.archZoom || 1;
  acState.dragDX = e.clientX / zoom - node.x;
  acState.dragDY = e.clientY / zoom - node.y;
}

function acDuringDrag(e) {
  if (!acState.dragId) return;
  const zoom = window.archZoom || 1;
  const x = Math.max(0, Math.round(e.clientX / zoom - acState.dragDX));
  const y = Math.max(0, Math.round(e.clientY / zoom - acState.dragDY));
  const node = acState.layout.nodes.find(function (n) { return n.id === acState.dragId; });
  if (node && (node.x !== x || node.y !== y)) {
    acState.dragMoved = true;
    acRepositionLive(acState.dragId, x, y);
  }
}

function acEndDrag() {
  if (!acState.dragId) return;
  const id = acState.dragId;
  const moved = acState.dragMoved;
  const node = acState.layout.nodes.find(function (n) { return n.id === id; });
  acState.dragId = null;
  if (moved && node) {
    acState.overrides.set(id, { x: node.x, y: node.y });
  } else {
    acSelect(id);
  }
}

let acInteractionsBound = false;

function acBindInteractions(out) {
  // Bound once, permanently — mirrors architecture.js's own
  // `dataset.panZoomBound` idiom. Nodes are found by delegation at event
  // time (closest()), so this survives every re-render without re-binding.
  if (acInteractionsBound) return;
  acInteractionsBound = true;

  out.addEventListener('mousedown', function (e) {
    const g = e.target.closest && e.target.closest('g.' + AC_NODE_CLASS);
    if (!g) return;
    // Stops architecture.js's own pan-start handler on #arch-output from also
    // engaging — without this a node drag would scroll the whole panel too.
    e.stopPropagation();
    e.preventDefault();
    acStartDrag(g.getAttribute('data-entity'), e);
  }, true); // capture: run before architecture.js's own mousedown listener

  window.addEventListener('mousemove', function (e) {
    if (acState.dragId) acDuringDrag(e);
  });

  window.addEventListener('mouseup', function () {
    if (acState.dragId) acEndDrag();
  }, true); // capture: resolve the drag before the legacy recenter handler runs

  out.addEventListener('dblclick', function (e) {
    const g = e.target.closest && e.target.closest('g.' + AC_NODE_CLASS);
    if (!g) return;
    e.stopPropagation();
    acToggleExpand(g.getAttribute('data-entity'));
  });
}

function acRenderDetails() {
  const box = document.getElementById('arch-details-pane');
  if (!box) return;
  const entity = acState.selected ? acEntityByName(acState.selected) : null;
  if (!entity) {
    box.innerHTML = '<div style="padding:var(--sp-3);color:var(--text-muted);font-size:0.8rem">'
      + 'Click an entity on the canvas to see its table, columns and associations.</div>';
    return;
  }
  const attrRows = (entity.attributes || []).map(function (a) {
    return '<tr><td>' + acEsc(a.name) + '</td><td><code>' + acEsc(a.column) + '</code></td>'
      + '<td>' + acEsc(a.type) + '</td>'
      + '<td>' + (a.isAutoNumber ? 'AutoNumber' : '') + '</td></tr>';
  }).join('');
  const assocRows = acAssociationsOf(entity.name).map(function (a) {
    const otherSide = a.one === entity.name ? a.many : a.one;
    const dir = a.one === entity.name ? '→ (1 side)' : '← (' + (a.cardinality === '*-*' ? '*' : 'many') + ' side)';
    const fk = a.storage === 'junction'
      ? 'junction <code>' + acEsc(a.table) + '</code>'
      : 'FK <code>' + acEsc((a.columns && a.columns[0]) || '') + '</code> on <code>' + acEsc(a.table) + '</code>';
    return '<tr><td>' + acEsc(a.shortName || a.name) + '</td><td>' + acEsc(otherSide) + '</td>'
      + '<td>' + acEsc(a.cardinality) + ' ' + dir + '</td><td style="font-size:0.72rem">' + fk + '</td></tr>';
  }).join('');
  box.innerHTML = `
    <div style="padding:var(--sp-2) var(--sp-3);overflow:auto;height:100%;font-size:0.78rem">
      <div style="font-weight:600;font-size:0.88rem;margin-bottom:2px">${acEsc(entity.shortName)}</div>
      <div style="color:var(--text-muted);margin-bottom:var(--sp-2)">
        table <code>${acEsc(entity.table)}</code> · module ${acEsc(entity.module)}
        ${entity.superName ? ' · extends ' + acEsc(entity.superName) : ''}
        ${entity.remote ? ' · remote (external DB)' : ''}
      </div>
      <div style="font-weight:600;margin-bottom:4px">Attributes (${(entity.attributes || []).length})</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:var(--sp-3)">
        <thead><tr style="color:var(--text-muted);text-align:left"><th>Name</th><th>Column</th><th>Type</th><th></th></tr></thead>
        <tbody>${attrRows || '<tr><td colspan="4" style="color:var(--text-muted)">No attributes.</td></tr>'}</tbody>
      </table>
      <div style="font-weight:600;margin-bottom:4px">Associations (${acAssociationsOf(entity.name).length})</div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="color:var(--text-muted);text-align:left"><th>Name</th><th>Other side</th><th>Cardinality</th><th>Storage</th></tr></thead>
        <tbody>${assocRows || '<tr><td colspan="4" style="color:var(--text-muted)">No associations — orphan entity.</td></tr>'}</tbody>
      </table>
    </div>`;
}

// Entry point: architecture.js calls this after archExploreFrom resolves a
// focus entity. A focus change resets expanded/overrides/selection — they
// describe a specific neighbourhood, and carrying them to a different one is
// more likely to confuse ("why is this unrelated node dragged over there?")
// than to help.
window.archCanvasRender = function (model, focusFullName, hops) {
  const focusChanged = acState.focus !== focusFullName;
  acState.model = model;
  acState.focus = focusFullName;
  acState.maxHops = (hops === 2) ? 2 : 1;
  if (focusChanged) {
    acState.expanded = new Set();
    acState.overrides = new Map();
    acState.selected = null;
  }
  acRender(!focusChanged);
};

window.archCanvasRerenderForTheme = function () {
  if (acState.model && acState.focus) acRender(true);
};

window.archCanvasRenderEmpty = function () {
  const out = document.getElementById('arch-output');
  if (out) out.innerHTML = '<div style="color:var(--text-muted)">Explore an entity below to begin.</div>';
  const legend = document.getElementById('arch-legend');
  if (legend) { legend.style.display = 'none'; legend.innerHTML = ''; }
  acRenderDetails();
};

window.archSetLeftPane = function (mode, btn) {
  const details = document.getElementById('arch-details-pane');
  const source = document.getElementById('arch-source-pane');
  if (details) details.style.display = mode === 'details' ? 'block' : 'none';
  if (source) source.style.display = mode === 'source' ? 'flex' : 'none';
  if (btn) {
    const group = btn.closest('.btn-group');
    if (group) group.querySelectorAll('.btn').forEach(function (b) {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
    });
  }
};

// --- Exposed for scripts/parser-test.js (pure, no DOM) ---
window.archNodeSize = archNodeSize;
window.archHopDistances = archHopDistances;
window.archLayoutRadial = archLayoutRadial;
window.archEdgeAnchor = archEdgeAnchor;
window.ARCH_CANVAS = ARCH_CANVAS;
