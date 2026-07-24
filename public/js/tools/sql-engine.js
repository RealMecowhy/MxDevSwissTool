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

// Formats masked SQL/OQL text: `breakKeywords` each start a new line,
// `indentKeywords` start a new, indented continuation line, `listKeywords`
// (a subset of breakKeywords, e.g. SELECT/GROUP BY/ORDER BY) additionally get
// their following clause split on top-level commas, one item per indented
// line. Keywords are uppercased in the output.
function sqePrettify(text, opts) {
  opts = opts || {};
  const breakKeywords = opts.breakKeywords || [];
  const indentKeywords = opts.indentKeywords || [];
  const listKeywords = opts.listKeywords || [];
  const inlineKeywords = opts.inlineKeywords || [];

  const masked = sqeMask(text);
  let res = masked.masked.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();

  // Inline keywords (ASC/DESC/CASE/…) are case-normalized in place — no line
  // break — so this must run before break/indent insert their own newlines.
  if (inlineKeywords.length) {
    res = res.replace(sqeKeywordRegex(inlineKeywords), function (m) { return m.toUpperCase(); });
  }
  if (breakKeywords.length) {
    res = res.replace(sqeKeywordRegex(breakKeywords), function (m) { return '\n' + m.toUpperCase(); });
  }
  if (indentKeywords.length) {
    res = res.replace(sqeKeywordRegex(indentKeywords), function (m) { return '\n  ' + m.toUpperCase(); });
  }

  if (listKeywords.length) {
    const lines = res.split('\n');
    res = lines.map(function (line) {
      for (let k = 0; k < listKeywords.length; k++) {
        const kw = listKeywords[k].toUpperCase();
        const re = new RegExp('^' + kw.replace(/ /g, '\\s+') + '\\s+');
        const m = line.match(re);
        if (m) {
          const items = sqeSplitTopLevel(line.slice(m[0].length), ',');
          return kw + '\n  ' + items.join(',\n  ');
        }
      }
      return line;
    }).join('\n');
  }

  res = res.split('\n').map(function (l) { return l.replace(/[ \t]+$/, ''); }).join('\n');
  return sqeUnmask(res, masked.tokens).trim();
}

SQE_GLOBAL.sqeMask = sqeMask;
SQE_GLOBAL.sqeUnmask = sqeUnmask;
SQE_GLOBAL.sqeSplitTopLevel = sqeSplitTopLevel;
SQE_GLOBAL.sqePrettify = sqePrettify;
// Exposed so a caller's own highlight regexes (sql.js, query-intelligence.js) can
// build the same lookbehind/lookahead guard against matching a placeholder's
// digit run, without hardcoding the marker character themselves.
SQE_GLOBAL.sqeMark = SQE_MARK;
