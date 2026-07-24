// PASSWORD GENERATOR
// ============================================================
// Extracted from misc-mendix.js (Fala 7.4) — purely mechanical, no behavior
// change.

function generatePassword() {
  const len = parseInt(document.getElementById('pwd-len').value);
  const up = document.getElementById('pwd-upper').checked;
  const low = document.getElementById('pwd-lower').checked;
  const num = document.getElementById('pwd-num').checked;
  const spec = document.getElementById('pwd-spec').checked;

  const cUp = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const cLow = "abcdefghijklmnopqrstuvwxyz";
  const cNum = "0123456789";
  const cSpec = "!@#$%^&*()_+~`|}{[]:;?><,./-=";

  let chars = "";
  if (up) chars += cUp;
  if (low) chars += cLow;
  if (num) chars += cNum;
  if (spec) chars += cSpec;

  if (chars.length === 0) {
    document.getElementById('pwd-result').value = "Select at least one character type";
    return;
  }

  let pwd = "";
  const array = new Uint32Array(len);
  window.crypto.getRandomValues(array);

  for (let i = 0; i < len; i++) {
    pwd += chars[array[i] % chars.length];
  }

  document.getElementById('pwd-result').value = pwd;
}

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.generatePassword = generatePassword;

export function init() {}
