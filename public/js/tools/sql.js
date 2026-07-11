// SQL FORMATTER
// ============================================================
function sqlFormat() {
  const raw=document.getElementById('sql-input').value; if(!raw.trim()){document.getElementById('sql-output').innerHTML='<span style="color:var(--text-muted)">Output will appear here...</span>';return;}
  document.getElementById('sql-output').innerHTML=sqlHighlight(prettifySQL(raw));
}
function sqlMinify(){document.getElementById('sql-output').textContent=document.getElementById('sql-input').value.replace(/\s+/g,' ').trim();}
function prettifySQL(sql) {
  const breaks=['SELECT','FROM','WHERE','AND','OR','GROUP BY','ORDER BY','HAVING','LIMIT','OFFSET','LEFT JOIN','RIGHT JOIN','INNER JOIN','FULL OUTER JOIN','JOIN','UNION ALL','UNION','RETURNING','SET','VALUES'];
  let out=sql.replace(/\s+/g,' ').trim();
  breaks.forEach(kw=>{const re=new RegExp('\\b'+kw.replace(/ /g,'\\s+')+'\\b','gi');out=out.replace(re,'\n'+kw);});
  return out.trim();
}
function sqlHighlight(sql) {
  return escHtml(sql)
    .replace(/\b(SELECT|FROM|WHERE|AND|OR|NOT|IN|LEFT|RIGHT|INNER|OUTER|FULL|JOIN|ON|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|INSERT INTO|INSERT|VALUES|UPDATE|SET|DELETE|CREATE TABLE|CREATE|DROP|ALTER|DISTINCT|AS|CASE|WHEN|THEN|ELSE|END|UNION ALL|UNION|EXISTS|BETWEEN|LIKE|IS NULL|IS NOT NULL|NULL|TRUE|FALSE|ASC|DESC|WITH|RETURNING|BEGIN|COMMIT|ROLLBACK|TRUNCATE)\b/gi,
      m=>'<span class="sql-kw">'+m+'</span>')
    .replace(/'([^']*)'/g,m=>'<span class="sql-str">'+m+'</span>')
    .replace(/\b(\d+)\b/g,m=>'<span class="sql-num">'+m+'</span>')
    .replace(/--[^\n]*/g,m=>'<span class="sql-comment">'+m+'</span>');
}

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.sqlFormat = sqlFormat;
window.sqlMinify = sqlMinify;
window.prettifySQL = prettifySQL;
window.sqlHighlight = sqlHighlight;

export function init() {}
