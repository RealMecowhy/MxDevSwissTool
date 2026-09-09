'use strict';
const crypto = require('crypto');

// The Ed25519 public key that release signatures must verify against. The
// matching private key is held only as the MXDEV_RELEASE_PRIVATE_KEY GitHub
// Actions secret (see scripts/gen-release-key.js). An empty string means "no
// signed release has been published yet" — verifyReleasePackage() then returns
// { ok: true, verified: false } so the updater still works for existing users.
const RELEASE_PUBLIC_KEY_PEM = '';

// Reject a ZIP entry name that would escape the extraction dir: absolute paths,
// drive letters, or any '..' path segment (either slash). true = safe.
function isSafeZipEntryName(name) {
  if (typeof name !== 'string' || !name) return false;
  const n = name.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return false;
  return !n.split('/').some(seg => seg === '..');
}

// data: Buffer of the downloaded ZIP. sigBase64: contents of the .sig asset
// (base64 of a 64-byte Ed25519 signature), or null/'' if none. pubKeyPem:
// defaults to RELEASE_PUBLIC_KEY_PEM; parameterised for tests.
// Returns { ok, verified, reason }:
//   ok:false                 -> refuse the update, show `reason`
//   ok:true, verified:true    -> signature checked out, proceed
//   ok:true, verified:false   -> no key configured yet OR no .sig asset; proceed but caller warns
function verifyReleasePackage(data, sigBase64, pubKeyPem) {
  const pem = pubKeyPem == null ? RELEASE_PUBLIC_KEY_PEM : pubKeyPem;
  if (!pem) return { ok: true, verified: false, reason: 'No release public key is configured in this build.' };
  if (!sigBase64) return { ok: true, verified: false, reason: 'This release has no signature asset (.sig).' };
  if (!Buffer.isBuffer(data) || data.length === 0) return { ok: false, reason: 'The downloaded package is empty.' };
  let sig;
  try { sig = Buffer.from(String(sigBase64).trim(), 'base64'); }
  catch (e) { return { ok: false, reason: 'The signature asset is not valid base64.' }; }
  if (sig.length !== 64) return { ok: false, reason: `The signature is ${sig.length} bytes, expected 64.` };
  let key;
  try { key = crypto.createPublicKey(pem); }
  catch (e) { return { ok: false, reason: 'The bundled release public key is malformed.' }; }
  let good = false;
  try { good = crypto.verify(null, data, key, sig); }
  catch (e) { return { ok: false, reason: 'Signature verification threw: ' + e.message }; }
  if (good) return { ok: true, verified: true, reason: 'Signature verified.' };
  return { ok: false, reason: 'The package signature does not match this build\'s release key — the download may be corrupted or tampered with. Update aborted; use the manual ZIP from the Releases page.' };
}

module.exports = { RELEASE_PUBLIC_KEY_PEM, isSafeZipEntryName, verifyReleasePackage };
