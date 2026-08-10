// LOG VIEWER
// ============================================================
let logAllEntries = [], logFilteredEntries = [];
// True once >1 distinct file is loaded (chronological merge) — gates the
// per-row file-origin badge so single-file logs stay uncluttered.
let logMultiFileActive = false;
// Cache of filename → short badge label, so two files sharing a long common
// prefix still render distinguishable abbreviations without recomputing per row.
let logFileBadgeCache = new Map();
function logFileBadgeLabel(file) {
  const key = file || '';
  if (logFileBadgeCache.has(key)) return logFileBadgeCache.get(key);
  const base = key.replace(/\.[^./\\]+$/, '').split(/[\\/]/).pop() || key;
  const label = base.length > 14 ? base.slice(0, 13) + '…' : base;
  logFileBadgeCache.set(key, label);
  return label;
}
// Parser normalizes WARNING -> WARN, so the filter set only needs WARN
let logActiveLevels = new Set(['TRACE','DEBUG','INFO','WARN','ERROR','CRITICAL']);
// Pinned lines for cross-filter navigation. Keyed by file#line (unique across the
// merged multi-file timeline); the value snapshots what the bookmark list shows so
// the map survives filter changes and re-renders independently of logFilteredEntries.
let logBookmarks = new Map();
function logBookmarkKey(e) { return (e.file || '') + '#' + e.line; }
// Quotes a value for safe embedding in an inline-handler argument (mirrors
// logInsightsAttr — file names could in theory carry quotes/backslashes).
function logJsStr(s) { return "'" + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }
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
    const list = Array.from(files);
    // The Data Hub carries ONE file; with a multi-file drop the last one that
    // actually parsed is shared and the rest are reported as staying here.
    let shareable = null;
    // Sequential to keep file order deterministic before the timestamp merge-sort
    for (const f of list) {
      try {
        showLoader('Parsing ' + f.name + '...');
        const text = await logReadFileText(f);
        const before = logAllEntries.length;
        logParseContent(text, f.name);
        const added = logAllEntries.length - before;
        if (added > 0) {
          shareable = {
            name: f.name,
            // .gz reports its compressed size, which would misdescribe the text
            // the other tools receive, so measure the decompressed string.
            size: f.name.toLowerCase().endsWith('.gz') ? text.length : f.size,
            text: text,
            records: added,
            format: f.name.toLowerCase().endsWith('.csv') ? 'csv' : 'live'
          };
        }
      } catch (err) {
        console.error('Failed to load ' + f.name, err);
        window.mtToast('Could not read "' + f.name + '": ' + err.message, 'error');
      }
    }
    // Sharing the decompressed text is what lets the other log tools consume a
    // .gz download at all — only the Log Viewer knows how to unpack one.
    if (shareable && window.mtHub) {
      window.mtHub.setSource(Object.assign({ origin: 'log-viewer', siblings: list.length - 1 }, shareable));
    }
    hideLoader();
  })();
}
// Cross-link / Data Hub entry point: parse raw log text as if it were a dropped
// file, mirroring lqeLoadText / mftLoadText / wsreLoadText.
function logLoadText(text, filename) {
  logParseContent(text, filename || 'shared.log');
  hideLoader();
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
  logMultiFileActive = distinctFiles.size > 1;
  if (logMultiFileActive) {
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
  const insTab = document.getElementById('log-tab-insights');
  if (insTab && insTab.style.display !== 'none') logRenderInsights();
  const mtxTab = document.getElementById('log-tab-matrix');
  if (mtxTab && mtxTab.style.display !== 'none') logRenderMatrix();
  logUpdateBookmarkBar();
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
  const clearBtn = document.getElementById('log-clear-filters-btn');
  if (clearBtn) clearBtn.style.display = logAnyFilterActive() ? 'inline-flex' : 'none';
}
// True when at least one Log Stream filter deviates from its default. Gates the
// "Clear all filters" button so it is only offered when there is something to
// clear. Every filter mutation routes through logApplyFilters, so checking here
// keeps the button in sync with no extra wiring on the individual controls.
function logAnyFilterActive() {
  if (logActiveSignatureKey) return true;
  if (logActiveLevels.size !== LOG_LEVEL_ORDER.length) return true;
  return ['log-search', 'log-time-from', 'log-time-to', 'log-node-filter', 'log-date-filter']
    .some(function (id) { const el = document.getElementById(id); return el && el.value.trim() !== ''; });
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
  
  const html = rows.map((e, i) => {
    const cls = 'row-' + e.level.toLowerCase();
    const msgParts = e.msg.split('\n');
    const mainLine = msgParts[0];
    const stackLines = msgParts.slice(1);

    const bmKey = logBookmarkKey(e);
    const isBm = logBookmarks.has(bmKey);
    const bmToggle = '<span class="log-bm-toggle' + (isBm ? ' active' : '') + '" data-bmkey="' + escHtml(bmKey) + '"'
      + ' title="' + (isBm ? 'Remove bookmark' : 'Bookmark this line') + '"'
      + ' onclick="event.stopPropagation();logToggleBookmark(this,' + logJsStr(e.file) + ',' + e.line + ')">'
      + (isBm ? '★' : '☆') + '</span>';

    let mainHtml = escHtml(mainLine);
    if (search && search.length > 1) {
      const re = new RegExp(escRegex(search), 'gi');
      mainHtml = mainHtml.replace(re, m => '<mark class="log-highlight">'+m+'</mark>');
    }

    // ERROR/CRITICAL rows get an "Explain" chip that hands the full message
    // (headline + stack) to the Mendix Error Decoder. Index is into the current
    // filtered list, which is rebuilt on every filter change, so it stays valid.
    // Only offered when the decoder actually recognizes a signature in this
    // message — otherwise the chip lands on "No known pattern matched", a dead
    // end. Memoized per entry (msg is stable) so filter re-renders stay cheap.
    let showExplain = false;
    if (e.level === 'ERROR' || e.level === 'CRITICAL') {
      if (typeof window.edxDecode !== 'function') {
        showExplain = true; // decoder script not loaded — keep prior behavior
      } else {
        if (e._edxHasMatch === undefined) e._edxHasMatch = window.edxDecode(e.msg).matches.length > 0;
        showExplain = e._edxHasMatch;
      }
    }
    const explainChip = showExplain
      ? '<span class="log-explain-chip" onclick="event.stopPropagation();window.logExplainError('+(start+i)+')" title="Decode this error\'s mechanism in the Mendix Error Decoder">Explain</span>'
      : '';

    // When >1 file is loaded (merged chronological timeline), show which file
    // this line came from — badge text is the filename without extension,
    // truncated, so two similarly-named files stay distinguishable via title.
    const fileBadge = logMultiFileActive
      ? '<span class="log-row-file-badge" title="' + escHtml(e.file || '') + '">' + escHtml(logFileBadgeLabel(e.file)) + '</span>'
      : '';

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

    return '<div class="log-row '+cls+(isBm ? ' log-row-bookmarked' : '')+'" style="flex-wrap:wrap" oncontextmenu="logShowRowContextMenu(event,'+(start+i)+')">'
      + bmToggle
      + '<span class="log-row-num">'+e.line+'</span>'
      + fileBadge
      + '<span class="log-row-ts">'+escHtml(e.ts)+'</span>'
      + '<span class="log-row-level">'+logBadge(e.level)+'</span>'
      + '<span class="log-row-node" title="'+escHtml(e.node)+'">'+escHtml(e.node)+'</span>'
      + '<span class="log-row-msg">'+mainHtml+'</span>'
      + explainChip
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
  logMultiFileActive = false; logFileBadgeCache.clear();
  logCloseRowContextMenu();
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
  const insOut = document.getElementById('log-insights-output');
  if (insOut) insOut.innerHTML = '<div class="log-insights-empty"><p style="font-weight:600;margin-bottom:6px">No log loaded yet</p>'
    + '<p style="font-size:0.8rem;color:var(--text-muted)">Insights scans WARNING/ERROR patterns and shows a card for each problem that actually appears. Click a card to filter the stream.</p></div>';

  // Bookmarks & matrix reset with the log
  logBookmarks.clear();
  logUpdateBookmarkBar();
  logRenderMatrix();
}
function logExportFiltered() {
  if (!logFilteredEntries.length) return;
  downloadText(logFilteredEntries.map(e=>e.raw).join('\n'), 'filtered-logs.txt');
}

// Parses a log timestamp to epoch ms (UTC basis), matching the convention the
// MFT/WSRE tsToMs helpers use so the Incident Report can align windows across
// tools. Returns NaN for time-only or unparseable stamps.
function logTsToMs(ts) {
  if (!ts) return NaN;
  const m = String(ts).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!m) return NaN;
  const base = Date.parse(m[1] + 'T' + m[2] + ':' + m[3] + ':' + m[4] + 'Z');
  const frac = m[5] ? parseFloat('0.' + m[5]) * 1000 : 0;
  return base + frac;
}

// Incident Report source: the stream's current filtered entries (levels, search,
// node, time), optionally narrowed further to [fromMs, toMs]. Returns null when
// nothing qualifies so the report omits the section (data-driven rule).
function logReportSection(fromMs, toMs) {
  if (!logAllEntries.length) return null;
  // WYSIWYG: mirror the stream's current filter (levels, search, node, time), not
  // a fixed warnings/errors subset of the whole file.
  const rows = [];
  let firstMs = Infinity, lastMs = -Infinity, total = 0;
  for (let i = 0; i < logFilteredEntries.length; i++) {
    const e = logFilteredEntries[i];
    const ms = logTsToMs(e.ts);
    if (fromMs != null && !isNaN(ms) && ms < fromMs) continue;
    if (toMs != null && !isNaN(ms) && ms > toMs) continue;
    total++;
    if (!isNaN(ms)) { if (ms < firstMs) firstMs = ms; if (ms > lastMs) lastMs = ms; }
    if (rows.length < 1000) rows.push([e.ts, e.level, e.node, e.msg.split('\n')[0]]);
  }
  if (total === 0) return null;
  return {
    id: 'log-viewer', title: 'Log Viewer — log entries',
    subtitle: total + ' entr' + (total === 1 ? 'y' : 'ies') + ' (current filter)' + (rows.length < total ? ' · showing first ' + rows.length : ''),
    columns: ['Time', 'Level', 'Node', 'Message'], rows: rows, total: total,
    firstMs: firstMs === Infinity ? null : firstMs, lastMs: lastMs === -Infinity ? null : lastMs
  };
}

// "Explain" chip on ERROR/CRITICAL rows → hand the full message (headline +
// stack) to the Mendix Error Decoder, with a "← Back" chip to return here.
function logExplainError(idx) {
  const e = logFilteredEntries[idx];
  if (!e) return;
  if (window.navigateWithReturn) window.navigateWithReturn('error-decoder');
  else if (window.navigate) window.navigate('error-decoder', null);
  // The decoder's checklist says things like "look for two commits around this
  // timestamp" — so send the timestamp and correlation ID along with the message
  // instead of dropping them here. They are what turns those buttons from a
  // suggestion into navigation.
  const corr = e.raw.match(LOG_CORRID_PAT);
  if (window.edxDecodeText) window.edxDecodeText(e.msg, { ts: e.ts, corrId: corr ? corr[0] : null });
}

// ============================================================
// ROW CONTEXT MENU — right-click a line → "Filter by this Correlation ID"
// ============================================================
// A dedicated Correlation ID input already exists in the Correlation tab; this
// adds the other half of audit finding #7 — jumping straight from a stream row
// to a filter, without first having to spot/copy the ID by hand. Since parsed
// entries have no structured corrId field, the heuristic is the first
// UUID/GUID-like token on the line (how Mendix request/session IDs usually look).
const LOG_CORRID_PAT = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

function logShowRowContextMenu(ev, idx) {
  ev.preventDefault();
  logCloseRowContextMenu();
  const e = logFilteredEntries[idx];
  if (!e) return;
  const m = e.raw.match(LOG_CORRID_PAT);
  const menu = document.createElement('div');
  menu.id = 'log-row-ctxmenu';
  menu.className = 'log-ctxmenu';
  menu.style.left = ev.pageX + 'px';
  menu.style.top = ev.pageY + 'px';
  menu.onclick = ev2 => ev2.stopPropagation();
  menu.innerHTML = m
    ? '<div class="log-ctxmenu-item" onclick="logFilterByCorrId(' + logJsStr(m[0]) + ')">Filter by this Correlation ID<br><span style="font-family:var(--font-mono);font-size:0.7rem;color:var(--text-muted)">' + escHtml(m[0]) + '</span></div>'
    : '<div class="log-ctxmenu-item log-ctxmenu-disabled">No correlation/request ID-like token found on this line</div>';
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', logCloseRowContextMenu, { once: true }), 0);
}

function logCloseRowContextMenu() {
  const el = document.getElementById('log-row-ctxmenu');
  if (el) el.remove();
}

// Reuses the existing search filter — same substring match the Correlation
// tab and the highlighter already rely on — so no new filter dimension is needed.
function logFilterByCorrId(id) {
  logCloseRowContextMenu();
  document.getElementById('log-search').value = id;
  logApplyFilters();
}

// ============================================================
// LINE BOOKMARKS — pin lines and jump between them across filters
// ============================================================
// Bookmarks live in logBookmarks (file#line → snapshot) so they persist through
// every filter/level change. The star on each row toggles membership; the bar
// below the toolbar lists them chronologically and jumps back to the stream —
// clearing filters first if the target line is currently filtered out.

function logToggleBookmark(el, file, line) {
  const key = (file || '') + '#' + line;
  if (logBookmarks.has(key)) {
    logBookmarks.delete(key);
    if (el) {
      el.classList.remove('active'); el.textContent = '☆'; el.title = 'Bookmark this line';
      const row = el.closest('.log-row'); if (row) row.classList.remove('log-row-bookmarked');
    }
  } else {
    const e = logAllEntries.find(x => x.line === line && (x.file || '') === (file || ''));
    if (!e) return;
    logBookmarks.set(key, { line: e.line, file: e.file, ts: e.ts, level: e.level, node: e.node, msg: e.msg.split('\n')[0] });
    if (el) {
      el.classList.add('active'); el.textContent = '★'; el.title = 'Remove bookmark';
      const row = el.closest('.log-row'); if (row) row.classList.add('log-row-bookmarked');
    }
  }
  logUpdateBookmarkBar();
}

// Removes one bookmark and syncs any star currently rendered for that line.
function logRemoveBookmark(key) {
  logBookmarks.delete(key);
  document.querySelectorAll('.log-bm-toggle').forEach(function (el) {
    if (el.dataset.bmkey !== key) return;
    el.classList.remove('active'); el.textContent = '☆'; el.title = 'Bookmark this line';
    const row = el.closest('.log-row'); if (row) row.classList.remove('log-row-bookmarked');
  });
  logUpdateBookmarkBar();
  logRenderBookmarks();
}

function logClearBookmarks() {
  logBookmarks.clear();
  document.querySelectorAll('.log-bm-toggle.active').forEach(function (el) {
    el.classList.remove('active'); el.textContent = '☆'; el.title = 'Bookmark this line';
    const row = el.closest('.log-row'); if (row) row.classList.remove('log-row-bookmarked');
  });
  logUpdateBookmarkBar();
}

// Shows/hides the bar (empty ⇒ hidden) and refreshes the count and open list.
function logUpdateBookmarkBar() {
  const bar = document.getElementById('log-bookmarks-bar');
  if (!bar) return;
  const n = logBookmarks.size;
  const list = document.getElementById('log-bookmarks-list');
  if (n === 0) { bar.style.display = 'none'; if (list) list.style.display = 'none'; return; }
  bar.style.display = 'flex';
  const countEl = document.getElementById('log-bm-count');
  if (countEl) countEl.textContent = n;
  if (list && list.style.display !== 'none') logRenderBookmarks();
}

function logToggleBookmarksList() {
  const list = document.getElementById('log-bookmarks-list');
  if (!list) return;
  const show = list.style.display === 'none' || !list.style.display;
  list.style.display = show ? 'block' : 'none';
  if (show) logRenderBookmarks();
}

function logRenderBookmarks() {
  const list = document.getElementById('log-bookmarks-list');
  if (!list) return;
  if (logBookmarks.size === 0) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:0.78rem;padding:var(--sp-2)">No bookmarks yet. Click the ☆ at the start of a log line to pin it.</div>';
    return;
  }
  const items = Array.from(logBookmarks.entries()).map(function (e) { return { key: e[0], b: e[1] }; });
  items.sort(function (x, y) {
    const mx = logTsToMs(x.b.ts), my = logTsToMs(y.b.ts);
    if (!isNaN(mx) && !isNaN(my) && mx !== my) return mx - my;
    return x.b.line - y.b.line;
  });
  list.innerHTML = items.map(function (it) {
    const b = it.b;
    return '<div class="log-bm-item" onclick="logJumpToBookmark(' + logJsStr(it.key) + ')" title="Jump to this line in the stream">'
      + '<span class="log-bm-item-line">L' + b.line + '</span>'
      + '<span class="log-bm-item-ts">' + escHtml(logInsightsShortTs(b.ts)) + '</span>'
      + logBadge(b.level)
      + '<span class="log-bm-item-node" title="' + escHtml(b.node) + '">' + escHtml(b.node) + '</span>'
      + '<span class="log-bm-item-msg">' + escHtml(b.msg) + '</span>'
      + '<span class="log-bm-item-remove" title="Remove bookmark" onclick="event.stopPropagation();logRemoveBookmark(' + logJsStr(it.key) + ')">&times;</span>'
      + '</div>';
  }).join('');
}

// Resets every stream filter — search, levels, time range, node, date and the
// signature filter. Backs both the toolbar's "Clear all filters" button and
// logJumpToBookmark, which needs it to reveal a bookmark the filters are hiding.
// Sets the input values, then defers to logToggleAllLevels(true), which
// re-applies and re-renders. The loaded log itself is untouched (that is logClear).
function logResetStreamFilters() {
  logActiveSignatureKey = null;
  const banner = document.getElementById('log-sig-filter-banner');
  if (banner) banner.style.display = 'none';
  const ids = ['log-search', 'log-time-from', 'log-time-to', 'log-node-filter', 'log-date-filter'];
  ids.forEach(function (id) { const el = document.getElementById(id); if (el) el.value = ''; });
  logToggleAllLevels(true);
}

// Jumps to a bookmarked line in the Log Stream: switch to the stream tab, reveal
// the row (clearing filters if the line is filtered out), page the infinite-scroll
// list up to it, then centre and flash it.
function logJumpToBookmark(key) {
  let idx = logFilteredEntries.findIndex(e => logBookmarkKey(e) === key);
  if (idx < 0) {
    logResetStreamFilters();
    idx = logFilteredEntries.findIndex(e => logBookmarkKey(e) === key);
    if (idx < 0) return;
  }
  const streamTab = document.querySelector('#panel-log-viewer .tabs .tab[data-help-key="log-viewer-stream"]');
  logSetTab('stream', streamTab);
  const list = document.getElementById('log-virtual-list');
  let guard = 0;
  while (logScrollState.currentLoaded <= idx && logScrollState.currentLoaded < logFilteredEntries.length && guard++ < 100000) logLoadMore();
  const row = list && list.children[idx];
  if (row) {
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.add('log-row-flash');
    setTimeout(function () { row.classList.remove('log-row-flash'); }, 1500);
  }
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
      window.mtToast('Error during log signature analysis: ' + e.message, 'error');
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
// LOG INSIGHTS — curated Mendix problem cards (data-driven)
// ============================================================
// Pure function, attached to window/self so Node tests can require it like the
// MFT/LQE/WSRE extractors. Consumes parser records ({level, logNode|node,
// message|msg, timestamp|ts}) and returns ONLY the problem categories that
// actually occur in the data — no empty cards (data-driven rule). Specialized
// detectors pull structured detail out of known Mendix pain points; everything
// else falls back to per-node error/warning hotspots. Zero new parsing:
// aggregation runs over records already produced by the log parser.

function logInsightsLevel(l) {
  l = (l || '').toUpperCase();
  if (l === 'WARNING') return 'WARN';
  if (l === 'ERR' || l === 'FATAL') return 'ERROR';
  return l;
}

// Collapse a message to a signature so distinct variants can be counted:
// UUIDs, Mendix ids, numbers and quoted literals become '#'.
function logInsightsSignature(msg) {
  return String(msg || '').split('\n')[0]
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '#')
    .replace(/'[^']*'/g, "'#'")
    .replace(/\b\d+\b/g, '#')
    .trim().slice(0, 200);
}

// Slow-query warning shape, mirroring LQE_SLOW_QUERY in the Log Query Extractor.
// Duplicated rather than shared because the two tools are independent modules;
// if the runtime ever changes the wording, both need the same edit.
const LOG_SLOW_QUERY = /^Query executed in (?:(\d+) seconds? and )?(\d+) milliseconds?:\s*([\s\S]+)/i;

// Statement identity for grouping slow-query warnings: the same normalization
// the Query Extractor uses for its duplicate detection — identical statements
// differ only in their bound values.
function logSlowQuerySig(sql) {
  return String(sql).replace(/\s+/g, ' ').replace(/\b\d+\b/g, '?').trim().slice(0, 120);
}

function logFmtDurMs(ms) {
  return ms >= 1000 ? +(ms / 1000).toFixed(1) + ' s' : ms + ' ms';
}

// Longest prefix two statements share. Members of one signature group differ
// only in their bound values, so this cuts off exactly where the first value
// varies — long enough to identify the statement, short enough to match them all.
function logCommonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return a.slice(0, i);
}

function logExtractInsights(records, opts) {
  opts = opts || {};
  const warnMin = opts.warnHotspotMin != null ? opts.warnHotspotMin : 10;
  // A handful of DEBUG lines is normal; a node left at TRACE is what this looks
  // for, so the per-node floor is deliberately well above incidental logging.
  const verboseMin = opts.verboseMin != null ? opts.verboseMin : 25;
  records = records || [];

  const rows = records.map(function (r) {
    return {
      level: logInsightsLevel(r.level),
      node:  (r.logNode != null ? r.logNode : r.node) || '',
      msg:   String(r.message != null ? r.message : r.msg || ''),
      ts:    (r.timestamp != null ? r.timestamp : r.ts) || ''
    };
  });

  const consumed = new Array(rows.length).fill(false);
  const categories = [];

  let warnings = 0, errors = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].level === 'WARN') warnings++;
    else if (rows[i].level === 'ERROR' || rows[i].level === 'CRITICAL') errors++;
  }

  function agg() { return { count: 0, firstTs: '', lastTs: '', sample: '', sigs: new Set() }; }
  function bump(a, r) {
    a.count++;
    if (!a.firstTs) a.firstTs = r.ts;
    a.lastTs = r.ts;
    if (!a.sample) a.sample = r.msg.split('\n')[0];
    a.sigs.add(logInsightsSignature(r.msg));
  }
  function finishCat(key, title, severity, a, filter, items, subtitle) {
    return {
      key: key, title: title, severity: severity,
      count: a.count, distinct: a.sigs.size,
      firstTs: a.firstTs, lastTs: a.lastTs, sample: a.sample,
      subtitle: subtitle || '', filter: filter, items: items || []
    };
  }
  function itemsFromMap(map, parentFilter, searchIsLabel) {
    return Array.from(map.entries()).map(function (e) {
      const label = e[0], a = e[1];
      return {
        label: label, count: a.count, sample: a.sample, distinct: a.sigs.size,
        filter: {
          node: parentFilter.node, levels: parentFilter.levels,
          search: searchIsLabel === false ? '' : label
        }
      };
    }).sort(function (x, y) { return y.count - x.count; });
  }

  // ── 1. Access denied — user lacks microflow/entity rights (WebUI WARNING) ──
  {
    const byMf = new Map(); const users = new Set(); const cat = agg();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.node !== 'WebUI' || r.level !== 'WARN') continue;
      const m = r.msg.match(/User '([^']*)' attempted to execute .*?\(microflow call '([^']+)'\)/);
      if (!m) continue;
      consumed[i] = true; bump(cat, r); users.add(m[1]);
      if (!byMf.has(m[2])) byMf.set(m[2], agg());
      bump(byMf.get(m[2]), r);
    }
    if (cat.count > 0) {
      categories.push(finishCat('perm-denied', 'Access denied — user lacks rights', 'warning', cat,
        { node: 'WebUI', levels: 'WARN', search: 'attempted to execute' },
        itemsFromMap(byMf, { node: 'WebUI', levels: 'WARN' }),
        cat.count + ' denied call(s) · ' + users.size + ' user(s) · ' + byMf.size + ' microflow(s)'));
    }
  }

  // ── 2. Runtime operation missing parameters (WebUI WARNING) ──
  {
    const byOp = new Map(); const cat = agg();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (consumed[i] || r.node !== 'WebUI' || r.level !== 'WARN') continue;
      if (!/is missing parameters/.test(r.msg)) continue;
      consumed[i] = true; bump(cat, r);
      const m = r.msg.match(/is missing parameters: \[([^\]]*)\]/);
      const key = m ? m[1] : '(unknown)';
      if (!byOp.has(key)) byOp.set(key, agg());
      bump(byOp.get(key), r);
    }
    if (cat.count > 0) {
      categories.push(finishCat('missing-params', 'Runtime operation missing parameters', 'warning', cat,
        { node: 'WebUI', levels: 'WARN', search: 'is missing parameters' },
        itemsFromMap(byOp, { node: 'WebUI', levels: 'WARN' }, false),
        cat.count + ' occurrence(s) · ' + byOp.size + ' distinct parameter set(s)'));
    }
  }

  // ── 3. Request state bloat — session memory (RequestStatistics WARNING) ──
  {
    const cat = agg(); let maxSize = 0, threshold = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.node !== 'RequestStatistics' || r.level !== 'WARN') continue;
      const m = r.msg.match(/Request state size of (\d+) objects exceeds the threshold of (\d+)/);
      if (!m) continue;
      consumed[i] = true; bump(cat, r);
      maxSize = Math.max(maxSize, parseInt(m[1], 10));
      threshold = parseInt(m[2], 10);
    }
    if (cat.count > 0) {
      categories.push(finishCat('session-bloat', 'Request state bloat (session memory)', 'warning', cat,
        { node: 'RequestStatistics', levels: 'WARN', search: 'Request state size' }, [],
        cat.count + ' request(s) over limit · peak ' + maxSize + ' objects (threshold ' + threshold + ')'));
    }
  }

  // ── 4. TaskQueue — failed background tasks (ERROR); retry loops surface here ──
  {
    const byTask = new Map(); const cat = agg();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.node !== 'TaskQueue' || (r.level !== 'ERROR' && r.level !== 'CRITICAL')) continue;
      // Task args can contain single quotes (e.g. MailTo='...'), so capture the
      // task name (up to '(' or quote) and the queue name independently rather
      // than with one brittle regex that would drop those failures.
      const tm = r.msg.match(/Failed to execute task '([^'(]+)/);
      if (!tm) continue;
      consumed[i] = true; bump(cat, r);
      const task = tm[1].trim();
      const qm = r.msg.match(/from task queue '([^']+)'/);
      const queue = qm ? qm[1] : '(unknown)';
      const key = task + '  ·  queue ' + queue;
      if (!byTask.has(key)) byTask.set(key, { agg: agg(), task: task });
      bump(byTask.get(key).agg, r);
    }
    if (cat.count > 0) {
      const items = Array.from(byTask.entries()).map(function (e) {
        const a = e[1].agg;
        return { label: e[0], count: a.count, sample: a.sample, distinct: a.sigs.size,
          filter: { node: 'TaskQueue', levels: 'ERROR,CRITICAL', search: e[1].task } };
      }).sort(function (x, y) { return y.count - x.count; });
      const loops = items.filter(function (it) { return it.count >= 5; }).length;
      categories.push(finishCat('taskqueue-fail', 'TaskQueue — failed background tasks', 'error', cat,
        { node: 'TaskQueue', levels: 'ERROR,CRITICAL', search: 'Failed to execute task' }, items,
        cat.count + ' failure(s) · ' + byTask.size + ' task(s)' + (loops ? ' · ' + loops + ' retry-loop(s)' : '')));
    }
  }

  // ── 5. Slow-query warnings (ConnectionBus_Queries WARNING) ──
  // The only database signal available at default production log levels — the
  // Log Query Extractor already treats it as first class, while Insights used to
  // drop it into an anonymous per-node bucket that said nothing about duration.
  {
    const byStmt = new Map(); const cat = agg(); let worstMs = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (consumed[i] || r.node !== 'ConnectionBus_Queries' || r.level !== 'WARN') continue;
      const m = r.msg.match(LOG_SLOW_QUERY);
      if (!m) continue;
      consumed[i] = true; bump(cat, r);
      const ms = (m[1] ? parseInt(m[1], 10) * 1000 : 0) + parseInt(m[2], 10);
      if (ms > worstMs) worstMs = ms;
      const sql = String(m[3]).replace(/\s+/g, ' ').trim();
      const key = logSlowQuerySig(sql);
      if (!byStmt.has(key)) byStmt.set(key, { a: agg(), worst: 0, search: sql.slice(0, 80) });
      const e = byStmt.get(key);
      bump(e.a, r);
      if (ms > e.worst) e.worst = ms;
      // The stream filter matches raw log text, where the bound values are still
      // in place — so the search has to be what every execution in this group
      // shares, not the first one's text. A card that counts 2 must not filter
      // down to the 1 that happened to be logged first.
      e.search = logCommonPrefix(e.search, sql);
    }
    if (cat.count > 0) {
      const items = Array.from(byStmt.entries()).map(function (e) {
        return {
          label: e[0] + '  ·  worst ' + logFmtDurMs(e[1].worst),
          count: e[1].a.count, sample: e[1].a.sample, distinct: e[1].a.sigs.size,
          // Search on the raw statement, not the normalized label: the stream
          // filter matches the log text, where the bound values are still there.
          filter: { node: 'ConnectionBus_Queries', levels: 'WARN', search: e[1].search }
        };
      }).sort(function (x, y) { return y.count - x.count; });
      const c = finishCat('slow-queries', 'Slow queries (runtime warnings)', 'warning', cat,
        { node: 'ConnectionBus_Queries', levels: 'WARN', search: '' }, items,
        cat.count + ' slow quer' + (cat.count === 1 ? 'y' : 'ies') + ' · ' + byStmt.size +
        ' distinct statement(s) · worst ' + logFmtDurMs(worstMs));
      c.crossLink = 'log-query-extractor';
      categories.push(c);
    }
  }

  // ── 6. Nodes logging at TRACE/DEBUG — a fact about the log, not a problem ──
  // "Why is my log 60 MB and my app slow" is most often answered by a log node
  // left at TRACE on production. The Levels matrix already counts this; nobody
  // ever stated it as a finding. Phrased as an observation (severity 'info'),
  // because verbose logging in a development environment is intentional.
  {
    const counts = new Map();
    for (let i = 0; i < rows.length; i++) {
      const lv = rows[i].level;
      if (lv !== 'TRACE' && lv !== 'DEBUG') continue;
      const key = rows[i].node || '(unknown)';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const loud = new Set();
    counts.forEach(function (n, node) { if (n >= verboseMin) loud.add(node); });
    if (loud.size) {
      // Second pass so the card's own span and sample come from the qualifying
      // nodes only — summing the per-node aggregates would report the first
      // node's last timestamp as the category's.
      const byNode = new Map(); const cat = agg();
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r.level !== 'TRACE' && r.level !== 'DEBUG') continue;
        const key = r.node || '(unknown)';
        if (!loud.has(key)) continue;
        bump(cat, r);
        if (!byNode.has(key)) byNode.set(key, agg());
        bump(byNode.get(key), r);
      }
      const share = function (n) { return rows.length ? Math.round(n / rows.length * 100) : 0; };
      const items = Array.from(byNode.entries()).map(function (e) {
        return {
          label: e[0] + '  ·  ' + share(e[1].count) + '% of the log',
          count: e[1].count, sample: e[1].sample, distinct: e[1].sigs.size,
          filter: { node: e[0], levels: 'TRACE,DEBUG', search: '' }
        };
      }).sort(function (x, y) { return y.count - x.count; });
      categories.push(finishCat('verbose-nodes', 'Nodes logging at TRACE/DEBUG', 'info', cat,
        { node: '', levels: 'TRACE,DEBUG', search: '' }, items,
        cat.count + ' entr' + (cat.count === 1 ? 'y' : 'ies') + ' · ' + share(cat.count) +
        '% of the log · ' + loud.size + ' node(s) at ' + verboseMin + '+ entries'));
    }
  }

  // ── 7. Generic per-node hotspots for everything not captured above ──
  const buckets = new Map();
  for (let i = 0; i < rows.length; i++) {
    if (consumed[i]) continue;
    const r = rows[i];
    const isErr = r.level === 'ERROR' || r.level === 'CRITICAL';
    const isWarn = r.level === 'WARN';
    if (!isErr && !isWarn) continue;
    const bkey = (isErr ? 'E|' : 'W|') + r.node;
    if (!buckets.has(bkey)) buckets.set(bkey, { node: r.node, severity: isErr ? 'error' : 'warning', a: agg(), sigMap: new Map() });
    const b = buckets.get(bkey);
    bump(b.a, r);
    const sig = logInsightsSignature(r.msg);
    if (!b.sigMap.has(sig)) b.sigMap.set(sig, agg());
    bump(b.sigMap.get(sig), r);
  }
  buckets.forEach(function (b) {
    if (b.severity === 'warning' && b.a.count < warnMin) return;
    const levels = b.severity === 'error' ? 'ERROR,CRITICAL' : 'WARN';
    const items = Array.from(b.sigMap.entries()).map(function (e) {
      return { label: e[0], count: e[1].count, sample: e[1].sample, distinct: 1,
        filter: { node: b.node, levels: levels, search: '' } };
    }).sort(function (x, y) { return y.count - x.count; }).slice(0, 8);
    categories.push(finishCat('node-' + b.severity + '-' + b.node,
      b.node + (b.severity === 'error' ? ' — errors' : ' — warnings'), b.severity, b.a,
      { node: b.node, levels: levels, search: '' }, items,
      b.a.count + ' entr' + (b.a.count === 1 ? 'y' : 'ies') + ' · ' + b.sigMap.size + ' distinct message(s)'));
  });

  // Problems first, observations last: an 'info' card states a fact about the
  // log and must never outrank an error, however many entries it counts.
  const sevRank = { error: 0, warning: 1, info: 2 };
  categories.sort(function (x, y) {
    const sr = (sevRank[x.severity] || 0) - (sevRank[y.severity] || 0);
    if (sr) return sr;
    return y.count - x.count;
  });

  return { categories: categories, stats: { records: rows.length, warnings: warnings, errors: errors, categories: categories.length } };
}

// ============================================================
// LEVEL MATRIX — LogNode × level pivot (data-driven)
// ============================================================
// Pure function, attached to window/self so Node tests require it like the
// other extractors. Consumes parser records ({level, logNode|node}) and returns
// only the levels and nodes that actually occur — no empty rows/columns
// (data-driven rule). Zero new parsing: it counts records the log parser already
// produced. Nodes rank by ERROR+CRITICAL volume so the noisiest logger floats up.

const LOG_LEVEL_ORDER = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'];

function logMatrixLevel(l) {
  l = (l || '').toUpperCase();
  if (l === 'WARNING') return 'WARN';
  if (l === 'ERR' || l === 'FATAL') return 'ERROR';
  return l;
}

function logBuildLevelMatrix(records) {
  records = records || [];
  const nodeMap = new Map();       // node → { node, counts:{level:n}, total }
  const levelTotals = {};
  const present = new Set();
  let grandTotal = 0;

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const level = logMatrixLevel(r.level);
    if (LOG_LEVEL_ORDER.indexOf(level) === -1) continue; // ignore unknown levels
    const node = ((r.logNode != null ? r.logNode : r.node) || 'Runtime') || 'Runtime';
    if (!nodeMap.has(node)) nodeMap.set(node, { node: node, counts: {}, total: 0 });
    const row = nodeMap.get(node);
    row.counts[level] = (row.counts[level] || 0) + 1;
    row.total++;
    levelTotals[level] = (levelTotals[level] || 0) + 1;
    present.add(level);
    grandTotal++;
  }

  const levels = LOG_LEVEL_ORDER.filter(l => present.has(l));
  const nodes = Array.from(nodeMap.values());
  nodes.sort(function (a, b) {
    const ae = (a.counts.ERROR || 0) + (a.counts.CRITICAL || 0);
    const be = (b.counts.ERROR || 0) + (b.counts.CRITICAL || 0);
    if (be !== ae) return be - ae;
    if (b.total !== a.total) return b.total - a.total;
    return a.node.localeCompare(b.node);
  });

  return { levels: levels, nodes: nodes, levelTotals: levelTotals, grandTotal: grandTotal, nodeCount: nodes.length };
}

// Renders the pivot table. Honors the data-driven rule: no log → guidance;
// otherwise one row per node, one column per level that occurs. Every non-zero
// cell is clickable and hands node+level to logInsightFilter (jumps to the
// Stream pre-filtered); zero cells are inert. Error/critical columns are tinted.
function logRenderMatrix() {
  const out = document.getElementById('log-matrix-output');
  if (!out) return;

  if (!logAllEntries.length) {
    out.innerHTML = '<div class="log-insights-empty">'
      + '<p style="font-weight:600;margin-bottom:6px">No log loaded yet</p>'
      + '<p style="font-size:0.8rem;color:var(--text-muted)">The Levels matrix pivots the loaded log by log node × severity so you can see, at a glance, which logger is producing the errors and which nodes are running at DEBUG/TRACE. Load a log in the <strong>Log Stream</strong> tab; then click any cell to filter the stream to exactly those entries.</p></div>';
    return;
  }

  const m = logBuildLevelMatrix(logAllEntries);
  if (m.grandTotal === 0) {
    out.innerHTML = '<div class="log-insights-empty"><p style="font-weight:600">No leveled entries to pivot</p></div>';
    return;
  }

  const levelClass = { TRACE: 'lm-trace', DEBUG: 'lm-debug', INFO: 'lm-info', WARN: 'lm-warn', ERROR: 'lm-error', CRITICAL: 'lm-critical' };

  const head = '<div class="log-insights-summary">Pivot of <strong>' + m.grandTotal + '</strong> entr' + (m.grandTotal === 1 ? 'y' : 'ies') + ' · '
    + '<strong>' + m.nodeCount + '</strong> log node' + (m.nodeCount === 1 ? '' : 's') + ' × <strong>' + m.levels.length + '</strong> level' + (m.levels.length === 1 ? '' : 's')
    + ' · <span style="color:var(--text-muted)">click a cell to filter the stream</span></div>';

  let thead = '<tr><th class="lm-node-th">Log node</th>';
  m.levels.forEach(function (l) {
    thead += '<th class="lm-lvl-th ' + (levelClass[l] || '') + '" onclick="logInsightFilter(\'\',' + logJsStr(l) + ',\'\')" title="Filter the stream to all ' + l + ' entries">' + l + '</th>';
  });
  thead += '<th class="lm-total-th">Total</th></tr>';

  const body = m.nodes.map(function (row) {
    let tr = '<tr><td class="lm-node" onclick="logInsightFilter(' + logJsStr(row.node) + ',\'\',\'\')" title="Filter the stream to node ' + escHtml(row.node) + '">' + escHtml(row.node) + '</td>';
    m.levels.forEach(function (l) {
      const c = row.counts[l] || 0;
      if (c === 0) { tr += '<td class="lm-cell lm-zero">·</td>'; return; }
      tr += '<td class="lm-cell ' + (levelClass[l] || '') + '" onclick="logInsightFilter(' + logJsStr(row.node) + ',' + logJsStr(l) + ',\'\')" title="Filter to ' + escHtml(row.node) + ' · ' + l + ' (' + c + ')">' + c + '</td>';
    });
    tr += '<td class="lm-cell lm-total" onclick="logInsightFilter(' + logJsStr(row.node) + ',\'\',\'\')">' + row.total + '</td></tr>';
    return tr;
  }).join('');

  let tfoot = '<tr class="lm-foot"><td class="lm-node">All nodes</td>';
  m.levels.forEach(function (l) {
    const c = m.levelTotals[l] || 0;
    tfoot += '<td class="lm-cell ' + (levelClass[l] || '') + '" onclick="logInsightFilter(\'\',' + logJsStr(l) + ',\'\')">' + c + '</td>';
  });
  tfoot += '<td class="lm-cell lm-total">' + m.grandTotal + '</td></tr>';

  out.innerHTML = head
    + '<div class="log-matrix-wrap"><table class="log-matrix"><thead>' + thead + '</thead>'
    + '<tbody>' + body + '</tbody>'
    + '<tfoot>' + tfoot + '</tfoot></table></div>';
}

// ============================================================
// ADVANCED LOG INTELLIGENCE (Correlation, Sequence, Gantt)
// ============================================================

function logSetTab(tabId, el) {
  document.querySelectorAll('#panel-log-viewer .tabs .tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
  if (el) { el.classList.add('active'); el.setAttribute('aria-selected', 'true'); }

  const tabs = ['stream', 'insights', 'matrix', 'correlation', 'sequence', 'gantt'];
  tabs.forEach(t => {
    const pane = document.getElementById('log-tab-' + t);
    if (pane) pane.style.display = (t === tabId) ? 'flex' : 'none';
  });
  if (tabId === 'insights') logRenderInsights();
  if (tabId === 'matrix') logRenderMatrix();
}

// Builds the Insights problem-card overview from the loaded records. Honors the
// data-driven rule: empty log → guidance; loaded but no WARN/ERROR patterns →
// an explicit "clean" state; otherwise one card per category that occurs.
function logRenderInsights() {
  const out = document.getElementById('log-insights-output');
  if (!out) return;

  if (!logAllEntries.length) {
    out.innerHTML = '<div class="log-insights-empty">'
      + '<p style="font-weight:600;margin-bottom:6px">No log loaded yet</p>'
      + '<p style="font-size:0.8rem;color:var(--text-muted)">Insights scans WARNING/ERROR patterns (permission violations, session-state bloat, TaskQueue failures, slow-query warnings, per-node error hotspots) and shows a card for each problem that actually appears — nothing more. It also states one fact about the log itself: which log nodes are running at TRACE/DEBUG.</p></div>';
    return;
  }

  const result = logExtractInsights(logAllEntries);
  const cats = result.categories;

  // Observations ('info') are not problems, so they are counted separately —
  // a log whose only card says "these nodes log at TRACE" is still a clean log.
  const problems = cats.filter(function (c) { return c.severity !== 'info'; }).length;
  const notes = cats.length - problems;

  const head = '<div class="log-insights-summary">Scanned <strong>' + result.stats.records + '</strong> entries · '
    + '<span style="color:var(--log-error)">' + result.stats.errors + ' errors</span> · '
    + '<span style="color:var(--log-warning)">' + result.stats.warnings + ' warnings</span> · '
    + '<strong>' + problems + '</strong> problem categor' + (problems === 1 ? 'y' : 'ies')
    + (notes ? ' · <strong>' + notes + '</strong> observation' + (notes === 1 ? '' : 's') : '') + '</div>';

  const cleanNote = '<div class="log-insights-empty" style="margin-top:var(--sp-4)">'
    + '<p style="font-weight:600;margin-bottom:6px">No WARNING/ERROR patterns found</p>'
    + '<p style="font-size:0.8rem;color:var(--text-muted)">This log is clean at WARNING level and above. If you expected background-job or microflow detail, raise the relevant log nodes to DEBUG/TRACE and reproduce the scenario.</p></div>';

  if (cats.length === 0) {
    out.innerHTML = head + cleanNote;
    return;
  }

  const cards = cats.map(function (c, i) {
    const sevColor = c.severity === 'error' ? 'var(--log-error)'
      : (c.severity === 'info' ? 'var(--accent)' : 'var(--log-warning)');
    const span = (c.firstTs && c.lastTs && c.firstTs !== c.lastTs)
      ? '<span class="log-insights-span" title="First → last occurrence">' + escHtml(logInsightsShortTs(c.firstTs)) + ' → ' + escHtml(logInsightsShortTs(c.lastTs)) + '</span>' : '';
    const itemsHtml = (c.items && c.items.length) ? '<div class="log-insights-items" id="log-insights-items-' + i + '" style="display:none">'
      + c.items.slice(0, 12).map(function (it) {
          return '<div class="log-insights-item" onclick="logInsightFilter(' + logInsightsAttr(it.filter) + ')" title="Filter the stream to these entries">'
            + '<span class="log-insights-item-count">' + it.count + '×</span>'
            + '<span class="log-insights-item-label">' + escHtml(it.label) + '</span></div>';
        }).join('')
      + (c.items.length > 12 ? '<div style="font-size:0.72rem;color:var(--text-muted);padding:4px 8px">…and ' + (c.items.length - 12) + ' more</div>' : '')
      + '</div>' : '';
    const toggle = (c.items && c.items.length)
      ? '<button class="btn btn-ghost btn-sm log-insights-toggle" onclick="event.stopPropagation();logInsightsToggle(' + i + ')">Breakdown (' + c.items.length + ')</button>' : '';
    const cross = (c.crossLink && LOG_INSIGHT_TOOLS[c.crossLink])
      ? '<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();logInsightsOpenTool(\'' + c.crossLink + '\')" title="' + LOG_INSIGHT_TOOLS[c.crossLink].title + '">' + LOG_INSIGHT_TOOLS[c.crossLink].label + '</button>' : '';

    return '<div class="log-insights-card" style="border-left:3px solid ' + sevColor + '">'
      + '<div class="log-insights-card-head" onclick="logInsightFilter(' + logInsightsAttr(c.filter) + ')" title="Filter the stream to these entries">'
      +   '<span class="log-insights-count" style="background:' + sevColor + '">' + c.count + '×</span>'
      +   '<div style="flex:1;min-width:0">'
      +     '<div class="log-insights-title">' + escHtml(c.title) + '</div>'
      +     '<div class="log-insights-sub">' + escHtml(c.subtitle) + '</div>'
      +     (c.sample ? '<div class="log-insights-sample" title="' + escHtml(c.sample) + '">' + escHtml(c.sample) + '</div>' : '')
      +   '</div>'
      +   span
      + '</div>'
      + ((toggle || cross) ? '<div class="log-insights-actions">' + toggle + cross + '</div>' : '')
      + itemsHtml
      + '</div>';
  }).join('');

  out.innerHTML = head + (problems === 0 ? cleanNote : '') + '<div class="log-insights-grid">' + cards + '</div>';
}

// Cross-links an Insights card can offer. A card names the tool; the label and
// tooltip live here so the pure extractor stays free of UI copy.
const LOG_INSIGHT_TOOLS = {
  'log-query-extractor': {
    label: 'Open in Query Extractor',
    title: 'Open the Log Query Extractor on this log — it reads the same slow-query warnings and shows the full SQL, with a By-statement view for total cost'
  }
};

// Hands the loaded log over to another tool, with the same fallback every other
// cross-link uses: if the target has nothing, give it this file so one load
// powers both. The full log goes over, not the filtered view — the target needs
// the lines the current level filter happens to be hiding.
function logInsightsOpenTool(toolId) {
  if (window.navigateWithReturn) window.navigateWithReturn(toolId);
  if (toolId === 'log-query-extractor' && window.lqeLoadText &&
      window.lqeHasData && !window.lqeHasData() && logAllEntries.length) {
    window.lqeLoadText(logAllEntries.map(function (e) { return e.raw; }).join('\n'));
  }
}

function logInsightsShortTs(ts) {
  const m = String(ts).match(/(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : ts;
}

// Serializes a filter object into an inline-handler argument list, safely quoted.
// Two escapes, in this order: JavaScript first (the string literal the handler
// will parse), then HTML (the double-quoted attribute the browser unescapes
// before it ever sees JavaScript). The HTML half matters as soon as a filter
// carries a double quote — a slow-query breakdown searches on raw SQL such as
// SELECT "sales$order"…, which without it closes the onclick attribute early
// and the click throws a SyntaxError instead of filtering.
function logInsightsAttr(f) {
  const q = function (s) {
    return "'" + String(s == null ? '' : s)
      .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') + "'";
  };
  return q(f.node) + ',' + q(f.levels) + ',' + q(f.search);
}

function logInsightsToggle(i) {
  const el = document.getElementById('log-insights-items-' + i);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// Card/item click → jump to the Log Stream tab with matching filters applied.
function logInsightFilter(node, levels, search) {
  const levelSet = (levels || '').split(',').map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean)
    .map(function (l) { return l === 'WARNING' ? 'WARN' : l; });

  ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'].forEach(function (l) {
    const on = levelSet.length === 0 || levelSet.indexOf(l) !== -1;
    const btn = document.querySelector('.level-filter-btn[onclick*="\'' + l + '\'"]');
    if (on) { logActiveLevels.add(l); if (btn) btn.classList.add('active'); }
    else { logActiveLevels.delete(l); if (btn) btn.classList.remove('active'); }
  });

  document.getElementById('log-node-filter').value = node || '';
  document.getElementById('log-search').value = search || '';

  const streamTab = document.querySelector('#panel-log-viewer .tabs .tab[data-help-key="log-viewer-stream"]');
  logSetTab('stream', streamTab);
  logApplyFilters();
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

// Resolves the entries onto one monotonic epoch axis for the Gantt. Entries can
// carry three timestamp shapes: full ISO (LOG_PAT_CLOUD/STUDIO/SIMPLE), the Studio
// Pro CSV export the shared parser emits, or a time-only stamp from LOG_PAT_TIME.
// Only the last one has to be synthesised — and it is the one that used to break
// the chart: anchoring every entry to a fixed 1970-01-01 threw the date away, so a
// log crossing midnight sorted backwards and reported "logs have same timestamp".
// Carrying a day offset forward when the clock jumps back keeps the axis monotonic.
function logGanttAxis(entries) {
  let dayOffset = 0;
  let prevTimeOnly = -1;
  return entries.map(e => {
    let ms = logTsToMs(e.ts);
    if (isNaN(ms) && window.mftTsToMs) ms = window.mftTsToMs(e.ts);
    if (isNaN(ms)) {
      const m = String(e.ts).match(/^\[?(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
      if (!m) return null;
      const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10), ss = parseInt(m[3], 10);
      const t = ((hh * 60 + mm) * 60 + ss) * 1000 +
                (m[4] ? parseInt(m[4].padEnd(3, '0').slice(0, 3), 10) : 0);
      if (prevTimeOnly >= 0 && t < prevTimeOnly) dayOffset += 86400000;
      prevTimeOnly = t;
      ms = t + dayOffset;
    }
    return { ...e, ms: ms };
  }).filter(e => e !== null);
}

function logGenerateGantt() {
  const out = document.getElementById('log-gantt-output');
  if (logFilteredEntries.length < 2) {
    out.innerHTML = '<span style="color:var(--warning)">Not enough logs to generate timeline (need at least 2).</span>';
    return;
  }
  
  const maxEntries = 500;
  const entries = logFilteredEntries.slice(0, maxEntries);

  const parsed = logGanttAxis(entries);

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
  
  // The bar measures the gap to the NEXT log line, which is all a generic log can
  // support — an arbitrary entry carries no duration of its own. Saying "gap" is
  // the honest label: a wide bar means nothing was logged for that long, which is
  // either a quiet period or one un-instrumented operation running. For real
  // per-activity durations the log needs MicroflowEngine DEBUG/TRACE records —
  // that is the Microflow Tracer's job, and the note below points there.
  let html = `<div style="margin-bottom:var(--sp-4);color:var(--text-muted);font-size:0.8rem">Timeline for ${parsed.length} entries. Total span: ${totalDuration}ms. Each bar is the gap until the next log line — a wide bar means the log went quiet, not that one operation took that long.</div>`;

  html += '<div style="display:flex;flex-direction:column;gap:2px">';
  parsed.forEach((e, i) => {
    const elapsed = e.ms - t0;
    const perc = (elapsed / totalDuration) * 100;

    // Gap to the next entry — see the note above on why this is not a duration.
    let gap = 0;
    if (i < parsed.length - 1) {
       gap = parsed[i+1].ms - e.ms;
    }
    const widthPerc = Math.max((gap / totalDuration) * 100, 0.5); // min 0.5%

    html += `<div style="display:flex;align-items:center;font-size:0.75rem;font-family:var(--font-mono)">
      <div style="width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(e.node)}: ${escHtml(e.msg.split('\n')[0])}">${escHtml(e.node)}</div>
      <div style="flex:1;position:relative;height:16px;background:var(--bg-base);margin:0 var(--sp-2)">
         <div style="position:absolute;left:${perc}%;width:${widthPerc}%;height:100%;background:var(--accent);min-width:2px;border-radius:2px" title="Time: ${escHtml(e.ts)}\nGap to next line: ${gap}ms\nMsg: ${escHtml(e.msg.split('\n')[0])}"></div>
      </div>
      <div style="width:60px;text-align:right" title="Gap to the next log line">${gap}ms</div>
    </div>`;
  });
  html += '</div>';
  
  out.innerHTML = html;
}

function logAnonymizeAndCopy() {
  if (!logFilteredEntries.length) {
    window.mtToast('No logs to anonymize.', 'warning');
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
  window.mtToast(`Anonymized and copied ${logFilteredEntries.length} filtered log entries to clipboard!`, 'success');
}

function logSendToAnonymizer() {
  if (!logFilteredEntries.length) {
    window.mtToast('No logs to send.', 'warning');
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
    window.mtToast('Please paste some logs first.', 'warning');
    return;
  }
  logClosePasteModal();
  logParseContent(text, 'clipboard-paste.txt');
}


// Data Hub: does this tool currently show something of its own? Used to warn
// before a one-click hand-off from another tool silently replaces it.
function logHasData() { return logAllEntries.length > 0; }

// --- AUTO-GENERATED ESM EXPORTS ---
window.logIsContinuation = logIsContinuation;
window.logHasData = logHasData;
window.logLoadFiles = logLoadFiles;
window.logLoadText = logLoadText;
window.logHandleDrop = logHandleDrop;
window.logParseContent = logParseContent;
window.logBuildDateFilter = logBuildDateFilter;
window.logToggleLevel = logToggleLevel;
window.logToggleAllLevels = logToggleAllLevels;
window.logApplyFilters = logApplyFilters;
window.logResetStreamFilters = logResetStreamFilters;
window.logRender = logRender;
window.logToggleStack = logToggleStack;
window.logBadge = logBadge;
window.logUpdateStats = logUpdateStats;
window.logScrollTo = logScrollTo;
window.logClear = logClear;
window.logExportFiltered = logExportFiltered;
window.logExplainError = logExplainError;
window.logReportSection = logReportSection;
window.logFileBadgeLabel = logFileBadgeLabel;
window.logShowRowContextMenu = logShowRowContextMenu;
window.logCloseRowContextMenu = logCloseRowContextMenu;
window.logFilterByCorrId = logFilterByCorrId;
window.logToggleBookmark = logToggleBookmark;
window.logRemoveBookmark = logRemoveBookmark;
window.logClearBookmarks = logClearBookmarks;
window.logToggleBookmarksList = logToggleBookmarksList;
window.logRenderBookmarks = logRenderBookmarks;
window.logJumpToBookmark = logJumpToBookmark;
window.logBuildLevelMatrix = logBuildLevelMatrix;
window.logRenderMatrix = logRenderMatrix;
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
window.logExtractInsights = logExtractInsights;
window.logRenderInsights = logRenderInsights;
window.logInsightFilter = logInsightFilter;
window.logInsightsToggle = logInsightsToggle;
window.logInsightsOpenTool = logInsightsOpenTool;
window.logSetTab = logSetTab;
window.logGenerateCorrelation = logGenerateCorrelation;
window.logGenerateSequence = logGenerateSequence;
window.logGenerateGantt = logGenerateGantt;
window.logGanttAxis = logGanttAxis;
window.logAnonymizeAndCopy = logAnonymizeAndCopy;
window.logSendToAnonymizer = logSendToAnonymizer;
window.logOpenPasteModal = logOpenPasteModal;
window.logClosePasteModal = logClosePasteModal;
window.logSubmitPaste = logSubmitPaste;

export function init() {}
