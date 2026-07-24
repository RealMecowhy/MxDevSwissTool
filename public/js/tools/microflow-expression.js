// MICROFLOW EXPRESSION FORMATTER · prefix `mef`
// =========================================================================
// Mendix's Expression editor gives you one long line for `if/then/else`
// nesting, string concatenation and arithmetic — readable while you're
// writing it, unreadable a week later when you're debugging it. This tool
// pretty-prints it: break before every `if` / `then` / `else if` / `else`,
// indented to the paren depth it sits at, so nested if-expressions read as
// nested blocks instead of one run-on line.
//
// Reuses the string-safe scanning idea from sql-engine.js (7.1) rather than
// the engine itself: sqePrettify's break-keyword regex assumes a flat
// SELECT/FROM/WHERE grammar, but here structure comes from PAREN DEPTH, not
// a fixed clause order — an `if` can appear at any depth, arbitrarily
// nested. So this is a purpose-built scanner: sqeMask still protects string
// literals ('...', '' escape) from being scanned as code, exactly like SQL/OQL.
//
// Pure: attaches to window/self so scripts/parser-test.js exercises it in
// plain Node.
// =========================================================================

const MEF_GLOBAL = (typeof window !== 'undefined' ? window : self);

const MEF_KEYWORDS = ['and', 'or', 'not', 'empty', 'true', 'false', 'div', 'mod'];
const MEF_FUNCTIONS = ['trim', 'max', 'min', 'round', 'floor', 'ceil', 'abs', 'power', 'sqrt',
  'toString', 'length', 'substring', 'concat', 'indexOf', 'replaceAll', 'replace',
  'toLowerCase', 'toUpperCase', 'contains', 'startsWith', 'endsWith', 'guid',
  'parseInteger', 'parseDecimal', 'formatDateTime', 'addDays', 'addHours', 'addMinutes',
  'addMonths', 'addYears', 'addWeeks', 'diffDays', 'monthsBetween', 'daysBetween',
  'dayOfMonth', 'dayOfWeek', 'weekOfYear', 'currentDateTime', 'currentUser'];

// Break BEFORE these, indented to the current paren depth. `else if` must be
// tried before the bare `else`/`if` alternatives so it matches as one unit.
const MEF_BREAK_RE = /^(else\s+if|if|then|else)\b/i;

function mefIsWordChar(c) { return !!c && /[A-Za-z0-9_$]/.test(c); }

// Pretty-prints a Microflow expression: string-literal-safe (via sqeMask),
// breaking before if/then/else-if/else and indenting two spaces per paren
// depth. Depth is read straight off the masked text — a paren inside a
// string literal never reaches here, it's part of an opaque placeholder.
function mefFormat(expr) {
  const masked = sqeMask(expr);
  const s = masked.masked.replace(/[ \t\r\n]+/g, ' ').trim();
  let depth = 0;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const prevChar = i > 0 ? s[i - 1] : '';
    if (!mefIsWordChar(prevChar)) {
      const m = s.slice(i).match(MEF_BREAK_RE);
      if (m) {
        out += '\n' + '  '.repeat(depth) + m[1].replace(/\s+/g, ' ');
        i += m[0].length;
        continue;
      }
    }
    const c = s[i];
    if (c === '(') { depth++; out += c; i++; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); out += c; i++; continue; }
    out += c; i++;
  }
  out = out.split('\n').map(function (l) { return l.replace(/[ \t]+$/, ''); }).join('\n');
  return sqeUnmask(out, masked.tokens).replace(/^\n+/, '').trim();
}

function mefKeywordRegex(list) {
  return new RegExp('\\b(' + list.slice().sort((a, b) => b.length - a.length).join('|') + ')\\b', 'g');
}
const MEF_KW_RE = mefKeywordRegex(MEF_KEYWORDS);
const MEF_FN_RE = mefKeywordRegex(MEF_FUNCTIONS);

function mefHighlightCode(code) {
  return escHtml(code)
    // Numbers highlighted FIRST, before any other replacement injects its own
    // HTML — the function span below carries a literal `font-weight:600`, and
    // a digit regex running after that would wrongly re-wrap that 600.
    // Guarded against matching the digit run of a mask placeholder too.
    .replace(new RegExp('(?<!' + sqeMark + ')\\b(\\d+(\\.\\d+)?)\\b(?!' + sqeMark + ')', 'g'), m => '<span class="sql-num">' + m + '</span>')
    .replace(/\b(if|then|else\s+if|else)\b/gi, m => '<span class="sql-kw">' + m + '</span>')
    .replace(MEF_KW_RE, m => '<span class="sql-kw">' + m + '</span>')
    .replace(MEF_FN_RE, m => '<span style="color:#c678dd;font-weight:600">' + m + '</span>')
    .replace(/\$[A-Za-z_][\w]*/g, m => '<span style="color:#e5c07b">' + m + '</span>');
}

function mefHighlight(expr) {
  const masked = sqeMask(expr);
  const highlighted = mefHighlightCode(masked.masked);
  return sqeUnmask(highlighted, masked.tokens, function (t) {
    return '<span class="sql-str">' + escHtml(t.raw) + '</span>';
  });
}

// ============================================================
// UI
// ============================================================

function mefFormatClick() {
  const input = document.getElementById('mef-input');
  const out = document.getElementById('mef-output');
  const val = input ? input.value : '';
  if (!val.trim()) {
    out.innerHTML = '<span style="color:var(--text-muted)">Paste a Microflow expression above — e.g. ' +
      '<code>if ($Customer/Status = \'Active\') then $Customer/Email else \'unknown\'</code> — to format it.</span>';
    return;
  }
  out.innerHTML = mefHighlight(mefFormat(val));
}

MEF_GLOBAL.mefFormat = mefFormat;
MEF_GLOBAL.mefHighlight = mefHighlight;
MEF_GLOBAL.mefFormatClick = mefFormatClick;

export function init() {}
