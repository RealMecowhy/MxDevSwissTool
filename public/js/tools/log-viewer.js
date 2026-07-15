// LOG VIEWER
// ============================================================
let logAllEntries = [], logFilteredEntries = [];
// Parser normalizes WARNING -> WARN, so the filter set only needs WARN
let logActiveLevels = new Set(['TRACE','DEBUG','INFO','WARN','ERROR','CRITICAL']);
// ── Log format patterns ────────────────────────────────────
// Pattern 1 (Mendix Cloud):
//   2026-07-01T14:51:09.591808 [runtime-container/v7f5t]  ERROR - Connector: message
// Pattern 2 (Studio Pro local):
//   2024-01-15 09:12:34.567  INFO - Core: message
// Pattern 3 (plain):
//   09:12:34  ERROR  Core  message
// ───────────────────────────────────────────────────────────
const LOG_PAT_CLOUD   = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+\[[^\]]+\]\s+(TRACE|DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL)\s+-\s+([^:\n]+?):\s*(.*)$/i;
const LOG_PAT_STUDIO  = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:\d{2}|Z)?)\s+(TRACE|DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL)\s+-\s+([^:\n]+?):\s*(.*)$/i;
const LOG_PAT_SIMPLE  = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:\d{2}|Z)?)\s+(TRACE|DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL)\s+([^:\n]{1,80}):\s*(.*)$/i;
const LOG_PAT_TIME    = /^\[?(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]?\s+(TRACE|DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL)\s+([^:\n]{1,60}):\s*(.*)$/i;
const LOG_PATTERNS    = [LOG_PAT_CLOUD, LOG_PAT_STUDIO, LOG_PAT_SIMPLE, LOG_PAT_TIME];

// Lines that are continuation/stack-trace lines (not new log entries)
function logIsContinuation(line) {
  return /^\s/.test(line)                // starts with whitespace (tab indent)
    || /^(at |java\.|scala\.|com\.|org\.|sun\.|javax\.|net\.)/i.test(line.trim())  // Java stack frame
    || /^Caused by:/i.test(line.trim())  // nested cause
    || /^\.\.\. \d+ more/.test(line.trim()); // truncated stack
}

// Reads a file as text, transparently gunzipping .gz archives (Mendix Cloud log downloads)
async function logReadFileText(f) {
  if (f.name.toLowerCase().endsWith('.gz')) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser does not support gzip decompression (DecompressionStream)');
    }
    const stream = f.stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }
  return await f.text();
}
function logLoadFiles(files) {
  showLoader('Reading files...');
  (async () => {
    // Sequential to keep file order deterministic before the timestamp merge-sort
    for (const f of Array.from(files)) {
      try {
        showLoader('Parsing ' + f.name + '...');
        const text = await logReadFileText(f);
        logParseContent(text, f.name);
      } catch (err) {
        console.error('Failed to load ' + f.name, err);
        alert('Could not read "' + f.name + '": ' + err.message);
      }
    }
    hideLoader();
  })();
}
function logHandleDrop(e) {
  e.preventDefault();
  document.getElementById('log-container').classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files).filter(f => {
    const fn = f.name.toLowerCase();
    return fn.endsWith('.log') || fn.endsWith('.txt') || fn.endsWith('.csv') || fn.endsWith('.gz') || f.type === 'text/plain' || f.type === 'text/csv' || f.type === '';
  });
  if (files.length) logLoadFiles(files);
}
function logParseContent(text, filename) {
  const entries = [];
  let prev = null, lineNum = 0;

  if (filename && filename.toLowerCase().endsWith('.csv')) {
    const rawLines = text.split(/\r?\n/);
    const csvRows = [];
    let currentLine = '';
    let insideQuotes = false;
    
    for (let i = 0; i < rawLines.length; i++) {
      let line = rawLines[i];
      currentLine += (currentLine ? '\n' : '') + line;
      let quoteCount = 0;
      for (let j = 0; j < line.length; j++) {
        if (line[j] === '"') quoteCount++;
      }
      if (quoteCount % 2 !== 0) insideQuotes = !insideQuotes;
      if (!insideQuotes) {
        csvRows.push(currentLine);
        currentLine = '';
      }
    }
    if (currentLine) csvRows.push(currentLine);

    const parseCSVRow = function(row) {
      const fields = [];
      let i = 0;
      while (i < row.length) {
        if (row[i] === '"') {
          let field = '';
          i++;
          while (i < row.length) {
            if (row[i] === '"' && i + 1 < row.length && row[i + 1] === '"') {
              field += '"';
              i += 2;
            } else if (row[i] === '"') {
              i++;
              break;
            } else {
              field += row[i];
              i++;
            }
          }
          fields.push(field);
          if (i < row.length && row[i] === ',') i++;
        } else {
          let end = row.indexOf(',', i);
          if (end === -1) end = row.length;
          fields.push(row.substring(i, end));
          i = end + 1;
        }
      }
      return fields;
    };

    for (const row of csvRows) {
      lineNum++;
      if (!row.trim()) continue;
      if (row.startsWith('Type,TimeStamp,LogNode,Message') || row.startsWith('"Type","TimeStamp","LogNode","Message"')) continue;
      const fields = parseCSVRow(row);
      if (fields.length < 4) continue;
      let level = fields[0].toUpperCase();
      if (level === 'WARNING') level = 'WARN';
      if (level === 'ERR' || level === 'FATAL') level = 'ERROR';
      let ts = fields[1] ? fields[1].trim() : '';
      let node = fields[2] ? fields[2].trim() : 'Runtime';
      let msg = fields[3] || '';
      if (fields[4]) msg += '\n' + fields[4];
      entries.push({ line: lineNum, ts: ts, level: level, node: node, msg: msg.trim(), raw: row, file: filename, stackLines: 0 });
    }
  } else {
    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
    lineNum++;
    const line = raw.trimEnd();

    // blank line — skip but don't break continuation
    if (!line.trim()) continue;

    // Check if this is a continuation line (stack trace, indented text, etc.)
    if (prev && logIsContinuation(line)) {
      prev.msg += '\n' + line.trim();
      prev.raw += '\n' + line;
      prev.stackLines = (prev.stackLines || 0) + 1;
      continue;
    }

    // Try to match a new log entry
    let matched = false;
    for (const pat of LOG_PATTERNS) {
      const m = line.match(pat);
      if (m) {
        let ts, level, node, msg;
        if (m.length === 5) {
          [, ts, level, node, msg] = m;
        } else {
          [, ts, level, msg] = m;
          node = 'Runtime';
        }
        level = level.toUpperCase();
        if (level === 'WARNING') level = 'WARN';
        node = (node || 'Runtime').trim();
        msg  = (msg  || '').trim();
        prev = { line: lineNum, ts: ts.trim(), level, node, msg, raw: line, file: filename, stackLines: 0 };
        entries.push(prev);
        matched = true;
        break;
      }
    }

    if (!matched) {
      // Fallback: Check if it's a platform log or standard timestamped line that didn't match the strict format
      // Pattern: YYYY-MM-DDTHH:mm:ss... [SOURCE] Message OR YYYY-MM-DD... Message
      const fallbackPat = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:\d{2}|Z)?)\s+(.*)$/;
      const m = line.match(fallbackPat);
      
      if (m) {
        let ts = m[1];
        let rest = m[2];
        let level = 'INFO'; // default
        let node = 'Platform';
        
        // Try to extract [APP/PROC/WEB/0] or [CELL/0] as node
        const sourceMatch = rest.match(/^\[([^\]]+)\]\s+(.*)$/);
        if (sourceMatch) {
            node = sourceMatch[1];
            rest = sourceMatch[2];
        }
        
        // Try to extract pseudo-level like "INFO:" or "WARNING:" or "ERROR:" or "ERR"
        const levelMatch = rest.match(/^(TRACE|DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|ERR|FATAL)[\s:-]+(.*)$/i);
        if (levelMatch) {
            level = levelMatch[1].toUpperCase();
            if (level === 'WARNING') level = 'WARN';
            if (level === 'ERR' || level === 'FATAL') level = 'ERROR';
            rest = levelMatch[2].trim();
        } else if (/error|exception|fail|crashed|unhealthy|oom|out of memory/i.test(rest)) {
            level = 'ERROR';
        }

        prev = { line: lineNum, ts: ts.trim(), level, node, msg: rest, raw: line, file: filename, stackLines: 0 };
        entries.push(prev);
        matched = true;
      }
    }

    // Not matched and not a continuation → treat as continuation of previous or standalone
    if (!matched) {
      if (prev) {
        prev.msg += '\n' + line;
        prev.raw += '\n' + line;
      } else {
        // No previous entry — create a plain INFO entry
        prev = { line: lineNum, ts: '', level: 'INFO', node: 'Raw', msg: line.trim(), raw: line, file: filename, stackLines: 0 };
        entries.push(prev);
      }
    }
  }
  }

  if (entries.length === 0) {
    document.getElementById('log-virtual-list').innerHTML =
      '<div style="padding:var(--sp-8);text-align:center;color:var(--danger)">Could not parse any log entries from this file. ' +
      'Ensure the file is a plain text Mendix log.</div>';
    document.getElementById('log-virtual-list').style.display = 'block';
    document.getElementById('log-empty-state').style.display  = 'none';
    return;
  }

  logAllEntries = [...logAllEntries, ...entries];

  // When logs come from multiple files, merge them chronologically so an
  // incident spanning several files reads as one timeline. Entries without a
  // parseable full timestamp keep their relative order (stable sort).
  const distinctFiles = new Set(logAllEntries.map(e => e.file));
  if (distinctFiles.size > 1) {
    logAllEntries.forEach(e => {
      if (e._t === undefined) {
        const t = Date.parse(e.ts);
        e._t = isNaN(t) ? null : t;
      }
    });
    logAllEntries.sort((a, b) => (a._t !== null && b._t !== null) ? a._t - b._t : 0);
  }

  logBuildDateFilter();
  logApplyFilters();
  document.getElementById('log-stats').style.display = 'flex';
  document.getElementById('log-analyze-btn').style.display = 'inline-flex';
  document.getElementById('log-anon-copy-btn').style.display = 'inline-flex';
  document.getElementById('log-send-anon-btn').style.display = 'inline-flex';
  document.getElementById('log-empty-state').style.display = 'none';
  document.getElementById('log-virtual-list').style.display = 'block';
}
function logBuildDateFilter() {
  const dates = [...new Set(logAllEntries.map(e => { const m = e.ts.match(/(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; }).filter(Boolean))];
  const sel = document.getElementById('log-date-filter'), cur = sel.value;
  sel.innerHTML = '<option value="">All dates</option>';
  dates.forEach(d => { const o = document.createElement('option'); o.value = d; o.textContent = d; if (d === cur) o.selected = true; sel.appendChild(o); });
}
function logToggleLevel(level, btn) {
  if (logActiveLevels.has(level)) { logActiveLevels.delete(level); btn.classList.remove('active'); }
  else { logActiveLevels.add(level); btn.classList.add('active'); }
  logApplyFilters();
}
function logToggleAllLevels(val) {
  ['TRACE','DEBUG','INFO','WARN','ERROR','CRITICAL'].forEach(l => {
    const btn = document.querySelector('.level-filter-btn[onclick*="\''+l+'\'"]');
    if (val) { logActiveLevels.add(l); if(btn) btn.classList.add('active'); }
    else { logActiveLevels.delete(l); if(btn) btn.classList.remove('active'); }
  });
  logApplyFilters();
}
function logApplyFilters() {
  const search = document.getElementById('log-search').value.toLowerCase();
  const from = document.getElementById('log-time-from').value.trim();
  const to = document.getElementById('log-time-to').value.trim();
  const node = document.getElementById('log-node-filter').value.toLowerCase();
  const date = document.getElementById('log-date-filter').value;
  logFilteredEntries = logAllEntries.filter(e => {
    if (logActiveSignatureKey) {
      const entrySig = logGetSignature(e);
      if (entrySig.key !== logActiveSignatureKey) return false;
    }
    if (!logActiveLevels.has(e.level)) return false;
    if (search && !e.raw.toLowerCase().includes(search)) return false;
    if (node && !e.node.toLowerCase().includes(node)) return false;
    if (date && !e.ts.includes(date)) return false;
    if (from || to) { const m = e.ts.match(/(\d{2}:\d{2}:\d{2})/); if (m) { const t = m[1]; if (from && t < from) return false; if (to && t > to) return false; } }
    return true;
  });
  logRender(); logUpdateStats();
}
let logScrollState = {
  batchSize: 1000,
  currentLoaded: 0,
  observer: null
};

function logInitInfiniteScroll() {
  const container = document.getElementById('log-container');
  const list = document.getElementById('log-virtual-list');
  
  if (list) {
    list.style.position = '';
    list.style.top = '';
    list.style.left = '';
    list.style.right = '';
    list.style.transform = '';
  }
  if (container) {
    container.style.position = '';
    container.removeEventListener('scroll', logOnScroll);
  }
  
  const spacer = document.getElementById('log-vs-spacer');
  if (spacer) spacer.remove();
  
  let sentinel = document.getElementById('log-scroll-sentinel');
  if (!sentinel && container) {
    sentinel = document.createElement('div');
    sentinel.id = 'log-scroll-sentinel';
    sentinel.style.minHeight = '10px';
    sentinel.style.width = '100%';
    container.appendChild(sentinel);
  }
  
  if (!logScrollState.observer && container) {
    logScrollState.observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        logLoadMore();
      }
    }, { root: container, rootMargin: '200px' });
  }
  
  if (sentinel && logScrollState.observer) {
    logScrollState.observer.observe(sentinel);
  }
}

function logOnScroll() {}

function logRender() {
  logInitInfiniteScroll();
  
  const list = document.getElementById('log-virtual-list');
  if (list) {
    list.innerHTML = '';
    list.style.display = 'block';
  }
  
  logScrollState.currentLoaded = 0;
  
  const container = document.getElementById('log-container');
  if (container) container.scrollTop = 0;
  
  logLoadMore();
}

function logLoadMore() {
  if (logScrollState.currentLoaded >= logFilteredEntries.length) return;
  
  const list = document.getElementById('log-virtual-list');
  const search = document.getElementById('log-search') ? document.getElementById('log-search').value : '';
  
  const start = logScrollState.currentLoaded;
  const end = Math.min(logFilteredEntries.length, start + logScrollState.batchSize);
  
  const rows = logFilteredEntries.slice(start, end);
  logScrollState.currentLoaded = end;
  
  const html = rows.map(e => {
    const cls = 'row-' + e.level.toLowerCase();
    const msgParts = e.msg.split('\n');
    const mainLine = msgParts[0];
    const stackLines = msgParts.slice(1);

    let mainHtml = escHtml(mainLine);
    if (search && search.length > 1) {
      const re = new RegExp(escRegex(search), 'gi');
      mainHtml = mainHtml.replace(re, m => '<mark class="log-highlight">'+m+'</mark>');
    }

    let stackHtml = '';
    if (stackLines.length > 0) {
      const id = 'st' + (e.file||'').replace(/[^a-z0-9]/gi,'').slice(-10) + e.line;
      const preview = stackLines.length + ' frame' + (stackLines.length > 1 ? 's' : '');
      stackHtml = '<div style="width:100%; margin-top:4px; padding-left:42px; box-sizing:border-box">'
        + '<span class="log-stack-toggle" onclick="logToggleStack(\''+id+'\')" style="cursor:pointer; font-size:.72rem; color:var(--text-primary); background:var(--bg-elevated); border:1px solid var(--border); padding:3px 8px; border-radius:var(--r-md); font-weight:600; user-select:none; display:inline-block; transition:all 0.2s" onmouseover="this.style.borderColor=\'var(--accent)\'; this.style.color=\'var(--accent)\'" onmouseout="this.style.borderColor=\'var(--border)\'; this.style.color=\'var(--text-primary)\'">&#9654; Show ' + preview + '</span>'
        + '<div id="'+id+'" class="log-stack-body" style="display:none;margin-top:6px;padding:6px 10px;background:var(--bg-overlay);border-radius:4px;border:1px solid var(--border-subtle);font-size:.72rem;color:var(--text-muted);white-space:pre;overflow-x:auto;max-height:350px;overflow-y:auto">'
        + stackLines.map(l => escHtml(l)).join('\n')
        + '</div></div>';
    }

    return '<div class="log-row '+cls+'" style="flex-wrap:wrap">'
      + '<span class="log-row-num">'+e.line+'</span>'
      + '<span class="log-row-ts">'+escHtml(e.ts)+'</span>'
      + '<span class="log-row-level">'+logBadge(e.level)+'</span>'
      + '<span class="log-row-node" title="'+escHtml(e.node)+'">'+escHtml(e.node)+'</span>'
      + '<span class="log-row-msg">'+mainHtml+'</span>'
      + stackHtml
      + '</div>';
  }).join('');
  
  if (list) {
    list.insertAdjacentHTML('beforeend', html);
  }
  
  const sentinel = document.getElementById('log-scroll-sentinel');
  if (sentinel) {
    if (logScrollState.currentLoaded >= logFilteredEntries.length) {
      sentinel.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:0.75rem">Showing all ' + logFilteredEntries.length + ' results</div>';
    } else {
      sentinel.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:0.75rem">Showing ' + logScrollState.currentLoaded + ' of ' + logFilteredEntries.length + ' results. Scroll down to load more.</div>';
    }
  }
}

function logToggleStack(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const visible = el.style.display !== 'none';
  el.style.display = visible ? 'none' : 'block';
  const toggle = el.previousElementSibling;
  if (toggle) toggle.innerHTML = (visible ? '&#9654;' : '&#9660;') + toggle.innerHTML.slice(1);
}
function logBadge(l) {
  const m = {TRACE:'badge-trace',DEBUG:'badge-debug',INFO:'badge-info',WARN:'badge-warning',WARNING:'badge-warning',ERROR:'badge-error',CRITICAL:'badge-critical'};
  return '<span class="badge '+(m[l]||'badge-neutral')+'">'+l+'</span>';
}
function logUpdateStats() {
  let e = 0, w = 0, i = 0;
  for (let idx = 0; idx < logFilteredEntries.length; idx++) {
    const lvl = logFilteredEntries[idx].level;
    if (lvl === 'ERROR' || lvl === 'CRITICAL') e++;
    else if (lvl === 'WARN') w++;
    else if (lvl === 'INFO') i++;
  }
  document.getElementById('ls-total').textContent = logAllEntries.length;
  document.getElementById('ls-shown').textContent = logFilteredEntries.length;
  document.getElementById('ls-errors').textContent = e;
  document.getElementById('ls-warnings').textContent = w;
  document.getElementById('ls-info').textContent = i;
}
function logScrollTo(pos) { const c = document.getElementById('log-container'); c.scrollTop = pos==='top'?0:c.scrollHeight; }
function logClear() {
  logAllEntries=[]; logFilteredEntries=[];
  document.getElementById('log-virtual-list').innerHTML=''; document.getElementById('log-virtual-list').style.display='none';
  
  const spacer = document.getElementById('log-vs-spacer');
  if (spacer) spacer.remove();
  
  const sentinel = document.getElementById('log-scroll-sentinel');
  if (sentinel) sentinel.innerHTML = '';

  document.getElementById('log-empty-state').style.display='flex'; document.getElementById('log-stats').style.display='none';
  document.getElementById('log-file-input').value=''; document.getElementById('log-date-filter').innerHTML='<option value="">All dates</option>';
  document.getElementById('log-analyze-btn').style.display='none';
  document.getElementById('log-anon-copy-btn').style.display='none';
  document.getElementById('log-send-anon-btn').style.display='none';
  logClearSignatureFilter();
  
  // Clear filters
  document.getElementById('log-search').value = '';
  document.getElementById('log-time-from').value = '';
  document.getElementById('log-time-to').value = '';
  document.getElementById('log-node-filter').value = '';
  logToggleAllLevels(true);
  
  // Clear tabs data
  document.getElementById('log-correlation-id').value = '';
  document.getElementById('log-correlation-output').innerHTML = '<span style="color:var(--text-muted)">Enter a correlation ID to see the flow...</span>';
  document.getElementById('log-sequence-output').innerHTML = '<span style="color:var(--text-muted);margin-top:var(--sp-5)">Sequence diagram will appear here...</span>';
  document.getElementById('log-gantt-output').innerHTML = '<span style="color:var(--text-muted)">Gantt chart will appear here...</span>';
}
function logExportFiltered() {
  if (!logFilteredEntries.length) return;
  downloadText(logFilteredEntries.map(e=>e.raw).join('\n'), 'filtered-logs.txt');
}

// ============================================================
// ERROR & EXCEPTION SIGNATURE AGGREGATOR
// ============================================================
let logSignatures = [];
let logActiveSignatureKey = null;

function logOpenAggregator() {
  const modal = document.getElementById('log-aggregator-modal');
  if (modal) {
    modal.classList.add('active');
    logAnalyzeSignatures();
  }
}

function logCloseAggregator() {
  const modal = document.getElementById('log-aggregator-modal');
  if (modal) {
    modal.classList.remove('active');
  }
}

function logAnalyzeSignatures() {
  showLoader('Analyzing error signatures...');
  setTimeout(() => {
    try {
      const sigMap = new Map();
      let exceptionCount = 0;
      let plainMessageCount = 0;

      for (let i = 0; i < logAllEntries.length; i++) {
        const entry = logAllEntries[i];
        
        const isErrorOrWarn = ['ERROR', 'CRITICAL', 'WARN', 'WARNING'].includes(entry.level);
        const hasStackTrace = entry.stackLines > 0;
        if (!isErrorOrWarn && !hasStackTrace) continue;

        const sigInfo = logGetSignature(entry);
        if (sigInfo.type === 'exception') {
          exceptionCount++;
        } else {
          plainMessageCount++;
        }

        if (!sigMap.has(sigInfo.key)) {
          sigMap.set(sigInfo.key, {
            key: sigInfo.key,
            type: sigInfo.type,
            header: sigInfo.header,
            stack: sigInfo.stack,
            count: 0,
            level: entry.level,
            samples: [],
            entries: []
          });
        }

        const group = sigMap.get(sigInfo.key);
        group.count++;
        group.entries.push(entry);
        
        if (group.samples.length < 5) {
          group.samples.push({
            ts: entry.ts,
            line: entry.line,
            raw: entry.raw.split('\n')[0]
          });
        }
      }

      logSignatures = Array.from(sigMap.values());
      logRenderSignatures();
      
      document.getElementById('sig-summary-stats').innerHTML = 
        `Analyzed <strong>${logAllEntries.length}</strong> log entries. Found <strong>${logSignatures.length}</strong> unique error signatures (Exceptions: ${exceptionCount}, Warnings/Messages: ${plainMessageCount}).`;

    } catch (e) {
      console.error(e);
      alert('Error during log signature analysis: ' + e.message);
    } finally {
      hideLoader();
    }
  }, 50);
}

function logGetSignature(entry) {
  const msg = entry.msg || '';
  const lines = msg.split('\n');
  let header = lines[0] || '';
  
  header = normalizeString(header);
  
  const stack = [];
  for (let i = 1; i < lines.length; i++) {
    let line = lines[i].trim();
    if (line.startsWith('at ') || line.includes('.java:') || line.includes('.scala:')) {
      line = line.replace(/\.java:\d+/g, '.java:[LINE]')
                 .replace(/\.scala:\d+/g, '.scala:[LINE]')
                 .replace(/:c?\d+\b/g, ':[LINE]')
                 .replace(/\b\d+\b/g, '[NUM]');
      stack.push(line);
    }
    if (stack.length >= 4) break;
  }
  
  if (stack.length > 0) {
    return {
      type: 'exception',
      key: header + '\n' + stack.join('\n'),
      header: header,
      stack: stack
    };
  } else {
    return {
      type: 'message',
      key: header,
      header: header,
      stack: []
    };
  }
}

function normalizeString(str) {
  if (!str) return '';
  return str
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '[UUID]')
    .replace(/\b0x[0-9a-fA-F]+\b/g, '[HEX]')
    .replace(/\b\d{15,19}\b/g, '[MENDIX_ID]')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/g, '[DATETIME]')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '[TIME]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[EMAIL]')
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP]')
    .replace(/\b\d+\b/g, '[NUM]');
}

function logRenderSignatures() {
  const container = document.getElementById('sig-list-container');
  if (!container) return;

  const search = document.getElementById('sig-search').value.toLowerCase().trim();
  const sortVal = document.getElementById('sig-sort').value;
  const typeFilter = document.getElementById('sig-type-filter').value;

  let list = logSignatures.filter(s => {
    if (typeFilter === 'exceptions' && s.type !== 'exception') return false;
    if (typeFilter === 'messages' && s.type !== 'message') return false;

    if (search) {
      const matchHeader = s.header.toLowerCase().includes(search);
      const matchStack = s.stack.some(f => f.toLowerCase().includes(search));
      return matchHeader || matchStack;
    }
    return true;
  });

  list.sort((a, b) => {
    if (sortVal === 'count-desc') {
      return b.count - a.count;
    } else if (sortVal === 'count-asc') {
      return a.count - b.count;
    } else if (sortVal === 'name-asc') {
      return a.header.localeCompare(b.header);
    }
    return 0;
  });

  if (list.length === 0) {
    container.innerHTML = `<div style="padding:var(--sp-8); text-align:center; color:var(--text-secondary)">No signatures found matching the criteria.</div>`;
    return;
  }

  container.innerHTML = list.map((s, idx) => {
    const originalIdx = logSignatures.indexOf(s);
    const id = `sig-${originalIdx}`;
    const badgeClass = s.type === 'exception' ? 'badge-error' : 'badge-warning';
    const firstFrame = s.stack.length > 0 ? s.stack[0] : 'No stack trace';
    const stackTraceHtml = s.stack.length > 0 
      ? s.header + '\n' + s.stack.map(f => '    ' + f).join('\n')
      : s.header;

    const samplesHtml = s.samples.map(sample => {
      return `<li><span style="font-family:var(--font-mono); color:var(--accent)">Line ${sample.line} [${sample.ts}]</span>: <code>${escHtml(sample.raw)}</code></li>`;
    }).join('');

    return `
      <div class="sig-card" style="background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--r-md); padding:var(--sp-3); margin-bottom:var(--sp-2)">
        <div style="display:flex; align-items:center; gap:var(--sp-3); cursor:pointer" onclick="logToggleSigDetail('${id}')">
          <span class="badge ${badgeClass}" style="font-size:0.85rem; padding:4px 8px; min-width:60px; justify-content:center">${s.count}x</span>
          <div style="flex:1; overflow:hidden">
            <div style="font-family:var(--font-mono); font-size:0.85rem; font-weight:600; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; color:var(--text-primary)" title="${escHtml(s.header)}">${escHtml(s.header)}</div>
            <div style="font-size:0.75rem; color:var(--text-secondary); text-overflow:ellipsis; overflow:hidden; white-space:nowrap">${escHtml(firstFrame)}</div>
          </div>
          <button class="btn btn-secondary btn-sm" style="flex-shrink:0" onclick="event.stopPropagation(); logFilterToSignature(${originalIdx})">Filter Logs</button>
        </div>
        <div id="sig-detail-${id}" style="display:none; margin-top:var(--sp-3); border-top:1px solid var(--border); padding-top:var(--sp-3)">
          <div class="form-label" style="margin-bottom:var(--sp-1)">Exception/Message Signature Pattern:</div>
          <pre style="background:var(--bg-overlay); padding:var(--sp-3); border-radius:var(--r-md); font-family:var(--font-mono); font-size:0.78rem; white-space:pre-wrap; word-break:break-all; color:var(--text-primary); max-height:200px; overflow-y:auto">${escHtml(stackTraceHtml)}</pre>
          
          <div class="form-label" style="margin-top:var(--sp-3); margin-bottom:var(--sp-1)">Sample Occurrences (Top 5):</div>
          <ul style="padding-left:var(--sp-4); font-size:0.78rem; color:var(--text-secondary); display:flex; flex-direction:column; gap:4px">
            ${samplesHtml}
          </ul>
        </div>
      </div>
    `;
  }).join('');
}

function logToggleSigDetail(id) {
  const el = document.getElementById(`sig-detail-${id}`);
  if (el) {
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  }
}

function logExpandAllSignatures(expand) {
  const list = document.getElementById('sig-list-container');
  if (!list) return;
  const details = list.querySelectorAll('[id^="sig-detail-"]');
  details.forEach(el => {
    el.style.display = expand ? 'block' : 'none';
  });
}

function logFilterToSignature(index) {
  const group = logSignatures[index];
  if (!group) return;
  
  logActiveSignatureKey = group.key;
  document.getElementById('log-sig-filter-name').textContent = group.header;
  document.getElementById('log-sig-filter-banner').style.display = 'flex';
  
  logCloseAggregator();
  logApplyFilters();
}

function logClearSignatureFilter() {
  logActiveSignatureKey = null;
  document.getElementById('log-sig-filter-banner').style.display = 'none';
  logApplyFilters();
}
// ============================================================
// ADVANCED LOG INTELLIGENCE (Correlation, Sequence, Gantt)
// ============================================================

function logSetTab(tabId, el) {
  document.querySelectorAll('#panel-log-viewer .tabs .tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
  if (el) { el.classList.add('active'); el.setAttribute('aria-selected', 'true'); }
  
  const tabs = ['stream', 'correlation', 'sequence', 'gantt'];
  tabs.forEach(t => {
    document.getElementById('log-tab-' + t).style.display = (t === tabId) ? 'flex' : 'none';
  });
}

function logGenerateCorrelation() {
  const cid = document.getElementById('log-correlation-id').value.trim();
  const out = document.getElementById('log-correlation-output');
  if (!cid) {
    out.innerHTML = '<span style="color:var(--warning)">Please enter a Correlation ID.</span>';
    return;
  }
  
  const matched = logAllEntries.filter(e => e.raw.includes(cid));
  if (matched.length === 0) {
    out.innerHTML = '<span style="color:var(--text-muted)">No logs found for this Correlation ID.</span>';
    return;
  }
  
  let html = `<div style="margin-bottom:var(--sp-4)">Found <strong>${matched.length}</strong> log entries for ID: <code>${escHtml(cid)}</code></div>`;
  
  html += '<div style="display:flex;flex-direction:column;gap:var(--sp-2)">';
  matched.forEach((e, i) => {
    html += `<div style="padding:var(--sp-2);border-left:2px solid var(--accent);background:var(--bg-base);border-radius:0 var(--r-sm) var(--r-sm) 0;">
      <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:4px">${escHtml(e.ts)} &mdash; Node: <strong>${escHtml(e.node)}</strong> &mdash; Level: ${logBadge(e.level)}</div>
      <div style="white-space:pre-wrap">${escHtml(e.msg)}</div>
    </div>`;
  });
  html += '</div>';
  out.innerHTML = html;
}

function logGenerateSequence() {
  const out = document.getElementById('log-sequence-output');
  if (logFilteredEntries.length === 0) {
    out.innerHTML = '<span style="color:var(--warning)">No logs in current filter.</span>';
    return;
  }
  
  const maxEntries = 100;
  const entries = logFilteredEntries.slice(0, maxEntries);
  
  let html = `<div style="display:flex;flex-direction:column;gap:var(--sp-1);width:100%;max-width:800px;position:relative">`;
  html += `<div style="text-align:center;margin-bottom:var(--sp-4);color:var(--text-muted);font-size:0.8rem">Showing sequence flow for first ${entries.length} visible logs</div>`;
  
  const nodes = [...new Set(entries.map(e => e.node))];
  
  html += `<div style="display:flex;margin-bottom:var(--sp-4);border-bottom:2px solid var(--border)">`;
  nodes.forEach(n => {
    html += `<div style="flex:1;text-align:center;font-weight:600;padding:var(--sp-2);position:relative">
      ${escHtml(n)}
      <div style="position:absolute;left:50%;top:100%;bottom:-1000px;width:1px;background:var(--border);transform:translateX(-50%);z-index:0"></div>
    </div>`;
  });
  html += `</div>`;
  
  entries.forEach((e, i) => {
    const nodeIdx = nodes.indexOf(e.node);
    const leftPerc = (nodeIdx / nodes.length) * 100 + (100 / nodes.length / 2);
    
    html += `<div style="display:flex;align-items:center;position:relative;z-index:1;margin-bottom:var(--sp-3)">
      <div style="width:100px;font-size:0.75rem;color:var(--text-muted);text-align:right;padding-right:var(--sp-2)">${escHtml(e.ts.split(' ')[1] || e.ts)}</div>
      <div style="flex:1;position:relative;height:24px;">
        <div style="position:absolute;left:${leftPerc}%;transform:translate(-50%, -50%);top:50%;width:12px;height:12px;border-radius:50%;background:var(--accent);border:2px solid var(--bg-elevated)"></div>
        <div style="position:absolute;left:calc(${leftPerc}% + 15px);top:50%;transform:translateY(-50%);font-size:0.75rem;background:var(--bg-base);padding:2px 6px;border-radius:var(--r-sm);border:1px solid var(--border);white-space:nowrap;max-width:300px;overflow:hidden;text-overflow:ellipsis" title="${escHtml(e.msg.split('\n')[0])}">${escHtml(e.msg.split('\n')[0])}</div>
      </div>
    </div>`;
  });
  
  html += '</div>';
  out.innerHTML = html;
}

function logGenerateGantt() {
  const out = document.getElementById('log-gantt-output');
  if (logFilteredEntries.length < 2) {
    out.innerHTML = '<span style="color:var(--warning)">Not enough logs to generate timeline (need at least 2).</span>';
    return;
  }
  
  const maxEntries = 500;
  const entries = logFilteredEntries.slice(0, maxEntries);
  
  // Parse times
  let parsed = entries.map(e => {
    // try to extract just time HH:MM:SS.mmm
    const m = e.ts.match(/(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
    if (!m) return null;
    const date = new Date(1970, 0, 1, parseInt(m[1]), parseInt(m[2]), parseInt(m[3]), m[4] ? parseInt(m[4].padEnd(3,'0').slice(0,3)) : 0);
    return { ...e, ms: date.getTime() };
  }).filter(e => e !== null);
  
  if (parsed.length < 2) {
    out.innerHTML = '<span style="color:var(--warning)">Could not parse time from logs.</span>';
    return;
  }
  
  const t0 = parsed[0].ms;
  const tEnd = parsed[parsed.length - 1].ms;
  const totalDuration = tEnd - t0;
  
  if (totalDuration <= 0) {
    out.innerHTML = '<span style="color:var(--warning)">Total duration is zero (logs have same timestamp).</span>';
    return;
  }
  
  let html = `<div style="margin-bottom:var(--sp-4);color:var(--text-muted);font-size:0.8rem">Timeline for ${parsed.length} entries. Total Duration: ${totalDuration}ms</div>`;
  
  html += '<div style="display:flex;flex-direction:column;gap:2px">';
  parsed.forEach((e, i) => {
    const elapsed = e.ms - t0;
    const perc = (elapsed / totalDuration) * 100;
    
    // Bar width based on time to next entry
    let duration = 0;
    if (i < parsed.length - 1) {
       duration = parsed[i+1].ms - e.ms;
    }
    const widthPerc = Math.max((duration / totalDuration) * 100, 0.5); // min 0.5%
    
    html += `<div style="display:flex;align-items:center;font-size:0.75rem;font-family:var(--font-mono)">
      <div style="width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(e.node)}: ${escHtml(e.msg.split('\n')[0])}">${escHtml(e.node)}</div>
      <div style="flex:1;position:relative;height:16px;background:var(--bg-base);margin:0 var(--sp-2)">
         <div style="position:absolute;left:${perc}%;width:${widthPerc}%;height:100%;background:var(--accent);min-width:2px;border-radius:2px" title="Time: ${escHtml(e.ts)}\nDuration: ${duration}ms\nMsg: ${escHtml(e.msg.split('\n')[0])}"></div>
      </div>
      <div style="width:60px;text-align:right">${duration}ms</div>
    </div>`;
  });
  html += '</div>';
  
  out.innerHTML = html;
}

function logAnonymizeAndCopy() {
  if (!logFilteredEntries.length) {
    alert('No logs to anonymize.');
    return;
  }
  const rawText = logFilteredEntries.map(e => e.raw).join('\n');
  let anonymized = rawText;
  
  // 1. UUIDs
  anonymized = anonymized.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '[UUID]');
  
  // 2. IPs
  anonymized = anonymized.replace(/\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g, '[IP]');
  anonymized = anonymized.replace(/\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g, '[IP]');
  
  // 3. Emails
  anonymized = anonymized.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]');
  
  // 4. Mendix IDs
  anonymized = anonymized.replace(/\b\d{15,19}\b/g, '[MENDIX_ID]');
  
  copyToClipboard(anonymized);
  alert(`Anonymized and copied ${logFilteredEntries.length} filtered log entries to clipboard!`);
}

function logSendToAnonymizer() {
  if (!logFilteredEntries.length) {
    alert('No logs to send.');
    return;
  }
  showLoader('Preparing logs for anonymization...');
  // Defer the heavy join to let the browser paint the loader first
  setTimeout(() => {
    const rawText = logFilteredEntries.map(e => e.raw).join('\n');
    window.pendingAnonymizerText = rawText;
    window.navigateWithReturn('log-anonymizer');
    // Don't hideLoader — anonymizeProcess will take over and manage the loader
  }, 50);
}

function logOpenPasteModal() {
  const modal = document.getElementById('log-paste-modal');
  if (modal) {
    document.getElementById('log-paste-input').value = '';
    modal.classList.add('active');
  }
}

function logClosePasteModal() {
  const modal = document.getElementById('log-paste-modal');
  if (modal) {
    modal.classList.remove('active');
  }
}

function logSubmitPaste() {
  const text = document.getElementById('log-paste-input').value;
  if (!text || !text.trim()) {
    alert('Please paste some logs first.');
    return;
  }
  logClosePasteModal();
  logParseContent(text, 'clipboard-paste.txt');
}


// --- AUTO-GENERATED ESM EXPORTS ---
window.logIsContinuation = logIsContinuation;
window.logLoadFiles = logLoadFiles;
window.logHandleDrop = logHandleDrop;
window.logParseContent = logParseContent;
window.logBuildDateFilter = logBuildDateFilter;
window.logToggleLevel = logToggleLevel;
window.logToggleAllLevels = logToggleAllLevels;
window.logApplyFilters = logApplyFilters;
window.logRender = logRender;
window.logToggleStack = logToggleStack;
window.logBadge = logBadge;
window.logUpdateStats = logUpdateStats;
window.logScrollTo = logScrollTo;
window.logClear = logClear;
window.logExportFiltered = logExportFiltered;
window.logOpenAggregator = logOpenAggregator;
window.logCloseAggregator = logCloseAggregator;
window.logAnalyzeSignatures = logAnalyzeSignatures;
window.logGetSignature = logGetSignature;
window.normalizeString = normalizeString;
window.logRenderSignatures = logRenderSignatures;
window.logToggleSigDetail = logToggleSigDetail;
window.logExpandAllSignatures = logExpandAllSignatures;
window.logFilterToSignature = logFilterToSignature;
window.logClearSignatureFilter = logClearSignatureFilter;
window.logSetTab = logSetTab;
window.logGenerateCorrelation = logGenerateCorrelation;
window.logGenerateSequence = logGenerateSequence;
window.logGenerateGantt = logGenerateGantt;
window.logAnonymizeAndCopy = logAnonymizeAndCopy;
window.logSendToAnonymizer = logSendToAnonymizer;
window.logOpenPasteModal = logOpenPasteModal;
window.logClosePasteModal = logClosePasteModal;
window.logSubmitPaste = logSubmitPaste;

export function init() {}
