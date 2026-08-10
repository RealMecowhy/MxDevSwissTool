// QUERY INTELLIGENCE SUITE (Formatter / Translator / Explain / Schema tabs)
// ============================================================
// The 5th tab, Index Advisor, lives in its own file (index-advisor.js) — it
// talks to Live DB and was built as a standalone module from the start. The
// four tabs here were extracted from the old misc-mendix.js grab-bag (7.4):
// purely mechanical, no behavior change beyond the formatter fix in 7.1 and
// the three new SQL Explain detectors in 7.3 (see visualizeSqlExplain below).

function qiSetTab(tabId, el) {
  document.querySelectorAll('#panel-query-intelligence .tabs .tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
  if (el) { el.classList.add('active'); el.setAttribute('aria-selected', 'true'); }

  const tabs = ['formatter', 'translator', 'explain', 'schema', 'indexes'];
  tabs.forEach(t => {
    document.getElementById('qi-tab-' + t).style.display = (t === tabId) ? 'flex' : 'none';
  });
}

// ── Schema visualizer (join tree) ─────────────────────────────────────────

const getVennSVG = (joinType) => {
  const type = (joinType || 'INNER JOIN').toUpperCase().trim();
  const base = `<svg width="28" height="18" viewBox="0 0 40 24" style="margin-right:12px;overflow:visible;flex-shrink:0;">
    <circle cx="14" cy="12" r="10" stroke="currentColor" stroke-width="1.5" fill="none" />
    <circle cx="26" cy="12" r="10" stroke="currentColor" stroke-width="1.5" fill="none" />`;

  if (type.includes('INNER')) {
    return base + `<path d="M 20,4 A 10,10 0 0,0 20,20 A 10,10 0 0,0 20,4 Z" fill="currentColor" opacity="0.4" /></svg>`;
  }
  if (type.includes('LEFT')) {
    return base + `<circle cx="14" cy="12" r="10" fill="currentColor" opacity="0.4" /></svg>`;
  }
  if (type.includes('RIGHT')) {
    return base + `<circle cx="26" cy="12" r="10" fill="currentColor" opacity="0.4" /></svg>`;
  }
  if (type.includes('FULL')) {
    return base + `<circle cx="14" cy="12" r="10" fill="currentColor" opacity="0.4" /><circle cx="26" cy="12" r="10" fill="currentColor" opacity="0.4" /></svg>`;
  }
  return base + `<path d="M 20,4 A 10,10 0 0,0 20,20 A 10,10 0 0,0 20,4 Z" fill="currentColor" opacity="0.4" /></svg>`;
};

const getJoinDesc = (joinType) => {
  const type = (joinType || 'INNER JOIN').toUpperCase().trim();
  if (type.includes('INNER')) return 'INNER JOIN: Returns only records that have matches in BOTH entities (intersection).';
  if (type.includes('LEFT')) return 'LEFT JOIN: Returns ALL records from the parent entity, and only matched records from the joined entity. Unmatched child data will be empty.';
  if (type.includes('RIGHT')) return 'RIGHT JOIN: Returns ALL records from the joined entity, and only matched records from the parent entity.';
  if (type.includes('FULL')) return 'FULL OUTER JOIN: Returns all records when there is a match in either parent or child entity.';
  return 'Matches records between entities based on the association.';
};

function buildJoinTreeHtml(node, isRoot = true) {
  let [mod, name] = node.name.split('.');
  let html = `<div style="display:flex; flex-direction:column; align-items:flex-start; width:100%;">`;

  if (!isRoot) {
     let color = 'var(--primary)';
     let type = (node.joinType || 'INNER JOIN').toUpperCase();
     if(type.includes('LEFT')) color = 'var(--warning)';
     if(type.includes('RIGHT')) color = 'var(--info)';
     if(type.includes('FULL')) color = '#c792ea';

     html += `
     <div style="display:flex; align-items:center; margin-top:12px; margin-bottom:8px;">
        <div style="width:30px; height:2px; background:var(--border);"></div>
        <div style="background:var(--bg-sunken); border:1px solid ${color}; border-radius:var(--r-md); padding:8px 14px; display:flex; align-items:center; cursor:help; box-shadow:var(--shadow-sm);" title="${getJoinDesc(node.joinType)}">
           <div style="color:${color}">${getVennSVG(node.joinType)}</div>
           <div style="display:flex; flex-direction:column;">
             <span style="font-size:0.75rem; font-weight:700; color:${color}; letter-spacing:0.5px;">${type}</span>
             <span style="font-size:0.75rem; font-family:var(--font-mono); color:var(--text-secondary); margin-top:2px;">via ${node.assoc}</span>
           </div>
        </div>
     </div>`;
  }

  let boxMargin = isRoot ? '0' : 'margin-left: 40px;';

  html += `<div style="background:var(--bg-overlay); border:1px solid var(--border); border-left:4px solid var(--primary); border-radius:var(--r-md); padding:12px 16px; min-width:280px; box-shadow:var(--shadow-md); z-index:2; ${boxMargin} display:flex; align-items:center; justify-content:space-between; gap:16px;">
      <div style="display:flex; flex-direction:column;">
        <div style="font-size:0.75rem; color:var(--text-secondary); text-transform:uppercase; margin-bottom:2px; letter-spacing:0.5px">${mod}</div>
        <div style="font-weight:600; color:var(--text-primary); font-size:1.15rem; display:flex; align-items:center; gap:6px;">
           <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>
           ${name}
        </div>
      </div>
      ${node.alias ? `<div style="background:var(--bg-sunken); color:var(--text-muted); font-size:0.85rem; padding:4px 8px; border-radius:4px; font-family:var(--font-mono); border:1px solid var(--border)">${node.alias}</div>` : ''}
  </div>`;

  if (node.children && node.children.length > 0) {
      let childMarginLeft = isRoot ? 'margin-left: 20px;' : 'margin-left: 60px;';
      html += `<div style="border-left: 2px dashed var(--border); ${childMarginLeft} padding-bottom: 8px;">`;
      node.children.forEach(child => {
         html += buildJoinTreeHtml(child, false);
      });
      html += `</div>`;
  }

  html += `</div>`;
  return html;
}

// ── Schema visualizer pan/zoom (12.3) ───────────────────────────────────────
// The canvas is plain positioned HTML (not SVG/canvas drawing), so pan/zoom is
// a CSS transform on an inner viewport div — no new dependency. Zoom/pan state
// persists across re-extraction (typing in the query box shouldn't reset the
// user's view), which is why render targets #qi-schema-viewport, not the outer
// #qi-schema-canvas that owns the wheel/drag listeners.
let qiSchemaZoom = 1, qiSchemaPanX = 0, qiSchemaPanY = 0;
let qiSchemaDragging = false, qiSchemaDragStartX = 0, qiSchemaDragStartY = 0, qiSchemaPanStartX = 0, qiSchemaPanStartY = 0;

function qiSchemaClampZoom(z) {
  return Math.min(3, Math.max(0.3, z));
}

function qiApplySchemaTransform() {
  const vp = document.getElementById('qi-schema-viewport');
  if (vp) vp.style.transform = `translate(${qiSchemaPanX}px, ${qiSchemaPanY}px) scale(${qiSchemaZoom})`;
}

window.qiSchemaZoomBy = function (factor) {
  qiSchemaZoom = qiSchemaClampZoom(qiSchemaZoom * factor);
  qiApplySchemaTransform();
};

window.qiSchemaResetView = function () {
  qiSchemaZoom = 1; qiSchemaPanX = 0; qiSchemaPanY = 0;
  qiApplySchemaTransform();
};

function qiInitSchemaPanZoom() {
  const canvas = document.getElementById('qi-schema-canvas');
  if (!canvas || canvas.dataset.panZoomBound) return;
  canvas.dataset.panZoomBound = '1';
  canvas.style.cursor = 'grab';
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    qiSchemaZoom = qiSchemaClampZoom(qiSchemaZoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    qiApplySchemaTransform();
  }, { passive: false });
  canvas.addEventListener('mousedown', function (e) {
    qiSchemaDragging = true;
    qiSchemaDragStartX = e.clientX; qiSchemaDragStartY = e.clientY;
    qiSchemaPanStartX = qiSchemaPanX; qiSchemaPanStartY = qiSchemaPanY;
    canvas.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', function (e) {
    if (!qiSchemaDragging) return;
    qiSchemaPanX = qiSchemaPanStartX + (e.clientX - qiSchemaDragStartX);
    qiSchemaPanY = qiSchemaPanStartY + (e.clientY - qiSchemaDragStartY);
    qiApplySchemaTransform();
  });
  window.addEventListener('mouseup', function () { qiSchemaDragging = false; canvas.style.cursor = 'grab'; });
}

function qiExtractSchema() {
  const query = document.getElementById('qi-schema-query').value;
  const canvas = document.getElementById('qi-schema-viewport');
  qiInitSchemaPanZoom();
  if (!query.trim()) {
    canvas.innerHTML = '<span style="color:var(--text-muted)">Awaiting OQL query...</span>';
    window.qiSchemaResetView();
    return;
  }

  const nodes = [];
  const aliasToNode = {};

  const fromRegex = /FROM\s+([a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)(?:\s+(?!WHERE|GROUP|ORDER|HAVING|LIMIT|INNER|LEFT|RIGHT|FULL|OUTER|JOIN)([a-zA-Z0-9_]+))?/gi;
  let fromMatch;
  while ((fromMatch = fromRegex.exec(query)) !== null) {
    const ent = fromMatch[1];
    const alias = fromMatch[2];
    const node = { id: ent, name: ent, alias: alias, isRoot: true, children: [] };
    nodes.push(node);
    if (alias) aliasToNode[alias] = node;
  }

  const joinRegex = /((?:INNER|LEFT(?: OUTER)?|RIGHT(?: OUTER)?|FULL(?: OUTER)?|CROSS)?\s*JOIN)\s+([a-zA-Z0-9_]+)\/([a-zA-Z0-9_.\/]+)\/([a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)(?:\s+(?!WHERE|GROUP|ORDER|HAVING|LIMIT|ON)([a-zA-Z0-9_]+))?/gi;
  let joinMatch;
  while ((joinMatch = joinRegex.exec(query)) !== null) {
    const joinType = joinMatch[1].trim();
    const parentAlias = joinMatch[2];
    const assocPath = joinMatch[3];
    const targetEnt = joinMatch[4];
    const targetAlias = joinMatch[5];

    const pathParts = assocPath.split('/');
    const assoc = pathParts[pathParts.length - 1];

    const node = { id: targetEnt, name: targetEnt, alias: targetAlias, isRoot: false, joinType, assoc, children: [] };
    nodes.push(node);
    if (targetAlias) aliasToNode[targetAlias] = node;

    const parentNode = aliasToNode[parentAlias];
    if (parentNode) {
      parentNode.children.push(node);
    } else if (nodes.length > 0) {
      // fallback to first node if alias not found
      nodes[0].children.push(node);
    }
  }

  const rootNodes = nodes.filter(n => n.isRoot);

  if (rootNodes.length === 0) {
    canvas.innerHTML = '<span style="color:var(--warning)">No valid FROM clause found in query. Please ensure standard OQL format.</span>';
    return;
  }

  let html = '<div style="display:flex; flex-direction:column; gap:var(--sp-4); padding:var(--sp-4); width:100%; height:100%; overflow-y:auto; overflow-x:auto;">';
  rootNodes.forEach(root => {
    html += buildJoinTreeHtml(root);
  });
  html += '</div>';
  canvas.innerHTML = html;
  qiApplySchemaTransform();
}

// ── OQL pattern library (12.3) ──────────────────────────────────────────────
// The three patterns the audit named. Dates use only tokens verified in 10.2
// (tsMendixTokenPreview) — no invented `EndOf*`/`BeginOfNext*` token, which is
// why the range below is a lower bound rather than a closed [start, end) window.
const OQL_PATTERNS = {
  duplicates: {
    label: 'Find duplicates',
    oql: 'SELECT c.Email, COUNT(c.Email) AS DuplicateCount\nFROM eShop.Customer c\nGROUP BY c.Email\nHAVING COUNT(c.Email) > 1'
  },
  countByAssociation: {
    label: 'Count by association',
    oql: 'SELECT c.Name, COUNT(o.Amount) AS OrderCount\nFROM eShop.Customer c\nLEFT JOIN c/eShop.Customer_Order/eShop.Order o\nGROUP BY c.Name\nORDER BY OrderCount DESC'
  },
  dateRangeFilter: {
    label: 'Date range filter with [%tokens%]',
    oql: "SELECT o.OrderNumber, o.OrderDate\nFROM eShop.Order o\nWHERE o.OrderDate >= [%BeginOfCurrentMonth%]\n  AND o.OrderDate < [%CurrentDateTime%]"
  }
};

window.qiInsertOqlPattern = function (key) {
  const p = OQL_PATTERNS[key];
  if (!p) return;
  document.getElementById('oql-input').value = p.oql;
  formatOql();
};

// ── OQL Formatter ──────────────────────────────────────────────────────────
// Same string/comment-safe engine as sql.js (see sql-engine.js): a naive
// `\s+`/`\bKEYWORD\b` pass corrupts a literal like `WHERE Name = 'ORDER BY'`.
const OQL_BREAK_KEYWORDS = ['LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN',
  'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'OUTER JOIN', 'JOIN',
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET'];
const OQL_INDENT_KEYWORDS = ['AND', 'OR', 'ON'];
const OQL_INLINE_KEYWORDS = ['ASC', 'DESC', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'IS NULL', 'IS NOT NULL', 'TRUE', 'FALSE', 'NULL'];
const OQL_LIST_KEYWORDS = ['SELECT', 'GROUP BY', 'ORDER BY'];

function formatOql() {
  const input = document.getElementById('oql-input').value;
  const out = document.getElementById('oql-output');
  if (!input.trim()) {
    out.innerHTML = '<span style="color:var(--text-muted)">Output will appear here...</span>';
    return;
  }
  const formatted = sqePrettify(input, {
    breakKeywords: OQL_BREAK_KEYWORDS, indentKeywords: OQL_INDENT_KEYWORDS,
    inlineKeywords: OQL_INLINE_KEYWORDS, listKeywords: OQL_LIST_KEYWORDS
  });
  out.innerHTML = oqlHighlight(formatted);
}

function oqlHighlightCode(code) {
  return escHtml(code)
    // Numbers highlighted FIRST, before any other replacement injects its own
    // HTML — the COUNT/SUM span below carries a literal `font-weight:600`,
    // and a digit regex running after that would wrongly re-wrap that 600.
    // Guarded against matching the digit run of a mask placeholder too.
    .replace(new RegExp('(?<!' + sqeMark + ')\\b(\\d+(\\.\\d+)?)\\b(?!' + sqeMark + ')', 'g'), m => '<span class="sql-num">' + m + '</span>')
    .replace(/\b(SELECT|FROM|WHERE|AND|OR|NOT|IN|LEFT|RIGHT|INNER|OUTER|FULL|JOIN|ON|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|AS|CASE|WHEN|THEN|ELSE|END|EXISTS|BETWEEN|LIKE|IS NULL|IS NOT NULL|NULL|TRUE|FALSE|ASC|DESC)\b/gi,
      m => '<span class="sql-kw">' + m + '</span>')
    .replace(/\b(COUNT|SUM|AVG|MAX|MIN|CAST|DAY|MONTH|YEAR|ROUND|LENGTH)\b/gi,
      m => '<span style="color:#c678dd;font-weight:600">' + m + '</span>')
    .replace(/\$([a-zA-Z0-9_]+)/g, m => '<span style="color:#e5c07b">' + m + '</span>')
    .replace(/\[%[a-zA-Z0-9_]+%\]/g, m => '<span style="color:#e5c07b">' + m + '</span>');
}

function oqlHighlight(oql) {
  const masked = sqeMask(oql);
  const highlighted = oqlHighlightCode(masked.masked);
  return sqeUnmask(highlighted, masked.tokens, function (t) {
    const cls = t.type === 'comment' ? 'sql-comment' : 'sql-str';
    return '<span class="' + cls + '">' + escHtml(t.raw) + '</span>';
  });
}

// ── OQL <-> SQL translator ─────────────────────────────────────────────────

// Recognizes the same association-path join syntax qiExtractSchema already
// parses for the Schema Visualizer (`parentAlias/Module.Association/Module.
// TargetEntity targetAlias`) and rewrites it to a real SQL JOIN with the
// correct table name and alias. The one thing genuinely NOT derivable from
// OQL text alone is the physical FK column Mendix generated for that
// association — that lives in `mendixsystem$association.child_column_name`
// (see server/livedb.js), which this translator has no connection to. Rather
// than guess a column name and present it as fact (breaks "zasada danych"),
// the ON clause names the association explicitly and flags it for the one
// manual check that's actually required — the JOIN shape and target table are
// still 100% derived, not guessed.
function oqlTranslateAssociationJoins(text) {
  const joinRegex = /((?:INNER|LEFT(?: OUTER)?|RIGHT(?: OUTER)?|FULL(?: OUTER)?|CROSS)?\s*JOIN)\s+([a-zA-Z0-9_]+)\/([a-zA-Z0-9_.\/]+)\/([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)(?:\s+(?!WHERE|GROUP|ORDER|HAVING|LIMIT|ON)([a-zA-Z0-9_]+))?/gi;
  return text.replace(joinRegex, function (m, joinKw, parentAlias, assocPath, targetModule, targetEntity, targetAliasRaw) {
    const targetTable = (targetModule + '$' + targetEntity).toLowerCase();
    const targetAlias = targetAliasRaw || (targetModule + '_' + targetEntity).toLowerCase();
    const pathParts = assocPath.split('/');
    const assocFull = pathParts[pathParts.length - 1];
    const assocShort = assocFull.indexOf('.') === -1 ? assocFull : assocFull.slice(assocFull.indexOf('.') + 1);
    const sqlJoinKw = joinKw.replace(/\s+/g, ' ').trim().toUpperCase();
    return `${sqlJoinKw} ${targetTable} ${targetAlias} ON ${parentAlias}.id = ${targetAlias}.${assocShort.toLowerCase()} ` +
      `/* verify the FK column for association '${assocFull}' — check mendixsystem$association.child_column_name or the Domain Model tool */`;
  });
}

function translateOqlSql() {
  const dir = document.getElementById('oql-sql-dir').value;
  let val = document.getElementById('oql-sql-input').value;
  const out = document.getElementById('oql-sql-output');
  if (!val.trim()) { out.value = ''; return; }

  if (dir === 'o2s') {
    // OQL -> SQL (PostgreSQL). Association joins first — this consumes the
    // `alias/Module.Assoc/Module.Entity` path into real SQL syntax before the
    // generic entity-path regex below would otherwise corrupt it.
    val = oqlTranslateAssociationJoins(val);
    val = val.replace(/\b([A-Z][a-zA-Z0-9_]*)\.([A-Z][a-zA-Z0-9_]*)\b/g, (m, p1, p2) => (p1 + '$' + p2).toLowerCase());
    val = val.replace(/\bCAST\s*\(\s*(.*?)\s+AS\s+String\s*\)/gi, 'CAST($1 AS VARCHAR)');
    val = val.replace(/\bCAST\s*\(\s*(.*?)\s+AS\s+DateTime\s*\)/gi, 'CAST($1 AS TIMESTAMP)');
    val = val.replace(/\bCAST\s*\(\s*(.*?)\s+AS\s+Integer\s*\)/gi, 'CAST($1 AS INT)');
    val = val.replace(/\bCAST\s*\(\s*(.*?)\s+AS\s+Float\s*\)/gi, 'CAST($1 AS DOUBLE PRECISION)');
    val = val.replace(/\[%CurrentDateTime%\]/gi, 'CURRENT_TIMESTAMP');
    val = val.replace(/\[%BeginOfCurrentDay%\]/gi, "date_trunc('day', CURRENT_TIMESTAMP)");
  } else {
    // SQL -> OQL
    val = val.replace(/\b([a-z0-9_]+)\$([a-z0-9_]+)\b/g, (m, p1, p2) => {
      const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
      return cap(p1) + '.' + cap(p2);
    });
    val = val.replace(/\bCAST\s*\(\s*(.*?)\s+AS\s+VARCHAR\s*\)/gi, 'CAST($1 AS String)');
    val = val.replace(/\bCAST\s*\(\s*(.*?)\s+AS\s+TIMESTAMP\s*\)/gi, 'CAST($1 AS DateTime)');
    val = val.replace(/\bCAST\s*\(\s*(.*?)\s+AS\s+INT\s*\)/gi, 'CAST($1 AS Integer)');
    val = val.replace(/\bCAST\s*\(\s*(.*?)\s+AS\s+DOUBLE PRECISION\s*\)/gi, 'CAST($1 AS Float)');
    val = val.replace(/\bCURRENT_TIMESTAMP\b/gi, '[%CurrentDateTime%]');
    val = val.replace(/date_trunc\('day',\s*CURRENT_TIMESTAMP\)/gi, '[%BeginOfCurrentDay%]');
  }

  out.value = val;
}

// ── SQL Explain ────────────────────────────────────────────────────────────
// visualizeSqlExplain already covered Seq Scan / Index Scan / Hash Join /
// Nested Loop / Sort / cost / actual time, plus Filter-> index and
// Sort Key -> index suggestions. Fala 7.3 adds three detectors the audit
// found missing — each gated behind "no hits = no card" like the rest:
//   (a) a high % of rows discarded by a Filter (missing/unselective index)
//   (b) a Hash Join probing a Seq Scan with no matching Index Scan anywhere
//       in the plan (approximate — this is a flat line scan, not a real
//       plan tree, so it flags "somewhere in this plan", not the exact node)
//   (c) a Sort directly feeding a Limit (a "Top N" query a sorted index
//       would let the database skip the sort for entirely)
function visualizeSqlExplain() {
  const input = document.getElementById('sql-explain-input').value;
  const res = document.getElementById('sql-explain-result');
  if (!input.trim()) {
    res.style.display = 'none';
    return;
  }

  let lines = input.split('\n');
  let html = '<div style="font-family:var(--font-mono);font-size:0.85rem;line-height:1.5;white-space:pre-wrap;margin-top:var(--sp-3);padding-top:var(--sp-3);border-top:1px solid var(--border)">';

  // Data for analysis
  let foundTerms = new Set();
  let suggestions = [];
  let hasSeqScan = false;
  let currentScanTable = null;
  let currentActualRows = null;
  let lastLineHadLimit = false;
  const seqScanTables = new Set();
  const indexedTables = new Set();

  // Parsing and Highlighting
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let l = escHtml(line);

    // Detect Table for context
    let scanMatch = line.match(/Seq Scan on ([a-zA-Z0-9_]+)/i) || line.match(/Index Scan.*on ([a-zA-Z0-9_]+)/i);
    if (scanMatch) currentScanTable = scanMatch[1];

    // Actual row count this node returned (needed for the Rows Removed % below).
    const actualMatch = line.match(/actual time=[0-9.]+\.\.[0-9.]+\s+rows=(\d+)/i);
    if (actualMatch) currentActualRows = parseInt(actualMatch[1], 10);

    // Detect operations
    if (l.includes('Seq Scan')) {
      foundTerms.add('Seq Scan');
      hasSeqScan = true;
      if (scanMatch) seqScanTables.add(scanMatch[1]);
      l = l.replace(/Seq Scan/g, '<span style="background:var(--danger-subtle);color:var(--danger);padding:0 4px;border-radius:2px;font-weight:bold" title="Sequential scan of the entire dataset. Usually a reason for concern with large tables.">Seq Scan</span>');
    }
    if (l.includes('Index Scan') || l.includes('Index Only Scan')) {
      foundTerms.add('Index Scan');
      if (scanMatch) indexedTables.add(scanMatch[1]);
      l = l.replace(/Index( Only)? Scan/g, '<span style="color:var(--success);font-weight:bold" title="Optimal search using an index.">$&</span>');
    }
    if (l.includes('Hash Join')) {
      foundTerms.add('Hash Join');
      l = l.replace(/Hash Join/g, '<span style="color:var(--info);font-weight:bold" title="Fast table join using a hash table, requires significant RAM.">$&</span>');
    }
    if (l.includes('Nested Loop')) {
      foundTerms.add('Nested Loop');
      l = l.replace(/Nested Loop/g, '<span style="color:var(--warning);font-weight:bold" title="Nested loop join. Fast for small datasets, but performs poorly on millions of records.">$&</span>');
    }
    if (l.includes('Limit')) foundTerms.add('Limit');
    if (l.includes('Sort')) {
      foundTerms.add('Sort');
      // (c) redundant Sort: this Sort node directly feeds the Limit printed
      // just above it — a "Top N" query where a matching index would let the
      // database walk it in order and skip the sort entirely.
      if (lastLineHadLimit && !/Sort\s*Key:/i.test(line)) {
        suggestions.push('This <em>Sort</em> directly feeds the <em>Limit</em> above it — a classic "Top N" query. ' +
          '👉 <strong style="color:var(--primary)">Add an index matching the Sort Key</strong> (see below) so the database can walk rows already in order and skip the sort.');
      }
      l = l.replace(/Sort(?!\sKey)/g, '<span style="color:var(--warning);font-weight:bold" title="Sorting in memory (or on disk). Often avoidable by adding a corresponding index.">Sort</span>');
    }
    // Recorded AFTER the Sort check above uses it, so it reflects THIS line
    // for the next iteration (i.e. "was the previous plan line a Limit node").
    lastLineHadLimit = /\bLimit\b/.test(line);

    // Metrics
    if (l.includes('cost=')) {
      foundTerms.add('cost');
      l = l.replace(/cost=[0-9.]+\.\.[0-9.]+/g, '<span style="color:var(--warning)" title="Estimated cost: [start]..[total]. Lower is better.">$&</span>');
    }
    if (l.includes('actual time=')) {
      foundTerms.add('actual time');
      l = l.replace(/actual time=[0-9.]+\.\.[0-9.]+/g, '<span style="color:#c792ea" title="Actual execution time (in milliseconds). If very high, this is where the bottleneck is.">$&</span>');
    }

    // Filter and Sort suggestions
    if (line.includes('Filter:')) {
      let filterMatch = line.match(/Filter:\s*\((.*?)\)/);
      if (filterMatch && currentScanTable) {
        let cols = filterMatch[1].match(/([a-zA-Z0-9_]+)/g);
        if (cols && cols.length > 0) {
          // "Find the entity corresponding to table eshop$orderline" is work the
          // tool can do for the reader whenever a domain model has been loaded.
          const entity = window.mxEntityForTable ? window.mxEntityForTable(currentScanTable) : null;
          const target = entity
            ? `open entity <strong>${entity}</strong> (table <code>${currentScanTable}</code>)`
            : `find the entity corresponding to table <code>${currentScanTable}</code>`;
          suggestions.push(`Observed filtering on column <code>${cols[0]}</code> associated with table <strong>${currentScanTable}</strong> during a <em>Seq Scan</em>. <br>👉 <strong style="color:var(--primary)">Open Domain Model in Mendix Studio Pro</strong>, ${target}, and add an Index for attribute <code>${cols[0]}</code>.`);
        }
      }
    }
    if (line.includes('Sort Key:')) {
      let sortMatch = line.match(/Sort Key:\s*(.*)/);
      if (sortMatch) {
        let key = sortMatch[1].trim();
        // Check for DESC/ASC in the line or assume ascending
        let direction = key.toUpperCase().includes('DESC') ? 'Descending (Z to A)' : 'Ascending (A to Z)';
        let cleanKey = key.replace(/ DESC| ASC/ig, '').replace(/,/g, '');
        suggestions.push(`The query sorts data by <code>${key}</code>, which requires a memory/disk <em>Sort</em> node. To optimize this: <br>👉 <strong style="color:var(--primary)">Open Domain Model in Mendix Studio Pro</strong>, find the corresponding entity, and add an Index on attribute <code>${cleanKey}</code>. Set the index sorting direction to: <strong>${direction}</strong>.`);
      }
    }

    // (a) % of rows discarded by a Filter: a Seq/Index Scan that returned very
    // few rows after examining many more is exactly what a selective index fixes.
    if (line.includes('Rows Removed by Filter:')) {
      const removedMatch = line.match(/Rows Removed by Filter:\s*(\d+)/);
      if (removedMatch) {
        const removed = parseInt(removedMatch[1], 10);
        const kept = currentActualRows || 0;
        const total = removed + kept;
        if (total > 0) {
          const pct = Math.round((removed / total) * 100);
          if (pct >= 50) {
            suggestions.push(`<strong>${pct}% of rows were discarded by the Filter</strong>${currentScanTable ? ' on <strong>' + currentScanTable + '</strong>' : ''} ` +
              `(${removed} removed, ${kept} kept). The database examined far more rows than it needed. ` +
              `👉 A selective index on the filtered column would let it skip the discarded rows instead of reading and rejecting each one.`);
          }
        }
      }
    }

    html += l + '\n';
  }

  // (b) Hash Join probing a Seq Scan with no Index Scan anywhere on that table
  // in this plan. Flat line-scan, not a real plan tree, so this names the
  // table it's suspicious of rather than claiming which exact node is the probe.
  if (foundTerms.has('Hash Join')) {
    const unindexed = Array.from(seqScanTables).filter(t => !indexedTables.has(t));
    if (unindexed.length) {
      suggestions.push(`<strong>Hash Join present alongside a Seq Scan on ${unindexed.map(t => '<code>' + t + '</code>').join(', ')}</strong> with no Index Scan seen on ` +
        `${unindexed.length === 1 ? 'that table' : 'those tables'} anywhere in this plan. 👉 If the join or filter column there is selective, an index may let the planner avoid the sequential scan (or switch to a cheaper Nested Loop).`);
    }
  }

  html += '</div>';

  // Build Explanations & Report
  let reportHtml = ``;

  // 1. Summary
  if (hasSeqScan) {
    reportHtml += `<div class="notice notice-warning" style="margin-bottom:var(--sp-3)"><strong>Analysis:</strong> The query performs a "Seq Scan". This means the database is forced to scan data row-by-row instead of using an index shortcut. This will drastically slow down the application on large tables.</div>`;
  } else if (foundTerms.has('Index Scan')) {
    reportHtml += `<div class="notice notice-success" style="margin-bottom:var(--sp-3)"><strong>Analysis:</strong> Looks good! The database is using indexes (Index Scan / Index Only Scan), which is highly optimal. Check the costs to ensure the index fits the query perfectly.</div>`;
  } else {
    reportHtml += `<div class="notice notice-info" style="margin-bottom:var(--sp-3)"><strong>Analysis:</strong> Execution plan analyzed successfully. See details below.</div>`;
  }

  // 2. Suggestions
  if (suggestions.length > 0) {
    // Unique suggestions
    let uniqueSugg = [...new Set(suggestions)];
    reportHtml += `<div style="margin-bottom:var(--sp-3);background:var(--bg-sunken);border:1px dashed var(--primary);padding:var(--sp-3);border-radius:var(--r-md)">`;
    reportHtml += `<h4 style="margin-top:0;margin-bottom:var(--sp-2);color:var(--primary)">💡 Optimization Suggestions (Where to add indexes)</h4>`;
    reportHtml += `<ul style="margin:0;padding-left:20px;font-size:0.9rem;line-height:1.6;color:var(--text-muted)">`;
    uniqueSugg.forEach(s => reportHtml += `<li>${s}</li>`);
    reportHtml += `</ul></div>`;
  }

  // 3. Glossary
  let glossaryDefs = {
    'Seq Scan': '<strong>Seq Scan (Sequential Scan)</strong>: The database searches the entire table row by row from the beginning. Very slow for large tables.',
    'Index Scan': '<strong>Index Scan</strong>: The database uses an index to locate records immediately without scanning the entire table. Highly optimal.',
    'Hash Join': '<strong>Hash Join</strong>: The database builds a hash table in memory from one relation and scans the second relation to find matches. Fast but can consume significant RAM.',
    'Nested Loop': '<strong>Nested Loop</strong>: The database takes each row from the first table and scans the second table for a match. Good for small datasets, but performs poorly on large relations.',
    'Limit': '<strong>Limit</strong>: Restricts the number of returned rows. Often combined with a <em>Sort</em> operation to find the "Top N" records.',
    'Sort': '<strong>Sort</strong>: Reorders the retrieved rows in memory or on disk. Can be eliminated by adding a matching index that pre-sorts the data.',
    'cost': '<strong>Cost</strong>: An abstract unit of work calculated by the database planner (not seconds). The first value is the startup cost (before the first row is returned), and the second is the total cost.',
    'actual time': '<strong>Actual time</strong>: Only available when using <code>EXPLAIN ANALYZE</code>. The time in milliseconds taken to execute this step.'
  };

  if (foundTerms.size > 0) {
    reportHtml += `<div><h4 style="margin-bottom:var(--sp-2)">Glossary of terms found in the query plan:</h4><ul style="margin:0;padding-left:20px;font-size:0.9rem;line-height:1.6;color:var(--text-muted)">`;
    foundTerms.forEach(term => {
      if (glossaryDefs[term]) {
        reportHtml += `<li>${glossaryDefs[term]}</li>`;
      }
    });
    reportHtml += `</ul></div>`;
  }

  res.innerHTML = reportHtml + html;
  res.style.display = 'block';
}

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.qiSetTab = qiSetTab;
window.qiExtractSchema = qiExtractSchema;
window.formatOql = formatOql;
window.translateOqlSql = translateOqlSql;
window.visualizeSqlExplain = visualizeSqlExplain;

// Exposed for scripts/parser-test.js (pure functions, no DOM).
window.oqlTranslateAssociationJoins = oqlTranslateAssociationJoins;
window.OQL_PATTERNS = OQL_PATTERNS;

export function init() {
  qiInitSchemaPanZoom();
}
