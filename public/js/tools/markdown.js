// MARKDOWN PREVIEW
// ============================================================
function mdRender(){document.getElementById('md-preview-output').innerHTML=parseMarkdown(document.getElementById('md-input').value);}
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

function mdSetTab(tabId, el) {
  document.querySelectorAll('#panel-md-preview .tabs .tab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  
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
  const cols = mdTableData[0].length;
  mdTableData.push(new Array(cols).fill(''));
  mdTableRender();
}

function mdTableAddCol() {
  mdTableData.forEach((row, i) => {
    row.push(i === 0 ? 'New Header' : '');
  });
  mdTableAlign.push('left');
  mdTableRender();
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
  mdTableRender();
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
      td.contentEditable = true;
      td.textContent = cell;
      td.style.border = '1px solid var(--border)';
      td.style.padding = '8px';
      td.style.textAlign = mdTableAlign[cIndex];
      if (isHeader) {
        td.style.background = 'var(--bg-elevated)';
        td.style.cursor = 'pointer';
        td.title = 'Click to toggle alignment';
        // Toggle align on click, but avoid interfering with text selection
        td.addEventListener('mousedown', (e) => {
          if(e.offsetX > td.offsetWidth - 20) { // simple hit area on right side for sort/align icon could be added later
            // reserved
          }
        });
        td.onclick = (e) => {
          if (e.target === td) {
            mdTableToggleAlign(cIndex);
          }
        };
      }
      
      td.oninput = (e) => mdTableUpdateCell(rIndex, cIndex, e.target.textContent);
      
      td.onkeydown = (e) => {
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

      td.onpaste = (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text');
        if (text.includes('\t') || text.includes('\n')) {
          // Paste tabular data
          const lines = text.trim().split('\n');
          const maxCols = Math.max(...lines.map(l => l.split('\t').length));
          
          // Expand table if needed
          while (mdTableData.length < rIndex + lines.length) mdTableAddRow();
          while (mdTableData[0].length < cIndex + maxCols) mdTableAddCol();
          
          lines.forEach((line, i) => {
            const parts = line.split('\t');
            parts.forEach((p, j) => {
              mdTableData[rIndex + i][cIndex + j] = p.trim();
            });
          });
          mdTableRender();
        } else {
          // Normal paste
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

export function init() {}
