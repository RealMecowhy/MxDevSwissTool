// JVM HEALTH ANALYZER (Thread Dump + GC & Memory tabs)
// ============================================================
// Extracted from misc-mendix.js (Fala 7.4) — purely mechanical, no behavior
// change. GC & Memory tab logic itself lives in memory-inspector.js
// (window.miAnalyze); this file owns the tab switch and Thread Dump analysis.

function jvmSetTab(tab, el) {
  const panel = document.getElementById('panel-thread-dump');
  if (!panel) return;
  panel.querySelectorAll('.tabs .tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
  if (el) { el.classList.add('active'); el.setAttribute('aria-selected', 'true'); }
  document.getElementById('jvm-tab-threads').style.display = tab === 'threads' ? 'block' : 'none';
  document.getElementById('jvm-tab-memory').style.display = tab === 'memory' ? 'flex' : 'none';
  const btn = document.getElementById('jvm-analyze-btn');
  if (btn) btn.textContent = tab === 'memory' ? 'Analyze Memory Data' : 'Analyze Thread Dump';
}

function jvmAnalyzeActive() {
  const memTab = document.getElementById('jvm-tab-memory');
  if (memTab && memTab.style.display !== 'none') {
    if (window.miAnalyze) window.miAnalyze();
  } else {
    analyzeThreadDump();
  }
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

  let m2eeJsonStr = null;
  const marker = "Current JVM Thread Stacktraces:";
  const markerIdx = input.indexOf(marker);

  if (markerIdx !== -1) {
    const bracketIdx = input.indexOf('{', markerIdx);
    if (bracketIdx !== -1) {
      const lastBracketIdx = input.lastIndexOf('}');
      if (lastBracketIdx > bracketIdx) {
         m2eeJsonStr = input.substring(bracketIdx, lastBracketIdx + 1);
      }
    }
  } else if (input.trim().startsWith('{')) {
    const trimmed = input.trim();
    const lastBracketIdx = trimmed.lastIndexOf('}');
    if (lastBracketIdx !== -1) {
       m2eeJsonStr = trimmed.substring(0, lastBracketIdx + 1);
    }
  }

  let parsedAsJson = false;
  if (m2eeJsonStr) {
    try {
      let jsonObj = JSON.parse(m2eeJsonStr);
      for (let threadName in jsonObj) {
        let traceArray = jsonObj[threadName];
        let traceStr = traceArray.join('\n');
        let thread = { name: `"${threadName}"`, trace: traceStr, state: 'UNKNOWN' };

        // Infer state for m2ee dumps
        if (traceStr.includes('waiting to lock') || traceStr.includes('java.lang.Thread.State: BLOCKED')) {
          thread.state = 'BLOCKED';
          blocked.push(thread);
        } else if (traceStr.includes('Unsafe.park') || traceStr.includes('Object.wait') || traceStr.includes('waiting on condition') || traceStr.includes('EPoll.wait')) {
          thread.state = 'WAITING';
          waiting.push(thread);
        } else {
          thread.state = 'RUNNABLE';
          runnable.push(thread);
        }
      }
      parsedAsJson = true;
    } catch (e) {
      console.error("Failed to parse JSON thread dump", e);
    }
  }

  if (!parsedAsJson) {
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

  // Stash a lightweight summary for the Incident Report. A thread dump is a
  // point-in-time snapshot (no time window), so the report includes it only when
  // one has actually been analyzed here (data-driven rule).
  window._jvmLastSummary = {
    blocked: blocked.length, waiting: waiting.length, runnable: runnable.length,
    total: blocked.length + waiting.length + runnable.length, deadlocks: deadlocks.length,
    blockedThreads: blocked.slice(0, 25).map(function (t) { return (t.name.split('"')[1] || t.name); })
  };

  let html = `<div style="display:flex;gap:var(--sp-4);margin-bottom:var(--sp-3)">
    <div class="card" style="flex:1;border-color:var(--danger)"><div class="card-body"><h3 style="color:var(--danger);margin:0">${blocked.length}</h3><div style="font-size:0.8rem">BLOCKED</div></div></div>
    <div class="card" style="flex:1;border-color:var(--warning)"><div class="card-body"><h3 style="color:var(--warning);margin:0">${waiting.length}</h3><div style="font-size:0.8rem">WAITING</div></div></div>
    <div class="card" style="flex:1;border-color:var(--success)"><div class="card-body"><h3 style="color:var(--success);margin:0">${runnable.length}</h3><div style="font-size:0.8rem">RUNNABLE</div></div></div>
  </div>`;

  html += `<div class="card" style="margin-bottom:var(--sp-4); border-left: 4px solid ${blocked.length > 0 ? 'var(--danger)' : 'var(--success)'};">
    <div class="card-body">
      <h4 style="margin-top:0; margin-bottom:var(--sp-2)">Analysis Insight</h4>
      <p style="margin:0; font-size:0.9rem; color:var(--text-secondary); line-height:1.5;">`;

  if (blocked.length === 0) {
    html += `<strong style="color:var(--success)">System looks healthy.</strong> No blocked threads were detected. <br/>
    &bull; <strong>${runnable.length} RUNNABLE</strong> threads were actively processing work (e.g. handling requests, running microflows).<br/>
    &bull; <strong>${waiting.length} WAITING</strong> threads are idle in thread pools (e.g. database connections, web server) waiting for new tasks. This high number is completely normal.`;
  } else {
    html += `<strong style="color:var(--danger)">Warning: ${blocked.length} blocked threads detected!</strong> This might indicate a severe performance bottleneck.<br/>
    Check the "Blocked Threads" list below. These threads are stuck waiting indefinitely for a resource (like a database lock or an external API response) held by another process.`;
  }
  html += `</p></div></div>`;

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

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.jvmSetTab = jvmSetTab;
window.jvmAnalyzeActive = jvmAnalyzeActive;
window.analyzeThreadDump = analyzeThreadDump;
// Incident Report source: the last analyzed thread dump. Point-in-time, so the
// fromMs/toMs window is accepted for a uniform signature but not applied. Returns
// null until a dump has been analyzed in the JVM Health tool (data-driven rule).
window.jvmReportSection = function() {
  const s = window._jvmLastSummary;
  if (!s || !s.total) return null;
  const rows = [
    ['BLOCKED', s.blocked], ['WAITING', s.waiting], ['RUNNABLE', s.runnable],
    ['Total threads', s.total], ['Deadlocks detected', s.deadlocks]
  ];
  if (s.blockedThreads && s.blockedThreads.length) {
    rows.push(['Blocked threads', s.blockedThreads.join(', ') + (s.blocked > s.blockedThreads.length ? ', …' : '')]);
  }
  return {
    id: 'thread-dump', title: 'JVM Health — thread dump summary',
    subtitle: 'Point-in-time snapshot (not time-filtered) · ' + s.blocked + ' blocked, ' + s.waiting + ' waiting, ' + s.runnable + ' runnable',
    columns: ['Metric', 'Value'], rows: rows, total: s.total, firstMs: null, lastMs: null
  };
};

export function init() {
  const tdInput = document.getElementById('thread-dump-input');
  if (tdInput) {
    tdInput.addEventListener('dragover', (e) => {
      e.preventDefault();
      tdInput.style.borderColor = 'var(--accent)';
    });
    tdInput.addEventListener('dragleave', (e) => {
      e.preventDefault();
      tdInput.style.borderColor = '';
    });
    tdInput.addEventListener('drop', (e) => {
      e.preventDefault();
      tdInput.style.borderColor = '';
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        const reader = new FileReader();
        reader.onload = (event) => {
          tdInput.value = event.target.result;
          analyzeThreadDump();
        };
        reader.readAsText(file);
      }
    });
  }
}
