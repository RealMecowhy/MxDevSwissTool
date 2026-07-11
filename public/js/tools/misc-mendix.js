// NEW TOOLS LOGIC (OQL, Thread Dump, SQL Explain, Naming, XPath Format, Mendix Regex)
// ============================================================

function formatXPathClick() {
  let val = document.getElementById('xpath-input').value;
  if (!val) { document.getElementById('xpath-output').value = ''; return; }
  // String-aware formatting: only insert breaks outside string literals
  let result = '', inStr = false, strChar = '';
  for (let i = 0; i < val.length; i++) {
    const ch = val[i];
    if (!inStr && (ch === "'" || ch === '"')) { inStr = true; strChar = ch; result += ch; }
    else if (inStr && ch === strChar) { inStr = false; result += ch; }
    else if (!inStr) {
      const rest = val.slice(i);
      const andM = rest.match(/^(\s+and\s+)/i);
      const orM  = rest.match(/^(\s+or\s+)/i);
      const bracketPair = rest.match(/^\]\[/);
      if (andM)        { result += '\n  and '; i += andM[1].length - 1; }
      else if (orM)    { result += '\n  or ';  i += orM[1].length - 1; }
      else if (bracketPair) { result += ']\n['; i += 1; }
      else             { result += ch; }
    } else { result += ch; }
  }
  document.getElementById('xpath-output').value = result;
  xpathAnalyze();
}

function qiSetTab(tabId, el) {
  document.querySelectorAll('#panel-query-intelligence .tabs .tab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  
  const tabs = ['formatter', 'translator', 'explain', 'schema'];
  tabs.forEach(t => {
    document.getElementById('qi-tab-' + t).style.display = (t === tabId) ? 'flex' : 'none';
  });
}

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

function qiExtractSchema() {
  const query = document.getElementById('qi-schema-query').value;
  const canvas = document.getElementById('qi-schema-canvas');
  if (!query.trim()) {
    canvas.innerHTML = '<span style="color:var(--text-muted)">Awaiting OQL query...</span>';
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
}

function formatOql() {
  const input = document.getElementById('oql-input').value;
  const out = document.getElementById('oql-output');
  if (!input.trim()) {
    out.innerHTML = '<span style="color:var(--text-muted)">Output will appear here...</span>';
    return;
  }
  
  const breaks = [
    'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN',
    'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'OUTER JOIN', 'JOIN', 
    'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET'
  ];
  const indents = ['AND', 'OR', 'ON'];
  const inlineKws = ['ASC', 'DESC', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'IS NULL', 'IS NOT NULL', 'TRUE', 'FALSE', 'NULL'];
  
  let res = input.replace(/\s+/g, ' ').trim();
  
  const breakRe = new RegExp('\\b(' + breaks.join('|').replace(/ /g, '\\s+') + ')\\b', 'gi');
  res = res.replace(breakRe, m => '\n' + m.toUpperCase());

  const indentRe = new RegExp('\\b(' + indents.join('|').replace(/ /g, '\\s+') + ')\\b', 'gi');
  res = res.replace(indentRe, m => '\n  ' + m.toUpperCase());

  const inlineRe = new RegExp('\\b(' + inlineKws.join('|').replace(/ /g, '\\s+') + ')\\b', 'gi');
  res = res.replace(inlineRe, m => m.toUpperCase());

  // Helper to split elements on top-level commas (outside parentheses)
  const splitTopLevelCommas = (text) => {
    let parts = [];
    let current = '';
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      let char = text[i];
      if (char === '(') depth++;
      else if (char === ')') depth--;
      
      if (char === ',' && depth === 0) {
        parts.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  };

  let lines = res.split('\n').filter(l => l.trim() !== '');
  let formatted = lines.map(line => {
    let trimmed = line.trim();
    if (trimmed.startsWith('SELECT ')) {
      let content = trimmed.substring(7);
      let parts = splitTopLevelCommas(content);
      return 'SELECT\n  ' + parts.join(',\n  ');
    }
    if (trimmed.startsWith('GROUP BY ')) {
      let content = trimmed.substring(9);
      let parts = splitTopLevelCommas(content);
      return 'GROUP BY\n  ' + parts.join(',\n  ');
    }
    if (trimmed.startsWith('ORDER BY ')) {
      let content = trimmed.substring(9);
      let parts = splitTopLevelCommas(content);
      return 'ORDER BY\n  ' + parts.join(',\n  ');
    }

    if (line.startsWith('  ')) {
      return '  ' + trimmed;
    } else if (trimmed.includes('JOIN')) {
      return ' ' + trimmed;
    }
    return trimmed;
  }).join('\n');
  
  let html = escHtml(formatted)
    .replace(/\b(SELECT|FROM|WHERE|AND|OR|NOT|IN|LEFT|RIGHT|INNER|OUTER|FULL|JOIN|ON|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|AS|CASE|WHEN|THEN|ELSE|END|EXISTS|BETWEEN|LIKE|IS NULL|IS NOT NULL|NULL|TRUE|FALSE|ASC|DESC)\b/gi,
      m => '<span class="sql-kw">' + m + '</span>')
    .replace(/\b(COUNT|SUM|AVG|MAX|MIN|CAST|DAY|MONTH|YEAR|ROUND|LENGTH)\b/gi,
      m => '<span style="color:#c678dd;font-weight:600">' + m + '</span>')
    .replace(/'([^']*)'/g, m => '<span class="sql-str">' + m + '</span>')
    .replace(/--[^\n]*/g, m => '<span class="sql-comment">' + m + '</span>')
    .replace(/\$([a-zA-Z0-9_]+)/g, m => '<span style="color:#e5c07b">' + m + '</span>')
    .replace(/\[%[a-zA-Z0-9_]+%\]/g, m => '<span style="color:#e5c07b">' + m + '</span>')
    .replace(/\b(\d+(\.\d+)?)\b(?![^<]*>)/g, m => '<span class="sql-num">' + m + '</span>');
    
  out.innerHTML = html;
}

function translateOqlSql() {
  const dir = document.getElementById('oql-sql-dir').value;
  let val = document.getElementById('oql-sql-input').value;
  const out = document.getElementById('oql-sql-output');
  if (!val.trim()) { out.value = ''; return; }

  if (dir === 'o2s') {
    // OQL -> SQL (PostgreSQL)
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

function analyzeThreadDump() {
  const input = document.getElementById('thread-dump-input').value;
  const res = document.getElementById('thread-dump-result');
  if (!input.trim()) {
    res.style.display = 'none';
    return;
  }
  
  let blocked = [], waiting = [], runnable = [];
  let currentThread = null, currentTrace = [];
  
  const lines = input.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('"')) {
      if (currentThread) {
        currentThread.trace = currentTrace.join('\n');
        if (currentThread.state.includes('BLOCKED')) blocked.push(currentThread);
        else if (currentThread.state.includes('WAITING')) waiting.push(currentThread);
        else if (currentThread.state.includes('RUNNABLE')) runnable.push(currentThread);
      }
      currentThread = { name: line, state: 'UNKNOWN', trace: '' };
      currentTrace = [];
    } else if (line.includes('java.lang.Thread.State:')) {
      if (currentThread) currentThread.state = line.trim();
    } else if (line.trim().startsWith('at ') || line.trim().startsWith('- ')) {
      currentTrace.push(line);
    }
  }
  if (currentThread) {
    currentThread.trace = currentTrace.join('\n');
    if (currentThread.state.includes('BLOCKED')) blocked.push(currentThread);
    else if (currentThread.state.includes('WAITING')) waiting.push(currentThread);
    else if (currentThread.state.includes('RUNNABLE')) runnable.push(currentThread);
  }
  
  // Detect deadlocks: threads waiting for locks held by other blocked/waiting threads
  const deadlocks = [];
  const allProblematic = [...blocked, ...waiting.filter(t => t.trace.includes('waiting to lock'))];
  allProblematic.forEach(t => {
    const lockMatch = t.trace.match(/waiting to lock <([0-9a-fx]+)>/);
    if (lockMatch) {
      const targetLock = lockMatch[1];
      const holder = allProblematic.find(other => other !== t && other.trace.includes('locked <' + targetLock + '>'));
      if (holder) deadlocks.push({ waiter: t.name.split('"')[1] || t.name, holder: holder.name.split('"')[1] || holder.name, lock: targetLock });
    }
  });

  let html = `<div style="display:flex;gap:var(--sp-4);margin-bottom:var(--sp-3)">
    <div class="card" style="flex:1;border-color:var(--danger)"><div class="card-body"><h3 style="color:var(--danger);margin:0">${blocked.length}</h3><div style="font-size:0.8rem">BLOCKED</div></div></div>
    <div class="card" style="flex:1;border-color:var(--warning)"><div class="card-body"><h3 style="color:var(--warning);margin:0">${waiting.length}</h3><div style="font-size:0.8rem">WAITING</div></div></div>
    <div class="card" style="flex:1;border-color:var(--success)"><div class="card-body"><h3 style="color:var(--success);margin:0">${runnable.length}</h3><div style="font-size:0.8rem">RUNNABLE</div></div></div>
  </div>`;
  
  if (deadlocks.length > 0) {
    html += `<div class="notice notice-error" style="margin-bottom:var(--sp-3)"><strong>⚠️ ${deadlocks.length} Deadlock(s) detected!</strong><ul style="margin-top:4px;padding-left:1.2em">`;
    deadlocks.forEach(d => { html += `<li><code>${escHtml(d.waiter)}</code> waiting for lock held by <code>${escHtml(d.holder)}</code> (lock: ${d.lock})</li>`; });
    html += '</ul></div>';
  }

  if (blocked.length > 0) {
    html += `<h4 style="color:var(--danger);margin-bottom:var(--sp-2)">Blocked Threads</h4>`;
    blocked.forEach(t => {
      html += `<div style="background:var(--bg-elevated);border:1px solid var(--danger-subtle);padding:var(--sp-2);border-radius:var(--r-md);margin-bottom:var(--sp-2);font-family:var(--font-mono);font-size:0.8rem">
        <div style="color:var(--text-primary);font-weight:600">${escHtml(t.name)}</div>
        <div style="color:var(--danger);margin-bottom:var(--sp-1)">${escHtml(t.state)}</div>
        <div style="color:var(--text-muted);white-space:pre-wrap">${escHtml(t.trace)}</div>
      </div>`;
    });
  }
  
  const foundDeadlockMatch = input.match(/Found (\d+) deadlock/);
  if (foundDeadlockMatch && deadlocks.length === 0) {
    html = `<div class="notice notice-error" style="margin-bottom:var(--sp-3)"><strong>⚠️ Java detected ${foundDeadlockMatch[1]} deadlock(s) in this thread dump.</strong> Look for "waiting to lock" entries above.</div>` + html;
  }

  res.innerHTML = html;
  res.style.display = 'block';
}

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
  
  // Parsing and Highlighting
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let l = escHtml(line);
    
    // Detect Table for context
    let scanMatch = line.match(/Seq Scan on ([a-zA-Z0-9_]+)/i) || line.match(/Index Scan.*on ([a-zA-Z0-9_]+)/i);
    if (scanMatch) currentScanTable = scanMatch[1];
    
    // Detect operations
    if (l.includes('Seq Scan')) {
      foundTerms.add('Seq Scan');
      hasSeqScan = true;
      l = l.replace(/Seq Scan/g, '<span style="background:var(--danger-subtle);color:var(--danger);padding:0 4px;border-radius:2px;font-weight:bold" title="Sequential scan of the entire dataset. Usually a reason for concern with large tables.">Seq Scan</span>');
    }
    if (l.includes('Index Scan') || l.includes('Index Only Scan')) {
      foundTerms.add('Index Scan');
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
      l = l.replace(/Sort(?!\sKey)/g, '<span style="color:var(--warning);font-weight:bold" title="Sorting in memory (or on disk). Often avoidable by adding a corresponding index.">Sort</span>');
    }
    
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
          suggestions.push(`Observed filtering on column <code>${cols[0]}</code> associated with table <strong>${currentScanTable}</strong> during a <em>Seq Scan</em>. <br>👉 <strong style="color:var(--primary)">Open Domain Model in Mendix Studio Pro</strong>, find the entity corresponding to table <code>${currentScanTable}</code>, and add an Index for attribute <code>${cols[0]}</code>.`);
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

    html += l + '\n';
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


function regexTestMendixMode() {
  const pat = document.getElementById('regex-input').value;
  const flags = document.getElementById('regex-flags').value;
  const test = document.getElementById('regex-test-str').value;
  const isMatchMode = document.getElementById('regex-ismatch-mode').checked;
  const mEl = document.getElementById('regex-matches');
  const sEl = document.getElementById('regex-stats');
  const hEl = document.getElementById('regex-highlight');
  
  if (!pat) {
    mEl.innerHTML = '<span style="color:var(--text-muted)">No pattern entered</span>';
    sEl.innerHTML = '';
    hEl.innerHTML = escHtml(test);
    return;
  }
  
  try {
    let evalPat = pat;
    if (isMatchMode) {
      evalPat = '^(?:' + pat + ')$';
    }
    
    const gFlags = flags.includes('g') ? flags : flags + 'g';
    const reHigh = new RegExp(evalPat, gFlags);
    
    let matchArr;
    let lastIdx = 0;
    let hl = '';
    let matchesCount = 0;
    
    while ((matchArr = reHigh.exec(test)) !== null) {
      if (matchArr[0].length === 0) {
        reHigh.lastIndex++; 
        continue;
      }
      hl += escHtml(test.substring(lastIdx, matchArr.index));
      hl += '<mark style="background:#f8c555;color:#111;border-radius:2px">' + escHtml(matchArr[0]) + '</mark>';
      lastIdx = matchArr.index + matchArr[0].length;
      matchesCount++;
    }
    hl += escHtml(test.substring(lastIdx));
    hEl.innerHTML = hl + '<br/>'; 
    
    sEl.innerHTML = `<span class="badge ${matchesCount>0?'badge-success':'badge-danger'}">${matchesCount} match${matchesCount!==1?'es':''}</span>`;
    
    if (matchesCount === 0) {
      mEl.innerHTML = '<span style="color:var(--text-muted)">No matches found</span>';
      return;
    }
    
    const matches = [...test.matchAll(new RegExp(evalPat, gFlags))];
    let mHtml = '';
    matches.forEach((m, i) => {
      mHtml += `<div style="margin-bottom:var(--sp-2);padding-bottom:var(--sp-2);border-bottom:1px solid var(--border)">`;
      mHtml += `<div style="color:var(--accent);font-weight:600;margin-bottom:4px">Match ${i+1} <span style="color:var(--text-muted);font-weight:normal;font-size:0.7rem">(Index: ${m.index})</span></div>`;
      mHtml += `<div style="padding-left:var(--sp-2);border-left:2px solid var(--accent)">${escHtml(m[0])}</div>`;
      if (m.length > 1) {
        mHtml += `<div style="margin-top:4px;font-size:0.75rem;color:var(--text-secondary)">Groups:</div>`;
        for (let g = 1; g < m.length; g++) {
          if (m[g] !== undefined) mHtml += `<div style="padding-left:var(--sp-3)"><span style="color:var(--info)">$${g}:</span> ${escHtml(m[g])}</div>`;
        }
      }
      mHtml += `</div>`;
    });
    mEl.innerHTML = mHtml;
    
  } catch (e) {
    mEl.innerHTML = '<span style="color:var(--danger)">Invalid regex: ' + escHtml(e.message) + '</span>';
    sEl.innerHTML = '';
    hEl.innerHTML = escHtml(test) + '<br/>';
  }
}

function generatePassword() {
  const len = parseInt(document.getElementById('pwd-len').value);
  const up = document.getElementById('pwd-upper').checked;
  const low = document.getElementById('pwd-lower').checked;
  const num = document.getElementById('pwd-num').checked;
  const spec = document.getElementById('pwd-spec').checked;
  
  const cUp = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const cLow = "abcdefghijklmnopqrstuvwxyz";
  const cNum = "0123456789";
  const cSpec = "!@#$%^&*()_+~`|}{[]:;?><,./-=";
  
  let chars = "";
  if (up) chars += cUp;
  if (low) chars += cLow;
  if (num) chars += cNum;
  if (spec) chars += cSpec;
  
  if (chars.length === 0) {
    document.getElementById('pwd-result').value = "Select at least one character type";
    return;
  }
  
  let pwd = "";
  const array = new Uint32Array(len);
  window.crypto.getRandomValues(array);
  
  for (let i = 0; i < len; i++) {
    pwd += chars[array[i] % chars.length];
  }
  
  document.getElementById('pwd-result').value = pwd;
}

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.formatXPathClick = formatXPathClick;
window.qiSetTab = qiSetTab;
window.qiExtractSchema = qiExtractSchema;
window.formatOql = formatOql;
window.translateOqlSql = translateOqlSql;
window.analyzeThreadDump = analyzeThreadDump;
window.visualizeSqlExplain = visualizeSqlExplain;
window.regexTestMendixMode = regexTestMendixMode;
window.generatePassword = generatePassword;

export function init() {}
