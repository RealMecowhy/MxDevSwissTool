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

// ── Scheduled Event Preview ─────────────────────────────────
function tsSchedUpdateFields() {
  const recur = document.getElementById('ts-sched-recur').value;
  document.getElementById('ts-sched-time-group').style.display = (recur === 'daily' || recur === 'weekly') ? '' : 'none';
  document.getElementById('ts-sched-weekday-group').style.display = (recur === 'weekly') ? '' : 'none';
  document.getElementById('ts-sched-interval-group').style.display = (recur === 'hourly' || recur === 'minutes') ? '' : 'none';
}

function tsSchedPreview() {
  const recur = document.getElementById('ts-sched-recur').value;
  const asUtc = document.getElementById('ts-sched-tz').value === 'utc';
  const timeStr = document.getElementById('ts-sched-time').value.trim();
  const [hh, mm] = timeStr.split(':').map(n => parseInt(n, 10));
  const now = new Date();
  const occurrences = [];

  if (recur === 'daily' || recur === 'weekly') {
    if (isNaN(hh) || isNaN(mm)) { alert('Enter a valid time as HH:MM'); return; }
    const targetDow = recur === 'weekly' ? parseInt(document.getElementById('ts-sched-weekday').value, 10) : null;
    // Walk day by day from today, building each candidate at the configured time
    let cursor = new Date(now.getTime());
    for (let i = 0; i < 400 && occurrences.length < 10; i++) {
      const cand = asUtc
        ? new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), hh, mm, 0))
        : new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), hh, mm, 0);
      const dow = asUtc ? cand.getUTCDay() : cand.getDay();
      if (cand.getTime() > now.getTime() && (recur === 'daily' || dow === targetDow)) {
        occurrences.push(cand);
      }
      cursor = new Date(cursor.getTime() + 86400000);
    }
  } else {
    const n = Math.max(1, parseInt(document.getElementById('ts-sched-interval').value, 10) || 1);
    const stepMs = recur === 'hourly' ? n * 3600000 : n * 60000;
    let t = now.getTime() + stepMs;
    for (let i = 0; i < 10; i++) { occurrences.push(new Date(t)); t += stepMs; }
  }

  const body = document.getElementById('ts-sched-body');
  let prevOffset = null;
  body.innerHTML = occurrences.map((d, i) => {
    const relMin = Math.round((d.getTime() - now.getTime()) / 60000);
    const relStr = relMin < 60 ? relMin + ' min' : relMin < 1440 ? (relMin / 60).toFixed(1) + ' h' : (relMin / 1440).toFixed(1) + ' d';
    const offset = d.getTimezoneOffset();
    const dstFlag = (prevOffset !== null && offset !== prevOffset)
      ? ' <span style="color:var(--warning)" title="Daylight Saving shift changes the local clock time here">⚠ DST shift</span>'
      : '';
    prevOffset = offset;
    const utcStr = d.toISOString().replace('.000Z', 'Z');
    const localStr = d.toLocaleString();
    return `<tr style="border-top:1px solid var(--border)">
      <td style="padding:6px 10px;color:var(--text-muted)">${i + 1}</td>
      <td style="padding:6px 10px;font-family:var(--font-mono)">${utcStr}</td>
      <td style="padding:6px 10px;font-family:var(--font-mono)">${window.escHtml(localStr)}${dstFlag}</td>
      <td style="padding:6px 10px;color:var(--text-muted)">${relStr}</td>
    </tr>`;
  }).join('');
  document.getElementById('ts-sched-result').style.display = 'block';
}
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

  const recurSel = document.getElementById('ts-sched-recur');
  if (recurSel) recurSel.addEventListener('change', tsSchedUpdateFields);

  const schedBtn = document.getElementById('ts-btn-sched');
  if (schedBtn) schedBtn.addEventListener('click', tsSchedPreview);

  tsSchedUpdateFields();
}
