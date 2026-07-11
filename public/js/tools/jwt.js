// JWT DECODER
// ============================================================
function jwtDecode() {
  const token = document.getElementById('jwt-input').value.trim();
  const resultEl = document.getElementById('jwt-result'), visualEl = document.getElementById('jwt-visual');
  if (!token || !token.includes('.')) { resultEl.style.display='none'; visualEl.style.display='none'; return; }
  const parts = token.split('.');
  if (parts.length < 2) return;
  visualEl.style.display='flex';
  visualEl.innerHTML = '<span class="jwt-header-part">'+escHtml(parts[0])+'</span><span class="jwt-separator">.</span><span class="jwt-payload-part">'+escHtml(parts[1])+'</span>'+(parts[2]?'<span class="jwt-separator">.</span><span class="jwt-sig-part">'+escHtml(parts[2])+'</span>':'');
  try {
    const b64d = s => { try { const p=s.replace(/-/g,'+').replace(/_/g,'/'); const pad=p.length%4; return JSON.parse(atob(pad?p+'='.repeat(4-pad):p)); } catch(e) { return null; } };
    const header = b64d(parts[0]), payload = b64d(parts[1]);
    if (!header || !payload) throw new Error('Invalid JWT structure');
    document.getElementById('jwt-header-table').innerHTML = '<tr><th>Claim</th><th>Value</th></tr>'+Object.entries(header).map(([k,v])=>'<tr><td>'+k+'</td><td>'+escHtml(String(v))+'</td></tr>').join('');
    const tsF=['exp','iat','nbf'];
    document.getElementById('jwt-payload-table').innerHTML = '<tr><th>Claim</th><th>Value</th></tr>'+Object.entries(payload).map(([k,v])=>{
      let d=escHtml(String(v));
      if (tsF.includes(k)&&typeof v==='number') d+=' <span style="color:var(--text-muted);font-size:.72em">('+new Date(v*1000).toISOString()+')</span>';
      return '<tr><td>'+k+'</td><td>'+d+'</td></tr>';
    }).join('');
    const now=Date.now()/1000, iat=payload.iat||0, exp=payload.exp, statusEl=document.getElementById('jwt-status-banner'), timelineEl=document.getElementById('jwt-timeline');
    if (exp) {
      const isExp=now>exp, total=exp-iat, elapsed=now-iat, pct=Math.min(100,Math.max(0,(elapsed/total)*100));
      statusEl.innerHTML = isExp
        ? '<div class="notice notice-error"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg><strong>Token Expired</strong> &mdash; expired '+Math.round((now-exp)/60)+' minutes ago</div>'
        : '<div class="notice notice-success"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;flex-shrink:0"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg><strong>Token Valid</strong> &mdash; expires in '+Math.round((exp-now)/60)+' min ('+new Date(exp*1000).toLocaleString()+')</div>';
      timelineEl.innerHTML = '<div style="display:flex;justify-content:space-between;font-size:.72rem;color:var(--text-muted)"><span>Issued: '+new Date(iat*1000).toLocaleString()+'</span><span>Expires: '+new Date(exp*1000).toLocaleString()+'</span></div><div class="jwt-progress-track"><div class="jwt-progress-bar '+(isExp?'expired':'valid')+'" style="width:'+pct+'%"></div></div><div style="font-size:.72rem;color:var(--text-secondary)">Lifetime: '+Math.round(total/60)+' min &mdash; '+(isExp?'EXPIRED':Math.round((1-pct/100)*100)+'% remaining')+'</div>';
    } else {
      statusEl.innerHTML = '<div class="notice notice-info"><span>No expiry claim (exp) found in token</span></div>';
      timelineEl.innerHTML = '';
    }
    resultEl.style.display='block';
  } catch(e) {
    document.getElementById('jwt-status-banner').innerHTML = '<div class="notice notice-error">Invalid JWT: '+escHtml(e.message)+'</div>';
    resultEl.style.display='block';
    document.getElementById('jwt-header-table').innerHTML=''; document.getElementById('jwt-payload-table').innerHTML=''; document.getElementById('jwt-timeline').innerHTML='';
  }
}

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.jwtDecode = jwtDecode;

export function init() {}
