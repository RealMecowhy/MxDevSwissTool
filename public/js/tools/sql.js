// SQL FORMATTER
// ============================================================
// Formatting and highlighting both go through the shared, string/comment-safe
// engine in sql-engine.js (prefix `sqe`) — see that file for why: a naive
// `\s+`/`\bKEYWORD\b` pass corrupts a literal like `WHERE name = 'ORDER BY'`.
const SQL_BREAK_KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING',
  'LIMIT', 'OFFSET', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL OUTER JOIN', 'JOIN',
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
  document.getElementById('sql-output').innerHTML=sqlHighlight(prettifySQL(raw));
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
  if (!raw.trim()) { alert('Paste a SQL query first.'); return; }
  const query = raw.trim().replace(/;\s*$/, '') + ';';
  const explainSql = 'EXPLAIN ANALYZE\n' + query;
  copyToClipboard(explainSql);
  if (window.navigateWithReturn) window.navigateWithReturn('query-intelligence');
  const tabBtn = document.querySelector('#panel-query-intelligence .tab[data-help-key="query-intelligence-explain"]');
  if (tabBtn && window.qiSetTab) window.qiSetTab('explain', tabBtn);
  alert('Copied to clipboard:\n\n' + explainSql +
    '\n\nRun it against your database, then paste the resulting plan into the box below and click "Visualize Query Plan".');
}
function sqlHighlightCode(code) {
  return escHtml(code)
    .replace(/\b(SELECT|FROM|WHERE|AND|OR|NOT|IN|LEFT|RIGHT|INNER|OUTER|FULL|JOIN|ON|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|INSERT INTO|INSERT|VALUES|UPDATE|SET|DELETE|CREATE TABLE|CREATE|DROP|ALTER|DISTINCT|AS|CASE|WHEN|THEN|ELSE|END|UNION ALL|UNION|EXISTS|BETWEEN|LIKE|IS NULL|IS NOT NULL|NULL|TRUE|FALSE|ASC|DESC|WITH|RETURNING|BEGIN|COMMIT|ROLLBACK|TRUNCATE)\b/gi,
      m=>'<span class="sql-kw">'+m+'</span>')
    // The digit run of a ` N ` mask placeholder must never be mistaken for a
    // number literal — a lookbehind/lookahead guard excludes it (the null
    // marker survives escHtml unchanged, so it's still adjacent here).
    .replace(new RegExp('(?<!' + sqeMark + ')\\b(\\d+)\\b(?!' + sqeMark + ')', 'g'),m=>'<span class="sql-num">'+m+'</span>');
}
function sqlHighlight(sql) {
  const masked = sqeMask(sql);
  const highlighted = sqlHighlightCode(masked.masked);
  return sqeUnmask(highlighted, masked.tokens, function (t) {
    const cls = t.type === 'comment' ? 'sql-comment' : 'sql-str';
    return '<span class="' + cls + '">' + escHtml(t.raw) + '</span>';
  });
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

export function init() {}
