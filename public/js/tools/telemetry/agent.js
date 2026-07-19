import { state } from './state.js';
import { tmUpdateTabsVisibility, tmToggleConnectionCard, tmTogglePgConfigCard } from './ui.js';
import { tmChangePollInterval } from './poller.js';
import { tmRenderOtelTracesTable, tmRenderTraceWaterfall, tmGetTraceList, tmRenderOtelLogsTable } from './traces.js';
import { tmGenerateMockPgStats } from './mock.js';

export function tmConnectAgent() {
  const agentUrl = document.getElementById('tm-agent-url').value.trim();
  const logPath = document.getElementById('tm-agent-logpath').value.trim();

  if (!agentUrl) return alert('Please enter a Local Agent Endpoint URL');

  const btn = document.getElementById('tm-btn-agent-connect');
  btn.disabled = true;
  btn.innerHTML = '<span style="display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 1s linear infinite;margin-right:5px"></span> Connecting...';

  // Append status query
  fetch(`${agentUrl}/status`)
    .then(res => {
      if (!res.ok) throw new Error(`Agent returned status ${res.status}`);
      return res.json();
    })
    .then(data => {
      state.tmAgentStatus = 'connected';
      state.tmLastLogTimestamp = Date.now() - 1000; // start capturing logs from now

      // UI Updates
      document.getElementById('tm-agent-status-dot').style.background = 'var(--success)';
      const statusText = document.getElementById('tm-agent-status-text');
      statusText.textContent = 'Agent Connected';
      statusText.style.color = 'var(--success)';

      document.getElementById('tm-agent-info-text').innerHTML = `
        Log File: <code style="color:var(--accent);background:rgba(0,0,0,0.2);padding:2px 4px;border-radius:3px">${escHtml(data.logFile)}</code>
        ${data.otel ? `| OTLP Collector: <code style="color:var(--info);background:rgba(0,0,0,0.2);padding:2px 4px;border-radius:3px">:${data.otel.port}</code> (Traces/Logs: <strong style="color:var(--success)">${data.otel.tracesReceived}/${data.otel.logsReceived}</strong>)` : ''}
      `;

      btn.classList.remove('btn-primary');
      btn.classList.add('btn-success');
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Connected';
      btn.disabled = false;

      // Start Polling loops for logs and Postgres
      tmStartAgentPolling(agentUrl);
      tmUpdateTabsVisibility();

      // Auto-collapse connection settings card on successful connection
      tmToggleConnectionCard(true);
    })
    .catch(err => {
      console.error(err);
      state.tmAgentStatus = 'disconnected';
      
      document.getElementById('tm-agent-status-dot').style.background = 'var(--danger)';
      const statusText = document.getElementById('tm-agent-status-text');
      statusText.textContent = 'Connection Failed';
      statusText.style.color = 'var(--danger)';
      
      document.getElementById('tm-agent-info-text').innerHTML = `Could not reach Agent at <strong>${escHtml(agentUrl)}</strong>. <br/><span style="color:var(--danger)">Error: ${escHtml(err.message)}</span><br/>Ensure you ran <code>node mendix-observability-bridge.js</code> in your Mendix project directory.`;
      
      btn.classList.remove('btn-success');
      btn.classList.add('btn-primary');
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10"/></svg> Connect Agent';
      btn.disabled = false;
 
      tmStopAgentPolling();
      tmUpdateTabsVisibility();

      // Auto-expand connection settings card to show error details
      tmToggleConnectionCard(false);
    });
}

export function tmStartAgentPolling(agentUrl) {
  tmStopAgentPolling();

  // Poll logs frequently (every 2s) for live feel
  state.tmAgentTimerLogs = setInterval(() => tmFetchAgentLogs(agentUrl), 2000);
  
  // Poll PostgreSQL statistics (every 8s)
  tmFetchAgentPostgres(agentUrl, true); // immediate first load in background
  state.tmAgentTimerPg = setInterval(() => tmFetchAgentPostgres(agentUrl, true), 8000);

  // Poll OTEL Traces and Logs (every 3s)
  state.tmAgentTimerOtel = setInterval(() => tmFetchAgentOtel(agentUrl), 3000);

  // Direct Prometheus Polling for Dashboard Metrics (if agent also exposes prometheus parser,
  // but Mendix app runs Prometheus on port 8090. Let's poll Mendix Prometheus endpoint directly in parallel!)
  // If the user is running Local Agent, we fetch Mendix app metrics directly from localhost:8090/prometheus in background.
  tmChangePollInterval();
}

export function tmStopAgentPolling() {
  if (state.tmAgentTimerLogs) {
    clearInterval(state.tmAgentTimerLogs);
    state.tmAgentTimerLogs = null;
  }
  if (state.tmAgentTimerPg) {
    clearInterval(state.tmAgentTimerPg);
    state.tmAgentTimerPg = null;
  }
  if (state.tmAgentTimerOtel) {
    clearInterval(state.tmAgentTimerOtel);
    state.tmAgentTimerOtel = null;
  }
}

export function tmFetchAgentLogs(agentUrl) {
  fetch(`${agentUrl}/logs?since=${state.tmLastLogTimestamp}`)
    .then(res => res.json())
    .then(data => {
      state.tmLastLogTimestamp = data.timestamp;
      
      if (data.lines && data.lines.length > 0) {
        const textBlock = data.lines.map(l => l.text).join('\n');
        
        // Push directly into Log Viewer tool if available!
        if (typeof logParseContent === 'function') {
          logParseContent(textBlock, 'Live Agent Stream');
          
          // Flash connection dot to indicate logs flowing
          const dot = document.getElementById('tm-agent-status-dot');
          dot.style.transform = 'scale(1.4)';
          dot.style.background = '#3498db';
          setTimeout(() => {
            dot.style.transform = 'scale(1)';
            dot.style.background = 'var(--success)';
          }, 400);
        }
      }
    })
    .catch(err => {
      console.warn('[Bridge] Log fetch failed:', err.message);
    });
}

export function tmFetchAgentOtel(agentUrl) {
  // Fetch Traces
  fetch(`${agentUrl}/otel/traces?since=${state.tmLastOtelTraceTimestamp}`)
    .then(res => res.json())
    .then(data => {
      state.tmLastOtelTraceTimestamp = data.timestamp;
      if (data.items && data.items.length > 0) {
        // Collect spans from payload
        const newSpans = [];
        data.items.forEach(item => {
          if (item.payload && item.payload.resourceSpans) {
            item.payload.resourceSpans.forEach(rs => {
              if (rs.scopeSpans) {
                rs.scopeSpans.forEach(ss => {
                  if (ss.spans) newSpans.push(...ss.spans);
                });
              }
            });
          } else if (Array.isArray(item.payload)) {
             newSpans.push(...item.payload);
          }
        });
        
        if (newSpans.length > 0) {
           state.tmParsedSpans = state.tmParsedSpans.concat(newSpans);
           // keep max 2000 spans
           if (state.tmParsedSpans.length > 2000) state.tmParsedSpans = state.tmParsedSpans.slice(-2000);
           
           if (state.tmActiveTab === 'traces') {
             tmRenderOtelTracesTable();
             if (state.tmSelectedTraceId) {
               tmRenderTraceWaterfall();
             }
           }
           
           const btn = document.getElementById('tm-tab-traces-btn');
           if (btn) btn.innerHTML = `OTLP Traces <span style="background:var(--success);color:#fff;border-radius:10px;padding:2px 6px;font-size:0.7rem;margin-left:4px">${tmGetTraceList().length}</span>`;
        }
      }
    })
    .catch(err => console.warn('[Bridge] OTEL Trace fetch failed:', err.message));

  // Fetch Logs
  fetch(`${agentUrl}/otel/logs?since=${state.tmLastOtelLogTimestamp}`)
    .then(res => res.json())
    .then(data => {
      state.tmLastOtelLogTimestamp = data.timestamp;
      if (data.items && data.items.length > 0) {
        let logLines = '';
        const newLogs = [];
        data.items.forEach(item => {
           if (item.payload && item.payload.resourceLogs) {
             item.payload.resourceLogs.forEach(rl => {
                if (rl.scopeLogs) {
                   rl.scopeLogs.forEach(sl => {
                      if (sl.logRecords) {
                         sl.logRecords.forEach(lr => {
                            const sev = lr.severityText || 'INFO';
                            const msg = lr.body ? (lr.body.stringValue || lr.body.intValue || lr.body.boolValue || '') : '';
                            const timeMs = lr.timeUnixNano ? parseInt(lr.timeUnixNano) / 1000000 : Date.now();
                            const timeStr = new Date(timeMs).toISOString();
                            logLines += `${timeStr} [OTLP_${sev}] ${msg}\n`;
                            
                            newLogs.push({
                              timestamp: timeMs,
                              severity: sev,
                              message: msg,
                              traceId: lr.traceId || '',
                              spanId: lr.spanId || ''
                            });
                         });
                      }
                   });
                }
             });
           }
        });
        
        if (newLogs.length > 0) {
          state.tmParsedLogs = state.tmParsedLogs.concat(newLogs);
          if (state.tmParsedLogs.length > 2000) state.tmParsedLogs = state.tmParsedLogs.slice(-2000);
          
          if (state.tmActiveTab === 'traces') {
            tmRenderOtelLogsTable();
          }
        }
        
        if (logLines && typeof logParseContent === 'function') {
           logParseContent(logLines, 'OTLP Live Stream');
        }
      }
    })
    .catch(err => console.warn('[Bridge] OTEL Log fetch failed:', err.message));
}

export function tmFetchAgentPostgres(agentUrl, isAutoPoll = false) {
  const dbConfig = {
    host: document.getElementById('tm-pg-host').value.trim(),
    port: parseInt(document.getElementById('tm-pg-port').value.trim()),
    database: document.getElementById('tm-pg-dbname').value.trim(),
    user: document.getElementById('tm-pg-user').value.trim(),
    password: document.getElementById('tm-pg-pass').value
  };

  const statusIndicator = document.getElementById('tm-pg-status-indicator');
  const connBtn = document.getElementById('tm-pg-btn-connect');
  
  if (!isAutoPoll) {
    if (connBtn) {
      connBtn.disabled = true;
      connBtn.innerHTML = '<span style="display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 1s linear infinite;margin-right:5px"></span> Connecting...';
    }
    if (statusIndicator) {
      statusIndicator.innerHTML = '<span style="color:var(--text-secondary)">Connecting...</span>';
    }
  }

  fetch(`${agentUrl}/postgres`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dbConfig)
  })
    .then(res => res.json())
    .then(data => {
      if (!isAutoPoll) {
        if (connBtn) {
          connBtn.disabled = false;
          connBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M12 2v10M18.36 6.64a9 9 0 1 1-12.73 0"/></svg> Connect &amp; Refresh';
        }
      }
      if (data.error) {
         const sessionsTbody = document.getElementById('tm-pg-sessions-tbody');
         if (sessionsTbody) {
           sessionsTbody.innerHTML = `<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--danger)">Database Connection Error: ${data.message}</td></tr>`;
         }
         if (statusIndicator) {
           statusIndicator.innerHTML = '<span style="color:var(--danger);font-weight:600">● Connection Error</span>';
         }
         if (!isAutoPoll) {
           tmTogglePgConfigCard(false); // auto-expand on manual error
         }
         return;
      }
      if (statusIndicator) {
        statusIndicator.innerHTML = '<span style="color:var(--success);font-weight:600">● Connected</span>';
      }
      tmRenderPostgresStats(data);
      if (!isAutoPoll) {
        tmTogglePgConfigCard(true); // auto-collapse on manual success
      }
    })
    .catch(err => {
      if (!isAutoPoll) {
        if (connBtn) {
          connBtn.disabled = false;
          connBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M12 2v10M18.36 6.64a9 9 0 1 1-12.73 0"/></svg> Connect &amp; Refresh';
        }
      }
      if (statusIndicator) {
        statusIndicator.innerHTML = '<span style="color:var(--danger);font-weight:600">● Connection Error</span>';
      }
      const sessionsTbody = document.getElementById('tm-pg-sessions-tbody');
      if (sessionsTbody) {
        sessionsTbody.innerHTML = `<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--danger)">Connection Error: ${err.message || err}</td></tr>`;
      }
      if (!isAutoPoll) {
        tmTogglePgConfigCard(false); // auto-expand on manual error
      }
    });
}

export function tmRefreshPostgres() {
  if (state.tmIsMocking) {
    // Generate new mock PostgreSQL stats
    tmGenerateMockPgStats();
    
    // Auto-collapse PostgreSQL settings card on success
    tmTogglePgConfigCard(true);
    return;
  }
  
  if (state.tmAgentStatus !== 'connected') {
    return alert('Please connect the Local Observability Agent first.');
  }
  const agentUrl = document.getElementById('tm-agent-url').value.trim();
  tmFetchAgentPostgres(agentUrl, false);
}

export function tmShowQueryModal(e, query) {
  e.preventDefault();
  let modal = document.getElementById('tm-query-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'tm-query-modal';
    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.width = '100vw';
    modal.style.height = '100vh';
    modal.style.backgroundColor = 'rgba(0,0,0,0.7)';
    modal.style.zIndex = '9999';
    modal.style.display = 'flex';
    modal.style.justifyContent = 'center';
    modal.style.alignItems = 'center';

    const content = document.createElement('div');
    content.style.backgroundColor = 'var(--bg)';
    content.style.padding = '20px';
    content.style.borderRadius = '8px';
    content.style.width = '80%';
    content.style.maxWidth = '800px';
    content.style.maxHeight = '80vh';
    content.style.display = 'flex';
    content.style.flexDirection = 'column';
    content.style.boxShadow = '0 10px 25px rgba(0,0,0,0.5)';
    content.style.border = '1px solid var(--border)';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.marginBottom = '15px';
    header.innerHTML = '<h3 style="margin:0;color:var(--text-primary)">SQL Query Preview</h3><button class="btn btn-secondary btn-sm" id="tm-query-modal-close">Close</button>';

    const body = document.createElement('pre');
    body.id = 'tm-query-modal-body';
    body.style.backgroundColor = 'var(--bg-elevated)';
    body.style.padding = '15px';
    body.style.borderRadius = '4px';
    body.style.overflow = 'auto';
    body.style.whiteSpace = 'pre-wrap';
    body.style.wordBreak = 'break-all';
    body.style.fontFamily = 'var(--font-mono)';
    body.style.fontSize = '0.8rem';
    body.style.color = 'var(--text-primary)';
    body.style.border = '1px solid var(--border)';
    body.style.flexGrow = '1';

    content.appendChild(header);
    content.appendChild(body);
    modal.appendChild(content);

    document.body.appendChild(modal);

    document.getElementById('tm-query-modal-close').addEventListener('click', () => {
      modal.style.display = 'none';
    });
    modal.addEventListener('click', (ev) => {
      if (ev.target === modal) modal.style.display = 'none';
    });
  }

  document.getElementById('tm-query-modal-body').textContent = query || 'No query available.';
  modal.style.display = 'flex';
}

export function tmRenderPostgresStats(data) {
  const statusIndicator = document.getElementById('tm-pg-status-indicator');
  if (statusIndicator) {
    statusIndicator.innerHTML = '<span style="color:var(--success);font-weight:600">● Connected</span>';
  }

  const stats = data.stats || {};
  
  // Size formatting
  const sizeBytes = stats.size_bytes || 0;
  const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);

  // 1. Update Cards
  const activeC = stats.active_conns || 0;
  const maxC = stats.max_conns || 100;
  const idleC = stats.idle_conns || 0;
  
  document.getElementById('tm-pg-card-conns').textContent = `${activeC} / ${maxC}`;
  document.getElementById('tm-pg-card-idle').textContent = `${idleC} idle sessions`;
  document.getElementById('tm-pg-card-size').textContent = `${sizeMB} MB`;
  document.getElementById('tm-pg-card-dbname').textContent = `DB: ${data.dbname || 'mendix'}`;
  document.getElementById('tm-pg-card-hitrate').textContent = `${(stats.hit_ratio || 0.0).toFixed(1)} %`;
  
  const locksCount = stats.lock_waiters || 0;
  const locksCard = document.getElementById('tm-pg-card-locks');
  locksCard.textContent = `${locksCount} lock${locksCount === 1 ? '' : 's'}`;
  document.getElementById('tm-pg-card-blocked').textContent = `${locksCount} blocked trans.`;
  
  // Highlight locks in red if deadlocks exist
  const locksCardParent = locksCard.closest('.stat-item');
  if (locksCount > 0) {
    locksCardParent.style.borderLeftColor = 'var(--danger)';
    locksCardParent.style.background = 'rgba(231, 76, 60, 0.08)';
  } else {
    locksCardParent.style.borderLeftColor = 'var(--danger)';
    locksCardParent.style.background = '';
  }

  // 1.5 Update Global Stats
  const globalStats = data.global_stats || {};
  document.getElementById('tm-pg-global-alloc').textContent = (globalStats.buffers_alloc || 0).toLocaleString();
  document.getElementById('tm-pg-global-clean').textContent = (globalStats.buffers_clean || 0).toLocaleString();
  document.getElementById('tm-pg-global-maxclean').textContent = (globalStats.maxwritten_clean || 0).toLocaleString();
  document.getElementById('tm-pg-global-backend').textContent = (globalStats.buffers_backend || 0).toLocaleString();

  // 2. Active Sessions Table
  const sessionsTbody = document.getElementById('tm-pg-sessions-tbody');
  sessionsTbody.innerHTML = '';
  
  const sessions = data.sessions || [];
  if (sessions.length === 0) {
    sessionsTbody.innerHTML = `<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted)">No active query sessions.</td></tr>`;
  } else {
    sessions.forEach(s => {
      let stateColor = 'var(--text-muted)';
      if (s.state === 'active') stateColor = 'var(--success)';
      else if (s.state.includes('transaction')) stateColor = 'var(--warning)';

      const row = document.createElement('tr');
      row.style.borderBottom = '1px solid var(--border)';
      row.innerHTML = `
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem">${s.pid}</td>
        <td style="padding:8px 12px;font-weight:600;font-size:0.7rem;color:${stateColor}">${escHtml(s.state)}</td>
        <td style="padding:8px 12px;font-size:0.72rem">${s.duration_ms ? s.duration_ms + ' ms' : '< 1 ms'}</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.7rem">${escHtml(s.client || 'local')}</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(s.query)}">
          <a href="#" onclick="tmShowQueryModal(event, this.parentElement.getAttribute('title'))" style="color:var(--accent);text-decoration:none;margin-right:8px;display:inline-flex;align-items:center" title="Preview SQL Query"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:middle;margin-right:4px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></a>${escHtml(s.query)}
        </td>
      `;
      sessionsTbody.appendChild(row);
    });
  }

  // 3. Locks Table
  const locksTbody = document.getElementById('tm-pg-locks-tbody');
  locksTbody.innerHTML = '';

  const locks = data.locks || [];
  if (locks.length === 0) {
    locksTbody.innerHTML = `<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted)">No transaction lock conflicts identified.</td></tr>`;
  } else {
    locks.forEach(l => {
      const row = document.createElement('tr');
      row.style.borderBottom = '1px solid var(--border)';
      row.style.background = 'rgba(231, 76, 60, 0.03)';
      row.innerHTML = `
        <td style="padding:8px 12px;font-family:var(--font-mono);font-weight:600;color:var(--danger)">${l.blocked_pid}</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);font-weight:600;color:var(--success)">${l.blocking_pid}</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(l.blocked_statement)}">
          <a href="#" onclick="tmShowQueryModal(event, this.parentElement.getAttribute('title'))" style="color:var(--accent);text-decoration:none;margin-right:8px;display:inline-flex;align-items:center" title="Preview SQL Query"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:middle;margin-right:4px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></a>${escHtml(l.blocked_statement)}
        </td>
        <td style="padding:8px 12px;font-family:var(--font-mono);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(l.blocking_statement)}">
          <a href="#" onclick="tmShowQueryModal(event, this.parentElement.getAttribute('title'))" style="color:var(--accent);text-decoration:none;margin-right:8px;display:inline-flex;align-items:center" title="Preview SQL Query"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:middle;margin-right:4px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></a>${escHtml(l.blocking_statement)}
        </td>
        <td style="padding:8px 12px;font-weight:600;color:var(--danger)">${l.duration_ms} ms</td>
      `;
      locksTbody.appendChild(row);
    });
  }

  // 4. Long-Running Transactions Table
  const longTbody = document.getElementById('tm-pg-long-running-tbody');
  longTbody.innerHTML = '';
  const longRunning = sessions.filter(s => s.state === 'idle in transaction' && s.duration_ms > 1000);
  if (longRunning.length === 0) {
    longTbody.innerHTML = `<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted)">No long-running idle transactions.</td></tr>`;
  } else {
    longRunning.forEach(s => {
      const row = document.createElement('tr');
      row.style.borderBottom = '1px solid var(--border)';
      row.style.background = 'rgba(243, 156, 18, 0.05)';
      row.innerHTML = `
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem">${s.pid}</td>
        <td style="padding:8px 12px;font-weight:600;font-size:0.7rem;color:var(--warning)">${escHtml(s.state)}</td>
        <td style="padding:8px 12px;font-size:0.72rem;color:var(--warning)">${s.duration_ms} ms</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.7rem">${escHtml(s.client || 'local')}</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(s.query)}">
          <a href="#" onclick="tmShowQueryModal(event, this.parentElement.getAttribute('title'))" style="color:var(--accent);text-decoration:none;margin-right:8px;display:inline-flex;align-items:center" title="Preview SQL Query"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:middle;margin-right:4px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></a>${escHtml(s.query)}
        </td>
      `;
      longTbody.appendChild(row);
    });
  }

  // 5. Slow Queries Table
  const slowQueriesTbody = document.getElementById('tm-pg-slow-queries-tbody');
  slowQueriesTbody.innerHTML = '';
  const slowError = document.getElementById('tm-pg-slow-queries-error');
  const slowTable = document.getElementById('tm-pg-slow-queries-table');
  
  if (data.slow_queries_error) {
    slowError.style.display = 'block';
    if (data.slow_queries_error.includes('pg_stat_statements')) {
      slowError.innerHTML = `${escHtml(data.slow_queries_error)}<br><br><span style="font-size:0.75rem;color:var(--text-muted)">Hint: To enable slow queries tracking, connect to your database and run <code>CREATE EXTENSION pg_stat_statements;</code>. Also ensure it is added to <code>shared_preload_libraries</code> in <code>postgresql.conf</code>.</span>`;
    } else {
      slowError.textContent = data.slow_queries_error;
    }
    slowTable.style.display = 'none';
  } else {
    slowError.style.display = 'none';
    slowTable.style.display = 'table';
    const slowQueries = data.slow_queries || [];
    if (slowQueries.length === 0) {
      slowQueriesTbody.innerHTML = `<tr><td colspan="4" style="padding:16px;text-align:center;color:var(--text-muted)">No slow queries recorded.</td></tr>`;
    } else {
      slowQueries.forEach(sq => {
        const row = document.createElement('tr');
        row.style.borderBottom = '1px solid var(--border)';
        row.innerHTML = `
          <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(sq.query)}">
            <a href="#" onclick="tmShowQueryModal(event, this.parentElement.getAttribute('title'))" style="color:var(--accent);text-decoration:none;margin-right:8px;display:inline-flex;align-items:center" title="Preview SQL Query"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:middle;margin-right:4px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></a>${escHtml(sq.query)}
          </td>
          <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem">${sq.calls}</td>
          <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem">${sq.mean_time_ms}</td>
          <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem">${sq.total_time_ms}</td>
        `;
        slowQueriesTbody.appendChild(row);
      });
    }
  }

  // 6. Table Health
  const tableHealthTbody = document.getElementById('tm-pg-table-health-tbody');
  tableHealthTbody.innerHTML = '';
  const tableHealth = data.table_health || [];
  if (tableHealth.length === 0) {
    tableHealthTbody.innerHTML = `<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted)">No table health data available.</td></tr>`;
  } else {
    tableHealth.forEach(th => {
      const bloatColor = th.bloat_ratio > 20 ? 'var(--warning)' : 'inherit';
      const hitColor = th.hit_ratio < 90 ? 'var(--warning)' : 'var(--success)';
      const row = document.createElement('tr');
      row.style.borderBottom = '1px solid var(--border)';
      row.innerHTML = `
        <td style="padding:8px 12px;font-weight:600;font-size:0.75rem">${escHtml(th.table_name)}</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem">${th.seq_scan || 0}</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem">${th.idx_scan || 0}</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem;color:${bloatColor}">${th.dead_tuples || 0} (${th.bloat_ratio || 0}%)</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.72rem;color:${hitColor}">${th.hit_ratio || 0}%</td>
      `;
      tableHealthTbody.appendChild(row);
    });
  }
}

