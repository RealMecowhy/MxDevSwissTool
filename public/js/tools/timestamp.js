// TIMESTAMP CONVERTER
// ============================================================
let tsLastDate = null;

// Shared by tsConvert and tsDiff so both accept epoch ms/s the same way —
// `new Date("1716220800000")` alone returns Invalid Date, it only parses
// recognized date-string formats, not raw epoch numbers passed as text.
function tsParseDate(raw) {
  raw=(raw||'').trim();
  if (!raw) return null;
  let d;
  if (/^\d{13}$/.test(raw)) d=new Date(parseInt(raw,10));
  else if (/^\d{10}$/.test(raw)) d=new Date(parseInt(raw,10)*1000);
  else d=new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

// Values that are unambiguous by construction (start of a calendar period).
// "EndOf*" tokens are deliberately omitted — Mendix's own docs don't specify
// whether they land on 23:59:59.999 or the next period's 00:00:00.000, and
// guessing would be exactly the kind of fabricated data the project avoids.
// BeginOfCurrentWeek(UTC) is locale-dependent in Mendix (first day of week
// follows the end user's locale), so it's shown as ISO-8601 Monday-start
// with an explicit note rather than presented as authoritative.
function tsMendixTokenPreview(now) {
  now = now || new Date();
  const y=now.getFullYear(), mo=now.getMonth(), d=now.getDate(), h=now.getHours(), mi=now.getMinutes();
  const uy=now.getUTCFullYear(), umo=now.getUTCMonth(), ud=now.getUTCDate(), uh=now.getUTCHours(), umi=now.getUTCMinutes();
  const sinceMonday=(now.getDay()+6)%7, uSinceMonday=(now.getUTCDay()+6)%7;
  return [
    { token:'[%CurrentDateTime%]', date: now },
    { token:'[%BeginOfCurrentMinute%]', date: new Date(y,mo,d,h,mi,0,0) },
    { token:'[%BeginOfCurrentMinuteUTC%]', date: new Date(Date.UTC(uy,umo,ud,uh,umi,0,0)) },
    { token:'[%BeginOfCurrentHour%]', date: new Date(y,mo,d,h,0,0,0) },
    { token:'[%BeginOfCurrentHourUTC%]', date: new Date(Date.UTC(uy,umo,ud,uh,0,0,0)) },
    { token:'[%BeginOfCurrentDay%]', date: new Date(y,mo,d,0,0,0,0) },
    { token:'[%BeginOfCurrentDayUTC%]', date: new Date(Date.UTC(uy,umo,ud,0,0,0,0)) },
    { token:'[%BeginOfCurrentWeek%]', date: new Date(y,mo,d-sinceMonday,0,0,0,0), note:'ISO-8601 Monday start shown — Mendix uses the end user\'s locale' },
    { token:'[%BeginOfCurrentWeekUTC%]', date: new Date(Date.UTC(uy,umo,ud-uSinceMonday,0,0,0,0)), note:'ISO-8601 Monday start shown — Mendix uses the end user\'s locale' },
    { token:'[%BeginOfCurrentMonth%]', date: new Date(y,mo,1,0,0,0,0) },
    { token:'[%BeginOfCurrentMonthUTC%]', date: new Date(Date.UTC(uy,umo,1,0,0,0,0)) },
    { token:'[%BeginOfCurrentYear%]', date: new Date(y,0,1,0,0,0,0) },
    { token:'[%BeginOfCurrentYearUTC%]', date: new Date(Date.UTC(uy,0,1,0,0,0,0)) },
  ];
}

const TS_ZONES = ['UTC','Europe/Warsaw','Europe/London','America/New_York','America/Los_Angeles','Asia/Tokyo','Asia/Shanghai','Australia/Sydney'];

function tsFormatInZone(date, zone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, dateStyle: 'full', timeStyle: 'long' }).format(date);
}

function tsConvert() {
  const raw=document.getElementById('ts-input').value.trim(); if(!raw) return;
  const d=tsParseDate(raw);
  if (!d) { document.getElementById('ts-grid').innerHTML='<div class="notice notice-error"><span>Cannot parse: "'+window.escHtml(raw)+'"</span></div>'; tsLastDate=null; document.getElementById('ts-tz-result').innerHTML=''; return; }
  tsLastDate=d;
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
  tsUpdateTzView();
}
function tsUpdateTzView() {
  const sel=document.getElementById('ts-tz-select');
  const out=document.getElementById('ts-tz-result');
  if (!sel || !out) return;
  if (!tsLastDate) { out.innerHTML=''; return; }
  const formatted=tsFormatInZone(tsLastDate, sel.value);
  out.innerHTML='<div class="ts-card"><div class="ts-card-label">'+window.escHtml(sel.value)+'</div><div class="ts-value" onclick="window.copyToClipboard(\''+formatted.replace(/'/g,"\\'")+'\')" title="Click to copy">'+window.escHtml(formatted)+'</div></div>';
}
function tsSetNow() { document.getElementById('ts-input').value=Date.now(); tsConvert(); }
function tsRenderTokenPreview() {
  const el=document.getElementById('ts-token-grid');
  if (!el) return;
  const rows=tsMendixTokenPreview(new Date());
  el.innerHTML=rows.map(r=>{
    const iso=r.date.toISOString();
    const note=r.note?'<div style="font-size:.68rem;color:var(--text-muted);margin-top:2px">'+window.escHtml(r.note)+'</div>':'';
    return '<div class="ts-card"><div class="ts-card-label">'+r.token+'</div><div class="ts-value" onclick="window.copyToClipboard(\''+iso+'\')" title="Click to copy">'+iso+'</div>'+note+'</div>';
  }).join('');
}
function tsDiff() {
  const a=tsParseDate(document.getElementById('ts-diff-from').value), b=tsParseDate(document.getElementById('ts-diff-to').value);
  if (!a||!b) return;
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

  const tzSelect = document.getElementById('ts-tz-select');
  if (tzSelect) tzSelect.addEventListener('change', tsUpdateTzView);

  tsRenderTokenPreview();
}

window.tsParseDate = tsParseDate;
window.tsMendixTokenPreview = tsMendixTokenPreview;
