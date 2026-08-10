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
  if (!result.oql) { window.mtToast('Enter an XPath expression or constraint first.', 'warning'); return; }
  window.navigateWithReturn('query-intelligence');
  const tabBtn = document.querySelector('#panel-query-intelligence .tabs .tab[data-help-key="query-intelligence-formatter"]');
  if (window.qiSetTab) window.qiSetTab('formatter', tabBtn);
  const oqlInput = document.getElementById('oql-input');
  if (oqlInput) {
    oqlInput.value = result.oql;
    if (window.formatOql) window.formatOql();
  }
};

// ── formatting ──────────────────────────────────────────────────────────────
// A pretty-printer, not a search/replace pass over the raw text: the input is
// tokenized with the same matchers the highlighter uses, the whitespace that
// came with it is DISCARDED, and the layout is regenerated from the bracket
// tree. That is what makes the result independent of how the query happened to
// be wrapped when it was pasted, and what lets `'x'and(` break correctly —
// a text-level scan can only see the glued characters, a token stream sees the
// keyword.
//
// Layout, in order:
//  - anything that fits in XPATH_WIDTH columns stays on one line;
//  - otherwise break before every `and`/`or` at that nesting level, and at the
//    root also before every `[` predicate so `][` chains stack vertically;
//  - a `[...]`/`(...)` group that still does not fit opens an indent level.
// Only whitespace is ever added or removed — an unbalanced bracket is rendered
// unclosed rather than silently repaired, since a formatter must not change
// what the query says.
const XPATH_WIDTH = 80;
const XPATH_INDENT = '  ';

// Tokens → nested groups. A closer only pops when it matches the group it would
// close, so a stray `)`/`]` stays an ordinary token instead of scrambling the
// tree; anything still open at the end is flagged `unclosed`.
function xpathTree(tokens) {
  const root = { type: 'seq', items: [] };
  const stack = [root];
  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];
    if (tk.t === 'ws') continue;
    const top = stack[stack.length - 1];
    if (tk.v === '[' || tk.v === '(') {
      const g = { type: 'group', open: tk.v, close: tk.v === '[' ? ']' : ')', items: [] };
      top.items.push(g);
      stack.push(g);
    } else if (tk.v === ']' || tk.v === ')') {
      if (stack.length > 1 && top.close === tk.v) stack.pop();
      else top.items.push({ type: 'atom', tk: tk });
    } else {
      top.items.push({ type: 'atom', tk: tk });
    }
  }
  for (let k = 1; k < stack.length; k++) stack[k].unclosed = true;
  return root;
}

function xpathFirstTok(node) {
  if (node.type === 'atom') return node.tk;
  return { t: node.open === '[' ? 'bracket' : 'paren', v: node.open };
}
function xpathLastTok(node) {
  if (node.type === 'atom') return node.tk;
  if (!node.unclosed) return { t: node.close === ']' ? 'bracket' : 'paren', v: node.close };
  return node.items.length ? xpathLastTok(node.items[node.items.length - 1]) : xpathFirstTok(node);
}

// One space between neighbouring tokens, except where XPath reads as one unit:
// `//Entity`, a predicate binding to its path (`Customer[`), a call's parens
// (`contains(`, `not(`), and the inside edges of a group.
function xpathNeedSpace(prev, next) {
  if (!prev) return false;
  if (next.v === ',') return false;
  if (next.v === ')' || next.v === ']') return false;
  if (next.v === '[') return false;
  if (prev.v === '/' || next.v === '/') return false;
  if (next.v === '(' && (prev.t === 'fn' || /^not$/i.test(prev.v))) return false;
  return true;
}

// The whole node on one line — also the measurement used to decide whether it
// may stay there.
function xpathFlat(node) {
  if (node.type === 'atom') return node.tk.v;
  let out = node.type === 'group' ? node.open : '';
  let prev = null;
  for (let k = 0; k < node.items.length; k++) {
    const it = node.items[k];
    if (xpathNeedSpace(prev, xpathFirstTok(it))) out += ' ';
    out += xpathFlat(it);
    prev = xpathLastTok(it);
  }
  if (node.type === 'group' && !node.unclosed) out += node.close;
  return out;
}

// One line's worth of items, starting at column `col`. A group too wide for the
// space left is expanded in place, so the text before it (`Module.Entity[`)
// keeps its line.
function xpathChunk(items, indent, col) {
  let out = '', cur = col, prev = null;
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    const sep = xpathNeedSpace(prev, xpathFirstTok(it)) ? ' ' : '';
    let piece = xpathFlat(it);
    if (it.type === 'group' && cur + sep.length + piece.length > XPATH_WIDTH) {
      const inner = indent + XPATH_INDENT;
      piece = it.open + '\n' + inner + xpathItems(it.items, inner, false) +
              (it.unclosed ? '' : '\n' + indent + it.close);
    }
    out += sep + piece;
    const nl = piece.lastIndexOf('\n');
    cur = nl === -1 ? cur + sep.length + piece.length : piece.length - nl - 1;
    prev = xpathLastTok(it);
  }
  return out;
}

// Items split into lines: before each `and`/`or`, and — at the root only, where
// consecutive predicates are separate filters rather than a path's own
// constraint — before each `[`.
function xpathItems(items, indent, splitPredicates) {
  const chunks = [[]];
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    const last = chunks[chunks.length - 1];
    const isBool = it.type === 'atom' && it.tk.t === 'kw' && /^(and|or)$/i.test(it.tk.v);
    const isPred = splitPredicates && it.type === 'group' && it.open === '[';
    if (last.length && (isBool || isPred)) chunks.push([]);
    chunks[chunks.length - 1].push(it);
  }
  return chunks.map(function (c) { return xpathChunk(c, indent, indent.length); }).join('\n' + indent);
}

function xpathFormat(val) {
  const root = xpathTree(fvTokenize(val, XPATH_MATCHERS));
  if (!root.items.length) return '';
  const flat = xpathFlat(root);
  return flat.length <= XPATH_WIDTH ? flat : xpathItems(root.items, '', true);
}

function formatXPathClick() {
  const val = document.getElementById('xpath-input').value;
  const result = val ? xpathFormat(val) : '';
  fvRender('xpath-output', result ? xpathHighlight(result) : '');
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
