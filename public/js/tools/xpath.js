// XPATH BUILDER
// ============================================================
let xpathCheatsheetWired = false;
function initXpath() {
  // Cheat sheet: click any snippet to copy it (single delegated listener)
  const sheet = document.getElementById('xpath-cheatsheet');
  if (!sheet || xpathCheatsheetWired) return;
  xpathCheatsheetWired = true;
  sheet.addEventListener('click', (e) => {
    const item = e.target.closest('.xcs-item');
    if (!item) return;
    const snippet = item.getAttribute('data-snippet');
    if (!snippet) return;
    window.copyToClipboard(snippet);
    const codeEl = item.querySelector('code');
    if (codeEl && !item.dataset.flashing) {
      item.dataset.flashing = '1';
      const original = codeEl.textContent;
      codeEl.textContent = '✓ Copied';
      setTimeout(() => { codeEl.textContent = original; delete item.dataset.flashing; }, 900);
    }
  });
}
function xpathAnalyze() {
  const val = document.getElementById('xpath-input').value.trim();
  const res = document.getElementById('xpath-result');
  const lintRes = document.getElementById('xpath-linter-result');
  const lintText = document.getElementById('xpath-linter-text');
  if (!val) {
    res.style.display='none';
    if(lintRes)lintRes.style.display='none';
    const out = document.getElementById('xpath-output');
    if (out) out.value = '';
    return;
  }
  
  const parts=[];
  const warnings=[];
  
  if (val.includes('starts-with')) parts.push('Uses starts-with()');
  if (val.includes('contains')) {
    parts.push('Uses contains()');
    warnings.push('<strong>contains() blocks indexes:</strong> Forces a sequential scan on the database. Prefer starts-with() or exact match if possible.');
  }
  if (val.includes('CurrentUser')) parts.push('Filtered by current user');
  if (/\band\b/i.test(val)) parts.push('Multiple AND conditions');
  
  if (/\bor\b/i.test(val)) {
    parts.push('Multiple OR conditions');
    warnings.push('<strong>OR conditions:</strong> Often lead to suboptimal index usage. Verify if both sides of OR use the same indexed attribute, otherwise performance may suffer.');
  }
  
  if (val.includes('!=')) warnings.push('<strong>Negation (!=):</strong> Negation operators usually prevent the database from using indexes effectively.');
  if (val.includes('not(')) warnings.push('<strong>not() function:</strong> Negation often causes full table scans.');
  
  const slashes = (val.match(/\//g) || []).length;
  if (slashes > 0) parts.push('Traverses association(s)');
  if (slashes > 1) {
    warnings.push('<strong>Deep associations ('+slashes+' hops):</strong> Each association hop translates to an SQL INNER/LEFT JOIN. Deep paths on large tables severely impact performance.');
  }
  
  if (!parts.length) parts.push('Simple attribute filter');
  
  document.getElementById('xpath-result-text').textContent = parts.join(' · ');
  res.style.display='flex';
  
  if (lintRes) {
    if (warnings.length > 0) {
      lintText.innerHTML = warnings.map(w => '<div style="font-size:0.85rem">&bull; ' + w + '</div>').join('');
      lintRes.style.display='flex';
    } else {
      lintRes.style.display='none';
    }
  }
}

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.initXpath = initXpath;
window.xpathAnalyze = xpathAnalyze;

export function init() { initXpath(); }
