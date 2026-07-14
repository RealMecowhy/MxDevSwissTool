// DOMAIN MODEL & ARCHITECTURE
// Generates Mermaid class diagrams from JSON payloads or pseudo-code

let archLastMermaidCode = '';

function archCopyMermaid() {
  if (!archLastMermaidCode) {
    alert('Generate a diagram first.');
    return;
  }
  window.copyToClipboard(archLastMermaidCode);
}

function archDownloadSvg() {
  const svg = document.querySelector('#arch-output svg');
  if (!svg) {
    alert('Generate a diagram first.');
    return;
  }
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const markup = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  a.download = 'domain-model.svg';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function archGenerate() {
  const input = document.getElementById('arch-input').value.trim();
  const out = document.getElementById('arch-output');
  if (!input) {
    out.innerHTML = '<div style="color:var(--text-muted)">Paste Domain Model JSON or Pseudo-code to generate diagram...</div>';
    return;
  }
  
  let mermaidCode = 'classDiagram\n';
  
  try {
    const json = JSON.parse(input);
    if (json.entities) {
      json.entities.forEach(ent => {
        mermaidCode += `  class ${ent.name} {\n`;
        if (ent.attributes) {
          ent.attributes.forEach(attr => {
            mermaidCode += `    ${attr.type} ${attr.name}\n`;
          });
        }
        mermaidCode += `  }\n`;
      });
    }
    if (json.associations) {
      json.associations.forEach(assoc => {
        const arrow = assoc.type === '1-*)' ? '"1" --> "*"' : 
                      assoc.type === '*-*)' ? '"*" --> "*"' : 
                      assoc.type === '1-1)' ? '"1" --> "1"' : '-->';
        mermaidCode += `  ${assoc.parent} ${arrow} ${assoc.child} : ${assoc.name}\n`;
      });
    }
  } catch(e) {
    // pseudo-code parsing
    // EntityName
    //  attr: Type
    //  attr: Type
    //
    // EntityA -> EntityB : assocName
    const lines = input.split('\n');
    let currentEntity = null;
    lines.forEach(line => {
      const l = line.trim();
      if (!l) {
        currentEntity = null;
        return;
      }
      
      // Cardinality syntax: Customer [1] -- [*] Order : has
      const cardMatch = l.match(/^(\S+)\s*\[([^\]]+)\]\s*--\s*\[([^\]]+)\]\s*(\S+)\s*(?::\s*(.+))?$/);
      if (cardMatch) {
        const [, left, leftCard, rightCard, right, label] = cardMatch;
        mermaidCode += `  ${left} "${leftCard}" --> "${rightCard}" ${right}${label ? ' : ' + label.trim() : ''}\n`;
        currentEntity = null;
      } else if (l.includes('->')) {
        const parts = l.split('->');
        const left = parts[0].trim();
        const rightParts = parts[1].split(':');
        const right = rightParts[0].trim();
        const label = rightParts.length > 1 ? rightParts[1].trim() : '';
        mermaidCode += `  ${left} --> ${right} ${label ? ': ' + label : ''}\n`;
        currentEntity = null;
      } else if (!l.includes(':')) {
        currentEntity = l;
        mermaidCode += `  class ${currentEntity} {\n  }\n`;
      } else if (currentEntity && l.includes(':')) {
        const [attr, type] = l.split(':');
        mermaidCode += `  class ${currentEntity} {\n    ${type.trim()} ${attr.trim()}\n  }\n`;
      }
    });
  }
  
  archLastMermaidCode = mermaidCode;

  // Render using Mermaid API if loaded
  if (window.mermaid) {
    out.innerHTML = `<div class="mermaid">${mermaidCode}</div>`;
    mermaid.init(undefined, document.querySelectorAll('.mermaid'));
  } else {
    out.innerHTML = `<pre style="font-family:var(--font-mono);font-size:0.8rem;background:var(--bg-base);padding:var(--sp-4);border-radius:var(--r-md);overflow-x:auto">${escHtml(mermaidCode)}</pre>
    <div class="notice notice-info" style="margin-top:var(--sp-2)">Mermaid.js library is not loaded. The raw syntax is shown above. To visualize, copy this into the <a href="https://mermaid.live/" target="_blank" style="color:var(--primary)">Mermaid Live Editor</a>.</div>`;
  }
}


// --- AUTO-GENERATED ESM EXPORTS ---
window.archGenerate = archGenerate;
window.archCopyMermaid = archCopyMermaid;
window.archDownloadSvg = archDownloadSvg;

export function init() {}
