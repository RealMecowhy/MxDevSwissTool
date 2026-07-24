// JWT DECODER
// ============================================================
const JWT_CLAIM_DESCRIPTIONS = {
  iss: 'Issuer — the party that created and signed the token.',
  sub: 'Subject — the principal the token is about (usually a user id).',
  aud: 'Audience — the intended recipient(s) of the token.',
  exp: 'Expiration time — Unix timestamp after which the token must be rejected.',
  nbf: 'Not before — Unix timestamp before which the token must not be accepted.',
  iat: 'Issued at — Unix timestamp when the token was created.',
  jti: 'JWT ID — unique identifier for this token, used to prevent replay.',
  azp: 'Authorized party — the client the token was issued to (OIDC).',
  scope: 'Scope — space-separated list of permissions granted to the token.'
};

function jwtBase64UrlDecodeJson(s) {
  try {
    const p = s.replace(/-/g, '+').replace(/_/g, '/');
    const pad = p.length % 4;
    return JSON.parse(atob(pad ? p + '='.repeat(4 - pad) : p));
  } catch (e) { return null; }
}

function jwtClaimCell(key) {
  const desc = JWT_CLAIM_DESCRIPTIONS[key];
  return desc ? '<span title="' + escHtml(desc) + '" style="border-bottom:1px dotted var(--text-muted);cursor:help">' + escHtml(key) + '</span>' : escHtml(key);
}

function jwtDecode() {
  const token = document.getElementById('jwt-input').value.trim();
  const resultEl = document.getElementById('jwt-result'), visualEl = document.getElementById('jwt-visual');
  if (!token || !token.includes('.')) { resultEl.style.display='none'; visualEl.style.display='none'; return; }
  const parts = token.split('.');
  if (parts.length < 2) return;
  visualEl.style.display='flex';
  visualEl.innerHTML = '<span class="jwt-header-part">'+escHtml(parts[0])+'</span><span class="jwt-separator">.</span><span class="jwt-payload-part">'+escHtml(parts[1])+'</span>'+(parts[2]?'<span class="jwt-separator">.</span><span class="jwt-sig-part">'+escHtml(parts[2])+'</span>':'');
  try {
    const header = jwtBase64UrlDecodeJson(parts[0]), payload = jwtBase64UrlDecodeJson(parts[1]);
    if (!header || !payload) throw new Error('Invalid JWT structure');
    document.getElementById('jwt-header-table').innerHTML = '<tr><th>Claim</th><th>Value</th></tr>'+Object.entries(header).map(([k,v])=>'<tr><td>'+jwtClaimCell(k)+'</td><td>'+escHtml(String(v))+'</td></tr>').join('');
    const tsF=['exp','iat','nbf'];
    document.getElementById('jwt-payload-table').innerHTML = '<tr><th>Claim</th><th>Value</th></tr>'+Object.entries(payload).map(([k,v])=>{
      let d=escHtml(String(v));
      if (tsF.includes(k)&&typeof v==='number') d+=' <span style="color:var(--text-muted);font-size:.72em">('+new Date(v*1000).toISOString()+')</span>';
      return '<tr><td>'+jwtClaimCell(k)+'</td><td>'+d+'</td></tr>';
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
    // A freshly (re)decoded token invalidates any signature check done against
    // the previous input — never leave a stale "Valid" banner on screen.
    jwtResetVerifyBanner();
  } catch(e) {
    document.getElementById('jwt-status-banner').innerHTML = '<div class="notice notice-error">Invalid JWT: '+escHtml(e.message)+'</div>';
    resultEl.style.display='block';
    document.getElementById('jwt-header-table').innerHTML=''; document.getElementById('jwt-payload-table').innerHTML=''; document.getElementById('jwt-timeline').innerHTML='';
  }
}

// ============================================================
// 8.3: SIGNATURE VERIFICATION (RS256 / ES256, via WebCrypto)
// ============================================================
// Data principle: without a key, the signature is UNVERIFIED — never shown
// as a silent "OK". Verification only runs when the user explicitly supplies
// a public key (PEM SPKI or a JWK/JWKS), and the banner always names which
// state applies: not verified / valid / invalid / unsupported algorithm.

function jwtResetVerifyBanner() {
  const el = document.getElementById('jwt-verify-result');
  if (el) el.innerHTML = '<div class="notice notice-info">Signature not verified — paste a public key (PEM or JWK/JWKS) below and click Verify.</div>';
}

function jwtPemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/[\r\n\s]/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function jwtBase64UrlToArrayBuffer(s) {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = p.length % 4;
  const bin = atob(pad ? p + '='.repeat(4 - pad) : p);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// Picks the right JWK out of a bare JWK, a JWKS {keys:[...]}, matching the
// header's `kid` when the set has more than one candidate for the algorithm.
function jwtSelectJwk(parsed, header) {
  const candidates = Array.isArray(parsed.keys) ? parsed.keys : [parsed];
  if (header.kid) {
    const byKid = candidates.find(k => k.kid === header.kid);
    if (byKid) return byKid;
  }
  return candidates.find(k => k.kty === (header.alg === 'ES256' ? 'EC' : 'RSA')) || candidates[0];
}

async function jwtImportVerifyKey(keyText, header) {
  const algParams = header.alg === 'RS256'
    ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
    : { name: 'ECDSA', namedCurve: 'P-256' };
  const trimmed = keyText.trim();
  if (trimmed.startsWith('-----BEGIN')) {
    return crypto.subtle.importKey('spki', jwtPemToArrayBuffer(trimmed), algParams, false, ['verify']);
  }
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch (e) { throw new Error('Key is neither a PEM block nor valid JSON (JWK/JWKS).'); }
  const jwk = jwtSelectJwk(parsed, header);
  if (!jwk) throw new Error('No matching key found in the supplied JWKS (checked "kid").');
  return crypto.subtle.importKey('jwk', jwk, algParams, false, ['verify']);
}

async function jwtVerifySignature() {
  const resultEl = document.getElementById('jwt-verify-result');
  const token = document.getElementById('jwt-input').value.trim();
  const keyText = document.getElementById('jwt-verify-key').value;
  const parts = token.split('.');
  if (parts.length !== 3) {
    resultEl.innerHTML = '<div class="notice notice-info">This token has no signature part to verify.</div>';
    return;
  }
  const header = jwtBase64UrlDecodeJson(parts[0]);
  if (!header) { resultEl.innerHTML = '<div class="notice notice-error">Could not read the token header.</div>'; return; }
  if (!keyText.trim()) { jwtResetVerifyBanner(); return; }
  if (header.alg !== 'RS256' && header.alg !== 'ES256') {
    resultEl.innerHTML = '<div class="notice notice-info">Signature verification is only supported for <code>RS256</code>/<code>ES256</code> here — this token uses <code>' + escHtml(header.alg || '(none)') + '</code>.</div>';
    return;
  }
  resultEl.innerHTML = '<div class="notice notice-info">Verifying…</div>';
  try {
    const key = await jwtImportVerifyKey(keyText, header);
    const signingInput = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    const signature = jwtBase64UrlToArrayBuffer(parts[2]);
    const verifyParams = header.alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' };
    const valid = await crypto.subtle.verify(verifyParams, key, signature, signingInput);
    resultEl.innerHTML = valid
      ? '<div class="notice notice-success"><strong>Signature valid</strong> — matches the supplied key.</div>'
      : '<div class="notice notice-error"><strong>Signature invalid</strong> — does not match the supplied key. The token may be tampered with, expired-and-reissued under a new key, or this is simply the wrong key.</div>';
  } catch (e) {
    resultEl.innerHTML = '<div class="notice notice-error">Could not verify: ' + escHtml(e.message) + '</div>';
  }
}

// ============================================================
// 8.4: TWO-TOKEN COMPARISON
// ============================================================
// Side-by-side claim diff — e.g. comparing a token before/after a refresh to
// see exactly which claims changed.
function jwtCompareTokens() {
  const resultEl = document.getElementById('jwt-compare-result');
  const tokenB = document.getElementById('jwt-compare-input').value.trim();
  const tokenA = document.getElementById('jwt-input').value.trim();
  if (!tokenB) { resultEl.innerHTML = ''; return; }
  const partsA = tokenA.split('.'), partsB = tokenB.split('.');
  const payloadA = partsA.length >= 2 ? jwtBase64UrlDecodeJson(partsA[1]) : null;
  const payloadB = partsB.length >= 2 ? jwtBase64UrlDecodeJson(partsB[1]) : null;
  if (!payloadA || !payloadB) {
    resultEl.innerHTML = '<div class="notice notice-error">Both the token above and the one pasted here must be valid JWTs to compare.</div>';
    return;
  }
  const keys = Array.from(new Set([...Object.keys(payloadA), ...Object.keys(payloadB)])).sort();
  const rows = keys.map(k => {
    const va = Object.prototype.hasOwnProperty.call(payloadA, k) ? JSON.stringify(payloadA[k]) : '<span style="color:var(--text-muted)">(absent)</span>';
    const vb = Object.prototype.hasOwnProperty.call(payloadB, k) ? JSON.stringify(payloadB[k]) : '<span style="color:var(--text-muted)">(absent)</span>';
    const changed = JSON.stringify(payloadA[k]) !== JSON.stringify(payloadB[k]);
    const style = changed ? ' style="background:var(--warning-subtle)"' : '';
    return '<tr' + style + '><td>' + jwtClaimCell(k) + '</td><td>' + escHtml(va) + '</td><td>' + escHtml(vb) + '</td></tr>';
  }).join('');
  resultEl.innerHTML = '<table class="jwt-claim-table"><tr><th>Claim</th><th>Token above</th><th>Token pasted here</th></tr>' + rows + '</table>';
}

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.jwtDecode = jwtDecode;
window.jwtVerifySignature = jwtVerifySignature;
window.jwtCompareTokens = jwtCompareTokens;
window.jwtBase64UrlDecodeJson = jwtBase64UrlDecodeJson;
window.jwtClaimCell = jwtClaimCell;
window.jwtSelectJwk = jwtSelectJwk;

export function init() {}
