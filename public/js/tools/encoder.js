// ENCODER / DECODER
// ============================================================
let encMode='base64';
let encFileBuffer = null;
let encFileName = '';

// Pure detection/codec helpers — no DOM, safe to require() from scripts/parser-test.js.

// Only claims Base64/URL (the two the audit asked for): a wrong guess must stay
// harmless (input text is never touched), so each branch requires the decode to
// actually succeed and produce something, not just match a charset regex.
function encDetectType(str) {
  const s = (str || '').trim();
  if (!s) return null;
  if (/%[0-9a-fA-F]{2}/.test(s)) {
    try { if (decodeURIComponent(s) !== s) return 'url'; } catch (e) { /* not valid URL-encoding */ }
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length >= 8 && s.length % 4 === 0) {
    try {
      const binary = atob(s);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return 'base64';
    } catch (e) { /* not valid base64-encoded UTF-8 text */ }
  }
  return null;
}

// Keeps decoding until the output stabilizes (catches the "double URL-encode"
// case from Mendix REST debugging) or maxDepth is hit — never loops forever.
function encDecodeRecursiveValue(mode, str, maxDepth) {
  maxDepth = maxDepth || 10;
  let current = str;
  let layers = 0;
  for (let i = 0; i < maxDepth; i++) {
    let next;
    try {
      if (mode === 'url') next = decodeURIComponent(current);
      else if (mode === 'base64') next = decodeURIComponent(escape(atob(current)));
      else break;
    } catch (e) { break; }
    if (next === current) break;
    current = next;
    layers++;
  }
  return { result: current, layers: layers };
}

function encBytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function encBase64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- DOM wiring ------------------------------------------------------------

function encActivateTab(m) {
  encMode = m;
  document.querySelectorAll('#panel-encoder .tab').forEach(t=>{
    const active = t.getAttribute('data-mode') === m;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function encSetStatus(msg) { const el=document.getElementById('enc-status'); if(el) el.textContent=msg||''; }

function encClearFile() {
  encFileBuffer = null;
  encFileName = '';
  const info = document.getElementById('enc-file-info');
  if (info) { info.style.display = 'none'; info.textContent = ''; }
}

function encSetMode(m) {
  encActivateTab(m);
  document.getElementById('enc-input').value='';
  document.getElementById('enc-output').value='';
  encClearFile();
  encSetStatus('');
}

function encOnInput() {
  const input = document.getElementById('enc-input');
  if (encFileBuffer && input.value !== `[File loaded: ${encFileName}]`) encClearFile();
  encAutoDetect();
}

function encAutoDetect() {
  if (encFileBuffer) return;
  const val = document.getElementById('enc-input').value;
  const detected = encDetectType(val);
  if (!detected) { encSetStatus(''); return; }
  const switched = detected !== encMode;
  if (switched) encActivateTab(detected);
  encDecode();
  const label = detected === 'base64' ? 'Base64' : 'URL encoding';
  encSetStatus(switched ? `Detected ${label} — switched tab and decoded automatically.` : `Auto-decoded (${label} detected).`);
}

function encEncode() {
  const i=document.getElementById('enc-input').value; let o='';
  try {
    if (encFileBuffer && encMode==='base64') o=encBytesToBase64(new Uint8Array(encFileBuffer));
    else if(encMode==='base64') o=btoa(unescape(encodeURIComponent(i)));
    else if(encMode==='url') o=encodeURIComponent(i);
    else if(encMode==='hex') o=Array.from(new TextEncoder().encode(i)).map(b=>b.toString(16).padStart(2,'0')).join('');
    else o=i.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
  } catch(e){o='Error: '+e.message;}
  document.getElementById('enc-output').value=o;
}

function encDecode() {
  if (encFileBuffer) {
    document.getElementById('enc-output').value='[A file is loaded — use Encode to get Base64, or "Download as file" to reverse a pasted Base64 string.]';
    return;
  }
  const i=document.getElementById('enc-input').value; let o='';
  try {
    if(encMode==='base64') o=decodeURIComponent(escape(atob(i)));
    else if(encMode==='url') o=decodeURIComponent(i);
    else if(encMode==='hex') o=new TextDecoder().decode(new Uint8Array((i.match(/.{1,2}/g)||[]).map(b=>parseInt(b,16))));
    else o=i.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#039;/g,"'");
  } catch(e){o='Error: '+e.message;}
  document.getElementById('enc-output').value=o;
}

function encDecodeRecursiveUI() {
  if (encFileBuffer) { encSetStatus('Recursive decode does not apply to a loaded file.'); return; }
  if (encMode!=='base64' && encMode!=='url') { encSetStatus('Recursive decode only applies to Base64 and URL Encode.'); return; }
  const i=document.getElementById('enc-input').value;
  const r=encDecodeRecursiveValue(encMode,i,10);
  document.getElementById('enc-output').value=r.result;
  encSetStatus(r.layers===0 ? 'Nothing further to decode.' : `Decoded ${r.layers} layer${r.layers===1?'':'s'}.`);
}

function encSwap() { const a=document.getElementById('enc-input').value,b=document.getElementById('enc-output').value; document.getElementById('enc-input').value=b; document.getElementById('enc-output').value=a; encClearFile(); encSetStatus(''); }

function encDownloadAsFile() {
  if (encMode!=='base64') { encSetStatus('Download as file only applies to the Base64 tab.'); return; }
  const val=document.getElementById('enc-input').value.trim();
  if (!val) { encSetStatus('Paste a Base64 string in Input first.'); return; }
  try {
    const bytes=encBase64ToBytes(val);
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));
    a.download=encFileName||'decoded-file.bin';
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),10000);
    encSetStatus(`Downloaded ${bytes.length} bytes as ${a.download}.`);
  } catch(e) { encSetStatus('Not valid Base64: '+e.message); }
}

function initEncoder() {
  const input=document.getElementById('enc-input');
  if (!input || input.dataset.encBound) return;
  input.dataset.encBound='1';
  input.addEventListener('dragover',(e)=>{e.preventDefault();input.style.borderColor='var(--accent)';});
  input.addEventListener('dragleave',(e)=>{e.preventDefault();input.style.borderColor='var(--border)';});
  input.addEventListener('drop', async (e)=>{
    e.preventDefault();
    input.style.borderColor='var(--border)';
    const file=e.dataTransfer.files[0];
    if (!file) return;
    encFileBuffer=await file.arrayBuffer();
    encFileName=file.name;
    encActivateTab('base64');
    input.value=`[File loaded: ${file.name}]`;
    document.getElementById('enc-output').value='';
    const info=document.getElementById('enc-file-info');
    if (info) { info.textContent=`Loaded ${file.name} (${Math.round(file.size/1024)} KB) — click Encode to get Base64.`; info.style.display='block'; }
    encSetStatus('');
    encEncode();
  });
}


// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.encSetMode = encSetMode;
window.encEncode = encEncode;
window.encDecode = encDecode;
window.encSwap = encSwap;
window.encOnInput = encOnInput;
window.encDecodeRecursiveUI = encDecodeRecursiveUI;
window.encDownloadAsFile = encDownloadAsFile;
window.encDetectType = encDetectType;
window.encDecodeRecursiveValue = encDecodeRecursiveValue;
window.encBytesToBase64 = encBytesToBase64;
window.encBase64ToBytes = encBase64ToBytes;

export function init() { initEncoder(); }
