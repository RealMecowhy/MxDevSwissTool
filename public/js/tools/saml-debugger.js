// SAML / OIDC DEBUGGER
// Decodes SAML Responses/Requests (Base64, optionally URL-encoded and DEFLATE-compressed)
// and OIDC id_tokens (JWT) locally — nothing is transmitted externally.
// ============================================================

let samlActiveTab = 'saml';

function samlSetTab(tab, el) {
  samlActiveTab = tab;
  const panel = document.getElementById('panel-saml-debugger');
  if (!panel) return;
  panel.querySelectorAll('.tabs .tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
  if (el) { el.classList.add('active'); el.setAttribute('aria-selected', 'true'); }
  document.getElementById('saml-tab-saml').style.display = tab === 'saml' ? 'block' : 'none';
  document.getElementById('saml-tab-oidc').style.display = tab === 'oidc' ? 'block' : 'none';
}

function samlDecodeActive() {
  if (samlActiveTab === 'oidc') {
    samlDecodeOidc();
  } else {
    samlDecodeSaml();
  }
}

// ── SAML decoding ───────────────────────────────────────────

function b64ToBytes(b64) {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function inflate(bytes, format) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot DEFLATE-decompress (no DecompressionStream). Use a Chromium/Firefox browser, or paste the already-inflated XML.');
  }
  const ds = new DecompressionStream(format);
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// Turns a raw SAML message into XML. Handles POST binding (plain Base64) and
// Redirect binding (URL-encoded + raw DEFLATE), trying each strategy in turn.
async function samlToXml(raw) {
  let input = raw.trim();
  if (!input) throw new Error('Paste a SAMLResponse / SAMLRequest value first.');

  // Redirect binding often arrives URL-encoded
  if (/%[0-9a-fA-F]{2}/.test(input)) {
    try { input = decodeURIComponent(input); } catch (e) { /* keep as-is */ }
  }
  input = input.replace(/\s+/g, '');

  let bytes;
  try {
    bytes = b64ToBytes(input);
  } catch (e) {
    throw new Error('Input is not valid Base64.');
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const asText = decoder.decode(bytes);
  if (asText.trimStart().startsWith('<')) return asText;

  // Not plain XML → try DEFLATE (Redirect binding uses raw deflate; some tools add a zlib header)
  for (const fmt of ['deflate-raw', 'deflate']) {
    try {
      const inflated = decoder.decode(await inflate(bytes, fmt));
      if (inflated.trimStart().startsWith('<')) return inflated;
    } catch (e) { /* try next */ }
  }
  throw new Error('Could not decode to XML. Ensure this is a Base64 SAMLResponse/SAMLRequest (POST or Redirect binding).');
}

function prettyXml(xml) {
  // Lightweight indenter: newline between tags, then re-indent by depth.
  const normalized = xml.replace(/>\s*</g, '><').replace(/></g, '>\n<');
  const lines = normalized.split('\n');
  let indent = 0;
  return lines.map(line => {
    line = line.trim();
    if (!line) return '';
    if (/^<\/[^>]+>/.test(line)) indent = Math.max(0, indent - 1);
    const padded = '  '.repeat(indent) + line;
    // Opening tag (not self-closing, not a declaration, not open+close on one line)
    if (/^<[^!?/][^>]*[^/]>$/.test(line) && !/^<[^>]+>.*<\/[^>]+>$/.test(line)) indent++;
    return padded;
  }).filter(Boolean).join('\n');
}

function highlightXml(xml) {
  return window.escHtml(xml)
    .replace(/(&lt;\/?)([a-zA-Z0-9:_-]+)/g, '$1<span class="xml-tag">$2</span>')
    .replace(/([a-zA-Z0-9:_-]+)=(&quot;.*?&quot;)/g, '<span class="xml-attr-name">$1</span>=<span class="xml-attr-val">$2</span>');
}

// namespace-agnostic element lookup by localName
function findByLocal(root, localName) {
  const out = [];
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === localName) out.push(all[i]);
  }
  return out;
}

function samlValidityRow(label, value) {
  if (!value) return '';
  const t = Date.parse(value);
  let status = '';
  if (!isNaN(t)) {
    const now = Date.now();
    const rel = t - now;
    const mins = Math.round(Math.abs(rel) / 60000);
    if (label === 'NotBefore') {
      status = rel > 0
        ? `<span style="color:var(--warning)">not valid yet (in ${mins} min)</span>`
        : `<span style="color:var(--success)">active</span>`;
    } else if (label === 'NotOnOrAfter' || label === 'SessionNotOnOrAfter') {
      status = rel < 0
        ? `<span style="color:var(--danger)">expired ${mins} min ago</span>`
        : `<span style="color:var(--success)">valid for ${mins} min</span>`;
    }
  }
  return `<tr><td style="padding:6px 10px;color:var(--text-muted)">${label}</td>
    <td style="padding:6px 10px;font-family:var(--font-mono)">${window.escHtml(value)}</td>
    <td style="padding:6px 10px">${status}</td></tr>`;
}

// ── X.509 certificate parsing (12.6) ────────────────────────────────────────
// Minimal DER/ASN.1 walker — WebCrypto can import a certificate's key but
// exposes none of Issuer/Subject/Validity, and there's no vendored X.509
// library in this project (offline-first, zero new deps). Bounded to exactly
// the fields this tool shows: no extension/SAN parsing, no signature check —
// this is a reader, not a validator.
// Bounds-checked: truncated/garbage input must throw (→ x509ParseCertificate's
// catch turns it into an honest {error}), never silently read past the buffer
// and hand back plausible-looking garbage as if it were real cert data.
function derReadLength(bytes, pos) {
  if (pos >= bytes.length) throw new Error('Unexpected end of data');
  let len = bytes[pos];
  pos++;
  if (len & 0x80) {
    const numBytes = len & 0x7f;
    len = 0;
    for (let i = 0; i < numBytes; i++) {
      if (pos >= bytes.length) throw new Error('Unexpected end of data');
      len = (len << 8) | bytes[pos]; pos++;
    }
  }
  return { len, pos };
}

function derReadTLV(bytes, pos) {
  if (pos >= bytes.length) throw new Error('Unexpected end of data');
  const tag = bytes[pos]; pos++;
  const l = derReadLength(bytes, pos);
  if (l.pos + l.len > bytes.length) throw new Error('Unexpected end of data');
  return { tag, len: l.len, valueStart: l.pos, valueEnd: l.pos + l.len, nextPos: l.pos + l.len };
}

// First byte encodes the first two OID components (X*40+Y); the rest are
// base-128 varints. Only used against well-known short X.509 attribute OIDs
// (2.5.4.x), where this simplified decoding is exact.
function x509ParseOid(bytes, start, end) {
  const first = bytes[start];
  const parts = [Math.floor(first / 40), first % 40];
  let val = 0;
  for (let i = start + 1; i < end; i++) {
    val = (val << 7) | (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) { parts.push(val); val = 0; }
  }
  return parts.join('.');
}

const X509_OID_NAMES = {
  '2.5.4.3': 'CN', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.6': 'C',
  '2.5.4.7': 'L', '2.5.4.8': 'ST', '2.5.4.5': 'serialNumber',
  '1.2.840.113549.1.9.1': 'emailAddress'
};

function x509DecodeString(bytes, node) {
  const slice = bytes.slice(node.valueStart, node.valueEnd);
  try { return new TextDecoder('utf-8').decode(slice); }
  catch (e) { return Array.from(slice).map(b => String.fromCharCode(b)).join(''); }
}

function x509ParseName(bytes, nameNode) {
  const parts = [];
  let p = nameNode.valueStart;
  while (p < nameNode.valueEnd) {
    const rdn = derReadTLV(bytes, p); // SET OF AttributeTypeAndValue
    let q = rdn.valueStart;
    while (q < rdn.valueEnd) {
      const atv = derReadTLV(bytes, q); // SEQUENCE
      let r = atv.valueStart;
      const oidNode = derReadTLV(bytes, r); r = oidNode.nextPos;
      const valNode = derReadTLV(bytes, r);
      const oid = x509ParseOid(bytes, oidNode.valueStart, oidNode.valueEnd);
      const label = X509_OID_NAMES[oid] || oid;
      parts.push(label + '=' + x509DecodeString(bytes, valNode));
      q = atv.nextPos;
    }
    p = rdn.nextPos;
  }
  return parts.join(', ');
}

// UTCTime (tag 0x17, YYMMDDHHMMSSZ, 2-digit year pivoted at 50 per X.690) or
// GeneralizedTime (tag 0x18, YYYYMMDDHHMMSSZ) — the only two time encodings
// X.509 validity fields use.
function x509DecodeTime(bytes, node) {
  const str = x509DecodeString(bytes, node);
  if (node.tag === 0x17) {
    const yy = parseInt(str.slice(0, 2), 10);
    const year = yy < 50 ? 2000 + yy : 1900 + yy;
    return new Date(Date.UTC(year, parseInt(str.slice(2, 4), 10) - 1, parseInt(str.slice(4, 6), 10),
      parseInt(str.slice(6, 8), 10), parseInt(str.slice(8, 10), 10), parseInt(str.slice(10, 12), 10)));
  }
  if (node.tag === 0x18) {
    return new Date(Date.UTC(parseInt(str.slice(0, 4), 10), parseInt(str.slice(4, 6), 10) - 1, parseInt(str.slice(6, 8), 10),
      parseInt(str.slice(8, 10), 10), parseInt(str.slice(10, 12), 10), parseInt(str.slice(12, 14), 10)));
  }
  return null;
}

// Returns null (not an error) when there's simply nothing to parse; returns
// { error } when there IS a certificate but this reader can't make sense of
// it — the caller shows that honestly instead of pretending nothing was found.
function x509ParseCertificate(base64) {
  const clean = String(base64 == null ? '' : base64).replace(/-----[^-]+-----/g, '').replace(/[\r\n\s]+/g, '');
  if (!clean) return null;
  let bytes;
  try { bytes = b64ToBytes(clean); } catch (e) { return { error: 'Not valid Base64.' }; }
  try {
    const cert = derReadTLV(bytes, 0);
    const tbs = derReadTLV(bytes, cert.valueStart);
    let p = tbs.valueStart;
    let node = derReadTLV(bytes, p);
    if (node.tag === 0xA0) { p = node.nextPos; node = derReadTLV(bytes, p); } // optional [0] version; node now = serialNumber
    p = node.nextPos;
    node = derReadTLV(bytes, p); p = node.nextPos; // signature AlgorithmIdentifier
    const issuerNode = derReadTLV(bytes, p); p = issuerNode.nextPos;
    const validityNode = derReadTLV(bytes, p); p = validityNode.nextPos;
    const subjectNode = derReadTLV(bytes, p);

    let vp = validityNode.valueStart;
    const nbNode = derReadTLV(bytes, vp); vp = nbNode.nextPos;
    const naNode = derReadTLV(bytes, vp);
    const notBefore = x509DecodeTime(bytes, nbNode);
    const notAfter = x509DecodeTime(bytes, naNode);

    return {
      issuer: x509ParseName(bytes, issuerNode),
      subject: x509ParseName(bytes, subjectNode),
      notBefore, notAfter,
      isExpired: notAfter ? Date.now() > notAfter.getTime() : null
    };
  } catch (e) {
    return { error: 'Could not parse this certificate (unsupported or malformed DER structure).' };
  }
}

function x509RenderCertificate(cert) {
  if (!cert) return '';
  if (cert.error) return `<div class="notice notice-warning" style="margin-bottom:var(--sp-3)">Certificate found but could not be parsed: ${window.escHtml(cert.error)}</div>`;
  const fmt = d => d ? d.toISOString() : '(unparsed)';
  const expiredBadge = cert.isExpired === true ? '<span style="color:var(--danger)">expired</span>'
    : cert.isExpired === false ? '<span style="color:var(--success)">valid</span>' : '';
  return `<div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:var(--sp-2)">Signing Certificate (X.509)</div>
    <table style="width:100%;border-collapse:collapse;font-size:0.82rem;margin-bottom:var(--sp-3);background:var(--bg-elevated);border-radius:var(--r-md)">
      <tr><td style="padding:6px 10px;color:var(--text-muted);width:150px">Issuer</td><td style="padding:6px 10px;font-family:var(--font-mono)">${window.escHtml(cert.issuer || '(unknown)')}</td></tr>
      <tr><td style="padding:6px 10px;color:var(--text-muted)">Subject</td><td style="padding:6px 10px;font-family:var(--font-mono)">${window.escHtml(cert.subject || '(unknown)')}</td></tr>
      <tr><td style="padding:6px 10px;color:var(--text-muted)">Valid From</td><td style="padding:6px 10px;font-family:var(--font-mono)">${window.escHtml(fmt(cert.notBefore))}</td></tr>
      <tr><td style="padding:6px 10px;color:var(--text-muted)">Valid To</td><td style="padding:6px 10px;font-family:var(--font-mono)">${window.escHtml(fmt(cert.notAfter))} ${expiredBadge}</td></tr>
    </table>`;
}

// ── Clock-skew hint (12.6) ──────────────────────────────────────────────────
// Pure: minutes NotBefore sits in the future relative to `nowMs`, or null when
// NotBefore is absent/unparseable/not in the future (nothing to warn about).
function samlClockSkewMinutes(notBeforeIso, nowMs) {
  if (!notBeforeIso) return null;
  const t = Date.parse(notBeforeIso);
  if (isNaN(t) || t <= nowMs) return null;
  return Math.round((t - nowMs) / 60000);
}

async function samlDecodeSaml() {
  const raw = document.getElementById('saml-input').value;
  const xmlEl = document.getElementById('saml-xml-output');
  const sumEl = document.getElementById('saml-summary');
  try {
    if (window.showLoader) window.showLoader('Decoding SAML...');
    const xml = await samlToXml(raw);
    if (window.hideLoader) window.hideLoader();

    xmlEl.innerHTML = highlightXml(prettyXml(xml));

    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      sumEl.innerHTML = '<div class="notice notice-warning">Decoded to text, but it is not well-formed XML. Showing raw output only.</div>';
      return;
    }

    const rootName = doc.documentElement.localName; // Response | AuthnRequest | LogoutRequest ...
    const issuer = findByLocal(doc, 'Issuer')[0];
    const statusCode = findByLocal(doc, 'StatusCode')[0];
    const nameId = findByLocal(doc, 'NameID')[0];
    const conditions = findByLocal(doc, 'Conditions')[0];
    const audiences = findByLocal(doc, 'Audience');
    const authnStmt = findByLocal(doc, 'AuthnStatement')[0];
    const attributes = findByLocal(doc, 'Attribute');
    const x509CertEl = findByLocal(doc, 'X509Certificate')[0];
    const hasSignature = findByLocal(doc, 'Signature').length > 0;

    let html = '';

    // Message type + status
    html += `<div class="notice ${statusCode && !/:Success$/.test(statusCode.getAttribute('Value') || '') ? 'notice-danger' : 'notice-info'}" style="margin-bottom:var(--sp-3)">
      <div><strong>Message type:</strong> ${window.escHtml(rootName)}${hasSignature ? ' &middot; <span style="color:var(--success)">signed (ds:Signature present)</span>' : ' &middot; <span style="color:var(--warning)">no signature found</span>'}</div>
      ${statusCode ? `<div style="margin-top:4px"><strong>Status:</strong> <span style="font-family:var(--font-mono)">${window.escHtml((statusCode.getAttribute('Value') || '').split(':').pop())}</span></div>` : ''}
    </div>`;

    // Identity block
    html += '<table style="width:100%;border-collapse:collapse;font-size:0.82rem;margin-bottom:var(--sp-3)">';
    if (issuer) html += `<tr><td style="padding:6px 10px;color:var(--text-muted);width:150px">Issuer (IdP)</td><td style="padding:6px 10px;font-family:var(--font-mono)">${window.escHtml(issuer.textContent.trim())}</td></tr>`;
    if (nameId) html += `<tr><td style="padding:6px 10px;color:var(--text-muted)">Subject (NameID)</td><td style="padding:6px 10px;font-family:var(--font-mono)">${window.escHtml(nameId.textContent.trim())}${nameId.getAttribute('Format') ? `<div style="color:var(--text-muted);font-size:0.72rem">${window.escHtml(nameId.getAttribute('Format'))}</div>` : ''}</td></tr>`;
    if (audiences.length) html += `<tr><td style="padding:6px 10px;color:var(--text-muted)">Audience (SP)</td><td style="padding:6px 10px;font-family:var(--font-mono)">${audiences.map(a => window.escHtml(a.textContent.trim())).join('<br>')}</td></tr>`;
    html += '</table>';

    // Validity timeline
    const nb = conditions && conditions.getAttribute('NotBefore');
    const noa = conditions && conditions.getAttribute('NotOnOrAfter');
    const sessionNoa = authnStmt && authnStmt.getAttribute('SessionNotOnOrAfter');
    const authnInstant = authnStmt && authnStmt.getAttribute('AuthnInstant');
    if (nb || noa || sessionNoa || authnInstant) {
      html += '<div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:var(--sp-2)">Validity Window</div>';
      html += '<table style="width:100%;border-collapse:collapse;font-size:0.82rem;margin-bottom:var(--sp-3);background:var(--bg-elevated);border-radius:var(--r-md)">';
      html += samlValidityRow('AuthnInstant', authnInstant);
      html += samlValidityRow('NotBefore', nb);
      html += samlValidityRow('NotOnOrAfter', noa);
      html += samlValidityRow('SessionNotOnOrAfter', sessionNoa);
      html += '</table>';

      const skewMins = samlClockSkewMinutes(nb, Date.now());
      if (skewMins !== null) {
        html += `<div class="notice notice-warning" style="margin-bottom:var(--sp-3)"><strong>NotBefore is ${skewMins} min in the future.</strong> Your server clock is likely behind the IdP by roughly that much — check NTP sync on this machine (or the IdP's clock-skew allowance is unusually large).</div>`;
      }
    }

    // Signing certificate
    if (x509CertEl) html += x509RenderCertificate(x509ParseCertificate(x509CertEl.textContent));

    // Attributes
    if (attributes.length) {
      html += '<div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:var(--sp-2)">Attributes / Claims</div>';
      html += '<table style="width:100%;border-collapse:collapse;font-size:0.82rem"><thead><tr style="color:var(--text-muted);text-align:left"><th style="padding:6px 10px">Name</th><th style="padding:6px 10px">Value(s)</th></tr></thead><tbody>';
      attributes.forEach(attr => {
        const name = attr.getAttribute('FriendlyName') || attr.getAttribute('Name') || '(unnamed)';
        const values = findByLocal(attr, 'AttributeValue').map(v => window.escHtml(v.textContent.trim())).join('<br>');
        html += `<tr style="border-top:1px solid var(--border)"><td style="padding:6px 10px;font-family:var(--font-mono)">${window.escHtml(name)}</td><td style="padding:6px 10px;font-family:var(--font-mono)">${values}</td></tr>`;
      });
      html += '</tbody></table>';
    }

    sumEl.innerHTML = html;
  } catch (err) {
    if (window.hideLoader) window.hideLoader();
    xmlEl.textContent = '';
    sumEl.innerHTML = `<div class="notice notice-danger">${window.escHtml(err.message)}</div>`;
  }
}

// ── OIDC id_token decoding ──────────────────────────────────

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return decodeURIComponent(escape(atob(str)));
}

const OIDC_CLAIM_HELP = {
  iss: 'Issuer — the IdP that issued this token. Must match the expected authority.',
  sub: 'Subject — stable unique identifier of the end user at the IdP.',
  aud: 'Audience — the client_id this token was issued for. Your app must be listed here.',
  exp: 'Expiration time (epoch). The token must be rejected at/after this time.',
  iat: 'Issued-at time (epoch).',
  nbf: 'Not-before time (epoch).',
  nonce: 'Binds the token to the auth request — must equal the nonce your app sent.',
  azp: 'Authorized party — the client_id the token was issued to (relevant with multiple audiences).',
  at_hash: 'Access-token hash — lets the client verify the paired access_token.',
  auth_time: 'Time the end-user authentication occurred (epoch).',
  acr: 'Authentication Context Class Reference (assurance level).',
  amr: 'Authentication Methods References (e.g. pwd, mfa).'
};

function samlDecodeOidc() {
  const raw = document.getElementById('saml-oidc-input').value.trim();
  const out = document.getElementById('saml-oidc-output');
  if (!raw) { out.innerHTML = '<div class="notice notice-info">Paste an OIDC id_token (JWT) above.</div>'; return; }

  const parts = raw.split('.');
  if (parts.length < 2) { out.innerHTML = '<div class="notice notice-danger">Not a JWT — expected header.payload.signature.</div>'; return; }

  let header, payload;
  try { header = JSON.parse(b64urlDecode(parts[0])); payload = JSON.parse(b64urlDecode(parts[1])); }
  catch (e) { out.innerHTML = `<div class="notice notice-danger">Could not decode JWT: ${window.escHtml(e.message)}</div>`; return; }

  let html = '';
  const now = Math.floor(Date.now() / 1000);

  // Validity banner from exp/nbf
  if (payload.exp !== undefined) {
    const rel = payload.exp - now;
    const mins = Math.round(Math.abs(rel) / 60);
    html += rel < 0
      ? `<div class="notice notice-danger" style="margin-bottom:var(--sp-3)"><strong>Expired</strong> ${mins} min ago (exp ${new Date(payload.exp * 1000).toISOString()})</div>`
      : `<div class="notice notice-info" style="margin-bottom:var(--sp-3)"><strong>Valid</strong> for ${mins} more min (exp ${new Date(payload.exp * 1000).toISOString()})</div>`;
  }

  html += `<div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:var(--sp-2)">Header</div>`;
  html += `<pre class="code-area" style="background:var(--bg-elevated);padding:var(--sp-2);border-radius:var(--r-md);margin-bottom:var(--sp-3);font-size:0.8rem">${window.escHtml(JSON.stringify(header, null, 2))}</pre>`;

  html += `<div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:var(--sp-2)">Claims</div>`;
  html += '<table style="width:100%;border-collapse:collapse;font-size:0.82rem"><tbody>';
  Object.keys(payload).forEach(k => {
    let v = payload[k];
    let display = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if ((k === 'exp' || k === 'iat' || k === 'nbf' || k === 'auth_time') && typeof v === 'number') {
      display += ` <span style="color:var(--text-muted)">(${new Date(v * 1000).toISOString()})</span>`;
    }
    const help = OIDC_CLAIM_HELP[k];
    html += `<tr style="border-top:1px solid var(--border)">
      <td style="padding:6px 10px;font-family:var(--font-mono);color:var(--accent);vertical-align:top">${window.escHtml(k)}</td>
      <td style="padding:6px 10px;font-family:var(--font-mono);word-break:break-all">${window.escHtml(display)}${help ? `<div style="color:var(--text-muted);font-family:var(--font-sans);font-size:0.72rem;margin-top:2px">${help}</div>` : ''}</td>
    </tr>`;
  });
  html += '</tbody></table>';

  out.innerHTML = html;
}

// --- ESM EXPORTS ---
window.samlSetTab = samlSetTab;
window.samlDecodeActive = samlDecodeActive;
window.samlDecodeSaml = samlDecodeSaml;
window.samlDecodeOidc = samlDecodeOidc;

// Exposed for scripts/parser-test.js (pure functions, no DOM).
window.x509ParseCertificate = x509ParseCertificate;
window.samlClockSkewMinutes = samlClockSkewMinutes;

export function init() {}
