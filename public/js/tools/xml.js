// XML FORMATTER
// ============================================================
let xmlLastDoc = null;
let xmlNodeIdMap = new WeakMap();
let xmlIdCounter = 0;
let xmlHideNamespaces = false;
let xmlXPathResults = [];
let xmlXPathIndex = -1;

function xmlResetInteractiveState() {
  xmlLastDoc = null;
  xmlNodeIdMap = new WeakMap();
  xmlIdCounter = 0;
  xmlXPathResults = [];
  xmlXPathIndex = -1;
  const countEl = document.getElementById('xml-xpath-count');
  if (countEl) countEl.textContent = '';
  // Nothing rendered means nothing to query — the XPath bar used to offer a
  // search over output that did not exist yet.
  const bar = document.getElementById('xml-find-bar');
  if (bar) bar.style.display = 'none';
}

function xmlFormat() {
  const raw = document.getElementById('xml-input').value.trim();
  if (!raw) {
    document.getElementById('xml-tree-output').innerHTML = '<div class="empty-output">Output will appear here…</div>';
    document.getElementById('xml-status').innerHTML = '';
    xmlResetInteractiveState();
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
    xmlLastDoc = xmlDoc;
    xmlNodeIdMap = new WeakMap();
    xmlIdCounter = 0;
    document.getElementById('xml-tree-output').innerHTML = roots.map(r => renderXmlTree(r, 0)).join('\n');
    addXmlToggleListeners();
    const xfBar = document.getElementById('xml-find-bar');
    if (xfBar) xfBar.style.display = '';
    const xpathInput = document.getElementById('xml-xpath-input');
    if (xpathInput && xpathInput.value.trim()) xmlXPathEval();
  } catch(e) {
    document.getElementById('xml-status').innerHTML = '<span class="badge badge-error">&#10007; Invalid</span>';
    document.getElementById('xml-tree-output').innerHTML = '<div class="jt-error">Parse error: ' + escHtml(e.message) + '</div>';
    xmlResetInteractiveState();
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
    const xid = 'xid' + (xmlIdCounter++);
    xmlNodeIdMap.set(node, xid);
    const name = xmlDisplayName(node.nodeName);
    let attrs = '';
    for (let j = 0; j < node.attributes.length; j++) {
      const attr = node.attributes[j];
      if (xmlHideNamespaces && (attr.name === 'xmlns' || attr.name.indexOf('xmlns:') === 0)) continue;
      attrs += ' <span class="xml-attr-name">' + escHtml(xmlDisplayName(attr.name)) + '</span>=<span class="xml-attr-val">"' + escHtml(attr.value) + '"</span>';
    }
    const children = Array.from(node.childNodes).filter(c => {
      if (c.nodeType === 3 && !c.nodeValue.trim()) return false;
      return true;
    });
    let inner;
    if (children.length === 0) {
      inner = brO + '<span class="xml-tag">' + name + '</span>' + attrs + ' ' + brS;
    } else if (children.length === 1 && children[0].nodeType === 3) {
      const text = children[0].nodeValue.trim();
      let textHtml = '';
      if (text) {
        const l = text.toLowerCase();
        if (!isNaN(Number(text))) textHtml = '<span class="jt-num">' + escHtml(text) + '</span>';
        else if (l === 'true' || l === 'false') textHtml = '<span class="jt-bool">' + escHtml(text) + '</span>';
        else textHtml = '<span class="jt-str">' + escHtml(text) + '</span>';
      }
      inner = brO + '<span class="xml-tag">' + name + '</span>' + attrs + brC + textHtml + brE + '<span class="xml-tag">' + name + '</span>' + brC;
    } else {
      const id = 'xmln' + Math.random().toString(36).slice(2);
      // `data-g` links the opening tag name to its matching closing tag name
      // (and the collapsed-placeholder copy) so hovering one highlights the
      // pair — same fvBindMatch/.ft-hi mechanism as the text formatters.
      const tagName = '<span class="xml-tag" data-g="' + id + '">' + name + '</span>';
      const openingTag = brO + tagName + attrs + brC;
      const closingTag = brE + tagName + brC;
      inner = '<span class="jt-collapse" data-target="' + id + '">▼</span>' + openingTag +
        '<span id="' + id + '-placeholder" class="jt-placeholder" style="display:none">... ' + closingTag + '</span>' +
        '<span id="' + id + '" class="jt-children">\n' +
        children.map(c => ni + renderXmlTree(c, depth + 1)).filter(s => s.trim() !== '').join('\n') +
        '\n' + i + closingTag + '</span>';
    }
    return '<span class="xml-node" data-xid="' + xid + '">' + inner + '</span>';
  }
  return '';
}
function xmlDisplayName(name, hide) {
  const h = hide === undefined ? xmlHideNamespaces : hide;
  if (!h) return name;
  const idx = name.indexOf(':');
  return idx === -1 ? name : name.slice(idx + 1);
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

// --- XPath evaluator (11.2): native document.evaluate, zero dependencies ---
function xmlExpandAncestors(el) {
  let node = el.parentElement;
  while (node && node.id !== 'xml-tree-output') {
    if (node.classList && node.classList.contains('jt-children') && node.style.display === 'none') {
      node.style.display = '';
      const p = document.getElementById(node.id + '-placeholder');
      if (p) p.style.display = 'none';
      const toggle = document.querySelector('.jt-collapse[data-target="' + node.id + '"]');
      if (toggle) toggle.textContent = '▼';
    }
    node = node.parentElement;
  }
}
function xmlXPathEval() {
  const input = document.getElementById('xml-xpath-input');
  const q = input ? input.value.trim() : '';
  document.querySelectorAll('#xml-tree-output .jt-find-match').forEach(el => el.classList.remove('jt-find-match', 'jt-find-current'));
  xmlXPathResults = [];
  xmlXPathIndex = -1;
  const countEl = document.getElementById('xml-xpath-count');
  if (!q || !xmlLastDoc) { if (countEl) countEl.textContent = ''; return; }
  let result;
  try {
    result = xmlLastDoc.evaluate(q, xmlLastDoc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  } catch(e) {
    if (countEl) countEl.textContent = 'Invalid XPath';
    return;
  }
  const nodes = [];
  for (let i = 0; i < result.snapshotLength; i++) nodes.push(result.snapshotItem(i));
  // Only element nodes are rendered as their own tree node (data-xid) — attribute/text
  // matches are real matches too, just not individually highlightable in this tree view.
  xmlXPathResults = nodes.map(n => xmlNodeIdMap.get(n)).filter(id => id !== undefined);
  if (!xmlXPathResults.length) {
    if (countEl) countEl.textContent = nodes.length ? (nodes.length + ' match(es), not shown (not element nodes)') : 'No matches';
    return;
  }
  xmlXPathResults.forEach(xid => {
    const el = document.querySelector('#xml-tree-output .xml-node[data-xid="' + xid + '"]');
    if (el) el.classList.add('jt-find-match');
  });
  xmlXPathNav(1);
}
function xmlXPathNav(delta) {
  if (!xmlXPathResults.length) return;
  if (xmlXPathIndex >= 0) {
    const prevEl = document.querySelector('#xml-tree-output .xml-node[data-xid="' + xmlXPathResults[xmlXPathIndex] + '"]');
    if (prevEl) prevEl.classList.remove('jt-find-current');
  }
  xmlXPathIndex = (xmlXPathIndex + delta + xmlXPathResults.length) % xmlXPathResults.length;
  const el = document.querySelector('#xml-tree-output .xml-node[data-xid="' + xmlXPathResults[xmlXPathIndex] + '"]');
  if (el) { el.classList.add('jt-find-current'); xmlExpandAncestors(el); el.scrollIntoView({block:'center'}); }
  const countEl = document.getElementById('xml-xpath-count');
  if (countEl) countEl.textContent = (xmlXPathIndex + 1) + '/' + xmlXPathResults.length;
}
// --- Namespace prefix toggle (11.2) ---
function xmlToggleNamespaces() {
  const cb = document.getElementById('xml-hide-ns');
  xmlHideNamespaces = !!(cb && cb.checked);
  xmlFormat();
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
window.xmlXPathEval = xmlXPathEval;
window.xmlXPathNav = xmlXPathNav;
window.xmlToggleNamespaces = xmlToggleNamespaces;
window.xmlDisplayName = xmlDisplayName;

export function init() {
  // Hover-match each opening tag with its closing tag — delegated on the
  // (persistent) tree container, so it survives re-renders. Reuses fvBindMatch.
  const tree = document.getElementById('xml-tree-output');
  if (tree && typeof fvBindMatch === 'function') fvBindMatch(tree);
}
