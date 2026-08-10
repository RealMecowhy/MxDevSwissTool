// SQL FORMATTER
// ============================================================
// Formatting and highlighting both go through the shared, string/comment-safe
// engine in sql-engine.js (prefix `sqe`) — see that file for why: a naive
// `\s+`/`\bKEYWORD\b` pass corrupts a literal like `WHERE name = 'ORDER BY'`.
// Multi-word JOINs must all be listed — sqeKeywordRegex matches longest-first,
// so `LEFT OUTER JOIN` wins over `JOIN`. Missing the OUTER variants was why
// `LEFT OUTER JOIN` broke as `LEFT OUTER` + a stray `JOIN` on the next line.
const SQL_BREAK_KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING',
  'LIMIT', 'OFFSET', 'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN',
  'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'CROSS JOIN', 'OUTER JOIN', 'JOIN',
  'UNION ALL', 'UNION', 'RETURNING', 'SET', 'VALUES', 'INSERT INTO'];
const SQL_INDENT_KEYWORDS = ['AND', 'OR'];
const SQL_LIST_KEYWORDS = ['SELECT', 'GROUP BY', 'ORDER BY'];

// Format settings (7.6) — session-only (not persisted; toolState persistence
// is Fala 8.1's job), default to the engine's own defaults so a fresh load
// formats exactly as before this setting existed.
let sqlIndentSize = 2;
let sqlKeywordCase = 'upper';

function sqlSetIndentSize(v) { sqlIndentSize = parseInt(v, 10) === 4 ? 4 : 2; sqlFormat(); }
function sqlSetKeywordCase(v) { sqlKeywordCase = (v === 'lower' || v === 'preserve') ? v : 'upper'; sqlFormat(); }

function sqlFormat() {
  const raw=document.getElementById('sql-input').value; if(!raw.trim()){document.getElementById('sql-output').innerHTML='<span style="color:var(--text-muted)">Output will appear here...</span>';return;}
  fvRender('sql-output', sqlHighlight(prettifySQL(raw)));
}
function sqlMinify() {
  const masked = sqeMask(document.getElementById('sql-input').value);
  const collapsed = masked.masked.replace(/\s+/g, ' ').trim();
  document.getElementById('sql-output').textContent = sqeUnmask(collapsed, masked.tokens);
}
function prettifySQL(sql) {
  return sqePrettify(sql, {
    breakKeywords: SQL_BREAK_KEYWORDS,
    indentKeywords: SQL_INDENT_KEYWORDS,
    listKeywords: SQL_LIST_KEYWORDS,
    indentSize: sqlIndentSize,
    keywordCase: sqlKeywordCase
  });
}

// "Analyze in Query Intelligence" (7.6): the QI Explain tab expects a real
// EXPLAIN plan, not a bare query (visualizeSqlExplain would just report
// "analyzed successfully" on a query with no plan keywords in it — a false
// success), so this never fakes a plan. It copies a ready-to-run
// `EXPLAIN ANALYZE <query>` to the clipboard and hands off to the tab that
// already documents this exact workflow ("Method B" in its own instructions).
function sqlAnalyzeInQI() {
  const raw = document.getElementById('sql-input').value;
  if (!raw.trim()) { window.mtToast('Paste a SQL query first.', 'warning'); return; }
  const query = raw.trim().replace(/;\s*$/, '') + ';';
  const explainSql = 'EXPLAIN ANALYZE\n' + query;
  copyToClipboard(explainSql);
  if (window.navigateWithReturn) window.navigateWithReturn('query-intelligence');
  const tabBtn = document.querySelector('#panel-query-intelligence .tab[data-help-key="query-intelligence-explain"]');
  if (tabBtn && window.qiSetTab) window.qiSetTab('explain', tabBtn);
  // The query itself went to the clipboard — repeating it in the notification
  // would push everything else off screen for anything longer than a few lines.
  window.mtToast('EXPLAIN ANALYZE copied to clipboard. Run it against your database, then paste the resulting plan into the box below and click "Visualize Query Plan".', 'success');
}
// Highlighting now runs through the shared tokenizer (format-view.js): a single
// ordered-matcher pass over the already-formatted text, so functions
// (SUM/COUNT/MAX…), operators and column paths get their own colour — not just
// keywords/numbers/strings — and matching parentheses share a hover group. The
// string/comment matchers run first, so a keyword inside a literal or comment
// is never re-coloured (the old mask/unmask guard is no longer needed).
const SQL_HL_KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING',
  'LIMIT', 'OFFSET', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL OUTER JOIN',
  'OUTER JOIN', 'CROSS JOIN', 'JOIN', 'ON', 'AND', 'OR', 'NOT', 'IN', 'EXISTS',
  'BETWEEN', 'LIKE', 'ILIKE', 'IS NOT NULL', 'IS NULL', 'IS', 'NULL', 'TRUE',
  'FALSE', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'UNION ALL', 'UNION',
  'INTERSECT', 'EXCEPT', 'DISTINCT', 'ALL', 'ASC', 'DESC', 'WITH', 'RETURNING',
  'INSERT INTO', 'INSERT', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE TABLE',
  'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'USING',
  'INTO', 'LEFT', 'RIGHT', 'INNER', 'FULL', 'OUTER', 'CROSS'];
const SQL_MATCHERS = [
  fvRe('ws', '[ \\t\\r\\n]+'),
  fvRe('comment', '--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/'),
  fvRe('str', "'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\""),
  fvRe('num', '\\d+(?:\\.\\d+)?'),
  fvWords('kw', SQL_HL_KEYWORDS),
  fvFnCall('fn'),
  fvRe('var', '[A-Za-z_]\\w*(?:[.\\/][A-Za-z_]\\w*)*'),
  fvRe('op', '<>|!=|>=|<=|=|<|>|\\|\\||\\+|\\-|\\*|\\/|%'),
  fvRe('paren', '[()]'),
  fvRe('comma', ',')
];
function sqlHighlight(sql) {
  const tokens = fvTokenize(sql, SQL_MATCHERS);
  fvAssignBrackets(tokens);
  return fvTokensToHtml(tokens);
}

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.sqlFormat = sqlFormat;
window.sqlMinify = sqlMinify;
window.prettifySQL = prettifySQL;
window.sqlHighlight = sqlHighlight;
window.sqlSetIndentSize = sqlSetIndentSize;
window.sqlSetKeywordCase = sqlSetKeywordCase;
window.sqlAnalyzeInQI = sqlAnalyzeInQI;

export function init() {
  if (typeof fvSetRehighlight === 'function') fvSetRehighlight('sql-output', sqlHighlight);
}
