// ODATA BUILDER
// ============================================================
function odataBuild() {
  const base=document.getElementById('odata-base').value.trim(), entity=document.getElementById('odata-entity').value.trim();
  const params=[]; ['filter','select','expand','orderby'].forEach(p=>{const v=document.getElementById('odata-'+p).value.trim();if(v) params.push(['$'+p,v]);});
  const top=document.getElementById('odata-top').value.trim(), skip=document.getElementById('odata-skip').value.trim(), count=document.getElementById('odata-count').value, fmt=document.getElementById('odata-format').value;
  if(top) params.push(['$top',top]); if(skip) params.push(['$skip',skip]); if(count) params.push(['$count',count]); if(fmt) params.push(['$format',fmt]);
  const displayEl=document.getElementById('odata-url-display');
  if(!base&&!entity){displayEl.innerHTML='<span style="color:var(--text-muted)">Fill in the fields above...</span>';return;}
  let html='<span class="url-base">'+escHtml(base||'https://your-app.mendixcloud.com/odata/Service/v1')+'</span>';
  if(entity) html+='<span style="color:var(--text-primary)">'+'/'+escHtml(entity)+'</span>';
  if(params.length) html+='<span class="url-sep">?</span>'+params.map(([k,v],i)=>(i>0?'<span class="url-sep">&amp;</span>':'')+'<span class="url-param-name">'+k+'</span><span class="url-sep">=</span><span class="url-param-val">'+escHtml(v)+'</span>').join('');
  displayEl.innerHTML=html;
}
function odataCopyUrl() {
  const base=document.getElementById('odata-base').value.trim()||'https://your-app.mendixcloud.com/odata/Service/v1', entity=document.getElementById('odata-entity').value.trim();
  const params=[]; ['filter','select','expand','orderby','top','skip','count','format'].forEach(p=>{const v=document.getElementById('odata-'+p).value.trim();if(v) params.push('$'+p+'='+encodeURIComponent(v));});
  copyToClipboard(base+(entity?'/'+entity:'')+(params.length?'?'+params.join('&'):''));
}



// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.odataBuild = odataBuild;
window.odataCopyUrl = odataCopyUrl;

export function init() {}
