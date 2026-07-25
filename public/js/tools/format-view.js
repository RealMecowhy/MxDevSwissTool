// =========================================================================
// FORMAT VIEW — shared interactive layer for the text formatters · prefix `fv`
// =========================================================================
// The SQL, Microflow Expression and XPath formatters all had the same three
// weaknesses: (1) highlighting was a blind chain of `String.replace` passes
// that could only reach a couple of token kinds, (2) the output was a static
// `<pre>` with no structure, so bracket/if-else matching was impossible, and
// (3) there was no way to tweak the result before copying.
//
// This module is the shared fix. It gives each formatter:
//   • a small, ordered-matcher TOKENIZER (fvTokenize) — one pass, string- and
//     comment-safe because the string/comment matchers run first, so a keyword
//     hiding inside a literal is never re-coloured or split;
//   • bracket/keyword GROUPING (fvAssignBrackets) so a `(` and its matching
//     `)` — or an `if` and its `then`/`else` — share a `data-g` id and light
//     up together on hover (fvBindMatch);
//   • an EDIT ⇄ VIEW toggle (fvToggleEdit) that swaps the highlighted pre for a
//     plain textarea and re-highlights on the way back, so the formatted result
//     stays editable before Copy (fvCopy).
//
// Pure where it can be: the tokenizer/grouping attach to window/self so
// scripts/parser-test.js exercises them in plain Node. `escHtml` and
// `copyToClipboard` are the app's own globals (utilities.js); parser-test stubs
// escHtml, and the DOM-touching helpers below simply aren't called there.
// =========================================================================

const FV_GLOBAL = (typeof window !== 'undefined' ? window : self);

// ── tokenizer ─────────────────────────────────────────────────────────────
// A matcher is `fn(text, i) -> {t, len} | null`: given the position `i`, it
// either claims a run of characters (returning its token type and length) or
// declines. fvTokenize tries them in order at every position; the first to
// claim wins, so more specific matchers (strings, comments, keywords) must be
// listed before the catch-alls (identifiers, single-char punctuation).
function fvTokenize(text, matchers) {
  const s = String(text == null ? '' : text);
  const toks = [];
  let i = 0;
  while (i < s.length) {
    let hit = null;
    for (let k = 0; k < matchers.length; k++) {
      const r = matchers[k](s, i);
      if (r && r.len > 0) { hit = r; break; }
    }
    if (!hit) { toks.push({ t: 'punct', v: s[i] }); i++; continue; }
    toks.push({ t: hit.t, v: s.slice(i, i + hit.len) });
    i += hit.len;
  }
  return toks;
}

// A sticky-regex matcher: claims text[i..] matching `src` anchored at `i`.
function fvRe(t, src, flags) {
  const re = new RegExp(src, 'y' + (flags || ''));
  return function (text, i) {
    re.lastIndex = i;
    const m = re.exec(text);
    return m ? { t: t, len: m[0].length } : null;
  };
}

// A word/keyword matcher: case-insensitive, honours word boundaries on both
// sides, and supports multi-word keywords (`GROUP BY`) by allowing any run of
// whitespace between the words. Longest alternatives are tried first so
// `INNER JOIN` wins over `JOIN`, `IS NOT NULL` over `IS`/`NOT`/`NULL`.
function fvWords(t, list) {
  const alts = list.slice()
    .sort(function (a, b) { return b.length - a.length; })
    .map(function (w) { return w.replace(/ /g, '\\s+'); });
  const re = new RegExp('(?:' + alts.join('|') + ')(?![\\w])', 'iy');
  return function (text, i) {
    // Block a match only when the char before is identifier-ish (letter/_/$) —
    // then `fooand` stays one identifier. A digit or `.` before is still a
    // boundary (a number can't contain letters), so pasted glued input like
    // `1000.0then` correctly splits into the number and the keyword.
    if (i > 0 && /[A-Za-z_$]/.test(text[i - 1])) return null;
    re.lastIndex = i;
    const m = re.exec(text);
    return m ? { t: t, len: m[0].length } : null;
  };
}

// An identifier-followed-by-`(` matcher — a function call. Whitespace between
// the name and the paren is tolerated (`count (*)`). Must be listed AFTER the
// keyword matcher so reserved words that take parens (`not(`, `in (`) stay
// keywords rather than being mis-tagged as functions.
function fvFnCall(t) {
  const re = /[A-Za-z_][A-Za-z0-9_]*/y;
  return function (text, i) {
    if (i > 0 && /[A-Za-z_$]/.test(text[i - 1])) return null;
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) return null;
    let j = i + m[0].length;
    while (text[j] === ' ' || text[j] === '\t') j++;
    return text[j] === '(' ? { t: t, len: m[0].length } : null;
  };
}

// ── bracket / keyword grouping ──────────────────────────────────────────────
// Assigns a shared `g` id to each pair of matching brackets: `(`↔`)` and
// `[`↔`]` are tracked on independent stacks so an unbalanced mix never crosses
// the streams. Returns the next free group id, so callers can keep numbering
// (e.g. if/then/else groups) from there without collisions.
function fvAssignBrackets(tokens, gStart) {
  let g = gStart || 0;
  const stackP = [], stackB = [];
  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];
    if (tk.t !== 'paren' && tk.t !== 'bracket') continue;
    const isRound = tk.v === '(' || tk.v === ')';
    const stack = isRound ? stackP : stackB;
    if (tk.v === '(' || tk.v === '[') { g++; tk.g = g; stack.push(g); }
    else { const id = stack.pop(); if (id != null) tk.g = id; }
  }
  return g;
}

// ── rendering ───────────────────────────────────────────────────────────────
// tokens → HTML. Whitespace tokens are emitted as raw (escaped) text so the
// pre's `white-space:pre-wrap` keeps newlines and indentation; every other
// token becomes a `<span class="ftok fk-TYPE">`, carrying `data-g` when it is
// part of a matched group so fvBindMatch can light the whole group at once.
function fvTokensToHtml(tokens) {
  let out = '';
  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];
    if (tk.t === 'ws') { out += escHtml(tk.v); continue; }
    const g = (tk.g != null) ? ' data-g="' + tk.g + '"' : '';
    out += '<span class="ftok fk-' + tk.t + '"' + g + '>' + escHtml(tk.v) + '</span>';
  }
  return out;
}

// ── hover matching ──────────────────────────────────────────────────────────
// Delegated on the pre: hovering any grouped token adds `.ft-hi` to every
// token sharing its group id (its bracket partner, or the if/then/else it
// belongs to), and clears them on the way out. Bound once per element.
function fvBindMatch(el) {
  if (!el || el._fvBound) return;
  el._fvBound = true;
  el.addEventListener('mouseover', function (e) {
    const t = e.target.closest ? e.target.closest('[data-g]') : null;
    if (!t || !el.contains(t)) return;
    const g = t.getAttribute('data-g');
    el.querySelectorAll('[data-g="' + g + '"]').forEach(function (n) { n.classList.add('ft-hi'); });
  });
  el.addEventListener('mouseout', function () {
    el.querySelectorAll('.ft-hi').forEach(function (n) { n.classList.remove('ft-hi'); });
  });
}

// Render highlighted HTML into `preId` and (re)bind hover matching.
function fvRender(preId, html) {
  const pre = document.getElementById(preId);
  if (!pre) return;
  pre.innerHTML = html;
  fvBindMatch(pre);
}

// ── Edit ⇄ View ─────────────────────────────────────────────────────────────
// Each output pane holds a highlighted `<pre id=preId>` plus a hidden
// `<textarea id=taId>`. A tool registers how to re-highlight arbitrary text
// (fvSetRehighlight); the toggle fills the textarea from the pre on the way in,
// and re-highlights the (possibly edited) text back into the pre on the way
// out — so manual edits survive and pick up colours/matching.
const FV_REHI = {};
function fvSetRehighlight(preId, fn) { FV_REHI[preId] = fn; }

function fvToggleEdit(preId, taId, btn) {
  const pre = document.getElementById(preId);
  const ta = document.getElementById(taId);
  if (!pre || !ta) return;
  const taHidden = window.getComputedStyle(ta).display === 'none';
  if (taHidden) {
    // Entering edit: seed the textarea from the pre's plain text and swap.
    ta.value = pre.innerText;
    ta.style.display = 'block';
    pre.style.display = 'none';
    if (btn) { btn.textContent = 'View'; btn.classList.add('active'); }
    ta.focus();
  } else {
    // Back to view: re-highlight the (possibly edited) text so colours and
    // bracket/if-else matching pick up the manual changes.
    const fn = FV_REHI[preId];
    fvRender(preId, fn ? fn(ta.value) : escHtml(ta.value));
    ta.style.display = 'none';
    pre.style.display = '';
    if (btn) { btn.textContent = 'Edit'; btn.classList.remove('active'); }
  }
}

// Copy the current plain text — from the textarea when editing, otherwise the
// pre's rendered text (innerText strips the highlight spans back to plain).
function fvCopy(preId, taId) {
  const pre = document.getElementById(preId);
  const ta = taId ? document.getElementById(taId) : null;
  const editing = ta && window.getComputedStyle(ta).display !== 'none';
  copyToClipboard(editing ? ta.value : (pre ? pre.innerText : ''));
}

FV_GLOBAL.fvTokenize = fvTokenize;
FV_GLOBAL.fvRe = fvRe;
FV_GLOBAL.fvWords = fvWords;
FV_GLOBAL.fvFnCall = fvFnCall;
FV_GLOBAL.fvAssignBrackets = fvAssignBrackets;
FV_GLOBAL.fvTokensToHtml = fvTokensToHtml;
FV_GLOBAL.fvBindMatch = fvBindMatch;
FV_GLOBAL.fvRender = fvRender;
FV_GLOBAL.fvSetRehighlight = fvSetRehighlight;
FV_GLOBAL.fvToggleEdit = fvToggleEdit;
FV_GLOBAL.fvCopy = fvCopy;

export function init() {}
