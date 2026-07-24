// MEMORY INSPECTOR (Module K)

// ── GC log parsing (12.7) ───────────────────────────────────────────────────
// The UI already claimed to accept "GC Logs" (placeholder/label text), but no
// code path ever recognized one — every paste fell through to the jmap-histo
// regex below and landed on "No valid data found". This adds the two formats
// the audit named, with format auto-detection, gated ahead of the histogram
// parser so histogram input behaves exactly as before.
function miDetectGcFormat(text) {
  if (/GC\(\d+\)\s+Pause\s+(Young|Full|Mixed)/.test(text)) return 'unified'; // -Xlog:gc, JDK 9+
  if (/\[(Full )?GC\b[\s\S]*?\(\s*[\d.]+\)\s*,?\s*[\d.]+\s*secs\]/.test(text) ||
      /\[(Full )?GC\b.*(PSYoungGen|ParOldGen|ParNew|DefNew|Tenured|G1 (Young|Evacuation))/.test(text)) return 'verbose'; // -verbose:gc, JDK 8
  return null;
}

function miUnitToKb(n, unit) {
  const u = String(unit).toUpperCase();
  if (u === 'G') return n * 1024 * 1024;
  if (u === 'M') return n * 1024;
  return n;
}

function miParseUnifiedGcLine(line) {
  // The gap between "Pause Young/Full/Mixed" and the size figures is free-form
  // annotation text — e.g. G1's own "(G1 Evacuation Pause)" contains a digit,
  // so this can't be [^\d]*? (which would refuse to skip over that digit and
  // fail the whole line). `.*?` is lazy, so it still finds the leftmost real
  // size triple rather than over-matching into a later GC(N) line.
  const m = line.match(/GC\(\d+\)\s+Pause\s+(Young|Full|Mixed).*?(\d+)([KMGkmg])->(\d+)([KMGkmg])\((\d+)([KMGkmg])\)\s+([\d.]+)ms/);
  if (!m) return null;
  return {
    type: m[1],
    beforeKb: miUnitToKb(parseInt(m[2], 10), m[3]),
    afterKb: miUnitToKb(parseInt(m[4], 10), m[5]),
    totalKb: miUnitToKb(parseInt(m[6], 10), m[7]),
    durationMs: parseFloat(m[8])
  };
}

// Nested regions (`[PSYoungGen: a->b(c)]`, `[ParOldGen: ...]`) appear before
// the overall heap total on the same line — the LAST `before->after(total)`
// triple on the line is always the overall figure, never a region's own.
function miParseVerboseGcLine(line) {
  if (!/\[(Full )?GC\b/.test(line)) return null;
  const isFull = /\[Full GC\b/.test(line);
  const sizeMatches = Array.from(line.matchAll(/(\d+)K->(\d+)K\((\d+)K\)/g));
  const durMatch = line.match(/([\d.]+)\s*secs\]/);
  if (!sizeMatches.length || !durMatch) return null;
  const overall = sizeMatches[sizeMatches.length - 1];
  return {
    type: isFull ? 'Full' : 'Young',
    beforeKb: parseInt(overall[1], 10), afterKb: parseInt(overall[2], 10), totalKb: parseInt(overall[3], 10),
    durationMs: parseFloat(durMatch[1]) * 1000
  };
}

// Returns null (not a GC log at all — falls through to histogram parsing
// below) or { format, events } — events can legitimately be empty when the
// format is recognized but individual lines don't match the per-event regex
// (unusual GC collector/flags), which the caller reports honestly rather
// than pretending 0 events means a healthy, event-free log.
function miParseGcLog(text) {
  const format = miDetectGcFormat(text);
  if (!format) return null;
  const parseLine = format === 'unified' ? miParseUnifiedGcLine : miParseVerboseGcLine;
  const events = text.split('\n').map(parseLine).filter(Boolean);
  return { format, events };
}

function miSummarizeGc(events) {
  const byType = {};
  events.forEach(e => {
    if (!byType[e.type]) byType[e.type] = { count: 0, totalMs: 0, maxMs: 0 };
    const s = byType[e.type];
    s.count++;
    s.totalMs += e.durationMs;
    s.maxMs = Math.max(s.maxMs, e.durationMs);
  });
  return byType;
}

function miRenderGcSummary(parsed) {
  const formatLabel = parsed.format === 'unified' ? '-Xlog:gc (JDK 9+ unified logging)' : '-verbose:gc (JDK 8 classic)';
  if (!parsed.events.length) {
    return `<div class="notice notice-warning">Detected a ${formatLabel}-style log, but couldn't parse any individual GC events out of these lines (an unusual collector or custom -Xlog decorators can look different from the patterns this reader expects).</div>`;
  }
  const summary = miSummarizeGc(parsed.events);
  let html = `<div class="notice notice-info" style="margin-bottom:var(--sp-3)">Detected format: <strong>${formatLabel}</strong> &middot; ${parsed.events.length} GC event(s) parsed.</div>`;
  html += '<table class="jwt-claim-table" style="width:100%"><tr><th style="text-align:left">Type</th><th style="text-align:right">Count</th><th style="text-align:right">Total time</th><th style="text-align:right">Avg</th><th style="text-align:right">Max</th></tr>';
  Object.keys(summary).forEach(type => {
    const s = summary[type];
    html += `<tr><td>${escHtml(type)}</td><td style="text-align:right">${s.count}</td><td style="text-align:right">${s.totalMs.toFixed(1)} ms</td><td style="text-align:right">${(s.totalMs / s.count).toFixed(1)} ms</td><td style="text-align:right">${s.maxMs.toFixed(1)} ms</td></tr>`;
  });
  html += '</table>';
  const last = parsed.events[parsed.events.length - 1];
  html += `<div class="notice notice-info" style="margin-top:var(--sp-3)">Last GC (${escHtml(last.type)}): heap ${formatBytes(last.beforeKb * 1024)} &rarr; ${formatBytes(last.afterKb * 1024)} (of ${formatBytes(last.totalKb * 1024)})</div>`;
  return html;
}

function miAnalyze() {
  const input = document.getElementById('mi-input').value.trim();
  const out = document.getElementById('mi-results');

  if (!input) {
    out.innerHTML = '<div style="color:var(--text-muted)">Paste Heap Dump summary (jmap histogram) or GC logs...</div>';
    return;
  }

  const gcParsed = miParseGcLog(input);
  if (gcParsed) {
    out.innerHTML = miRenderGcSummary(gcParsed);
    return;
  }

  const lines = input.split('\n');
  const parsedClasses = [];
  let totalBytes = 0;
  
  for (let line of lines) {
    const match = line.trim().match(/^(\d+):\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (match) {
      const instances = parseInt(match[2]);
      const bytes = parseInt(match[3]);
      const className = match[4].trim();
      totalBytes += bytes;
      parsedClasses.push({
        instances,
        bytes,
        className
      });
    }
  }
  
  let leakProbability = 'Low';
  let warningMessage = '';
  let oldGen = 0; // Will be calculated from actual data if available
  
  if (parsedClasses.length > 0) {
    // Sort by bytes desc
    parsedClasses.sort((a, b) => b.bytes - a.bytes);
    
    // Check for Mendix Object leaks
    const mendixObjects = parsedClasses.find(c => c.className.includes('MendixObjectImpl') || c.className === 'com.mendix.core.objectmanagement.MendixObjectImpl');
    if (mendixObjects) {
      const ratio = mendixObjects.bytes / totalBytes;
      if (ratio > 0.15 || mendixObjects.bytes > 100 * 1024 * 1024) {
        leakProbability = 'High';
        oldGen = Math.min(98, Math.floor(ratio * 100) + 40);
        warningMessage = `<strong>Leak Warning:</strong> <code>MendixObjectImpl</code> occupies ${formatBytes(mendixObjects.bytes)} (${(ratio * 100).toFixed(1)}% of scanned heap). This often points to uncommitted object lists in long-running Microflows.`;
      }
    }
    
    // Check for massive strings
    const strings = parsedClasses.find(c => c.className === 'java.lang.String' || c.className === '[C');
    if (strings && strings.bytes > 200 * 1024 * 1024) {
      leakProbability = 'Medium';
      warningMessage = warningMessage || `<strong>High Memory:</strong> String character arrays occupy ${formatBytes(strings.bytes)}. Look for large file exports or huge REST response payloads stored in memory.`;
    }
  } else {
    out.innerHTML = `<div class="notice notice-warning">
      <strong>No valid data found.</strong><br>
      Make sure you paste the exact output of a <code>jmap -histo &lt;pid&gt;</code> command. 
      <br><br>
      Example of expected format:
      <pre style="background:var(--bg-base);padding:8px;border-radius:4px;margin-top:8px;font-family:var(--font-mono);font-size:0.8rem">
 num     #instances         #bytes  class name
----------------------------------------------
   1:       12450      152043000  com.mendix.core.objectmanagement.MendixObjectImpl
   2:      450123       93320000  java.lang.String
      </pre>
    </div>`;
    return;
  }
  
  let html = `<div class="grid-2" style="gap:var(--sp-4);margin-bottom:var(--sp-4)">
    <div style="background:var(--bg-elevated);padding:var(--sp-4);border-radius:var(--r-md)">
      <div style="font-size:0.75rem;color:var(--text-secondary);text-transform:uppercase">Memory Leak Probability</div>
      <div style="font-size:1.5rem;font-weight:bold;color:${leakProbability === 'High' ? 'var(--danger)' : leakProbability === 'Medium' ? 'var(--warning)' : 'var(--success)'}">${leakProbability}</div>
    </div>
    <div style="background:var(--bg-elevated);padding:var(--sp-4);border-radius:var(--r-md)">
      <div style="font-size:0.75rem;color:var(--text-secondary);text-transform:uppercase">Old Gen Usage</div>
      <div style="font-size:1.5rem;font-weight:bold;color:${oldGen > 80 ? 'var(--danger)' : oldGen > 0 ? 'var(--info)' : 'var(--text-muted)'}">${oldGen > 0 ? oldGen + '%' : 'N/A'}</div>
    </div>
  </div>`;
  
  if (warningMessage) {
    html += `<div class="notice notice-warning" style="margin-bottom:var(--sp-4)">${warningMessage}</div>`;
  }
  
  html += `<h4>Histogram Analysis (Total Scanned: ${formatBytes(totalBytes)})</h4>
  <table class="jwt-claim-table" style="width:100%">
    <tr><th style="text-align:left">Class Name</th><th style="text-align:right">Size</th><th style="text-align:right">Instances</th></tr>`;
    
  parsedClasses.slice(0, 15).forEach(c => {
    html += `<tr>
      <td style="font-family:var(--font-mono);font-size:0.82rem;word-break:break-all">${escHtml(c.className)}</td>
      <td style="text-align:right;white-space:nowrap">${formatBytes(c.bytes)}</td>
      <td style="text-align:right">${c.instances.toLocaleString()}</td>
    </tr>`;
  });
  
  html += `</table>`;
  
  if (parsedClasses.length > 15) {
    html += `<div style="font-size:0.78rem;color:var(--text-muted);margin-top:var(--sp-2)">Showing top 15 items...</div>`;
  }
  
  html += `<div class="notice notice-info" style="margin-top:var(--sp-3)">
    <strong>Tip:</strong> Run <code>jmap -histo &lt;pid&gt;</code> on your JVM and paste the output here to perform a real-time memory analysis.
  </div>`;
  
  out.innerHTML = html;
}



// --- AUTO-GENERATED ESM EXPORTS ---
window.miAnalyze = miAnalyze;

// Exposed for scripts/parser-test.js (pure functions, no DOM).
window.miDetectGcFormat = miDetectGcFormat;
window.miParseGcLog = miParseGcLog;
window.miSummarizeGc = miSummarizeGc;

export function init() {}
