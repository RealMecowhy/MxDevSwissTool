// Log Query Extractor - Mendix TRACE Log Parser
// Extracts SQL queries, XPath/OQL sources, Query Plans, parameters and results

let extractedQueries = [];

window.lqeSetTab = function(tabId, btn) {
  const container = document.getElementById('panel-log-query-extractor');
  container.querySelectorAll('.tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
  btn.classList.add('active');
  btn.setAttribute('aria-selected', 'true');
  
  container.querySelectorAll('#lqe-tab-sql, #lqe-tab-source, #lqe-tab-params, #lqe-tab-result, #lqe-tab-plan').forEach(el => {
    el.style.display = 'none';
  });
  
  document.getElementById(tabId).style.display = 'block';
};

window.lqeClear = function() {
  extractedQueries = [];
  document.getElementById('lqe-query-list').innerHTML = '';
  document.getElementById('lqe-count').textContent = '0';
  document.getElementById('lqe-sql-content').textContent = 'Select a query to view its runnable SQL...';
  document.getElementById('lqe-source-content').textContent = 'No source available (XPath/OQL) for this query.';
  document.getElementById('lqe-params-body').innerHTML = '<tr><td colspan="2" style="padding:var(--sp-3); color:var(--text-muted); text-align:center;">No parameters</td></tr>';
  document.getElementById('lqe-result-content').textContent = 'No result output logged.';
  document.getElementById('lqe-plan-content').textContent = 'No execution plan found for this query.';
  const fileInput = document.getElementById('lqe-file-input');
  if (fileInput) fileInput.value = '';
};

window.lqeLoadFile = function(files) {
  if (!files || files.length === 0) return;
  const file = files[0];
  const reader = new FileReader();
  if (window.showLoader) window.showLoader('Reading log file...');
  
  reader.onload = function(e) {
    const text = e.target.result;
    setTimeout(() => parseLogContent(text), 50);
  };
  
  reader.readAsText(file);
};

function parseLogContent(text) {
  if (window.showLoader) window.showLoader('Parsing queries...', 50);
  
  // Step 1: Parse CSV properly, handling multiline quoted fields
  const rawLines = text.split('\n');
  const csvRows = [];
  
  let currentLine = '';
  let insideQuotes = false;
  
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i].replace(/\r$/, '');
    currentLine += (currentLine ? '\n' : '') + line;
    
    // Count unescaped quotes to determine if we're inside a quoted field
    let quoteCount = 0;
    for (let j = 0; j < line.length; j++) {
      if (line[j] === '"') quoteCount++;
    }
    
    if (quoteCount % 2 !== 0) {
      insideQuotes = !insideQuotes;
    }
    
    if (!insideQuotes) {
      csvRows.push(currentLine);
      currentLine = '';
    }
  }
  if (currentLine) csvRows.push(currentLine);
  
  // Step 2: Parse each CSV row into structured records
  const records = [];
  for (const row of csvRows) {
    // Skip header
    if (row.startsWith('Type,TimeStamp,LogNode,Message')) continue;
    
    // Parse CSV fields properly
    const fields = parseCSVRow(row);
    if (fields.length < 4) continue;
    
    records.push({
      type: fields[0],
      timestamp: fields[1],
      logNode: fields[2],
      message: fields[3],
      cause: fields[4] || ''
    });
  }
  
  extractQueriesFromRecords(records);
}

// Proper CSV field parser that handles quoted fields with embedded commas and doubled quotes
function parseCSVRow(row) {
  const fields = [];
  let i = 0;
  
  while (i < row.length) {
    if (row[i] === '"') {
      // Quoted field
      let field = '';
      i++; // skip opening quote
      while (i < row.length) {
        if (row[i] === '"' && i + 1 < row.length && row[i + 1] === '"') {
          field += '"';
          i += 2;
        } else if (row[i] === '"') {
          i++; // skip closing quote
          break;
        } else {
          field += row[i];
          i++;
        }
      }
      fields.push(field);
      if (i < row.length && row[i] === ',') i++; // skip comma
    } else {
      // Unquoted field
      let end = row.indexOf(',', i);
      if (end === -1) end = row.length;
      fields.push(row.substring(i, end));
      i = end + 1;
    }
  }
  
  return fields;
}

function extractQueriesFromRecords(records) {
  const queryMap = new Map();    // sqlId -> query object
  const xpathMap = new Map();    // xpathId -> { xpath, oql }
  const planMap = new Map();     // xpathId -> plan JSON string
  const unlinkedPlans = [];      // plans without xpathId, in order
  
  // First pass: collect all XPath sources, OQL translations, and Query Plans
  for (const rec of records) {
    const msg = rec.message;
    
    // XPath incoming
    let xpathMatch = msg.match(/^Incoming query of type (XPath|OQL):\s*\[([a-f0-9-]+)\]\s*(.*)/is); // jshint ignore:line
    if (xpathMatch) {
      const id = xpathMatch[2];
      if (!xpathMap.has(id)) xpathMap.set(id, { xpath: '', oql: '' });
      xpathMap.get(id).xpath = xpathMatch[1] + ': ' + xpathMatch[3].trim();
      continue;
    }
    
    // OQL QueryParseResult
    let oqlMatch = msg.match(/^OQL:\s*\[([a-f0-9-]+)\]\s*QueryParseResult\((.*)\)/is); // jshint ignore:line
    if (oqlMatch) {
      const id = oqlMatch[1];
      let oqlContent = oqlMatch[2].trim();
      // Remove trailing Mendix metadata
      oqlContent = oqlContent.replace(/,com\.mendix\.connectionbus\..*$/s, ''); // jshint ignore:line
      if (!xpathMap.has(id)) xpathMap.set(id, { xpath: '', oql: '' });
      xpathMap.get(id).oql = oqlContent;
      continue;
    }
    
    // Query Plan from DataStorage_QueryPlan
    if (rec.logNode === 'DataStorage_QueryPlan') {
      let planMatch = msg.match(/^Query Plan:\s*(?:\[([a-f0-9-]+)\]\s*)?([\s\S]*)/i);
      if (planMatch) {
        const xpathId = planMatch[1] || null;
        const planJson = planMatch[2].trim();
        if (xpathId) {
          planMap.set(xpathId, planJson);
        } else {
          unlinkedPlans.push(planJson);
        }
      }
      continue;
    }
  }
  
  // Second pass: extract SQL queries and correlate everything
  let lastSqlId = null;
  let unlinkedPlanIdx = 0;
  
  for (const rec of records) {
    const msg = rec.message;
    
    // SQL line: SQL@SQLID(TX-CONN): content
    let sqlMatch = msg.match(/^SQL@([a-f0-9]+)\((T\d+-C[a-f0-9]+)\):\s*(.*)/is); // jshint ignore:line
    if (!sqlMatch) continue;
    
    const sqlId = sqlMatch[1];
    const txConn = sqlMatch[2];
    const content = sqlMatch[3].trim();
    
    if (!queryMap.has(sqlId)) {
      queryMap.set(sqlId, {
        sqlId: sqlId,
        txConn: txConn,
        timestamp: rec.timestamp,
        sql: '',
        type: 'OTHER',
        params: [],
        paramsString: '',
        status: 'Pending',
        rows: '-',
        xpathId: null,
        xpathContent: '',
        resultData: '',
        queryPlan: '',
        duration: null,
        cost: null
      });
    }
    
    const q = queryMap.get(sqlId);
    lastSqlId = sqlId;
    
    // Determine content type
    // IMPORTANT: Check params BEFORE SQL keywords because "Select params..." starts with "SELECT"
    if (content.match(/^(Select|Update|Insert|Delete) params/i)) {
      const paramStr = content.substring(content.indexOf(':') + 1).trim();
      q.paramsString = (q.paramsString ? q.paramsString + ', ' : '') + paramStr;
    }
    else if (content.startsWith('Success:')) {
      q.status = 'Success';
    }
    else if (content.match(/^\[([a-f0-9-]+)\]\s*Data table/)) {
      // Result line with xpathId link — this is the KEY correlation!
      let m = content.match(/^\[([a-f0-9-]+)\]\s*(.*)/is); // jshint ignore:line
      q.xpathId = m[1];
      
      // Link XPath/OQL source
      if (xpathMap.has(q.xpathId)) {
        const src = xpathMap.get(q.xpathId);
        let parts = [];
        if (src.xpath) parts.push(src.xpath);
        if (src.oql) parts.push('\nTranslated OQL:\n' + src.oql);
        q.xpathContent = parts.join('\n');
      }
      
      // Link Query Plan
      if (planMap.has(q.xpathId)) {
        q.queryPlan = planMap.get(q.xpathId);
      }
      
      let rowMatch = m[2].match(/\((\d+)\s*row\(s\)\)/);
      if (rowMatch) q.rows = rowMatch[1];
      
      q.resultData += m[2] + '\n';
    }
    else if (content.startsWith('Data table')) {
      let rowMatch = content.match(/\((\d+)\s*row\(s\)\)/);
      if (rowMatch) q.rows = rowMatch[1];
      q.resultData += content + '\n';
    }
    else if (content.startsWith('Row ')) {
      q.resultData += content + '\n';
    }
    else {
      // SQL statement detection (must be last because all other patterns start with known prefixes)
      const upperContent = content.toUpperCase();
      if (upperContent.startsWith('SELECT ') || upperContent.startsWith('UPDATE ') || 
          upperContent.startsWith('INSERT ') || upperContent.startsWith('DELETE ') || 
          upperContent.startsWith('COUNT(')) {
        q.sql = content;
        if (upperContent.startsWith('SELECT')) q.type = 'SELECT';
        else if (upperContent.startsWith('UPDATE')) q.type = 'UPDATE';
        else if (upperContent.startsWith('INSERT')) q.type = 'INSERT';
        else if (upperContent.startsWith('DELETE')) q.type = 'DELETE';
        else if (upperContent.startsWith('COUNT')) q.type = 'SELECT';
      }
    }
  }
  
  // Build final list
  extractedQueries = Array.from(queryMap.values()).filter(q => q.sql.length > 0);

  // Duplicate detection (N+1): identical statements differ only in bound values,
  // so a normalized signature groups them together.
  const sigCounts = new Map();
  extractedQueries.forEach((q, i) => {
    q._idx = i;
    q.signature = q.sql.replace(/\s+/g, ' ').replace(/\b\d+\b/g, '?').trim().toLowerCase();
    sigCounts.set(q.signature, (sigCounts.get(q.signature) || 0) + 1);
  });
  extractedQueries.forEach(q => { q.dupCount = sigCounts.get(q.signature) || 1; });
  
  // Post-process: parse params, extract duration/cost from query plans
  for (let q of extractedQueries) {
    // For queries without an xpathId, try to assign an unlinked plan
    if (!q.queryPlan && unlinkedPlanIdx < unlinkedPlans.length && !q.xpathId) {
      q.queryPlan = unlinkedPlans[unlinkedPlanIdx++];
    }
    
    // Parse query plan JSON to extract duration and cost
    if (q.queryPlan) {
      try {
        const p = JSON.parse(q.queryPlan);
        if (p && p.length > 0 && p[0]) {
          // Execution Time is at the top level of the plan array element
          if (p[0]['Execution Time'] !== undefined) {
            q.duration = parseFloat(p[0]['Execution Time']).toFixed(3) + ' ms';
          } else if (p[0].Plan && p[0].Plan['Actual Total Time'] !== undefined) {
            q.duration = parseFloat(p[0].Plan['Actual Total Time']).toFixed(3) + ' ms';
          }
          if (p[0].Plan && p[0].Plan['Total Cost'] !== undefined) {
            q.cost = p[0].Plan['Total Cost'];
          }
          // Also extract Planning Time
          if (p[0]['Planning Time'] !== undefined) {
            q.planningTime = parseFloat(p[0]['Planning Time']).toFixed(3) + ' ms';
          }
        }
      } catch(e) {
        // Plan JSON wasn't valid — keep raw text
      }
    }
    
    // Parse params string
    if (q.paramsString) {
      if (q.paramsString.endsWith(',')) q.paramsString = q.paramsString.slice(0, -1);
      q.params = splitParams(q.paramsString);
    }
  }
  
  window.lqeFilter();
  if (window.hideLoader) window.hideLoader();
}

function splitParams(str) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '"') {
      inQuotes = !inQuotes;
      current += c;
    } else if (c === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  if (current) result.push(current.trim());
  return result;
}

let lqeSortKey = null;
let lqeSortDir = -1; // -1 = descending (slowest/most expensive first)

const LQE_SORT_ACCESSORS = {
  time: q => q._idx,
  duration: q => (q.duration ? parseFloat(q.duration) : -1),
  cost: q => (q.cost !== null && q.cost !== undefined ? parseFloat(q.cost) : -1),
  rows: q => (q.rows !== '-' ? parseInt(q.rows, 10) : -1)
};

window.lqeSort = function(key) {
  if (lqeSortKey === key) {
    lqeSortDir = -lqeSortDir;
  } else {
    lqeSortKey = key;
    lqeSortDir = key === 'time' ? 1 : -1;
  }
  // Update header arrows
  document.querySelectorAll('#lqe-list-header [data-sort-key]').forEach(el => {
    const arrow = el.querySelector('.lqe-sort-arrow');
    if (!arrow) return;
    arrow.textContent = (el.getAttribute('data-sort-key') === lqeSortKey) ? (lqeSortDir === 1 ? ' ▲' : ' ▼') : '';
  });
  window.lqeFilter();
};

window.lqeFilter = function() {
  const searchEl = document.getElementById('lqe-search');
  const search = searchEl ? searchEl.value.toLowerCase() : '';
  const typeFilterEl = document.getElementById('lqe-type-filter');
  const typeFilter = typeFilterEl ? typeFilterEl.value : 'ALL';

  const filtered = extractedQueries.filter(q => {
    if (typeFilter === 'DUP') {
      if (q.dupCount < 2) return false;
    } else if (typeFilter !== 'ALL' && q.type !== typeFilter) {
      return false;
    }
    if (search) {
      if (!q.sql.toLowerCase().includes(search) &&
          !q.txConn.toLowerCase().includes(search) &&
          !q.type.toLowerCase().includes(search) &&
          !(q.xpathContent && q.xpathContent.toLowerCase().includes(search))) {
        return false;
      }
    }
    return true;
  });

  if (lqeSortKey && LQE_SORT_ACCESSORS[lqeSortKey]) {
    const acc = LQE_SORT_ACCESSORS[lqeSortKey];
    filtered.sort((a, b) => (acc(a) - acc(b)) * lqeSortDir);
  }

  const countEl = document.getElementById('lqe-count');
  if (countEl) countEl.textContent = filtered.length;
  renderQueryList(filtered);
};

function highlightJsonSimple(json) {
  if (typeof json != 'string') json = JSON.stringify(json, undefined, 2);
  json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
    let cls = 'jt-num';
    if (/^"/.test(match)) {
      if (/:$/.test(match)) cls = 'jt-key';
      else cls = 'jt-str';
    } else if (/true|false/.test(match)) cls = 'jt-bool';
    else if (/null/.test(match)) cls = 'jt-null';
    return '<span class="' + cls + '">' + match + '</span>';
  });
}

function renderQueryList(list) {
  const container = document.getElementById('lqe-query-list');
  if (!container) return;
  container.innerHTML = '';
  
  if (list.length === 0) {
    container.innerHTML = '<div style="padding:var(--sp-5); text-align:center; color:var(--text-muted); font-size:0.85rem;">No queries found matching criteria.</div>';
    return;
  }
  
  list.forEach((q, idx) => {
    const el = document.createElement('div');
    el.className = 'lqe-list-item';
    el.style.display = 'grid';
    el.style.gridTemplateColumns = '80px 100px 120px 70px 60px 1fr 60px';
    el.style.padding = 'var(--sp-2) var(--sp-3)';
    el.style.borderBottom = '1px solid var(--border)';
    el.style.fontSize = '0.8rem';
    el.style.cursor = 'pointer';
    el.style.color = 'var(--text)';
    
    let summary = q.sql.substring(0, 100);
    if (q.sql.length > 100) summary += '...';
    
    let typeColor = 'var(--text)';
    if (q.type === 'SELECT') typeColor = '#3498db';
    if (q.type === 'UPDATE') typeColor = '#f39c12';
    if (q.type === 'INSERT') typeColor = '#2ecc71';
    if (q.type === 'DELETE') typeColor = '#e74c3c';

    const dupBadge = q.dupCount > 1
      ? `<span title="This statement was executed ${q.dupCount}× with different parameters — possible N+1 pattern" style="margin-left:4px;font-size:0.7rem;font-weight:700;color:${q.dupCount >= 10 ? 'var(--danger)' : 'var(--warning)'};background:${q.dupCount >= 10 ? 'var(--danger-subtle)' : 'var(--warning-subtle)'};padding:0 4px;border-radius:var(--r-sm)">×${q.dupCount}</span>`
      : '';

    el.innerHTML = `
      <div style="font-weight:600; color:${typeColor}">${q.type}${dupBadge}</div>
      <div style="color:var(--text-muted); font-family:var(--font-mono); font-size:0.75rem">${q.txConn}</div>
      <div style="color:var(--text-muted)">${q.timestamp}</div>
      <div style="color:var(--accent); font-weight:600;">${q.duration || '-'}</div>
      <div style="color:var(--text-muted)">${q.cost || '-'}</div>
      <div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${q.sql.replace(/"/g, '&quot;')}">${summary}</div>
      <div style="text-align:right">${q.rows}</div>
    `;
    
    el.onmouseenter = () => { if (el !== window._lqeActiveEl) el.style.background = 'var(--bg-hover)'; };
    el.onmouseleave = () => { if (el !== window._lqeActiveEl) el.style.background = 'transparent'; };
    
    el.onclick = () => {
      document.querySelectorAll('.lqe-list-item').forEach(i => i.style.background = 'transparent');
      el.style.background = 'var(--bg-active)';
      window._lqeActiveEl = el;
      selectQuery(q);
    };
    
    container.appendChild(el);
  });
}

function selectQuery(q) {
  let runnableSql = q.sql;
  if (q.params && q.params.length > 0) {
    let paramIndex = 0;
    runnableSql = runnableSql.replace(/\?/g, function() {
      if (paramIndex < q.params.length) {
        let val = q.params[paramIndex++];
        if (val === 'true' || val === 'false' || val === 'null' || (!isNaN(Number(val)) && val.trim() !== '')) {
           return val;
        } else {
           return "'" + val.replace(/'/g, "''") + "'";
        }
      }
      return '?';
    });
  }
  
  runnableSql = runnableSql.replace(/ FROM /gi, '\nFROM ')
                           .replace(/ WHERE /gi, '\nWHERE ')
                           .replace(/ INNER JOIN /gi, '\nINNER JOIN ')
                           .replace(/ LEFT JOIN /gi, '\nLEFT JOIN ')
                           .replace(/ ORDER BY /gi, '\nORDER BY ')
                           .replace(/ GROUP BY /gi, '\nGROUP BY ')
                           .replace(/ LIMIT /gi, '\nLIMIT ')
                           .replace(/ SET /gi, '\nSET ')
                           .replace(/ VALUES /gi, '\nVALUES ');
                           
  const sqlEl = document.getElementById('lqe-sql-content');
  if (window.sqlHighlight) {
    sqlEl.innerHTML = window.sqlHighlight(runnableSql);
  } else {
    sqlEl.textContent = runnableSql;
  }
  window._currentRunnableSql = runnableSql;
  
  const sourceEl = document.getElementById('lqe-source-content');
  if (q.xpathContent) {
    if (window.sqlHighlight) {
      sourceEl.innerHTML = window.sqlHighlight(q.xpathContent);
    } else {
      sourceEl.textContent = q.xpathContent;
    }
  } else {
    sourceEl.textContent = 'No source available (XPath/OQL) for this query.';
  }
  
  const tbody = document.getElementById('lqe-params-body');
  tbody.innerHTML = '';
  if (q.params && q.params.length > 0) {
    q.params.forEach((p, i) => {
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid var(--border)';
      tr.innerHTML = `
        <td style="padding:var(--sp-2); border-right:1px solid var(--border);">${i+1}</td>
        <td style="padding:var(--sp-2); font-family:var(--font-mono); color:var(--accent);">${p}</td>
      `;
      tbody.appendChild(tr);
    });
  } else {
    tbody.innerHTML = '<tr><td colspan="2" style="padding:var(--sp-3); color:var(--text-muted); text-align:center;">No parameters</td></tr>';
  }
  
  if (q.resultData) {
    document.getElementById('lqe-result-content').textContent = q.resultData.trim();
  } else {
    document.getElementById('lqe-result-content').textContent = 'No result output logged. (Might be a DML query or trace level too low)';
  }
  
  if (q.queryPlan) {
    // Try to pretty-print the JSON plan
    try {
      const planObj = JSON.parse(q.queryPlan);
      let prefix = '';
      if (q.duration) prefix += 'Execution Time: ' + q.duration + '\n';
      if (q.planningTime) prefix += 'Planning Time: ' + q.planningTime + '\n';
      if (q.duration || q.planningTime) prefix += '\n';
      
      const planEl = document.getElementById('lqe-plan-content');
      planEl.innerHTML = (window.escHtml ? window.escHtml(prefix) : prefix) + highlightJsonSimple(planObj);
    } catch(e) {
      document.getElementById('lqe-plan-content').textContent = q.queryPlan.trim();
    }
  } else {
    document.getElementById('lqe-plan-content').textContent = 'No execution plan found for this query.';
  }
  
  window._currentSelectedQuery = q;
}

window.lqeCopySql = function() {
  if (window._currentRunnableSql) {
    navigator.clipboard.writeText(window._currentRunnableSql).then(() => {
       const btn = document.querySelector('#lqe-tab-sql button:first-child');
       const oldHtml = btn.innerHTML;
       btn.innerHTML = 'Copied!';
       setTimeout(() => btn.innerHTML = oldHtml, 2000);
    });
  }
};

window.lqeCopyExplain = function() {
  if (window._currentRunnableSql) {
    const explainSql = 'EXPLAIN (ANALYZE, COSTS, VERBOSE, BUFFERS, FORMAT TEXT)\n' + window._currentRunnableSql;
    navigator.clipboard.writeText(explainSql).then(() => {
       const btn = document.querySelector('#lqe-tab-sql button:last-child');
       const oldHtml = btn.innerHTML;
       btn.innerHTML = 'Copied!';
       setTimeout(() => btn.innerHTML = oldHtml, 2000);
    });
  }
};

// Converts a PostgreSQL JSON plan node into the text EXPLAIN format
// understood by the Query Intelligence Explain visualizer.
function lqePlanNodeToText(node, depth) {
  const indent = '  '.repeat(depth);
  const arrow = depth > 0 ? '->  ' : '';
  let head = node['Node Type'] || 'Node';
  if (node['Relation Name']) head += ' on ' + node['Relation Name'];
  if (node['Index Name']) head += ' using ' + node['Index Name'];
  let metrics = '';
  if (node['Startup Cost'] !== undefined) {
    metrics += 'cost=' + node['Startup Cost'] + '..' + node['Total Cost'] + ' rows=' + (node['Plan Rows'] !== undefined ? node['Plan Rows'] : '?');
  }
  if (node['Actual Total Time'] !== undefined) {
    metrics += (metrics ? ' ' : '') + 'actual time=' + node['Actual Startup Time'] + '..' + node['Actual Total Time'] + ' rows=' + (node['Actual Rows'] !== undefined ? node['Actual Rows'] : '?');
  }
  let text = indent + arrow + head + (metrics ? '  (' + metrics + ')' : '') + '\n';
  if (node.Filter) text += indent + '      Filter: (' + node.Filter + ')\n';
  if (node['Index Cond']) text += indent + '      Index Cond: (' + node['Index Cond'] + ')\n';
  if (node['Sort Key']) text += indent + '      Sort Key: ' + [].concat(node['Sort Key']).join(', ') + '\n';
  (node.Plans || []).forEach(child => { text += lqePlanNodeToText(child, depth + 1); });
  return text;
}

window.lqeVisualizePlan = function() {
  const q = window._currentSelectedQuery;
  if (!q || !q.queryPlan) {
    alert('Select a query that has a logged Query Plan first.');
    return;
  }
  let text = q.queryPlan;
  try {
    const arr = JSON.parse(q.queryPlan);
    if (arr && arr[0] && arr[0].Plan) {
      text = lqePlanNodeToText(arr[0].Plan, 0);
      if (arr[0]['Planning Time'] !== undefined) text += 'Planning Time: ' + arr[0]['Planning Time'] + ' ms\n';
      if (arr[0]['Execution Time'] !== undefined) text += 'Execution Time: ' + arr[0]['Execution Time'] + ' ms\n';
    }
  } catch (e) {
    // Plan was already plain text — pass it through unchanged
  }
  window.navigate('query-intelligence', null);
  const tabBtn = document.querySelector('#panel-query-intelligence .tab[data-help-key="query-intelligence-explain"]');
  if (tabBtn && window.qiSetTab) window.qiSetTab('explain', tabBtn);
  const input = document.getElementById('sql-explain-input');
  if (input) input.value = text;
  if (window.visualizeSqlExplain) window.visualizeSqlExplain();
};

window.lqeCopyContent = function(elementId, btn) {
  let textToCopy = '';
  
  if (elementId === 'lqe-params-table') {
    if (window._currentSelectedQuery && window._currentSelectedQuery.params && window._currentSelectedQuery.params.length > 0) {
      textToCopy = JSON.stringify(window._currentSelectedQuery.params, null, 2);
    } else {
      textToCopy = '[]';
    }
  } else {
    const el = document.getElementById(elementId);
    if (el) {
      textToCopy = el.textContent || el.innerText;
    }
  }

  if (textToCopy) {
    navigator.clipboard.writeText(textToCopy).then(() => {
      const oldHtml = btn.innerHTML;
      btn.innerHTML = 'Copied!';
      setTimeout(() => btn.innerHTML = oldHtml, 2000);
    });
  }
};
