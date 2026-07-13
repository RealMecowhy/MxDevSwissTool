// TIMESTAMP CONVERTER
// ============================================================
function tsConvert() {
  const raw=document.getElementById('ts-input').value.trim(); if(!raw) return;
  let d;
  if (/^\d{13}$/.test(raw)) d=new Date(parseInt(raw));
  else if (/^\d{10}$/.test(raw)) d=new Date(parseInt(raw)*1000);
  else d=new Date(raw);
  if (isNaN(d.getTime())) { document.getElementById('ts-grid').innerHTML='<div class="notice notice-error"><span>Cannot parse: "'+window.escHtml(raw)+'"</span></div>'; return; }
  const tz=getTimezoneStr();
  const items=[
    {label:'Epoch (milliseconds)',value:d.getTime()},
    {label:'Epoch (seconds)',value:Math.floor(d.getTime()/1000)},
    {label:'ISO 8601 (UTC)',value:d.toISOString()},
    {label:'ISO 8601 (Local)',value:new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().replace('Z',tz)},
    {label:'UTC String',value:d.toUTCString()},
    {label:'Local Date/Time',value:d.toLocaleString()},
    {label:'Date Only',value:d.toLocaleDateString()},
    {label:'Time Only',value:d.toLocaleTimeString()},
    {label:'Day of Week',value:['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()]},
    {label:'Week Number',value:'Week '+getWeekNumber(d)+' of '+d.getFullYear()},
  ];
  document.getElementById('ts-grid').innerHTML=items.map(it=>'<div class="ts-card"><div class="ts-card-label">'+it.label+'</div><div class="ts-value" onclick="window.copyToClipboard(\''+String(it.value).replace(/'/g,"\\'")+'\')" title="Click to copy">'+window.escHtml(String(it.value))+'</div></div>').join('');
}
function tsSetNow() { document.getElementById('ts-input').value=Date.now(); tsConvert(); }
function tsDiff() {
  const a=new Date(document.getElementById('ts-diff-from').value), b=new Date(document.getElementById('ts-diff-to').value);
  if (isNaN(a)||isNaN(b)) return;
  const ms=Math.abs(b-a), s=Math.floor(ms/1000), m=Math.floor(s/60), h=Math.floor(m/60), days=Math.floor(h/24);
  const el=document.getElementById('ts-diff-result'); el.style.display='grid';
  el.innerHTML=[{label:'Milliseconds',value:ms.toLocaleString()},{label:'Seconds',value:s.toLocaleString()},{label:'Minutes',value:m.toLocaleString()},{label:'Hours',value:h.toLocaleString()},{label:'Days',value:days.toLocaleString()},{label:'Weeks',value:(days/7).toFixed(2)}].map(it=>'<div class="ts-card"><div class="ts-card-label">'+it.label+'</div><div class="ts-value">'+it.value+'</div></div>').join('');
}
function getWeekNumber(d) { const dt=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())); dt.setUTCDate(dt.getUTCDate()+4-(dt.getUTCDay()||7)); return Math.ceil((((dt-new Date(Date.UTC(dt.getUTCFullYear(),0,1)))/86400000)+1)/7); }
function getTimezoneStr() { const o=-new Date().getTimezoneOffset(), s=o>=0?'+':'-', h=String(Math.floor(Math.abs(o)/60)).padStart(2,'0'), m=String(Math.abs(o)%60).padStart(2,'0'); return s+h+':'+m; }

// ============================================================


// --- ES MODULE MIGRATION ---
export function init() {
  const tsInput = document.getElementById('ts-input');
  if (tsInput) tsInput.addEventListener('input', tsConvert);
  
  const convertBtn = document.getElementById('ts-btn-convert');
  if (convertBtn) convertBtn.addEventListener('click', tsConvert);
  
  const nowBtn = document.getElementById('ts-btn-now');
  if (nowBtn) nowBtn.addEventListener('click', tsSetNow);
  
  const diffFrom = document.getElementById('ts-diff-from');
  if (diffFrom) diffFrom.addEventListener('input', tsDiff);
  
  const diffTo = document.getElementById('ts-diff-to');
  if (diffTo) diffTo.addEventListener('input', tsDiff);
  
  const diffBtn = document.getElementById('ts-btn-diff');
  if (diffBtn) diffBtn.addEventListener('click', tsDiff);
}
