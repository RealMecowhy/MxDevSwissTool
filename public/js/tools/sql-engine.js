// =========================================================================
// SQL / OQL FORMATTING ENGINE (shared, string/comment-safe) · prefix `sqe`
// =========================================================================
// The formatters this engine replaces — prettifySQL (sql.js) and formatOql
// (query-intelligence.js) — both ran a blind `text.replace(/\s+/g, ' ')` over the raw
// input, then matched keywords with `\bKEYWORD\b` across the WHOLE string.
// Neither step knows about string literals or comments, so `WHERE name =
// 'ORDER BY'` breaks the line inside the literal, and a keyword sitting in a
// `-- comment` gets uppercased and relocated as if it were code.
//
// The fix is the classic mask/unmask technique: pull every string literal and
// comment out into an opaque placeholder BEFORE any keyword or whitespace
// transform runs, so those transforms only ever see real code. Once formatting
// is done, the placeholders are swapped back for the original text (or a
// highlighted version of it, for callers that render HTML).
//
// Comma-splitting (SELECT / GROUP BY / ORDER BY column lists) needs the same
// protection PLUS paren-depth awareness — `numeric(10,2)` and a subquery's
// commas are not list separators. Depth is tracked on the MASKED text: real
// parentheses inside code are still visible there, only string/comment
// content has been replaced by an opaque, paren-free token.
//
// Pure: attaches to window/self so scripts/parser-test.js exercises it in
// plain Node.
// =========================================================================

const SQE_GLOBAL = (typeof window !== 'undefined' ? window : self);
// NUL -- built via fromCharCode rather than a literal escape so no raw control
// byte sits in this source file. Never appears in real SQL/OQL text.
const SQE_MARK = String.fromCharCode(0);

// ── mask / unmask ─────────────────────────────────────────────────────────

// Pulls every string literal ('...'/"...", doubled-quote escape honoured) and
// every comment (`--` to end of line, `/* ... */`) out of `text`, replacing
// each with an opaque a NUL-delimited placeholder. Returns the masked text and
// the list of extracted tokens (in order, index-addressable).
function sqeMask(text) {
  const s = String(text == null ? '' : text);
  const tokens = [];
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"') {
      const q = c;
      let raw = c; i++;
      while (i < s.length) {
        if (s[i] === q && s[i + 1] === q) { raw += q + q; i += 2; continue; }
        raw += s[i];
        if (s[i] === q) { i++; break; }
        i++;
      }
      tokens.push({ type: 'string', raw: raw });
      out += SQE_MARK + (tokens.length - 1) + SQE_MARK;
      continue;
    }
    if (c === '-' && s[i + 1] === '-') {
      let j = i;
      while (j < s.length && s[j] !== '\n') j++;
      tokens.push({ type: 'comment', raw: s.slice(i, j) });
      out += SQE_MARK + (tokens.length - 1) + SQE_MARK;
      i = j;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      let j = i + 2;
      while (j < s.length && !(s[j] === '*' && s[j + 1] === '/')) j++;
      j = Math.min(j + 2, s.length);
      tokens.push({ type: 'comment', raw: s.slice(i, j) });
      out += SQE_MARK + (tokens.length - 1) + SQE_MARK;
      i = j;
      continue;
    }
    out += c; i++;
  }
  return { masked: out, tokens: tokens };
}

// Reverses sqeMask. `wrap(token)` maps a token to its output text — defaults
// to the original raw text (used for prettify/minify); a caller that renders
// HTML passes a wrap function that escapes and highlights instead.
function sqeUnmask(text, tokens, wrap) {
  const fn = wrap || function (t) { return t.raw; };
  return String(text).replace(new RegExp(SQE_MARK + '(\\d+)' + SQE_MARK, 'g'), function (m, idx) {
    return fn(tokens[Number(idx)]);
  });
}

// ── top-level splitting (comma boundaries outside parens) ─────────────────

// Splits `text` on `sep` (default ',') only at paren depth 0. Call this on
// MASKED text — real string/comment content never reaches it, so a comma
// inside a literal can't be mistaken for a list separator.
function sqeSplitTopLevel(text, sep) {
  sep = sep || ',';
  const s = String(text == null ? '' : text);
  const parts = [];
  let depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map(function (p) { return p.trim(); }).filter(function (p) { return p.length; });
}

// ── keyword-driven line breaking (operates on masked text) ────────────────

function sqeKeywordRegex(list) {
  const alts = list.slice().sort(function (a, b) { return b.length - a.length; })
    .map(function (k) { return k.replace(/ /g, '\\s+'); });
  return new RegExp('\\b(' + alts.join('|') + ')\\b', 'gi');
}

// Like `text.replace(regex, replacer)`, but `replacer` only runs on a match
// that sits at paren depth 0 in `text` — a match inside `(...)` (a subquery,
// a grouped condition) is left untouched. Depth is tracked cumulatively as
// matches are found left-to-right, so this stays O(n) rather than rescanning
// from the start for every match.
function sqeReplaceAtDepth0(text, regex, replacer) {
  const re = new RegExp(regex.source, regex.flags.indexOf('g') === -1 ? regex.flags + 'g' : regex.flags);
  let out = '', last = 0, depth = 0, m;
  while ((m = re.exec(text)) !== null) {
    for (let i = last; i < m.index; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
    }
    out += text.slice(last, m.index) + (depth === 0 ? replacer(m[0]) : m[0]);
    last = re.lastIndex;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out + text.slice(last);
}

// Placeholder marker for an extracted subquery. String.fromCharCode(2) — never
// appears in real SQL/OQL — kept distinct from SQE_MARK (\0, used for
// string/comment literals) so the two masking layers never collide.
const SQE_SUBMARK = String.fromCharCode(2);

// The FLAT pass (the original algorithm): formats masked text WITHOUT recursing
// into subqueries. `breakKeywords` each start a new line, `indentKeywords` a
// new indented continuation line, `listKeywords` (SELECT/GROUP BY/ORDER BY)
// additionally split their clause on top-level commas. All matching is
// depth-0 only, so a parenthesized group — function args (SUM(x)), a type param
// (VARCHAR(10)), an IN value-list, a grouped AND/OR condition — stays on one
// line and never has its closing paren misplaced.
function sqeFlatFormat(masked, opts) {
  const indent = ' '.repeat(opts.indentSize > 0 ? opts.indentSize : 2);
  const kwCase = opts.keywordCase || 'upper';
  function applyCase(m) {
    if (kwCase === 'lower') return m.toLowerCase();
    if (kwCase === 'preserve') return m;
    return m.toUpperCase();
  }
  let res = String(masked).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
  if (opts.inlineKeywords && opts.inlineKeywords.length) {
    res = res.replace(sqeKeywordRegex(opts.inlineKeywords), applyCase);
  }
  if (opts.breakKeywords && opts.breakKeywords.length) {
    res = sqeReplaceAtDepth0(res, sqeKeywordRegex(opts.breakKeywords), function (m) { return '\n' + applyCase(m); });
  }
  if (opts.indentKeywords && opts.indentKeywords.length) {
    res = sqeReplaceAtDepth0(res, sqeKeywordRegex(opts.indentKeywords), function (m) { return '\n' + indent + applyCase(m); });
  }
  if (opts.listKeywords && opts.listKeywords.length) {
    res = res.split('\n').map(function (line) {
      for (let k = 0; k < opts.listKeywords.length; k++) {
        const re = new RegExp('^(' + opts.listKeywords[k].replace(/ /g, '\\s+') + ')\\s+', 'i');
        const m = line.match(re);
        if (m) {
          const items = sqeSplitTopLevel(line.slice(m[0].length), ',');
          return m[1] + '\n' + indent + items.join(',\n' + indent);
        }
      }
      return line;
    }).join('\n');
  }
  // A break keyword at position 0 (a leading SELECT) prefixes a spurious empty
  // line; sqePrettify's final trim hid it for the outer query, but an indented
  // subquery body would keep it, so strip it here.
  res = res.replace(/^\n+/, '');
  return res.split('\n').map(function (l) { return l.replace(/[ \t]+$/, ''); }).join('\n');
}

// Pulls each SUBQUERY — a parenthesized group whose content begins with SELECT
// — out to an opaque placeholder before the flat pass runs, so the surrounding
// query formats without it, and it can be formatted on its own and re-indented
// to the column its `(` lands at. Function-arg parens, type params, IN
// value-lists and grouped AND/OR conditions do NOT start with SELECT, so they
// are left inline exactly as the flat pass always handled them.
function sqeExtractSubqueries(s) {
  let out = '', i = 0;
  const subs = [];
  while (i < s.length) {
    if (s[i] === '(') {
      let depth = 0, j = i;
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')') { depth--; if (depth === 0) break; }
      }
      const content = s.slice(i + 1, j);
      if (depth === 0 && /^\s*select\b/i.test(content)) {
        subs.push(content);
        out += SQE_SUBMARK + (subs.length - 1) + SQE_SUBMARK;
        i = j + 1;
        continue;
      }
    }
    out += s[i]; i++;
  }
  return { text: out, subs: subs };
}

// Recursively formats masked text: extract subqueries → flat-format the rest →
// expand each subquery placeholder into a `(` … `)` block, its body formatted
// the same way and indented one level past the line the call sits on. So
// `AND c.ID IN (SELECT …)` opens the paren on its clause line, lays the inner
// SELECT/FROM/WHERE out below it, and closes the paren back at the clause indent.
function sqeFormatRec(masked, opts) {
  const extracted = sqeExtractSubqueries(masked);
  const flat = sqeFlatFormat(extracted.text, opts);
  if (!extracted.subs.length) return flat;
  const indent = ' '.repeat(opts.indentSize > 0 ? opts.indentSize : 2);
  const phRe = new RegExp(SQE_SUBMARK + '(\\d+)' + SQE_SUBMARK);
  const outLines = [];
  flat.split('\n').forEach(function (line) {
    const m = line.match(phRe);
    if (!m) { outLines.push(line); return; }
    const lineIndent = (line.match(/^\s*/) || [''])[0];
    const before = line.slice(0, m.index).replace(/\s+$/, '');
    const after = line.slice(m.index + m[0].length);
    const innerIndent = lineIndent + indent;
    const inner = sqeFormatRec(extracted.subs[Number(m[1])], opts).split('\n')
      .map(function (l) { return innerIndent + l; });
    outLines.push(before.length ? before + ' (' : lineIndent + '(');
    Array.prototype.push.apply(outLines, inner);
    outLines.push(lineIndent + ')' + after);
  });
  return outLines.join('\n');
}

// Formats SQL/OQL: `keywordCase` — 'upper' (default), 'lower', or 'preserve' —
// and `indentSize` (default 2) are opt-in so existing callers see no change.
// Subqueries are formatted recursively (see sqeFormatRec); every other
// parenthesized group stays inline (see sqeFlatFormat).
function sqePrettify(text, opts) {
  opts = opts || {};
  const masked = sqeMask(text);
  const formatted = sqeFormatRec(masked.masked, opts);
  return sqeUnmask(formatted, masked.tokens).trim();
}

SQE_GLOBAL.sqeMask = sqeMask;
SQE_GLOBAL.sqeUnmask = sqeUnmask;
SQE_GLOBAL.sqeSplitTopLevel = sqeSplitTopLevel;
SQE_GLOBAL.sqePrettify = sqePrettify;
// Exposed so a caller's own highlight regexes (sql.js, query-intelligence.js) can
// build the same lookbehind/lookahead guard against matching a placeholder's
// digit run, without hardcoding the marker character themselves.
SQE_GLOBAL.sqeMark = SQE_MARK;
