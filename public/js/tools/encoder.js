// ENCODER / DECODER
// ============================================================
let encMode='base64';
function encSetMode(m,tab) { encMode=m; document.querySelectorAll('#panel-encoder .tab').forEach(t=>t.classList.remove('active')); if(tab) tab.classList.add('active'); document.getElementById('enc-input').value=''; document.getElementById('enc-output').value=''; }
function encEncode() { const i=document.getElementById('enc-input').value; let o=''; try { if(encMode==='base64') o=btoa(unescape(encodeURIComponent(i))); else if(encMode==='url') o=encodeURIComponent(i); else if(encMode==='hex') o=Array.from(new TextEncoder().encode(i)).map(b=>b.toString(16).padStart(2,'0')).join(''); else o=i.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); } catch(e){o='Error: '+e.message;} document.getElementById('enc-output').value=o; }
function encDecode() { const i=document.getElementById('enc-input').value; let o=''; try { if(encMode==='base64') o=decodeURIComponent(escape(atob(i))); else if(encMode==='url') o=decodeURIComponent(i); else if(encMode==='hex') o=new TextDecoder().decode(new Uint8Array((i.match(/.{1,2}/g)||[]).map(b=>parseInt(b,16)))); else o=i.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#039;/g,"'"); } catch(e){o='Error: '+e.message;} document.getElementById('enc-output').value=o; }
function encSwap() { const a=document.getElementById('enc-input').value,b=document.getElementById('enc-output').value; document.getElementById('enc-input').value=b; document.getElementById('enc-output').value=a; }


// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.encSetMode = encSetMode;
window.encEncode = encEncode;
window.encDecode = encDecode;
window.encSwap = encSwap;

export function init() {}
