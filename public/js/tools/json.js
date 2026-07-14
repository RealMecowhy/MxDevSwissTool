// JSON FORMATTER
// ============================================================
function jsonFormat() {
  const raw = document.getElementById('json-input').value.trim();
  if (!raw) { document.getElementById('json-tree-output').innerHTML = '<span style="color:var(--text-muted)">Output will appear here...</span>'; document.getElementById('json-status').innerHTML=''; return; }
  try {
    const parsed = JSON.parse(raw);
    document.getElementById('json-status').innerHTML = '<span class="badge badge-success">&#10003; Valid JSON</span>';
    document.getElementById('json-tree-output').innerHTML = renderJsonTree(parsed, 0);
    addJsonToggleListeners();
  } catch(e) {
    document.getElementById('json-status').innerHTML = '<span class="badge badge-error">&#10007; Invalid</span>';
    document.getElementById('json-tree-output').innerHTML = '<div class="jt-error">Parse error: '+escHtml(e.message)+'</div>';
  }
}
function jsonMinify() {
  try { document.getElementById('json-tree-output').innerHTML = '<span class="jt-str">'+escHtml(JSON.stringify(JSON.parse(document.getElementById('json-input').value)))+'</span>'; }
  catch(e) { document.getElementById('json-tree-output').innerHTML = '<div class="jt-error">'+escHtml(e.message)+'</div>'; }
}
function renderJsonTree(val, depth) {
  const i = '  '.repeat(depth), ni = '  '.repeat(depth+1);
  if (val===null) return '<span class="jt-null">null</span>';
  if (typeof val==='boolean') return '<span class="jt-bool">'+val+'</span>';
  if (typeof val==='number') return '<span class="jt-num">'+val+'</span>';
  if (typeof val==='string') return '<span class="jt-str">"'+escHtml(val)+'"</span>';
  if (Array.isArray(val)) {
    if (!val.length) return '<span class="jt-null">[]</span>';
    const id='jtn'+Math.random().toString(36).slice(2);
    return '<span class="jt-collapse" data-target="'+id+'">▼</span>[' +
      '<span id="'+id+'-placeholder" class="jt-placeholder" style="display:none">... ]</span>' +
      '<span id="'+id+'" class="jt-children">\n' +
      val.map((v,idx)=>ni+renderJsonTree(v,depth+1)+(idx<val.length-1?',':'')).join('\n') +
      '\n' + i + ']</span>';
  }
  if (typeof val==='object') {
    const keys=Object.keys(val); if (!keys.length) return '<span class="jt-null">{}</span>';
    const id='jtn'+Math.random().toString(36).slice(2);
    return '<span class="jt-collapse" data-target="'+id+'">▼</span>{' +
      '<span id="'+id+'-placeholder" class="jt-placeholder" style="display:none">... }</span>' +
      '<span id="'+id+'" class="jt-children">\n' +
      keys.map((k,idx)=>ni+'<span class="jt-key">"'+escHtml(k)+'"</span>: '+renderJsonTree(val[k],depth+1)+(idx<keys.length-1?',':'')).join('\n') +
      '\n' + i + '}</span>';
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

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.jsonFormat = jsonFormat;
window.jsonMinify = jsonMinify;
window.renderJsonTree = renderJsonTree;
window.addJsonToggleListeners = addJsonToggleListeners;
window.jsonCopyOutput = jsonCopyOutput;
window.jsonExpandAll = jsonExpandAll;
window.jsonCollapseAll = jsonCollapseAll;

export function init() {}
