// PASSWORD GENERATOR
// ============================================================
// Extracted from misc-mendix.js (Fala 7.4) — purely mechanical, no behavior
// change.

const PWD_CHARSETS = {
  up: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  low: "abcdefghijklmnopqrstuvwxyz",
  num: "0123456789",
  spec: "!@#$%^&*()_+~`|}{[]:;?><,./-=",
};

// Pure — testable from scripts/parser-test.js without touching the DOM.
function pwdEntropyBits(length, charsetSize) {
  if (!length || !charsetSize || charsetSize <= 1) return 0;
  return length * Math.log2(charsetSize);
}

function pwdStrengthLabel(bits) {
  if (bits < 40) return 'Weak';
  if (bits < 60) return 'Fair';
  if (bits < 80) return 'Good';
  if (bits < 100) return 'Strong';
  return 'Very strong';
}

// Illustrative only — actual crack speed depends entirely on how the
// password is hashed (bcrypt vs. an unsalted fast hash differ by orders of
// magnitude), so this is presented as a single stated assumption, not a
// universal truth.
function pwdCrackTimeSeconds(bits, guessesPerSecond) {
  guessesPerSecond = guessesPerSecond || 1e10;
  return Math.pow(2, bits) / guessesPerSecond;
}

function pwdFormatDuration(seconds) {
  if (!isFinite(seconds)) return 'effectively never';
  if (seconds < 1) return '< 1 second';
  const units = [['year', 31536000], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  for (let i = 0; i < units.length; i++) {
    const name = units[i][0], secs = units[i][1];
    if (seconds >= secs) {
      const v = seconds / secs;
      if (v > 1e6) return '> 1,000,000 ' + name + 's';
      const r = Math.round(v);
      return '~' + r.toLocaleString() + ' ' + name + (r === 1 ? '' : 's');
    }
  }
  return '< 1 second';
}

function pwdBuildCharset(opts) {
  let chars = '';
  if (opts.up) chars += PWD_CHARSETS.up;
  if (opts.low) chars += PWD_CHARSETS.low;
  if (opts.num) chars += PWD_CHARSETS.num;
  if (opts.spec) chars += PWD_CHARSETS.spec;
  return chars;
}

function pwdRandomOne(chars, length) {
  let pwd = '';
  const array = new Uint32Array(length);
  window.crypto.getRandomValues(array);
  for (let i = 0; i < length; i++) pwd += chars[array[i] % chars.length];
  return pwd;
}

function pwdRenderStrength(bits) {
  const el = document.getElementById('pwd-strength');
  if (!el) return;
  if (!bits) { el.innerHTML = ''; return; }
  const label = pwdStrengthLabel(bits);
  const pct = Math.min(100, Math.round((bits / 100) * 100));
  const color = bits < 40 ? 'var(--danger)' : bits < 60 ? 'var(--warning)' : bits < 80 ? 'var(--info)' : 'var(--success)';
  const crack = pwdFormatDuration(pwdCrackTimeSeconds(bits));
  el.innerHTML =
    '<div style="display:flex;justify-content:space-between;font-size:.75rem;color:var(--text-secondary);margin-bottom:4px">' +
      '<span>' + label + ' &middot; ' + Math.round(bits) + ' bits of entropy</span>' +
      '<span title="Illustrative only, assuming 10 billion guesses/sec — real speed depends on how the password is hashed">est. crack time: ' + crack + '</span>' +
    '</div>' +
    '<div style="height:6px;border-radius:3px;background:var(--bg-elevated);overflow:hidden">' +
      '<div style="height:100%;width:' + pct + '%;background:' + color + '"></div>' +
    '</div>';
}

function generatePassword() {
  const len = parseInt(document.getElementById('pwd-len').value, 10);
  const opts = {
    up: document.getElementById('pwd-upper').checked,
    low: document.getElementById('pwd-lower').checked,
    num: document.getElementById('pwd-num').checked,
    spec: document.getElementById('pwd-spec').checked,
  };
  const chars = pwdBuildCharset(opts);
  const resultEl = document.getElementById('pwd-result');

  if (chars.length === 0) {
    resultEl.value = "Select at least one character type";
    pwdRenderStrength(0);
    return;
  }

  const countEl = document.getElementById('pwd-count');
  const count = Math.max(1, Math.min(50, parseInt(countEl && countEl.value, 10) || 1));
  const passwords = [];
  for (let i = 0; i < count; i++) passwords.push(pwdRandomOne(chars, len));

  resultEl.value = passwords.join('\n');
  resultEl.rows = Math.min(10, count);
  pwdRenderStrength(pwdEntropyBits(len, chars.length));
}

// 12+ chars, upper+lower+digit+special — Mendix Cloud's own minimum for
// admin/service passwords.
function pwdApplyMendixCloudPreset() {
  document.getElementById('pwd-len').value = 12;
  document.getElementById('pwd-len-val').innerText = 12;
  document.getElementById('pwd-upper').checked = true;
  document.getElementById('pwd-lower').checked = true;
  document.getElementById('pwd-num').checked = true;
  document.getElementById('pwd-spec').checked = true;
  generatePassword();
}

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.generatePassword = generatePassword;
window.pwdApplyMendixCloudPreset = pwdApplyMendixCloudPreset;
window.pwdEntropyBits = pwdEntropyBits;
window.pwdStrengthLabel = pwdStrengthLabel;
window.pwdCrackTimeSeconds = pwdCrackTimeSeconds;
window.pwdFormatDuration = pwdFormatDuration;
window.pwdBuildCharset = pwdBuildCharset;

export function init() {}
