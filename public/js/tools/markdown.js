// MARKDOWN PREVIEW
// ============================================================
function mdRender(){document.getElementById('md-preview-output').innerHTML=parseMarkdown(document.getElementById('md-input').value);}

const MD_DROP_EXT = /\.(md|markdown|mdown|mkd|mdx|txt)$/i;

// Dropping a binary (an image, a .docx) would fill the editor with mojibake, so only
// text-ish files are read. Some browsers report no MIME type for .md, hence the extension check.
function mdHandleDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  if (!MD_DROP_EXT.test(file.name) && !(file.type || '').startsWith('text/')) {
    alert('Not a Markdown file: ' + file.name + '\nDrop a .md, .markdown, .mdx or .txt file.');
    return;
  }
  const reader = new FileReader();
  reader.onload = evt => {
    document.getElementById('md-input').value = evt.target.result;
    mdRender();
  };
  reader.onerror = () => alert('Could not read file: ' + file.name);
  reader.readAsText(file);
}
function mdExport(){const html='<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.7}pre{background:#f6f8fa;padding:16px;border-radius:8px;overflow:auto}code{background:#f6f8fa;padding:2px 6px;border-radius:4px;font-family:monospace}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d7de;padding:8px 12px}blockquote{border-left:4px solid #0969da;padding-left:16px;color:#636c76;margin-left:0}</style></head><body>'+document.getElementById('md-preview-output').innerHTML+'</body></html>';downloadText(html,'document.html');}
function parseMarkdown(md){
  if(!md)return'';
  let h=escHtml(md);
  h=h.replace(/```[\w]*\n?([\s\S]*?)```/g,(_,c)=>'<pre><code>'+c.trim()+'</code></pre>');
  h=h.replace(/^###### (.+)$/gm,'<h6>$1</h6>').replace(/^##### (.+)$/gm,'<h5>$1</h5>').replace(/^#### (.+)$/gm,'<h4>$1</h4>').replace(/^### (.+)$/gm,'<h3>$1</h3>').replace(/^## (.+)$/gm,'<h2>$1</h2>').replace(/^# (.+)$/gm,'<h1>$1</h1>');
  h=h.replace(/^---$/gm,'<hr>');
  h=h.replace(/\*\*\*(.+?)\*\*\*/g,'<strong><em>$1</em></strong>').replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>').replace(/__(.+?)__/g,'<strong>$1</strong>').replace(/_(.+?)_/g,'<em>$1</em>');
  h=h.replace(/`(.+?)`/g,'<code>$1</code>');
  h=h.replace(/!\[([^\]]*)\]\(([^)]+)\)/g,'<img src="$2" alt="$1">').replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank">$1</a>');
  h=h.replace(/^&gt; (.+)$/gm,'<blockquote>$1</blockquote>');
  h=h.replace(/^(\s*)[*-] (.+)$/gm,'<li>$2</li>').replace(/(<li>.*<\/li>\n?)+/g,m=>'<ul>'+m+'</ul>');
  h=h.replace(/^\d+\. (.+)$/gm,'<li>$1</li>');
  h=h.replace(/\|(.+)\|\n\|[-| :]+\|\n((?:\|.+\|\n?)+)/g,(_,header,body)=>{const ths=header.split('|').filter(s=>s.trim()).map(s=>'<th>'+s.trim()+'</th>').join('');const rows=body.trim().split('\n').map(row=>'<tr>'+row.split('|').filter(s=>s.trim()).map(s=>'<td>'+s.trim()+'</td>').join('')+'</tr>').join('');return '<table><thead><tr>'+ths+'</tr></thead><tbody>'+rows+'</tbody></table>';});
  h=h.replace(/\n\n(?!<)/g,'</p><p>');
  if(!h.startsWith('<'))h='<p>'+h;
  if(!h.endsWith('>'))h=h+'</p>';
  return h.replace(/<p><\/p>/g,'');
}

// ============================================================
// MARKDOWN TABLE GENERATOR
// ============================================================
let mdTableData = [
  ['Header 1', 'Header 2', 'Header 3'],
  ['Data', 'Data', 'Data'],
  ['Data', 'Data', 'Data']
];
let mdTableAlign = ['left', 'left', 'left'];
const MD_ALIGN_ICONS = { left: '⇤', center: '↔', right: '⇥' };

function mdSetTab(tabId, el) {
  document.querySelectorAll('#panel-md-preview .tabs .tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
  if (el) { el.classList.add('active'); el.setAttribute('aria-selected', 'true'); }
  
  const editorTab = document.getElementById('md-tab-editor');
  const tableTab = document.getElementById('md-tab-table');
  const editorActions = document.getElementById('md-editor-actions');
  const tableActions = document.getElementById('md-table-actions');

  if (tabId === 'editor') {
    editorTab.style.display = 'flex';
    tableTab.style.display = 'none';
    editorActions.style.display = '';
    tableActions.style.display = 'none';
  } else {
    editorTab.style.display = 'none';
    tableTab.style.display = 'flex';
    editorActions.style.display = 'none';
    tableActions.style.display = '';
    mdTableRender();
  }
}

function mdTableAddRow() {
  mdTableGrowRow();
  mdTableRender();
}

function mdTableAddCol() {
  mdTableGrowCol();
  mdTableRender();
}

// Grow-only helpers: a bulk paste expands the table many times, so it renders once at the end
function mdTableGrowRow() {
  mdTableData.push(new Array(mdTableData[0].length).fill(''));
}

function mdTableGrowCol() {
  mdTableData.forEach((row, i) => {
    row.push(i === 0 ? 'New Header' : '');
  });
  mdTableAlign.push('left');
}

// Excel and Google Sheets put tab-separated text on the clipboard; a CSV file gives
// commas (or semicolons in a locale that uses the comma as a decimal separator).
function mdTableDetectDelimiter(text) {
  if (text.includes('\t')) return '\t';
  const unquoted = text.replace(/"(?:[^"]|"")*"/g, '');
  const semicolons = (unquoted.match(/;/g) || []).length;
  const commas = (unquoted.match(/,/g) || []).length;
  if (semicolons > 0 && semicolons >= commas) return ';';
  if (commas > 0) return ',';
  return null;
}

// RFC4180-style scan: quoted fields may contain the delimiter, newlines and "" escapes
function mdTableParseClipboard(text) {
  const norm = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const delim = mdTableDetectDelimiter(norm);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (norm[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (delim && ch === delim) {
      row.push(field.trim());
      field = '';
    } else if (ch === '\n') {
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  row.push(field.trim());
  rows.push(row);
  return rows;
}

// Writes clipboard content into the grid starting at the given cell, growing the table to fit
function mdTableImport(text, rIndex, cIndex) {
  const rows = mdTableParseClipboard(text);
  if (!rows.length) return;
  const maxCols = Math.max(...rows.map(r => r.length));

  while (mdTableData.length < rIndex + rows.length) mdTableGrowRow();
  while (mdTableData[0].length < cIndex + maxCols) mdTableGrowCol();

  rows.forEach((cells, i) => {
    cells.forEach((val, j) => {
      mdTableData[rIndex + i][cIndex + j] = val;
    });
  });
  mdTableRender();
}

// Paste with no caret in a cell (the common case: switch to the tab, hit Ctrl+V) lands at the top-left.
// Pastes inside the grid are handled by the cell's own handler, which honours the caret position.
function mdTableInitPaste() {
  if (window.__mdTablePasteBound) return;
  window.__mdTablePasteBound = true;

  document.addEventListener('paste', (e) => {
    const panel = document.getElementById('panel-md-preview');
    const tableTab = document.getElementById('md-tab-table');
    if (!panel || !panel.classList.contains('active')) return;
    if (!tableTab || tableTab.style.display === 'none') return;

    const target = e.target;
    if (target && target.closest && target.closest('#md-table-grid')) return;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!text || !text.trim()) return;
    e.preventDefault();
    mdTableImport(text, 0, 0);
  });
}

function mdTableReset() {
  mdTableData = [
    ['Header 1', 'Header 2', 'Header 3'],
    ['Data', 'Data', 'Data'],
    ['Data', 'Data', 'Data']
  ];
  mdTableAlign = ['left', 'left', 'left'];
  mdTableRender();
}

function mdTableToggleAlign(colIndex) {
  const current = mdTableAlign[colIndex];
  const next = current === 'left' ? 'center' : (current === 'center' ? 'right' : 'left');
  mdTableAlign[colIndex] = next;
  // Restyle in place instead of re-rendering, so an in-progress edit keeps its caret
  mdTableApplyAlign(colIndex);
  mdTableGenerateMarkdown();
}

function mdTableApplyAlign(colIndex) {
  const grid = document.getElementById('md-table-grid');
  if (!grid) return;
  const align = mdTableAlign[colIndex];
  grid.querySelectorAll('tr').forEach(tr => {
    const cell = tr.children[colIndex];
    if (cell) cell.style.textAlign = align;
  });
  const btn = grid.querySelector('.md-th-align[data-col="' + colIndex + '"]');
  if (btn) {
    btn.textContent = MD_ALIGN_ICONS[align];
    btn.title = 'Align: ' + align + ' – click to change';
  }
}

function mdTableUpdateCell(r, c, val) {
  mdTableData[r][c] = val;
  mdTableGenerateMarkdown();
}

function mdTableRender() {
  const tbody = document.createElement('tbody');
  
  mdTableData.forEach((row, rIndex) => {
    const tr = document.createElement('tr');
    row.forEach((cell, cIndex) => {
      const isHeader = rIndex === 0;
      const td = document.createElement(isHeader ? 'th' : 'td');
      td.style.border = '1px solid var(--border)';
      td.style.padding = '8px';
      td.style.textAlign = mdTableAlign[cIndex];

      // Header text lives in its own editable span so the alignment icon next to it
      // stays out of the cell's text content
      let editable = td;
      if (isHeader) {
        td.style.background = 'var(--bg-elevated)';
        td.style.position = 'relative';
        td.style.paddingRight = '28px';

        const label = document.createElement('span');
        label.contentEditable = true;
        label.textContent = cell;
        label.style.outline = 'none';
        label.style.display = 'inline-block';
        label.style.minWidth = '1ch';
        td.appendChild(label);

        const alignBtn = document.createElement('span');
        alignBtn.className = 'md-th-align';
        alignBtn.contentEditable = false;
        alignBtn.dataset.col = cIndex;
        alignBtn.textContent = MD_ALIGN_ICONS[mdTableAlign[cIndex]];
        alignBtn.title = 'Align: ' + mdTableAlign[cIndex] + ' – click to change';
        alignBtn.style.cssText = 'position:absolute;right:4px;top:50%;transform:translateY(-50%);' +
          'cursor:pointer;opacity:0.55;padding:0 3px;user-select:none;font-weight:400';
        alignBtn.onclick = () => mdTableToggleAlign(cIndex);
        td.appendChild(alignBtn);

        // Clicking the cell's padding should land in the text, not do nothing
        td.onclick = (e) => { if (e.target === td) label.focus(); };

        editable = label;
      } else {
        td.contentEditable = true;
        td.textContent = cell;
      }

      editable.oninput = (e) => mdTableUpdateCell(rIndex, cIndex, e.target.textContent);

      editable.onkeydown = (e) => {
        if (e.key === 'Tab') {
          // Normal tab navigation is fine
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (rIndex < mdTableData.length - 1) {
            tr.nextElementSibling.children[cIndex].focus();
          } else {
            mdTableAddRow();
            setTimeout(() => {
               document.getElementById('md-table-grid').lastChild.lastChild.children[cIndex].focus();
            }, 10);
          }
        }
      };

      editable.onpaste = (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text');
        // Multi-cell content spreads across the grid from here; a plain value stays literal,
        // so text that merely contains a comma is not torn into columns
        if (/[\t\r\n]/.test(text)) {
          mdTableImport(text, rIndex, cIndex);
        } else {
          document.execCommand('insertText', false, text);
        }
      };

      tr.appendChild(td);
    });
    
    // Add delete row button
    const delTd = document.createElement('td');
    delTd.style.width = '30px';
    delTd.style.textAlign = 'center';
    delTd.style.border = 'none';
    delTd.innerHTML = '<span style="cursor:pointer;color:var(--danger);font-weight:bold">&times;</span>';
    delTd.onclick = () => {
      if (mdTableData.length > 1) {
        mdTableData.splice(rIndex, 1);
        mdTableRender();
      }
    };
    tr.appendChild(delTd);
    
    tbody.appendChild(tr);
  });
  
  const grid = document.getElementById('md-table-grid');
  grid.innerHTML = '';
  grid.appendChild(tbody);
  
  mdTableGenerateMarkdown();
}

function mdTableGenerateMarkdown() {
  if (mdTableData.length === 0) return;
  
  // Find max length of each column for padding
  const colLengths = mdTableData[0].map((_, c) => {
    let max = mdTableAlign[c] === 'center' ? 3 : (mdTableAlign[c] === 'right' ? 4 : 3);
    mdTableData.forEach(row => {
      if (row[c] && row[c].length > max) max = row[c].length;
    });
    return max;
  });

  let md = '';
  
  mdTableData.forEach((row, r) => {
    let line = '|';
    row.forEach((cell, c) => {
      const padLen = colLengths[c];
      const val = (cell || '').padEnd(padLen, ' ');
      line += ' ' + val + ' |';
    });
    md += line + '\n';
    
    // Divider row
    if (r === 0) {
      let divLine = '|';
      mdTableAlign.forEach((align, c) => {
        const padLen = colLengths[c];
        let dashes = '-'.repeat(padLen);
        if (align === 'center') dashes = ':' + '-'.repeat(padLen - 2) + ':';
        else if (align === 'right') dashes = '-'.repeat(padLen - 1) + ':';
        divLine += ' ' + dashes + ' |';
      });
      md += divLine + '\n';
    }
  });
  
  document.getElementById('md-table-preview-md').value = md;
}

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.mdRender = mdRender;
window.mdHandleDrop = mdHandleDrop;
window.mdExport = mdExport;
window.parseMarkdown = parseMarkdown;
window.mdSetTab = mdSetTab;
window.mdTableAddRow = mdTableAddRow;
window.mdTableAddCol = mdTableAddCol;
window.mdTableReset = mdTableReset;
window.mdTableToggleAlign = mdTableToggleAlign;
window.mdTableUpdateCell = mdTableUpdateCell;
window.mdTableRender = mdTableRender;
window.mdTableGenerateMarkdown = mdTableGenerateMarkdown;

export function init() {
  mdTableInitPaste();
}
