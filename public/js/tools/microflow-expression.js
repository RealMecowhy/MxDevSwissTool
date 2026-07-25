// MICROFLOW EXPRESSION FORMATTER · prefix `mef`
// =========================================================================
// Mendix's Expression editor gives you one long line for `if/then/else`
// nesting, string concatenation and arithmetic — readable while you're
// writing it, unreadable a week later when you're debugging it. Worse, pasted
// expressions often come back with the spaces stripped (`if$A/Type='x'and...`),
// so the old line-only formatter left tokens glued together.
//
// This version tokenizes the expression (via format-view.js's fvTokenize),
// then RE-EMITS it with canonical spacing — one space after a keyword, around
// every binary operator, after every comma — so glued input reads cleanly, and
// already-spaced input is unchanged. Structure still comes from PAREN DEPTH:
// each `if`/`then`/`else` breaks to a new line indented to the depth it sits
// at, so nested if-expressions read as nested blocks. Matching `(`/`)` and each
// `if`/`then`/`else` triple share a hover-highlight group (fvAssignBrackets +
// mefAssignGroups). String literals are tokenized first, so a keyword hiding
// inside 'then this' is never mistaken for a break point.
//
// Pure: attaches to window/self so scripts/parser-test.js exercises it in
// plain Node.
// =========================================================================

const MEF_GLOBAL = (typeof window !== 'undefined' ? window : self);

// `and/or/not/div/mod/empty/true/false` are keyword-coloured literals. `true`
// and `false` are written `true()`/`false()` in Mendix but are matched here
// (before fvFnCall) so they stay keywords; the spacing rule below keeps their
// `()` attached. `if/then/else` are the control keywords that drive breaking.
const MEF_KEYWORDS = ['and', 'or', 'not', 'div', 'mod', 'empty', 'true', 'false'];
const MEF_CONTROL = ['if', 'then', 'else'];

// Ordered matchers — specific first. Strings/`[%system%]`/numbers are claimed
// before any word matcher, so their contents never reach keyword scanning.
const MEF_MATCHERS = [
  fvRe('ws', '[ \\t\\r\\n]+'),
  fvRe('str', "'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\""),
  fvRe('sysvar', '\\[%[^\\]]*%\\]'),
  fvRe('num', '\\d+(?:\\.\\d+)?'),
  fvWords('kw', MEF_KEYWORDS),
  fvWords('ctrl', MEF_CONTROL),
  fvFnCall('fn'),
  fvRe('var', '\\$[A-Za-z_]\\w*(?:\\/[A-Za-z_]\\w*)*'),
  fvRe('ident', '[A-Za-z_]\\w*'),
  fvRe('op', '!=|<=|>=|=|<|>|\\+|\\-|\\*'),
  fvRe('paren', '[()]')
];

function mefRawTokens(text) {
  return fvTokenize(text, MEF_MATCHERS).filter(function (t) { return t.v.length > 0; });
}

// Whether a single space belongs between two adjacent tokens on the same line.
// No space hugs `(`/`)`/`,`; a function name (and `true`/`false`, which take
// `()`) binds tight to its opening paren; everything else gets one space.
function mefNeedSpace(prev, cur) {
  if (!prev) return false;
  if (cur.v === ')' || cur.v === ',') return false;
  if (prev.v === '(') return false;
  if (cur.v === '(') {
    if (prev.t === 'fn') return false;
    if (prev.t === 'kw' && /^(true|false)$/i.test(prev.v)) return false;
    return true;
  }
  return true;
}

// Lays out core tokens (whitespace stripped) into the final stream: a newline +
// depth indent before each control keyword, canonical single spaces elsewhere.
// `else if` is kept on one line — the `if` right after an `else` does not break.
function mefLayout(core) {
  const out = [];
  let depth = 0, prev = null;
  for (let k = 0; k < core.length; k++) {
    const tk = core[k];
    const w = tk.v.toLowerCase();
    const isCtrl = tk.t === 'ctrl';
    const afterElse = prev && prev.t === 'ctrl' && prev.v.toLowerCase() === 'else';
    const breakHere = isCtrl && !(w === 'if' && afterElse);
    if (breakHere) {
      if (out.length) out.push({ t: 'ws', v: '\n' + '  '.repeat(depth) });
    } else if (out.length && mefNeedSpace(prev, tk)) {
      out.push({ t: 'ws', v: ' ' });
    }
    out.push(tk);
    prev = tk;
    if (tk.t === 'paren') { depth = tk.v === '(' ? depth + 1 : Math.max(0, depth - 1); }
  }
  return out;
}

// Groups matching brackets, then each `if` with its `then`/`else`. A stack
// pairs a `then` (kept open) and an `else` (which closes the `if`) back to the
// most recent unmatched `if`, so nesting — and `else if` chains — link correctly.
function mefAssignGroups(tokens) {
  let g = fvAssignBrackets(tokens);
  const stack = [];
  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];
    if (tk.t !== 'ctrl') continue;
    const w = tk.v.toLowerCase();
    if (w === 'if') { g++; tk.g = g; stack.push(g); }
    else if (w === 'then') { if (stack.length) tk.g = stack[stack.length - 1]; }
    else if (w === 'else') { if (stack.length) { tk.g = stack[stack.length - 1]; stack.pop(); } }
  }
}

// Pretty-prints to plain text (Copy / tests): tokenize → strip ws → lay out →
// join. Trailing spaces per line are trimmed; already-clean input round-trips.
function mefFormat(expr) {
  const core = mefRawTokens(expr).filter(function (t) { return t.t !== 'ws'; });
  const laid = mefLayout(core);
  return laid.map(function (t) { return t.v; }).join('').replace(/[ \t]+$/gm, '').trim();
}

// Highlights already-laid-out text → HTML (also the Edit⇄View re-highlighter):
// tokenize keeping whitespace, assign hover groups, render.
function mefHighlight(text) {
  const tokens = mefRawTokens(text);
  mefAssignGroups(tokens);
  return fvTokensToHtml(tokens);
}

// ============================================================
// UI
// ============================================================

function mefFormatClick() {
  const input = document.getElementById('mef-input');
  const val = input ? input.value : '';
  if (!val.trim()) {
    fvRender('mef-output', '<span style="color:var(--text-muted)">Paste a Microflow expression above — e.g. ' +
      '<code>if ($Customer/Status = \'Active\') then $Customer/Email else \'unknown\'</code> — to format it.</span>');
    return;
  }
  fvRender('mef-output', mefHighlight(mefFormat(val)));
}

MEF_GLOBAL.mefFormat = mefFormat;
MEF_GLOBAL.mefHighlight = mefHighlight;
MEF_GLOBAL.mefFormatClick = mefFormatClick;

export function init() {
  if (typeof fvSetRehighlight === 'function') fvSetRehighlight('mef-output', mefHighlight);
}
