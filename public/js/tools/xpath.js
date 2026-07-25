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
    fvRender('xpath-output', '');
    const ed = document.getElementById('xpath-edit');
    if (ed) ed.value = '';
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

  // Masked (sqeMask) so a literal '/' inside a string constraint — a URL, a
  // 'dd/mm/yyyy' date — is never counted as an association hop; same reasoning
  // as xpathDeepHops below, which this count gates.
  const slashes = (sqeMask(val).masked.match(/\//g) || []).length;
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
// Masked first (sql-engine.js's sqeMask) so a string literal containing a
// literal '/' — a URL, a 'dd/mm/yyyy' date, a path — never gets split into
// fake hop segments; only slashes that are real association separators
// survive into the masked text.
function xpathDeepHops(val) {
  const hops = [];
  const masked = sqeMask(val);
  const bracketRe = /\[([^\]]*)\]/g;
  let bm;
  while ((bm = bracketRe.exec(masked.masked)) !== null) {
    const segs = bm[1].split('/');
    if (segs.length < 2) continue;
    for (let i = 0; i < segs.length - 1; i++) {
      const m = segs[i].trim().match(/[A-Za-z_][\w.]*$/);
      if (m) hops.push(m[0]);
    }
  }
  return hops;
}

// ── XPath → OQL conversion (12.4) ───────────────────────────────────────────
// Best-effort, like xpathDeepHops above — not a full XPath grammar. Two things
// are honestly refused rather than guessed, with the reason kept as a `-- `
// comment AND a bare string literal in the WHERE clause that fails loudly if
// run as-is (a string is not a boolean — Postgres rejects it), rather than a
// placeholder that would silently widen or narrow the real result set:
//  - not(...) and any parenthesized sub-group — precedence gets ambiguous
//    fast, and a wrong guess here silently changes query semantics.
//  - association hops (a '/' in the left-hand path): raw XPath only names the
//    ASSOCIATION, never the target entity, but this app's own OQL join syntax
//    (alias/Module.Assoc/Module.Entity — see query-intelligence.js) requires
//    that entity name explicitly. It isn't in the XPath text, so it can't be
//    filled in without guessing.
// This tool's input is normally a bare constraint (`[Status = 'Active']`, per
// its own placeholder) rather than a full `//Module.Entity[...]` — a leading
// `//Module.Entity` is still recognized when present (e.g. pasted from a cross
// link elsewhere in the app), but its absence just means the FROM clause gets
// an honest `<Module.Entity>` placeholder instead of a guessed entity name.
function xpathToOql(xpath) {
  const val = String(xpath == null ? '' : xpath).trim();
  if (!val) return { oql: '', notes: [] };

  const masked = sqeMask(val);
  const text = masked.masked;
  const unmaskFrag = s => sqeUnmask(s, masked.tokens);
  const notes = [];
  const rootAlias = 'e';

  const rootMatch = text.match(/^\/\/([A-Za-z_]\w*)\.([A-Za-z_]\w*)/);
  let fromEntity, bodyStart;
  if (rootMatch) {
    fromEntity = rootMatch[1] + '.' + rootMatch[2];
    bodyStart = rootMatch[0].length;
  } else {
    fromEntity = '<Module.Entity>';
    bodyStart = 0;
    notes.push("No root entity in the input (this tool accepts bare constraints like [Status = 'Active']) — replace <Module.Entity> below with the real entity.");
  }

  // Top-level [...] blocks — XPath ANDs them together implicitly.
  const blocks = [];
  {
    let depth = 0, cur = '';
    for (let i = bodyStart; i < text.length; i++) {
      const c = text[i];
      if (c === '[') { if (depth === 0) cur = ''; else cur += c; depth++; continue; }
      if (c === ']') { depth--; if (depth === 0) blocks.push(cur); else cur += c; continue; }
      if (depth > 0) cur += c;
    }
  }

  function splitBoolean(block) {
    const exprs = [], joiners = [];
    let depth = 0, cur = '', i = 0;
    while (i < block.length) {
      const c = block[i];
      if (c === '(') { depth++; cur += c; i++; continue; }
      if (c === ')') { depth--; cur += c; i++; continue; }
      if (depth === 0) {
        const rest = block.slice(i);
        const andM = rest.match(/^\s+and\s+/i);
        const orM = rest.match(/^\s+or\s+/i);
        if (andM) { exprs.push(cur.trim()); joiners.push('AND'); cur = ''; i += andM[0].length; continue; }
        if (orM) { exprs.push(cur.trim()); joiners.push('OR'); cur = ''; i += orM[0].length; continue; }
      }
      cur += c; i++;
    }
    exprs.push(cur.trim());
    return { exprs, joiners };
  }

  function translatePath(path) {
    const segs = path.split('/').map(s => s.trim()).filter(Boolean);
    if (segs.length <= 1) return { ref: rootAlias + '.' + (segs[0] || path), hop: false };
    return { hop: true };
  }

  function hopNote(path) {
    return "association hop not translated — XPath does not name the target entity, but this app's OQL join syntax (alias/Module.Assoc/Module.Entity) requires it: `" + unmaskFrag(path) + '`';
  }

  function translateAtomic(expr) {
    const t = expr.trim();
    if (/^not\s*\(/i.test(t)) return { sql: null, note: 'not(...) condition not translated: `' + unmaskFrag(t) + '`' };
    if (/^\(.*\)$/.test(t)) return { sql: null, note: 'grouped condition not translated: `' + unmaskFrag(t) + '`' };

    let m = t.match(/^contains\(\s*([^,]+?)\s*,\s*(.+)\)$/i);
    if (m) {
      const col = translatePath(m[1].trim());
      if (col.hop) return { sql: null, note: hopNote(m[1].trim()) };
      const raw = unmaskFrag(m[2].trim()).replace(/^'(.*)'$/, '$1');
      return { sql: col.ref + " LIKE '%" + raw + "%'" };
    }
    m = t.match(/^starts-with\(\s*([^,]+?)\s*,\s*(.+)\)$/i);
    if (m) {
      const col = translatePath(m[1].trim());
      if (col.hop) return { sql: null, note: hopNote(m[1].trim()) };
      const raw = unmaskFrag(m[2].trim()).replace(/^'(.*)'$/, '$1');
      return { sql: col.ref + " LIKE '" + raw + "%'" };
    }
    m = t.match(/^(.+?)\s*(!=|>=|<=|=|>|<)\s*(.+)$/);
    if (!m) return { sql: null, note: 'unrecognized condition not translated: `' + unmaskFrag(t) + '`' };
    const col = translatePath(m[1].trim());
    if (col.hop) return { sql: null, note: hopNote(m[1].trim()) };
    return { sql: col.ref + ' ' + m[2] + ' ' + unmaskFrag(m[3].trim()) };
  }

  const blockStrings = blocks.map(block => {
    const { exprs, joiners } = splitBoolean(block);
    const pieces = [];
    exprs.forEach((expr, idx) => {
      const r = translateAtomic(expr);
      if (r.sql) { pieces.push(r.sql); }
      else { notes.push(r.note); pieces.push('/* UNTRANSLATED: ' + r.note + " */ '#FIX_ME#'"); }
      if (idx < joiners.length) pieces.push(joiners[idx]);
    });
    const joined = pieces.join(' ');
    return exprs.length > 1 ? '(' + joined + ')' : joined;
  });

  const whereClause = blockStrings.join(' AND ');
  let oql = 'SELECT * FROM ' + fromEntity + ' ' + rootAlias;
  if (whereClause) oql += '\nWHERE ' + whereClause;
  if (notes.length) oql = notes.map(n => '-- ' + n).join('\n') + '\n' + oql;
  return { oql, notes };
}

window.xpathConvertToOql = function () {
  const input = document.getElementById('xpath-input');
  const result = xpathToOql(input ? input.value : '');
  if (!result.oql) { alert('Enter an XPath expression or constraint first.'); return; }
  window.navigateWithReturn('query-intelligence');
  const tabBtn = document.querySelector('#panel-query-intelligence .tabs .tab[data-help-key="query-intelligence-formatter"]');
  if (window.qiSetTab) window.qiSetTab('formatter', tabBtn);
  const oqlInput = document.getElementById('oql-input');
  if (oqlInput) {
    oqlInput.value = result.oql;
    if (window.formatOql) window.formatOql();
  }
};

function formatXPathClick() {
  let val = document.getElementById('xpath-input').value;
  if (!val) { fvRender('xpath-output', ''); const ed = document.getElementById('xpath-edit'); if (ed) ed.value = ''; return; }
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
  fvRender('xpath-output', xpathHighlight(result));
  const ed = document.getElementById('xpath-edit');
  if (ed) ed.value = result;
  xpathAnalyze();
}

// XPath function names carry hyphens (`starts-with`, `string-length`), which
// the shared fvFnCall (bare-identifier) matcher won't span — hence this local
// variant. Runs before the path matcher so `contains` in `contains(...)` is a
// function, not an attribute.
function xpathFnCall(text, i) {
  if (i > 0 && /[A-Za-z_$-]/.test(text[i - 1])) return null;
  const re = /[A-Za-z_][A-Za-z0-9_-]*/y;
  re.lastIndex = i;
  const m = re.exec(text);
  if (!m) return null;
  let j = i + m[0].length;
  while (text[j] === ' ' || text[j] === '\t') j++;
  return text[j] === '(' ? { t: 'fn', len: m[0].length } : null;
}

const XPATH_MATCHERS = [
  fvRe('ws', '[ \\t\\r\\n]+'),
  fvRe('str', "'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\""),
  fvRe('sysvar', '\\[%[^\\]]*%\\]'),
  fvRe('num', '\\d+(?:\\.\\d+)?'),
  fvWords('kw', ['and', 'or', 'not']),
  xpathFnCall,
  fvRe('var', '@?[A-Za-z_][\\w.]*(?:\\/@?[A-Za-z_][\\w.]*)*'),
  fvRe('op', '!=|<=|>=|=|<|>'),
  fvRe('bracket', '[\\[\\]]'),
  fvRe('paren', '[()]'),
  fvRe('comma', ',')
];

// Highlights XPath text → HTML (also the Edit⇄View re-highlighter): tokenize,
// pair matching `[ ]` / `( )` for hover, render.
function xpathHighlight(text) {
  const tokens = fvTokenize(text, XPATH_MATCHERS);
  fvAssignBrackets(tokens);
  return fvTokensToHtml(tokens);
}

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.xpathAnalyze = xpathAnalyze;
window.formatXPathClick = formatXPathClick;
window.xpathHighlight = xpathHighlight;
window.xpathDeepHops = xpathDeepHops;
window.xpathToOql = xpathToOql;

export function init() {
  if (typeof fvSetRehighlight === 'function') fvSetRehighlight('xpath-output', xpathHighlight);
}
