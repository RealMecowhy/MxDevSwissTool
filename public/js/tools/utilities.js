// UTILITIES
// ============================================================
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function escRegex(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function copyToClipboard(text){if(navigator.clipboard)navigator.clipboard.writeText(text).catch(()=>fallbackCopy(text));else fallbackCopy(text);}
function fallbackCopy(text){const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);}
function downloadText(text,filename){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'text/plain'}));a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),10000);}
function handleTextFileDrop(e, inputId, callbackName) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    const file = e.dataTransfer.files[0];
    const reader = new FileReader();
    reader.onload = function(evt) {
      document.getElementById(inputId).value = evt.target.result;
      if (window[callbackName]) window[callbackName]();
    };
    reader.readAsText(file);
  }
}

// Keyboard shortcuts
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){if(currentTool==='json-formatter')jsonFormat();else if(currentTool==='xml-formatter')xmlFormat();else if(currentTool==='sql-formatter')sqlFormat();}});

// Load fonts
(function(){
  const l=document.createElement('link');l.rel='stylesheet';l.href='https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap';document.head.appendChild(l);
})();

// ============================================================

// --- AUTO-GENERATED ESM EXPORTS ---
window.escHtml = escHtml;
window.escRegex = escRegex;
window.copyToClipboard = copyToClipboard;
window.fallbackCopy = fallbackCopy;
window.downloadText = downloadText;
window.handleTextFileDrop = handleTextFileDrop;
