// XPATH BUILDER
// ============================================================
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
    // 7.7: name the actual hop(s) instead of a generic count — an association
    // path is read from each bracketed constraint, taking every segment but
    // the last (the final segment is the attribute/condition, not a hop).
    // If nothing confidently parses, fall back to the plain count rather than
    // inventing a path (data-driven rule: no guessed hops).
    const hops = xpathDeepHops(val);
    warnings.push(hops.length
      ? '<strong>Deep association path (' + hops.length + ' hops):</strong> via ' + hops.map(h => '<code>' + escHtml(h) + '</code>').join(' &rarr; ') +
        '. Each hop translates to an SQL INNER/LEFT JOIN. Deep paths on large tables severely impact performance — consider a reverse reference to shorten it.'
      : '<strong>Deep associations (' + slashes + ' hops):</strong> Each association hop translates to an SQL INNER/LEFT JOIN. Deep paths on large tables severely impact performance.');
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

// Association hops inside each bracketed constraint: every '/'-separated
// segment except the last one (which is the attribute/condition, not a hop).
function xpathDeepHops(val) {
  const hops = [];
  const bracketRe = /\[([^\]]*)\]/g;
  let bm;
  while ((bm = bracketRe.exec(val)) !== null) {
    const segs = bm[1].split('/');
    if (segs.length < 2) continue;
    for (let i = 0; i < segs.length - 1; i++) {
      const m = segs[i].trim().match(/[A-Za-z_][\w.]*$/);
      if (m) hops.push(m[0]);
    }
  }
  return hops;
}

function formatXPathClick() {
  let val = document.getElementById('xpath-input').value;
  if (!val) { document.getElementById('xpath-output').value = ''; return; }
  // String-aware formatting: only insert breaks outside string literals
  let result = '', inStr = false, strChar = '';
  for (let i = 0; i < val.length; i++) {
    const ch = val[i];
    if (!inStr && (ch === "'" || ch === '"')) { inStr = true; strChar = ch; result += ch; }
    else if (inStr && ch === strChar) { inStr = false; result += ch; }
    else if (!inStr) {
      const rest = val.slice(i);
      const andM = rest.match(/^(\s+and\s+)/i);
      const orM  = rest.match(/^(\s+or\s+)/i);
      const bracketPair = rest.match(/^\]\[/);
      if (andM)        { result += '\n  and '; i += andM[1].length - 1; }
      else if (orM)    { result += '\n  or ';  i += orM[1].length - 1; }
      else if (bracketPair) { result += ']\n['; i += 1; }
      else             { result += ch; }
    } else { result += ch; }
  }
  document.getElementById('xpath-output').value = result;
  xpathAnalyze();
}

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.xpathAnalyze = xpathAnalyze;
window.formatXPathClick = formatXPathClick;

export function init() {}
