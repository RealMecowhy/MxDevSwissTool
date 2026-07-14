// XML FORMATTER
// ============================================================
function xmlFormat() {
  const raw = document.getElementById('xml-input').value.trim();
  if (!raw) {
    document.getElementById('xml-tree-output').innerHTML = '<span style="color:var(--text-muted)">Output will appear here...</span>';
    document.getElementById('xml-status').innerHTML = '';
    return;
  }
  try {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(raw, "application/xml");
    const parserError = xmlDoc.getElementsByTagName("parsererror");
    if (parserError.length > 0) {
      throw new Error(parserError[0].textContent);
    }
    document.getElementById('xml-status').innerHTML = '<span class="badge badge-success">&#10003; Valid XML</span>';
    const roots = Array.from(xmlDoc.childNodes).filter(c => {
      if (c.nodeType === 3 && !c.nodeValue.trim()) return false;
      return true;
    });
    document.getElementById('xml-tree-output').innerHTML = roots.map(r => renderXmlTree(r, 0)).join('\n');
    addXmlToggleListeners();
  } catch(e) {
    document.getElementById('xml-status').innerHTML = '<span class="badge badge-error">&#10007; Invalid</span>';
    document.getElementById('xml-tree-output').innerHTML = '<div class="jt-error">Parse error: ' + escHtml(e.message) + '</div>';
  }
}

function xmlMinify() {
  try {
    const raw = document.getElementById('xml-input').value.trim();
    if (!raw) return;
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(raw, "application/xml");
    const parserError = xmlDoc.getElementsByTagName("parsererror");
    if (parserError.length > 0) {
      throw new Error(parserError[0].textContent);
    }
    const minifyNode = (node) => {
      if (node.nodeType === 3) return node.nodeValue.trim();
      if (node.nodeType === 4) return '<![CDATA[' + node.nodeValue + ']]>';
      if (node.nodeType === 8) return '<!--' + node.nodeValue + '-->';
      if (node.nodeType === 7) return '<?' + node.nodeName + ' ' + node.nodeValue + '?>';
      if (node.nodeType === 1) {
        const name = node.nodeName;
        let attrs = '';
        for (let j = 0; j < node.attributes.length; j++) {
          const attr = node.attributes[j];
          attrs += ' ' + attr.name + '="' + attr.value + '"';
        }
        const childrenStr = Array.from(node.childNodes).map(minifyNode).join('');
        if (!childrenStr) return '<' + name + attrs + ' />';
        return '<' + name + attrs + '>' + childrenStr + '</' + name + '>';
      }
      if (node.nodeType === 9) return Array.from(node.childNodes).map(minifyNode).join('');
      return '';
    };
    document.getElementById('xml-tree-output').innerHTML = '<span class="jt-str">' + escHtml(minifyNode(xmlDoc)) + '</span>';
  } catch(e) {
    document.getElementById('xml-tree-output').innerHTML = '<div class="jt-error">Parse error: ' + escHtml(e.message) + '</div>';
  }
}

function renderXmlTree(node, depth) {
  const i = '  '.repeat(depth), ni = '  '.repeat(depth+1);
  const brO = '<span class="xml-bracket">&lt;</span>';
  const brC = '<span class="xml-bracket">&gt;</span>';
  const brS = '<span class="xml-bracket">/&gt;</span>';
  const brE = '<span class="xml-bracket">&lt;/</span>';
  
  if (node.nodeType === 3) {
    const text = node.nodeValue.trim();
    if (!text) return '';
    const l = text.toLowerCase();
    if (!isNaN(Number(text))) return '<span class="jt-num">' + escHtml(text) + '</span>';
    if (l === 'true' || l === 'false') return '<span class="jt-bool">' + escHtml(text) + '</span>';
    return '<span class="jt-str">' + escHtml(text) + '</span>';
  }
  if (node.nodeType === 4) {
    return '<span class="xml-cdata">' + brO + '![CDATA[' + escHtml(node.nodeValue) + ']]' + brC + '</span>';
  }
  if (node.nodeType === 8) {
    return '<span class="xml-comment">' + brO + '!--' + escHtml(node.nodeValue) + '--' + brC + '</span>';
  }
  if (node.nodeType === 7) {
    return '<span class="xml-cdata">' + brO + '?' + escHtml(node.nodeName + ' ' + node.nodeValue) + '?' + brC + '</span>';
  }
  if (node.nodeType === 1) {
    const name = node.nodeName;
    let attrs = '';
    for (let j = 0; j < node.attributes.length; j++) {
      const attr = node.attributes[j];
      attrs += ' <span class="xml-attr-name">' + escHtml(attr.name) + '</span>=<span class="xml-attr-val">"' + escHtml(attr.value) + '"</span>';
    }
    const children = Array.from(node.childNodes).filter(c => {
      if (c.nodeType === 3 && !c.nodeValue.trim()) return false;
      return true;
    });
    if (children.length === 0) {
      return brO + '<span class="xml-tag">' + name + '</span>' + attrs + ' ' + brS;
    }
    if (children.length === 1 && children[0].nodeType === 3) {
      const text = children[0].nodeValue.trim();
      let textHtml = '';
      if (text) {
        const l = text.toLowerCase();
        if (!isNaN(Number(text))) textHtml = '<span class="jt-num">' + escHtml(text) + '</span>';
        else if (l === 'true' || l === 'false') textHtml = '<span class="jt-bool">' + escHtml(text) + '</span>';
        else textHtml = '<span class="jt-str">' + escHtml(text) + '</span>';
      }
      return brO + '<span class="xml-tag">' + name + '</span>' + attrs + brC + textHtml + brE + '<span class="xml-tag">' + name + '</span>' + brC;
    }
    const id = 'xmln' + Math.random().toString(36).slice(2);
    const openingTag = brO + '<span class="xml-tag">' + name + '</span>' + attrs + brC;
    const closingTag = brE + '<span class="xml-tag">' + name + '</span>' + brC;
    return '<span class="jt-collapse" data-target="' + id + '">▼</span>' + openingTag +
      '<span id="' + id + '-placeholder" class="jt-placeholder" style="display:none">... ' + closingTag + '</span>' +
      '<span id="' + id + '" class="jt-children">\n' +
      children.map(c => ni + renderXmlTree(c, depth + 1)).filter(s => s.trim() !== '').join('\n') +
      '\n' + i + closingTag + '</span>';
  }
  return '';
}

function serializeXmlPretty(node, depth) {
  const i = '  '.repeat(depth), ni = '  '.repeat(depth+1);
  if (node.nodeType === 3) {
    const text = node.nodeValue.trim();
    return text ? text : '';
  }
  if (node.nodeType === 4) return '<![CDATA[' + node.nodeValue + ']]>';
  if (node.nodeType === 8) return '<!--' + node.nodeValue + '-->';
  if (node.nodeType === 7) return '<?' + node.nodeName + ' ' + node.nodeValue + '?>';
  if (node.nodeType === 1) {
    const name = node.nodeName;
    let attrs = '';
    for (let j = 0; j < node.attributes.length; j++) {
      const attr = node.attributes[j];
      attrs += ' ' + attr.name + '="' + attr.value + '"';
    }
    const children = Array.from(node.childNodes).filter(c => {
      if (c.nodeType === 3 && !c.nodeValue.trim()) return false;
      return true;
    });
    if (children.length === 0) return '<' + name + attrs + ' />';
    if (children.length === 1 && children[0].nodeType === 3) {
      return '<' + name + attrs + '>' + children[0].nodeValue.trim() + '</' + name + '>';
    }
    return '<' + name + attrs + '>\n' +
      children.map(c => ni + serializeXmlPretty(c, depth + 1)).filter(s => s.trim() !== '').join('\n') +
      '\n' + i + '</' + name + '>';
  }
  if (node.nodeType === 9) {
    return Array.from(node.childNodes).map(c => serializeXmlPretty(c, 0)).filter(s => s.trim() !== '').join('\n');
  }
  return '';
}

function addXmlToggleListeners() {
  document.querySelectorAll('#xml-tree-output .jt-collapse').forEach(el => {
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

function xmlCopyOutput() {
  try {
    const raw = document.getElementById('xml-input').value.trim();
    if (raw) {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(raw, "application/xml");
      const parserError = xmlDoc.getElementsByTagName("parsererror");
      if (parserError.length === 0) {
        copyToClipboard(serializeXmlPretty(xmlDoc, 0));
        return;
      }
    }
  } catch(e) {}
  copyToClipboard(document.getElementById('xml-tree-output').innerText);
}

function xmlExpandAll() {
  document.querySelectorAll('#xml-tree-output .jt-children').forEach(e => {
    e.style.display = '';
    const p = document.getElementById(e.id + '-placeholder');
    if (p) p.style.display = 'none';
  });
  document.querySelectorAll('#xml-tree-output .jt-collapse').forEach(e => {
    e.textContent = '▼';
  });
}

function xmlCollapseAll() {
  document.querySelectorAll('#xml-tree-output .jt-children').forEach((e, i) => {
    if (i > 0) {
      e.style.display = 'none';
      const p = document.getElementById(e.id + '-placeholder');
      if (p) p.style.display = 'inline';
    }
  });
  document.querySelectorAll('#xml-tree-output .jt-collapse').forEach((e, i) => {
    if (i > 0) {
      e.textContent = '▶';
    }
  });
}

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.xmlFormat = xmlFormat;
window.xmlMinify = xmlMinify;
window.renderXmlTree = renderXmlTree;
window.serializeXmlPretty = serializeXmlPretty;
window.addXmlToggleListeners = addXmlToggleListeners;
window.xmlCopyOutput = xmlCopyOutput;
window.xmlExpandAll = xmlExpandAll;
window.xmlCollapseAll = xmlCollapseAll;

export function init() {}
