// HASH GENERATOR
// ============================================================
let hashFileBuffer = null;
let hashFileName = '';

function initHash() {
  const input = document.getElementById('hash-input');
  if (!input) return;
  input.addEventListener('dragover', (e) => { e.preventDefault(); input.style.borderColor = 'var(--accent)'; });
  input.addEventListener('dragleave', (e) => { e.preventDefault(); input.style.borderColor = 'var(--border)'; });
  input.addEventListener('drop', async (e) => {
    e.preventDefault();
    input.style.borderColor = 'var(--border)';
    const file = e.dataTransfer.files[0];
    if (file) {
      document.getElementById('hash-file-info').innerText = `Hashing file: ${file.name} (${Math.round(file.size/1024)} KB)`;
      document.getElementById('hash-file-info').style.display = 'block';
      input.value = `[File loaded: ${file.name}]`;
      hashFileBuffer = await file.arrayBuffer();
      hashFileName = file.name;
      hashCompute();
    }
  });
  input.addEventListener('input', () => {
    if (input.value !== `[File loaded: ${hashFileName}]`) {
      hashFileBuffer = null;
      document.getElementById('hash-file-info').style.display = 'none';
    }
  });
}

async function hashCompute() {
  const text=document.getElementById('hash-input').value, el=document.getElementById('hash-results');
  const expectedHash = (document.getElementById('hash-compare')?.value || '').trim().toLowerCase();
  if(!text && !hashFileBuffer){el.innerHTML='';return;}
  
  const data = hashFileBuffer ? hashFileBuffer : new TextEncoder().encode(text);
  const algos=[{name:'SHA-256',algo:'SHA-256'},{name:'SHA-512',algo:'SHA-512'},{name:'SHA-1',algo:'SHA-1'}];
  
  const results=await Promise.all(algos.map(async({name,algo})=>{
    const h=await crypto.subtle.digest(algo,data);
    const hex = Array.from(new Uint8Array(h)).map(b=>b.toString(16).padStart(2,'0')).join('');
    return{name,hex};
  }));
  
  el.innerHTML=results.map(r=>{
    let matchHtml = '';
    if (expectedHash) {
      if (expectedHash === r.hex) {
        matchHtml = '<span style="color:var(--success);font-weight:bold;margin-left:8px;font-size:0.75rem">✓ MATCH</span>';
      } else {
        matchHtml = '<span style="color:var(--danger);font-weight:bold;margin-left:8px;font-size:0.75rem">✗ MISMATCH</span>';
      }
    }
    return '<div class="uuid-item"><div style="flex:1"><div class="form-label" style="display:flex;align-items:center">'+r.name+matchHtml+'</div><div class="uuid-val">'+r.hex+'</div></div><button class="btn btn-ghost btn-sm" onclick="copyToClipboard(\''+r.hex+'\');this.textContent=\'&#10003;\';setTimeout(()=>this.textContent=\'Copy\',1200)">Copy</button></div>';
  }).join('')+'<div class="notice notice-info" style="margin-top:var(--sp-2)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>MD5 is not supported by browser WebCrypto (deprecated). Use SHA-256 for security-sensitive applications.</div>';
}


// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.hashCompute = hashCompute;
window.initHash = initHash;

export function init() { initHash(); }
