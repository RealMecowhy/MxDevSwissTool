import { state } from './state.js';

export function tmLoadMockTraceJSON() {
  const mockTrace = [
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "00f067aa0ba902b7",
      "name": "HTTP POST /rest/Orders/Submit",
      "kind": "SPAN_KIND_SERVER",
      "startTimeUnixNano": 1688582400000000000,
      "endTimeUnixNano": 1688582400780000000,
      "attributes": {
        "http.method": "POST",
        "http.target": "/rest/Orders/Submit",
        "http.status_code": 200,
        "mendix.environment": "production"
      }
    },
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "01f067aa0ba902b8",
      "parentSpanId": "00f067aa0ba902b7",
      "name": "Microflow.SubmitOrder",
      "kind": "SPAN_KIND_INTERNAL",
      "startTimeUnixNano": 1688582400020000000,
      "endTimeUnixNano": 1688582400760000000,
      "attributes": {
        "mendix.microflow.name": "Sales.SubmitOrder",
        "mendix.user.name": "mikolaj.d"
      }
    },
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "02f067aa0ba902b9",
      "parentSpanId": "01f067aa0ba902b8",
      "name": "Database.RetrieveOrderTemplate",
      "kind": "SPAN_KIND_CLIENT",
      "startTimeUnixNano": 1688582400050000000,
      "endTimeUnixNano": 1688582400120000000,
      "attributes": {
        "db.system": "postgresql",
        "db.statement": "SELECT * FROM sales$order_template WHERE id = ?",
        "mendix.activity.type": "Retrieve"
      }
    },
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "03f067aa0ba902ba",
      "parentSpanId": "01f067aa0ba902b8",
      "name": "JavaAction.CalculateDiscounts",
      "kind": "SPAN_KIND_INTERNAL",
      "startTimeUnixNano": 1688582400150000000,
      "endTimeUnixNano": 1688582400320000000,
      "attributes": {
        "mendix.java_action.name": "Sales.CalculateDiscounts",
        "sales.discount.type": "VolumeBased",
        "sales.items.count": 24
      }
    },
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "04f067aa0ba902bb",
      "parentSpanId": "03f067aa0ba902ba",
      "name": "Database.QueryActiveDiscountRules",
      "kind": "SPAN_KIND_CLIENT",
      "startTimeUnixNano": 1688582400160000000,
      "endTimeUnixNano": 1688582400280000000,
      "attributes": {
        "db.system": "postgresql",
        "db.statement": "SELECT * FROM sales$discount_rule WHERE active = true",
        "mendix.activity.type": "Retrieve"
      }
    },
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "05f067aa0ba902bc",
      "parentSpanId": "01f067aa0ba902b8",
      "name": "RestServiceCall.ValidatePaymentStatus",
      "kind": "SPAN_KIND_CLIENT",
      "startTimeUnixNano": 1688582400350000000,
      "endTimeUnixNano": 1688582400680000000,
      "attributes": {
        "http.url": "https://api.paymentgateway.com/v1/payments/chk_9281a",
        "http.method": "GET",
        "http.status_code": 200,
        "mendix.activity.type": "CallRestService"
      }
    },
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "06f067aa0ba902bd",
      "parentSpanId": "01f067aa0ba902b8",
      "name": "Database.CommitOrder",
      "kind": "SPAN_KIND_CLIENT",
      "startTimeUnixNano": 1688582400700000000,
      "endTimeUnixNano": 1688582400750000000,
      "attributes": {
        "db.system": "postgresql",
        "db.statement": "INSERT INTO sales$order (id, total, status) VALUES (?, ?, ?)",
        "mendix.activity.type": "Commit"
      }
    }
  ];

  document.getElementById('tm-trace-input').value = JSON.stringify(mockTrace, null, 2);
}

export function tmClearTraces() {
  document.getElementById('tm-trace-input').value = '';
  document.getElementById('tm-trace-results-card').style.display = 'none';
  state.tmParsedSpans = [];
  state.tmParsedLogs = [];
  state.tmSelectedTraceId = null;
  tmRenderOtelTracesTable();
  tmRenderOtelLogsTable();
}

export function tmParseTraces() {
  const jsonStr = document.getElementById('tm-trace-input').value.trim();
  if (!jsonStr) return alert('Please enter or load a Trace JSON first.');

  try {
    const rawData = JSON.parse(jsonStr);
    
    let spans = [];
    if (Array.isArray(rawData)) {
      spans = rawData;
    } else if (rawData.resourceSpans) {
      for (let resSpan of rawData.resourceSpans) {
        if (!resSpan.scopeSpans) continue;
        for (let scopeSpan of resSpan.scopeSpans) {
          if (!scopeSpan.spans) continue;
          for (let span of scopeSpan.spans) {
            spans.push(span);
          }
        }
      }
    } else if (rawData.spans) {
      spans = rawData.spans;
    } else {
      throw new Error('Trace structure not recognized. Input must be an array of spans or a standard OTLP payload.');
    }

    if (spans.length === 0) {
      throw new Error('No spans found in payload.');
    }

    state.tmParsedSpans = spans;
    if (spans[0] && spans[0].traceId) {
      state.tmSelectedTraceId = spans[0].traceId;
      tmSetOtelSubtab('traces');
      tmSelectTrace(state.tmSelectedTraceId);
    } else {
      tmRenderTraceWaterfall();
    }

  } catch(e) {
    alert(`Failed to parse Trace JSON: ${e.message}`);
  }
}

export function tmRenderTraceWaterfall() {
  let spans = state.tmParsedSpans;
  if (state.tmSelectedTraceId) {
    spans = state.tmParsedSpans.filter(s => s.traceId === state.tmSelectedTraceId);
  }
  
  if (spans.length === 0) {
    const container = document.getElementById('tm-trace-waterfall-container');
    if (container) container.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;padding:20px;text-align:center">No spans found for this trace.</div>';
    return;
  }
  
  let minStart = Infinity;
  let maxEnd = -Infinity;
  
  const resolveTime = (tVal) => {
    if (typeof tVal === 'number') {
      if (tVal > 1e15) return tVal / 1e6;
      if (tVal > 1e12) return tVal / 1e3;
      return tVal;
    }
    if (typeof tVal === 'string') {
      if (/^\d+$/.test(tVal)) {
        const num = parseFloat(tVal);
        if (num > 1e15) return num / 1e6;
        if (num > 1e12) return num / 1e3;
        return num;
      }
      return new Date(tVal).getTime();
    }
    return 0;
  };

  spans.forEach(s => {
    s._startTimeMs = resolveTime(s.startTimeUnixNano || s.startTime || s.startTimeMs);
    s._endTimeMs = resolveTime(s.endTimeUnixNano || s.endTime || s.endTimeMs);
    s._durationMs = s._endTimeMs - s._startTimeMs;

    if (s._startTimeMs < minStart) minStart = s._startTimeMs;
    if (s._endTimeMs > maxEnd) maxEnd = s._endTimeMs;
  });

  const totalDuration = maxEnd - minStart;
  
  const spanMap = {};
  spans.forEach(s => { spanMap[s.spanId] = { span: s, children: [] }; });
  
  const roots = [];
  spans.forEach(s => {
    const parentId = s.parentSpanId || s.parentId;
    if (parentId && spanMap[parentId]) {
      spanMap[parentId].children.push(spanMap[s.spanId]);
    } else {
      roots.push(spanMap[s.spanId]);
    }
  });

  const sortTree = (node) => {
    node.children.sort((a, b) => a.span._startTimeMs - b.span._startTimeMs);
    node.children.forEach(sortTree);
  };
  roots.sort((a, b) => a.span._startTimeMs - b.span._startTimeMs);
  roots.forEach(sortTree);

  const rows = [];
  const traverse = (node, depth) => {
    rows.push({ node: node.span, depth: depth });
    node.children.forEach(child => traverse(child, depth + 1));
  };
  roots.forEach(r => traverse(r, 0));

  const waterfallContainer = document.getElementById('tm-trace-waterfall-container');
  waterfallContainer.innerHTML = '';

  rows.forEach((row, idx) => {
    const s = row.node;
    const depth = row.depth;
    
    const leftPct = totalDuration > 0 ? ((s._startTimeMs - minStart) / totalDuration) * 100 : 0;
    const widthPct = totalDuration > 0 ? (s._durationMs / totalDuration) * 100 : 100;
    
    let color = '#3498db';
    if (s.name.startsWith('Database.')) color = '#ff9f43';
    else if (s.name.startsWith('Microflow.')) color = '#2ecc71';
    else if (s.name.startsWith('JavaAction.')) color = '#9b59b6';
    else if (s.name.startsWith('RestServiceCall.') || s.name.startsWith('Http.')) color = '#f1c40f';

    const rowEl = document.createElement('div');
    rowEl.style.display = 'flex';
    rowEl.style.flexDirection = 'column';
    rowEl.style.padding = '8px 4px';
    rowEl.style.borderBottom = '1px solid var(--border)';
    rowEl.style.cursor = 'pointer';
    rowEl.className = 'tm-waterfall-row';
    rowEl.onclick = () => tmSelectSpan(s);
    
    rowEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.75rem;margin-bottom:4px;gap:8px">
        <div style="padding-left:${depth * 14}px;display:flex;align-items:center;gap:6px;font-weight:600;max-width:250px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color}"></span>
          ${escHtml(s.name)}
        </div>
        <div style="color:var(--text-secondary);font-size:0.7rem">${s._durationMs.toFixed(1)} ms</div>
      </div>
      <div style="height:8px;background:rgba(255,255,255,0.03);border-radius:4px;position:relative;width:100%">
        <div style="position:absolute;left:${leftPct}%;width:${Math.max(1, widthPct)}%;height:100%;background:${color};border-radius:4px"></div>
      </div>
    `;
    waterfallContainer.appendChild(rowEl);
  });

  document.getElementById('tm-trace-meta').textContent = `Total Spans: ${spans.length} · Duration: ${totalDuration.toFixed(1)}ms`;
  document.getElementById('tm-trace-results-card').style.display = 'block';

  if (rows.length > 0) {
    tmSelectSpan(rows[0].node);
  }
}

export function tmSelectSpan(span) {
  document.querySelectorAll('.tm-waterfall-row').forEach(row => {
    row.style.background = '';
  });
  
  const container = document.getElementById('tm-span-details-container');
  
  const attrs = span.attributes || {};
  let attrRows = '';
  for (let key in attrs) {
    let val = attrs[key];
    if (typeof val === 'object') val = JSON.stringify(val);
    attrRows += `
      <tr>
        <td style="padding:6px;font-family:var(--font-mono);font-size:0.72rem;color:var(--text-secondary);border-bottom:1px solid var(--border);width:40%;word-break:break-all">${escHtml(key)}</td>
        <td style="padding:6px;font-family:var(--font-mono);font-size:0.72rem;color:var(--text);border-bottom:1px solid var(--border);word-break:break-all">${escHtml(val)}</td>
      </tr>
    `;
  }

  if (!attrRows) {
    attrRows = `<tr><td colspan="2" style="padding:10px;text-align:center;color:var(--text-muted)">No attributes associated with this span.</td></tr>`;
  }

  const dbStatement = attrs['db.statement'] || attrs['sql'] || null;
  let sqlSection = '';
  if (dbStatement) {
    sqlSection = `
      <div style="margin-top:var(--sp-3);background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--r-md);padding:var(--sp-3)">
        <span style="font-size:0.75rem;font-weight:600;color:var(--warning);display:block;margin-bottom:var(--sp-1)">Associated SQL / DB Statement</span>
        <pre style="margin:0;font-family:var(--font-mono);font-size:0.72rem;white-space:pre-wrap;color:var(--text);word-break:break-all">${escHtml(dbStatement)}</pre>
      </div>
    `;
  }

  container.innerHTML = `
    <h4 style="margin-top:0;margin-bottom:var(--sp-1);color:var(--accent);font-size:0.9rem">${escHtml(span.name)}</h4>
    <div style="display:grid;grid-template-columns:1fr;gap:4px;font-size:0.75rem;color:var(--text-secondary);margin-bottom:var(--sp-3)">
      <div><strong>Span ID:</strong> <code>${escHtml(span.spanId)}</code></div>
      <div><strong>Parent ID:</strong> <code>${escHtml(span.parentSpanId || 'None (Root)')}</code></div>
      <div><strong>Duration:</strong> ${span._durationMs.toFixed(2)} ms</div>
    </div>
    
    <span style="font-size:0.75rem;font-weight:600;color:var(--info);display:block;margin-bottom:4px">Span Attributes</span>
    <table style="width:100%;border-collapse:collapse;text-align:left;font-size:0.75rem">
      <thead>
        <tr style="border-bottom:1px solid var(--border)">
          <th style="padding:6px;color:var(--text-muted)">Key</th>
          <th style="padding:6px;color:var(--text-muted)">Value</th>
        </tr>
      </thead>
      <tbody>
        ${attrRows}
      </tbody>
    </table>

    ${sqlSection}
  `;
}

export function tmSetOtelSubtab(subtab) {
  state.tmActiveOtelSubtab = subtab;
  
  const subtabs = ['traces', 'logs', 'import'];
  subtabs.forEach(t => {
    const btn = document.getElementById(`tm-otel-subtab-${t}`);
    const content = document.getElementById(`tm-otel-content-${t}`);
    if (btn) {
      if (t === subtab) {
        btn.style.background = 'var(--accent)';
        btn.style.color = '#fff';
      } else {
        btn.style.background = 'transparent';
        btn.style.color = 'var(--text-secondary)';
      }
    }
    if (content) {
      content.style.display = (t === subtab) ? 'flex' : 'none';
    }
  });
  
  if (subtab === 'traces') {
    tmRenderOtelTracesTable();
  } else if (subtab === 'logs') {
    tmRenderOtelLogsTable();
  }
}

export function tmGetTraceList() {
  const traceMap = {};
  
  const resolveTime = (tVal) => {
    if (typeof tVal === 'number') {
      if (tVal > 1e15) return tVal / 1e6;
      if (tVal > 1e12) return tVal / 1e3;
      return tVal;
    }
    if (typeof tVal === 'string') {
      if (/^\d+$/.test(tVal)) {
        const num = parseFloat(tVal);
        if (num > 1e15) return num / 1e6;
        if (num > 1e12) return num / 1e3;
        return num;
      }
      return new Date(tVal).getTime();
    }
    return 0;
  };

  state.tmParsedSpans.forEach(s => {
    const tId = s.traceId;
    if (!tId) return;
    
    const start = resolveTime(s.startTimeUnixNano || s.startTime || s.startTimeMs);
    const end = resolveTime(s.endTimeUnixNano || s.endTime || s.endTimeMs);
    
    if (!traceMap[tId]) {
      traceMap[tId] = {
        traceId: tId,
        spans: [],
        minStart: start,
        maxEnd: end,
        rootSpan: s
      };
    }
    
    traceMap[tId].spans.push(s);
    if (start < traceMap[tId].minStart) {
      traceMap[tId].minStart = start;
    }
    if (end > traceMap[tId].maxEnd) {
      traceMap[tId].maxEnd = end;
    }
    
    const pId = s.parentSpanId || s.parentId;
    if (!pId) {
      traceMap[tId].rootSpan = s;
    } else if (traceMap[tId].rootSpan === s) {
      // already root
    } else {
      const rootHasParent = traceMap[tId].rootSpan.parentSpanId || traceMap[tId].rootSpan.parentId;
      if (rootHasParent && !pId) {
        traceMap[tId].rootSpan = s;
      }
    }
  });
  
  return Object.values(traceMap).map(t => {
    return {
      traceId: t.traceId,
      name: t.rootSpan ? t.rootSpan.name : 'Unknown Trace',
      startTime: t.minStart,
      duration: t.maxEnd - t.minStart,
      spansCount: t.spans.length,
      spans: t.spans
    };
  }).sort((a, b) => b.startTime - a.startTime);
}

export function tmRenderOtelTracesTable() {
  const body = document.getElementById('tm-otel-traces-body');
  if (!body) return;
  
  const traceList = tmGetTraceList();
  if (traceList.length === 0) {
    body.innerHTML = `
      <tr>
        <td colspan="5" style="padding:20px;text-align:center;color:var(--text-muted)">No traces received yet. Generate some traffic in your Mendix app!</td>
      </tr>
    `;
    return;
  }
  
  let html = '';
  traceList.forEach(t => {
    const dateStr = new Date(t.startTime).toLocaleTimeString();
    const isSelected = (t.traceId === state.tmSelectedTraceId);
    const rowBg = isSelected ? 'rgba(52, 152, 219, 0.15)' : 'transparent';
    const borderStyle = isSelected ? 'border-left: 3px solid var(--accent)' : 'border-left: 3px solid transparent';
    
    html += `
      <tr style="background:${rowBg};cursor:pointer;border-bottom:1px solid var(--border-subtle);transition:background 0.2s" onclick="tmSelectTrace('${t.traceId}')" class="tm-trace-row">
        <td style="padding:8px 12px;${borderStyle}">${dateStr}</td>
        <td style="padding:8px 12px;font-weight:600;color:var(--text-primary)">${escHtml(t.name)}</td>
        <td style="padding:8px 12px;color:var(--text-muted)">${t.spansCount}</td>
        <td style="padding:8px 12px;color:var(--accent);font-weight:600">${t.duration.toFixed(1)} ms</td>
        <td style="padding:8px 12px;font-family:var(--font-mono);font-size:0.7rem;color:var(--text-secondary)">${t.traceId}</td>
      </tr>
    `;
  });
  body.innerHTML = html;
}

export function tmRenderOtelLogsTable() {
  const body = document.getElementById('tm-otel-logs-body');
  if (!body) return;
  
  if (state.tmParsedLogs.length === 0) {
    body.innerHTML = `
      <tr>
        <td colspan="4" style="padding:20px;text-align:center;color:var(--text-muted)">No structured logs received yet.</td>
      </tr>
    `;
    return;
  }
  
  let html = '';
  const sortedLogs = [...state.tmParsedLogs].reverse();
  
  sortedLogs.forEach(l => {
    const dateStr = new Date(l.timestamp).toLocaleTimeString();
    let levelColor = 'var(--text-secondary)';
    if (l.severity === 'ERROR' || l.severity === 'CRITICAL') levelColor = 'var(--danger)';
    else if (l.severity === 'WARN' || l.severity === 'WARNING') levelColor = 'var(--warning)';
    else if (l.severity === 'INFO') levelColor = 'var(--info)';
    else if (l.severity === 'DEBUG') levelColor = 'var(--success)';
    
    const traceBadge = l.traceId 
      ? `<span onclick="event.stopPropagation(); tmSelectTrace('${l.traceId}'); tmSetOtelSubtab('traces')" style="background:rgba(52,152,219,0.2);color:var(--info);padding:2px 6px;border-radius:4px;font-family:var(--font-mono);font-size:0.72rem;cursor:pointer;border:1px solid rgba(52,152,219,0.3)">${l.traceId.substring(0, 8)}...</span>` 
      : '—';
      
    html += `
      <tr style="border-bottom:1px solid var(--border-subtle);font-size:0.75rem">
        <td style="padding:8px 12px;color:var(--text-muted)">${dateStr}</td>
        <td style="padding:8px 12px;font-weight:600;color:${levelColor}">${l.severity}</td>
        <td style="padding:8px 12px;color:var(--text-primary);white-space:pre-wrap">${escHtml(l.message)}</td>
        <td style="padding:8px 12px">${traceBadge}</td>
      </tr>
    `;
  });
  body.innerHTML = html;
}

export function tmSelectTrace(traceId) {
  state.tmSelectedTraceId = traceId;
  
  tmRenderOtelTracesTable();
  
  const resultsCard = document.getElementById('tm-trace-results-card');
  if (resultsCard) {
    resultsCard.style.display = 'block';
  }
  
  tmRenderTraceWaterfall();
  
  const traceList = tmGetTraceList();
  const t = traceList.find(x => x.traceId === traceId);
  if (t) {
    document.getElementById('tm-trace-title').textContent = t.name;
    document.getElementById('tm-trace-meta').textContent = `Total Spans: ${t.spansCount} · Duration: ${t.duration.toFixed(1)}ms · Trace ID: ${t.traceId}`;
  }
  
  resultsCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export function tmCloseSelectedTrace() {
  state.tmSelectedTraceId = null;
  const resultsCard = document.getElementById('tm-trace-results-card');
  if (resultsCard) {
    resultsCard.style.display = 'none';
  }
  tmRenderOtelTracesTable();
}

