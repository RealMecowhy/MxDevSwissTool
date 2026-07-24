// JSON FORMATTER
// ============================================================
let jsonLastParsed = null;
let jsonPathElements = new Map();
let jsonFindResults = [];
let jsonFindIndex = -1;

function jsonResetInteractiveState() {
  jsonLastParsed = null;
  jsonPathElements = new Map();
  jsonFindResults = [];
  jsonFindIndex = -1;
  const bc = document.getElementById('json-breadcrumb');
  if (bc) bc.style.display = 'none';
  const countEl = document.getElementById('json-find-count');
  if (countEl) countEl.textContent = '';
}

function jsonFormat() {
  const raw = document.getElementById('json-input').value.trim();
  if (!raw) { document.getElementById('json-tree-output').innerHTML = '<span style="color:var(--text-muted)">Output will appear here...</span>'; document.getElementById('json-status').innerHTML=''; jsonResetInteractiveState(); return; }
  try {
    const parsed = JSON.parse(raw);
    document.getElementById('json-status').innerHTML = '<span class="badge badge-success">&#10003; Valid JSON</span>';
    document.getElementById('json-tree-output').innerHTML = renderJsonTree(parsed, 0);
    addJsonToggleListeners();
    jsonLastParsed = parsed;
    jsonBuildPathIndex();
    const bc = document.getElementById('json-breadcrumb');
    if (bc) bc.style.display = 'none';
    jsonFind();
  } catch(e) {
    document.getElementById('json-status').innerHTML = '<span class="badge badge-error">&#10007; Invalid</span>';
    document.getElementById('json-tree-output').innerHTML = '<div class="jt-error">Parse error: '+escHtml(e.message)+'</div>';
    jsonResetInteractiveState();
  }
}
function jsonMinify() {
  try { document.getElementById('json-tree-output').innerHTML = '<span class="jt-str">'+escHtml(JSON.stringify(JSON.parse(document.getElementById('json-input').value)))+'</span>'; jsonResetInteractiveState(); }
  catch(e) { document.getElementById('json-tree-output').innerHTML = '<div class="jt-error">'+escHtml(e.message)+'</div>'; jsonResetInteractiveState(); }
}
// JSON path segment, jQuery/jsonpath-style: $.orders[0].customer.name (bracket form for keys that aren't bare identifiers)
function jsonPathSegment(path, key) {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return path + '.' + key;
  return path + '["' + key.replace(/\\/g,'\\\\').replace(/"/g,'\\"') + '"]';
}
function renderJsonTree(val, depth, path) {
  path = path === undefined ? '$' : path;
  const i = '  '.repeat(depth), ni = '  '.repeat(depth+1);
  const pAttr = ' data-path="'+escHtml(path)+'"';
  if (val===null) return '<span class="jt-null"'+pAttr+'>null</span>';
  if (typeof val==='boolean') return '<span class="jt-bool"'+pAttr+'>'+val+'</span>';
  if (typeof val==='number') return '<span class="jt-num"'+pAttr+'>'+val+'</span>';
  if (typeof val==='string') return '<span class="jt-str"'+pAttr+'>"'+escHtml(val)+'"</span>';
  if (Array.isArray(val)) {
    if (!val.length) return '<span class="jt-null"'+pAttr+'>[]</span>';
    const id='jtn'+Math.random().toString(36).slice(2);
    return '<span class="jt-node"'+pAttr+'><span class="jt-collapse" data-target="'+id+'">▼</span>[' +
      '<span id="'+id+'-placeholder" class="jt-placeholder" style="display:none">... ]</span>' +
      '<span id="'+id+'" class="jt-children">\n' +
      val.map((v,idx)=>ni+renderJsonTree(v,depth+1,path+'['+idx+']')+(idx<val.length-1?',':'')).join('\n') +
      '\n' + i + ']</span></span>';
  }
  if (typeof val==='object') {
    const keys=Object.keys(val); if (!keys.length) return '<span class="jt-null"'+pAttr+'>{}</span>';
    const id='jtn'+Math.random().toString(36).slice(2);
    return '<span class="jt-node"'+pAttr+'><span class="jt-collapse" data-target="'+id+'">▼</span>{' +
      '<span id="'+id+'-placeholder" class="jt-placeholder" style="display:none">... }</span>' +
      '<span id="'+id+'" class="jt-children">\n' +
      keys.map((k,idx)=>{
        const childPath = jsonPathSegment(path, k);
        return ni+'<span class="jt-key" data-path="'+escHtml(childPath)+'">"'+escHtml(k)+'"</span>: '+renderJsonTree(val[k],depth+1,childPath)+(idx<keys.length-1?',':'');
      }).join('\n') +
      '\n' + i + '}</span></span>';
  }
  return String(val);
}
function addJsonToggleListeners() {
  document.querySelectorAll('.jt-collapse').forEach(el => {
    el.onclick = function() {
      const targetId = this.dataset.target;
      const t = document.getElementById(targetId);
      const p = document.getElementById(targetId + '-placeholder');
      if (t) {
        const isCollapsed = t.style.display === 'none';
        t.style.display = isCollapsed ? '' : 'none';
        if (p) p.style.display = isCollapsed ? 'none' : 'inline';
        this.textContent = isCollapsed ? '▼' : '▶';
      }
    };
  });
}
function jsonCopyOutput() {
  try {
    const raw = document.getElementById('json-input').value.trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      copyToClipboard(JSON.stringify(parsed, null, 2));
      return;
    }
  } catch(e) {}
  copyToClipboard(document.getElementById('json-tree-output').innerText);
}
function jsonExpandAll() {
  document.querySelectorAll('.jt-children').forEach(e => {
    e.style.display = '';
    const p = document.getElementById(e.id + '-placeholder');
    if (p) p.style.display = 'none';
  });
  document.querySelectorAll('.jt-collapse').forEach(e => {
    e.textContent = '▼';
  });
}
function jsonCollapseAll() {
  document.querySelectorAll('.jt-children').forEach((e, i) => {
    if (i > 0) {
      e.style.display = 'none';
      const p = document.getElementById(e.id + '-placeholder');
      if (p) p.style.display = 'inline';
    }
  });
  document.querySelectorAll('.jt-collapse').forEach((e, i) => {
    if (i > 0) {
      e.textContent = '▶';
    }
  });
}

// --- Breadcrumb (11.1): click any node to see its JSON path ---
function jsonTreeClick(e) {
  const el = e.target.closest('[data-path]');
  const bc = document.getElementById('json-breadcrumb');
  if (!el || !bc) return;
  bc.textContent = el.getAttribute('data-path');
  bc.style.display = '';
}

// --- Find in JSON (11.1) ---
function jsonBuildPathIndex() {
  jsonPathElements = new Map();
  document.querySelectorAll('#json-tree-output [data-path]').forEach(el => {
    const p = el.getAttribute('data-path');
    if (!jsonPathElements.has(p)) jsonPathElements.set(p, []);
    jsonPathElements.get(p).push(el);
  });
}
// Pure: collects every path whose key name or leaf value contains `query` (case-insensitive). No DOM.
function jsonFindMatches(val, query, path) {
  path = path === undefined ? '$' : path;
  const q = String(query).toLowerCase();
  if (!q) return [];
  let results = [];
  if (Array.isArray(val)) {
    val.forEach((v, idx) => { results = results.concat(jsonFindMatches(v, query, path+'['+idx+']')); });
  } else if (val !== null && typeof val === 'object') {
    Object.keys(val).forEach(k => {
      const childPath = jsonPathSegment(path, k);
      if (k.toLowerCase().indexOf(q) !== -1) results.push(childPath);
      results = results.concat(jsonFindMatches(val[k], query, childPath));
    });
  } else {
    const s = val === null ? 'null' : String(val);
    if (s.toLowerCase().indexOf(q) !== -1) results.push(path);
  }
  return results;
}
function jsonExpandAncestors(el) {
  let node = el.parentElement;
  while (node && node.id !== 'json-tree-output') {
    if (node.classList && node.classList.contains('jt-children') && node.style.display === 'none') {
      node.style.display = '';
      const p = document.getElementById(node.id + '-placeholder');
      if (p) p.style.display = 'none';
      const toggle = document.querySelector('.jt-collapse[data-target="'+node.id+'"]');
      if (toggle) toggle.textContent = '▼';
    }
    node = node.parentElement;
  }
}
function jsonFind() {
  const input = document.getElementById('json-find-input');
  const q = input ? input.value.trim() : '';
  document.querySelectorAll('#json-tree-output .jt-find-match').forEach(el => el.classList.remove('jt-find-match','jt-find-current'));
  jsonFindResults = [];
  jsonFindIndex = -1;
  const countEl = document.getElementById('json-find-count');
  if (!q || !jsonLastParsed) { if (countEl) countEl.textContent = ''; return; }
  jsonFindResults = Array.from(new Set(jsonFindMatches(jsonLastParsed, q)));
  jsonFindResults.forEach(p => { (jsonPathElements.get(p) || []).forEach(el => el.classList.add('jt-find-match')); });
  if (!jsonFindResults.length) { if (countEl) countEl.textContent = 'No matches'; return; }
  jsonFindNav(1);
}
function jsonFindNav(delta) {
  if (!jsonFindResults.length) return;
  if (jsonFindIndex >= 0) {
    (jsonPathElements.get(jsonFindResults[jsonFindIndex]) || []).forEach(el => el.classList.remove('jt-find-current'));
  }
  jsonFindIndex = (jsonFindIndex + delta + jsonFindResults.length) % jsonFindResults.length;
  const els = jsonPathElements.get(jsonFindResults[jsonFindIndex]) || [];
  els.forEach(el => el.classList.add('jt-find-current'));
  if (els[0]) { jsonExpandAncestors(els[0]); els[0].scrollIntoView({block:'center'}); }
  const countEl = document.getElementById('json-find-count');
  if (countEl) countEl.textContent = (jsonFindIndex+1) + '/' + jsonFindResults.length;
}

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.jsonFormat = jsonFormat;
window.jsonMinify = jsonMinify;
window.renderJsonTree = renderJsonTree;
window.jsonPathSegment = jsonPathSegment;
window.jsonFindMatches = jsonFindMatches;
window.addJsonToggleListeners = addJsonToggleListeners;
window.jsonCopyOutput = jsonCopyOutput;
window.jsonExpandAll = jsonExpandAll;
window.jsonCollapseAll = jsonCollapseAll;
window.jsonFind = jsonFind;
window.jsonFindNav = jsonFindNav;

export function init() {
  const pane = document.getElementById('json-output-pane');
  if (pane) pane.onclick = jsonTreeClick;
}
