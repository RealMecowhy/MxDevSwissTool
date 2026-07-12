// NGINX LOG ANALYZER
// ============================================================
window.nginxLoadedText = null;
window.nginxErrorLoadedText = null;
window.nginxParsedLogs = [];
window.nginxErrorParsedLogs = [];
window.nginxActiveTab = 'access';

function nginxSwitchTab(tab) {
  window.nginxActiveTab = tab;
  document.getElementById('nx-tab-access').classList.remove('active');
  document.getElementById('nx-tab-access').style.borderBottomColor = 'transparent';
  document.getElementById('nx-tab-access').style.color = 'var(--text-muted)';
  
  document.getElementById('nx-tab-error').classList.remove('active');
  document.getElementById('nx-tab-error').style.borderBottomColor = 'transparent';
  document.getElementById('nx-tab-error').style.color = 'var(--text-muted)';
  
  document.getElementById('nx-content-access').style.display = 'none';
  document.getElementById('nx-content-error').style.display = 'none';
  
  document.getElementById('nx-tab-' + tab).classList.add('active');
  document.getElementById('nx-tab-' + tab).style.borderBottomColor = 'var(--primary)';
  document.getElementById('nx-tab-' + tab).style.color = 'var(--text)';
  document.getElementById('nx-content-' + tab).style.display = 'flex';
}

function nginxHandleDrop(e) {
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    nginxLoadFilesFromInput(e.dataTransfer.files, 'access');
  }
}

function nginxHandleErrorDrop(e) {
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    nginxLoadFilesFromInput(e.dataTransfer.files, 'error');
  }
}

async function nginxLoadFilesFromInput(files, type = 'access') {
  if (files && files.length > 0) {
    showLoader('Reading logs...');
    await new Promise(resolve => setTimeout(resolve, 50)); // Yield to allow UI to paint
    
    const file = files[0];
    
    try {
      let stream = file.stream();
      const isGz = file.name.toLowerCase().endsWith('.gz');
      if (isGz) {
        stream = stream.pipeThrough(new DecompressionStream('gzip'));
      }
      
      const reader = stream.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      if (type === 'access') {
        window.nginxParsedLogs = [];
      } else {
        window.nginxErrorParsedLogs = [];
      }
      let totalBytes = 0;
      let chunkCount = 0;
      
      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          totalBytes += value.length;
          buffer += decoder.decode(value, { stream: true });
          let lines = buffer.split('\n');
          buffer = lines.pop(); // Keep partial line
          
          for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            if (!line) continue;
            const parsed = type === 'access' ? nginxParseLine(line) : nginxParseErrorLine(line);
            if (parsed) {
              let hourStr = 'Unknown';
              const timeMatch1 = parsed.date.match(/^(\d{2}\/\w{3}\/\d{4}:\d{2})/);
              const timeMatch2 = parsed.date.match(/^(\d{4}-\d{2}-\d{2}T\d{2})/);
              if (timeMatch1) hourStr = timeMatch1[1];
              else if (timeMatch2) hourStr = timeMatch2[1].replace('T', ' ');
              else hourStr = parsed.date.substring(0, 13);
              parsed.hourStr = hourStr;
              
              if (type === 'access') window.nginxParsedLogs.push(parsed);
              else window.nginxErrorParsedLogs.push(parsed);
            }
          }
          
          chunkCount++;
          if (chunkCount % 20 === 0) {
             let progressText;
             let pct = null;
             if (isGz) {
               progressText = `Reading logs... (${(totalBytes/1024/1024).toFixed(1)} MB decompressed)`;
             } else {
               pct = Math.min(100, Math.round((totalBytes / file.size) * 100));
               progressText = `Reading logs... ${pct}%`;
             }
             showLoader(progressText, pct !== null ? pct : undefined);
             // Yield to keep UI responsive on massive files
             await new Promise(r => setTimeout(r, 0));
          }
        }
        if (done) {
          if (buffer.trim()) {
            const parsed = type === 'access' ? nginxParseLine(buffer.trim()) : nginxParseErrorLine(buffer.trim());
            if (parsed) {
              let hourStr = 'Unknown';
              const timeMatch1 = parsed.date.match(/^(\d{2}\/\w{3}\/\d{4}:\d{2})/);
              const timeMatch2 = parsed.date.match(/^(\d{4}-\d{2}-\d{2}T\d{2})/);
              if (timeMatch1) hourStr = timeMatch1[1];
              else if (timeMatch2) hourStr = timeMatch2[1].replace('T', ' ');
              else hourStr = parsed.date.substring(0, 13);
              parsed.hourStr = hourStr;
              if (type === 'access') window.nginxParsedLogs.push(parsed);
              else window.nginxErrorParsedLogs.push(parsed);
            }
          }
          break;
        }
      }
      
      if (type === 'access') {
        window.nginxLoadedText = '[PRE-PARSED]';
        document.getElementById('nginx-log-input').value = `[File loaded: ${file.name}]\nSize: ${(file.size/1024/1024).toFixed(2)} MB${isGz ? ` (Decompressed: ${(totalBytes/1024/1024).toFixed(2)} MB)` : ''}\n\nClick Analyze Logs to re-run.`;
      } else {
        window.nginxErrorLoadedText = '[PRE-PARSED]';
        document.getElementById('nginx-error-log-input').value = `[File loaded: ${file.name}]\nSize: ${(file.size/1024/1024).toFixed(2)} MB${isGz ? ` (Decompressed: ${(totalBytes/1024/1024).toFixed(2)} MB)` : ''}\n\nClick Analyze Logs to re-run.`;
      }
      showLoader('Analyzing logs...');
      setTimeout(() => {
        if (type === 'access') nginxAnalyzeLogs();
        else nginxAnalyzeErrorLogs();
      }, 50);
      
    } catch (err) {
      console.error("Log file reading error:", err);
      hideLoader();
      alert("Failed to process the log file. Ensure it is a valid log file or gzip archive.");
    }
  }
}

const NGINX_REGEX = /^(\S+)\s+\S+\s+(\S+)\s+\[([^\]]+)\]\s+"(?:(\S+)\s+(\S+)\s+(\S+)|([^"]+))"\s+(\d{3})\s+(\d+|-)\s+"([^"]*)"\s+"([^"]*)"(?:\s+"?([\d.]+)"?)?/;

function nginxParseLine(line) {
  if (line.includes('request="') && line.includes('status="')) {
    const timeMatch = line.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
    const date = timeMatch ? timeMatch[1] + 'T' + timeMatch[2] : line.split(' ')[0];
    const dateOnly = timeMatch ? timeMatch[1] : '';
    const timeOnly = timeMatch ? timeMatch[2] : '';
    
    const kv = {};
    const regex = /(\w+)="([^"]*)"/g;
    let m;
    while ((m = regex.exec(line)) !== null) {
      kv[m[1]] = m[2];
    }
    
    let method = 'UNKNOWN';
    let url = '-';
    if (kv.request) {
      const parts = kv.request.split(' ');
      method = parts[0] || 'UNKNOWN';
      url = parts[1] || '-';
    }
    
    let ip = kv.remote_addr || '-';
    if (kv.http_x_forwarded_for && kv.http_x_forwarded_for !== '-') {
      ip = kv.http_x_forwarded_for.split(',')[0].trim();
    }
    
    return {
      ip: ip,
      date: date,
      dateOnly: dateOnly,
      timeOnly: timeOnly,
      method: method,
      url: url,
      status: parseInt(kv.status, 10) || 0,
      bytes: parseInt(kv.response_size_in_bytes, 10) || 0,
      time: parseFloat(kv.response_time_in_seconds) || 0,
      referer: kv.http_referer || '-',
      userAgent: kv.http_user_agent || '-',
      rawLine: line
    };
  }

  const match = line.match(NGINX_REGEX);
  if (!match) return null;
  const dateFull = match[3];
  const dateOnly = dateFull ? dateFull.split(':')[0] : '';
  const timeOnly = dateFull && dateFull.includes(':') ? dateFull.substring(dateFull.indexOf(':') + 1).split(' ')[0] : '';
  return {
    ip: match[1],
    date: dateFull,
    dateOnly: dateOnly,
    timeOnly: timeOnly,
    method: match[4] || 'UNKNOWN',
    url: match[5] || match[7] || '-',
    status: parseInt(match[8], 10),
    bytes: match[9] === '-' ? 0 : parseInt(match[9], 10),
    time: match[12] ? parseFloat(match[12]) : 0,
    referer: match[10],
    userAgent: match[11],
    rawLine: line
  };
}

function nginxGetOS(ua) {
  if (!ua || ua === '-') return 'Unknown';
  if (/windows/i.test(ua)) return 'Windows';
  if (/mac os/i.test(ua)) return 'Mac OS';
  if (/linux/i.test(ua)) return 'Linux';
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad/i.test(ua)) return 'iOS';
  if (/bot|crawl|spider/i.test(ua)) return 'Bot/Crawler';
  return 'Other';
}

function nginxFormatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

window.nginxParsedLogs = [];
window.nginxFilter = { hour: null, ip: null, url: null };

function nginxClearFilters(skipHistory = false) {
  window.nginxFilter = { hour: null, ip: null, url: null };
  if (!skipHistory) {
    history.pushState({ nginxFilterState: { ...window.nginxFilter } }, "");
  }
  showLoader('Re-analyzing...');
  setTimeout(() => nginxAggregateAndRender(), 50);
}

function nginxClearData() {
  window.nginxLoadedText = null;
  window.nginxParsedLogs = [];
  window.nginxFilter = { hour: null, ip: null, url: null };
  history.replaceState({ nginxFilterState: { ...window.nginxFilter } }, "");
  document.getElementById('nginx-log-input').value = '';
  document.getElementById('nginx-results').style.display = 'none';
  document.getElementById('nginx-input-card').style.display = 'flex';
  document.getElementById('nginx-send-anon-btn').style.display = 'none';
  const fileInput = document.getElementById('nginx-file-input');
  if (fileInput) fileInput.value = '';

  window.nginxErrorLoadedText = null;
  window.nginxErrorParsedLogs = [];
  document.getElementById('nginx-error-log-input').value = '';
  document.getElementById('nginx-error-results').style.display = 'none';
  document.getElementById('nginx-error-input-card').style.display = 'flex';
  const errorFileInput = document.getElementById('nginx-error-file-input');
  if (errorFileInput) errorFileInput.value = '';
}

function nginxSetFilter(type, value) {
  window.nginxFilter[type] = value;
  history.pushState({ nginxFilterState: { ...window.nginxFilter } }, "");
  showLoader('Filtering...');
  setTimeout(() => nginxAggregateAndRender(), 50);
}

async function nginxAnalyzeLogs() {
  let input = document.getElementById('nginx-log-input').value;
  if (input.startsWith('[File loaded:')) {
    input = window.nginxLoadedText;
  }
  if (!input || !input.trim()) { hideLoader(); return; }
  
  if (input !== '[PRE-PARSED]') {
    const lines = input.split('\n');
    window.nginxParsedLogs = [];
    
    lines.forEach(line => {
      line = line.trim();
      if (!line) return;
      const parsed = nginxParseLine(line);
      if (parsed) {
        let hourStr = 'Unknown';
        const timeMatch1 = parsed.date.match(/^(\d{2}\/\w{3}\/\d{4}:\d{2})/);
        const timeMatch2 = parsed.date.match(/^(\d{4}-\d{2}-\d{2}T\d{2})/);
        
        if (timeMatch1) {
          hourStr = timeMatch1[1];
        } else if (timeMatch2) {
          hourStr = timeMatch2[1].replace('T', ' ');
        } else {
          hourStr = parsed.date.substring(0, 13);
        }
        parsed.hourStr = hourStr;
        window.nginxParsedLogs.push(parsed);
      }
    });
  }

  history.replaceState({ nginxFilterState: { hour: null, ip: null, url: null } }, "");
  window.nginxFilter = { hour: null, ip: null, url: null };
  nginxApplyStreamFilters('access');
}

async function nginxAggregateAndRender() {
  const uniqueDates = [...new Set(window.nginxParsedLogs.map(l => l.dateOnly).filter(Boolean))].sort();
  const dateSelect = document.getElementById('nx-access-date-filter');
  if (dateSelect && dateSelect.options.length <= 1) {
    const currVal = dateSelect.value;
    dateSelect.innerHTML = '<option value="">All dates</option>' + uniqueDates.map(d => `<option value="${d}">${d}</option>`).join('');
    dateSelect.value = currVal || '';
  }

  let filteredLogs = window.nxStreamState.accessFiltered || window.nginxParsedLogs;
  
  if (window.nginxFilter.hour) filteredLogs = filteredLogs.filter(l => l.hourStr === window.nginxFilter.hour);
  if (window.nginxFilter.ip) filteredLogs = filteredLogs.filter(l => l.ip === window.nginxFilter.ip);
  if (window.nginxFilter.url) filteredLogs = filteredLogs.filter(l => l.url === window.nginxFilter.url);

  const filterContainer = document.getElementById('nx-filters-container');
  const activeFiltersDiv = document.getElementById('nx-active-filters');
  activeFiltersDiv.innerHTML = '';
  let hasFilters = false;
  
  ['hour', 'ip', 'url'].forEach(key => {
    if (window.nginxFilter[key]) {
      hasFilters = true;
      activeFiltersDiv.innerHTML += `<div style="background:var(--info);color:white;padding:4px 10px;border-radius:12px;font-size:0.75rem;display:flex;align-items:center;gap:6px">
        <strong style="text-transform:uppercase">${key}</strong>: ${window.nginxFilter[key]}
        <span style="cursor:pointer;font-weight:bold;font-size:1rem;line-height:1" title="Remove filter" onclick="nginxSetFilter('${key}', null)">&times;</span>
      </div>`;
    }
  });
  filterContainer.style.display = hasFilters ? 'flex' : 'none';

  const stats = {
    total: 0,
    bytes: 0,
    errors: 0,
    ips: {},
    urls: {},
    notFounds: {},
    statuses: {},
    os: {},
    hours: {},
    urlTimes: {},
    bots: {}
  };

  const suspiciousPatterns = ['wp-admin', '.env', '.git', 'union select', 'passwd', 'etc/', 'cmd.exe'];
  const suspiciousAgents = ['nikto', 'nmap', 'sqlmap', 'zgrab', 'curl', 'python-requests'];

  filteredLogs.forEach(parsed => {
    stats.total++;
    stats.bytes += parsed.bytes;
    if (parsed.status >= 400) stats.errors++;
    
    stats.ips[parsed.ip] = (stats.ips[parsed.ip] || 0) + 1;
    stats.urls[parsed.url] = (stats.urls[parsed.url] || 0) + 1;
    if (parsed.status === 404) stats.notFounds[parsed.url] = (stats.notFounds[parsed.url] || 0) + 1;
    stats.statuses[parsed.status] = (stats.statuses[parsed.status] || 0) + 1;
    stats.hours[parsed.hourStr] = (stats.hours[parsed.hourStr] || 0) + 1;
    
    const os = nginxGetOS(parsed.userAgent);
    stats.os[os] = (stats.os[os] || 0) + 1;

    if (!stats.urlTimes[parsed.url]) stats.urlTimes[parsed.url] = { count: 0, totalBytes: 0, totalTime: 0 };
    stats.urlTimes[parsed.url].count++;
    stats.urlTimes[parsed.url].totalBytes += parsed.bytes;
    stats.urlTimes[parsed.url].totalTime += parsed.time || 0;

    let botReason = null;
    const lowerUrl = parsed.url.toLowerCase();
    const lowerUa = parsed.userAgent.toLowerCase();
    
    suspiciousPatterns.forEach(p => { if(lowerUrl.includes(p)) botReason = 'Suspicious Path: ' + p; });
    suspiciousAgents.forEach(p => { if(lowerUa.includes(p)) botReason = 'Suspicious Agent: ' + p; });
    
    if (botReason) {
      if (!stats.bots[parsed.ip]) stats.bots[parsed.ip] = { reason: botReason, hits: 0 };
      stats.bots[parsed.ip].hits++;
    }
  });

  document.getElementById('nx-total-reqs').textContent = stats.total.toLocaleString('pl-PL');
  document.getElementById('nx-unique-ips').textContent = Object.keys(stats.ips).length.toLocaleString('pl-PL');
  document.getElementById('nx-bandwidth').textContent = nginxFormatBytes(stats.bytes);
  document.getElementById('nx-errors').textContent = stats.errors.toLocaleString('pl-PL');
  document.getElementById('nx-success-rate').textContent = window.nginxParsedLogs.length > 0 ? Math.round((stats.total / window.nginxParsedLogs.length) * 100) + '%' : '0%';
  
  const sortedHours = Object.entries(stats.hours).sort((a,b) => a[0].localeCompare(b[0]));
  if (sortedHours.length > 0) {
    let maxHour = sortedHours[0];
    sortedHours.forEach(h => { if(h[1] > maxHour[1]) maxHour = h; });
    document.getElementById('nx-active-hour').textContent = maxHour[0];
  } else {
    document.getElementById('nx-active-hour').textContent = '-';
  }

  const statusColors = { '2': 'var(--success)', '3': 'var(--info)', '4': 'var(--warning)', '5': 'var(--danger)' };
  let statusChartHtml = '';
  Object.entries(stats.statuses).sort((a,b)=>b[1]-a[1]).forEach(([code, count]) => {
    const p = Math.round((count / (stats.total || 1)) * 100);
    const color = statusColors[code.charAt(0)] || 'var(--text-muted)';
    statusChartHtml += `
      <div style="display:flex;align-items:center;gap:8px;font-size:0.75rem">
        <div style="width:30px;font-weight:600;color:${color}">${code}</div>
        <div style="flex:1;background:var(--bg-elevated);border-radius:2px;height:12px;overflow:hidden">
          <div style="height:100%;background:${color};width:${Math.max(1, p)}%"></div>
        </div>
        <div style="width:35px;text-align:right">${count.toLocaleString('pl-PL')}</div>
      </div>
    `;
  });
  document.getElementById('nx-status-chart').innerHTML = statusChartHtml || '<div style="color:var(--text-muted)">No data</div>';

  if (sortedHours.length > 0) {
    const maxVal = Math.max(...sortedHours.map(h => h[1]));
    let timeChartHtml = '';
    let xAxisHtml = '';
    const labelStep = Math.max(1, Math.ceil(sortedHours.length / 6));
    
    sortedHours.forEach(([hour, count], i) => {
      const hPercent = Math.max(2, (count / maxVal) * 100);
      timeChartHtml += `
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;height:100%;justify-content:flex-end;position:relative;cursor:pointer" onclick="nginxSetFilter('hour', '${hour}')">
          <div style="width:100%;background:var(--accent);height:${hPercent}%;border-radius:2px 2px 0 0;opacity:0.8;transition:opacity 0.2s" onmouseover="this.style.opacity=1; this.nextElementSibling.style.display='block'" onmouseout="this.style.opacity=0.8; this.nextElementSibling.style.display='none'"></div>
          <div style="display:none; position:absolute; bottom:calc(100% + 5px); left:50%; transform:translateX(-50%); background:var(--bg-elevated); border:1px solid var(--border); padding:6px 10px; border-radius:6px; font-size:0.75rem; color:var(--text); white-space:nowrap; z-index:10; pointer-events:none; box-shadow:0 4px 12px rgba(0,0,0,0.5)">
            <strong style="color:var(--accent)">${hour}</strong><br/>${count} requests<br/><span style="color:var(--text-muted);font-size:0.65rem">Click to filter by this hour</span>
          </div>
        </div>
      `;
      
      const showLabel = (i % labelStep === 0) || (i === sortedHours.length - 1);
      const shortHour = hour.split(' ')[1] ? hour.split(' ')[1] + ':00' : hour;
      xAxisHtml += `<div style="flex:1; text-align:center; overflow:visible; position:relative; min-width:0;">
        ${showLabel ? `<span style="font-size:0.7rem; color:var(--text-muted); position:absolute; left:50%; transform:translateX(-50%); white-space:nowrap;">${shortHour}</span>` : ''}
      </div>`;
    });
    
    const chartWithAxes = `
      <div style="display:flex; height:100%; width:100%; gap:8px">
        <div style="display:flex; flex-direction:column; justify-content:space-between; align-items:flex-end; font-size:0.75rem; color:var(--text-muted); padding-bottom:20px; min-width:35px;">
          <span>${maxVal >= 1000 ? (maxVal/1000).toFixed(1)+'k' : maxVal}</span>
          <span>${Math.round(maxVal/2) >= 1000 ? (Math.round(maxVal/2)/1000).toFixed(1)+'k' : Math.round(maxVal/2)}</span>
          <span>0</span>
        </div>
        <div style="flex:1; display:flex; flex-direction:column; min-width:0;">
          <div style="flex:1; display:flex; align-items:flex-end; gap:2px; border-bottom:1px solid var(--border); border-left:1px solid var(--border); padding-left:4px; padding-bottom:0; z-index:1">
             ${timeChartHtml}
          </div>
          <div style="display:flex; gap:2px; padding-top:4px; padding-left:4px; margin-bottom:16px;">
             ${xAxisHtml}
          </div>
        </div>
      </div>
    `;
    document.getElementById('nx-time-chart').innerHTML = chartWithAxes;
  } else {
    document.getElementById('nx-time-chart').innerHTML = '<div style="color:var(--text-muted);display:flex;align-items:center;justify-content:center;height:100%">No data</div>';
  }

  const toRows = (arr, total, isIp = false, isUrl = false) => arr.map(([k, c], i) => {
    let trHtml = `<tr>`;
    let keyStyle = `padding:4px 8px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
    if (isIp || isUrl) keyStyle += `cursor:pointer;color:var(--info);text-decoration:underline`;
    let clickAttr = isIp ? `onclick="nginxSetFilter('ip', '${k}')"` : (isUrl ? `onclick="nginxSetFilter('url', '${k.replace(/'/g, "\\'")}')"` : '');
    
    trHtml += `<td style="${keyStyle}" title="${k}" ${clickAttr}>${k}</td>`;
    if (isIp) trHtml += `<td style="padding:4px 8px" id="nx-geo-${i}">Loading...</td>`;
    trHtml += `<td style="padding:4px 8px">${c.toLocaleString('pl-PL')}</td>`;
    if (total) trHtml += `<td style="padding:4px 8px">${((c/total)*100).toFixed(1)}%</td>`;
    trHtml += `</tr>`;
    return trHtml;
  }).join('');

  const topUrls = Object.entries(stats.urls).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const top404s = Object.entries(stats.notFounds).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const topOs = Object.entries(stats.os).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const topIps = Object.entries(stats.ips).sort((a,b)=>b[1]-a[1]).slice(0,10);

  const slowestUrls = Object.entries(stats.urlTimes)
    .filter(([_, d]) => d.count > 0)
    .map(([url, d]) => [url, d.totalTime / d.count, d.count])
    .sort((a,b) => b[1] - a[1])
    .slice(0, 10);

  const bwHogs = Object.entries(stats.urlTimes)
    .sort((a,b) => b[1].totalBytes - a[1].totalBytes)
    .slice(0, 10)
    .map(([url, d]) => [url, d.totalBytes, d.count]);

  const topBots = Object.entries(stats.bots).sort((a,b)=>b[1].hits-a[1].hits).slice(0,10);

  const referrersMap = {};
  filteredLogs.forEach(l => {
    if (l.referer && l.referer !== '-') referrersMap[l.referer] = (referrersMap[l.referer] || 0) + 1;
  });
  const topReferrers = Object.entries(referrersMap).sort((a,b)=>b[1]-a[1]).slice(0,10);

  document.getElementById('nx-url-table').querySelector('tbody').innerHTML = toRows(topUrls, stats.total, false, true);
  document.getElementById('nx-404-table').querySelector('tbody').innerHTML = toRows(top404s, 0, false, true);
  document.getElementById('nx-os-table').querySelector('tbody').innerHTML = toRows(topOs, 0);
  document.getElementById('nx-ip-table').querySelector('tbody').innerHTML = toRows(topIps, stats.total, true);

  document.getElementById('nx-slow-table').querySelector('tbody').innerHTML = slowestUrls.map(u =>
    `<tr><td style="padding:4px 8px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;color:var(--info);text-decoration:underline" title="${u[0]}" onclick="nginxSetFilter('url', '${u[0].replace(/'/g, "\\\\'")}')">${u[0]}</td><td style="padding:4px 8px">${u[1].toFixed(3)}</td><td style="padding:4px 8px">${u[2].toLocaleString('pl-PL')}</td></tr>`
  ).join('');

  document.getElementById('nx-bw-table').querySelector('tbody').innerHTML = bwHogs.map(u =>
    `<tr><td style="padding:4px 8px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;color:var(--info);text-decoration:underline" title="${u[0]}" onclick="nginxSetFilter('url', '${u[0].replace(/'/g, "\\\\'")}')">${u[0]}</td><td style="padding:4px 8px">${nginxFormatBytes(u[1])}</td><td style="padding:4px 8px">${u[2].toLocaleString('pl-PL')}</td></tr>`
  ).join('');

  document.getElementById('nx-bots-table').querySelector('tbody').innerHTML = topBots.map(b =>
    `<tr><td style="padding:4px 8px;cursor:pointer;color:var(--info);text-decoration:underline" title="${b[0]}" onclick="nginxSetFilter('ip', '${b[0]}')">${b[0]}</td><td style="padding:4px 8px;color:var(--danger)">${b[1].reason}</td><td style="padding:4px 8px">${b[1].hits.toLocaleString('pl-PL')}</td></tr>`
  ).join('');

  document.getElementById('nx-ref-table').querySelector('tbody').innerHTML = toRows(topReferrers, 0);

  document.getElementById('nginx-input-card').style.display = 'none';
  document.getElementById('nginx-results').style.display = 'flex';
  document.getElementById('nginx-send-anon-btn').style.display = 'inline-flex';

  const ipsToFetch = topIps.map(x => x[0]);
  if (ipsToFetch.length > 0) {
    const geoToggle = document.getElementById('nx-geoip-toggle');
    if (geoToggle && !geoToggle.checked) {
      ipsToFetch.forEach((_, i) => {
        const el = document.getElementById(`nx-geo-${i}`);
        if (el) el.textContent = 'Disabled';
      });
    } else {
      try {
        const results = await Promise.all(ipsToFetch.map(ip =>
          fetch(`https://get.geojs.io/v1/ip/geo/${ip}.json`)
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
        ));
        results.forEach((geo, i) => {
          const el = document.getElementById(`nx-geo-${i}`);
          if (el) {
            if (geo && geo.country) el.textContent = geo.country + (geo.city ? ` (${geo.city})` : '');
            else el.textContent = 'Unknown';
          }
        });
      } catch(e) {
        ipsToFetch.forEach((_, i) => {
          const el = document.getElementById(`nx-geo-${i}`);
          if (el) el.textContent = 'Network Error';
        });
      }
    }
  }
  
  if (document.getElementById('nx-access-tab-stream') && document.getElementById('nx-access-tab-stream').classList.contains('active')) {
    nginxApplyStreamFilters('access');
  }
  
  hideLoader();
}

function nginxSendToAnonymizer() {
  let input = document.getElementById('nginx-log-input').value;
  if (input.startsWith('[File loaded:')) {
    input = window.nginxLoadedText;
  }
  if (!input || !input.trim()) return;
  window.pendingAnonymizerText = input;
  navigate('log-anonymizer', null);
}

window.addEventListener('popstate', function(e) {
  if (typeof currentTool !== 'undefined' && currentTool === 'nginx-log') {
    if (e.state && e.state.nginxFilterState) {
      window.nginxFilter = { ...e.state.nginxFilterState };
      showLoader('Filtering...');
      setTimeout(() => nginxAggregateAndRender(), 50);
    } else {
      window.nginxFilter = { hour: null, ip: null, url: null };
      showLoader('Re-analyzing...');
      setTimeout(() => nginxAggregateAndRender(), 50);
    }
  }
});

// DOMContentLoaded removed — lifecycle managed by core.js init() export



// --- AUTO-GENERATED ESM EXPORTS ---
window.nginxHandleDrop = nginxHandleDrop;
window.nginxLoadFilesFromInput = nginxLoadFilesFromInput;
window.nginxParseLine = nginxParseLine;
window.nginxGetOS = nginxGetOS;
function nginxParseErrorLine(line) {
  const regex = /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}) \[(\w+)\] \d+#\d+: (?:\*\d+ )?(.*)/;
  const match = line.match(regex);
  if (!match) return null;
  
  const dateStr = match[1];
  const dateOnly = dateStr.split(' ')[0];
  const timeOnly = dateStr.split(' ')[1];
  const level = match[2];
  const fullMessage = match[3];
  
  let ip = '-';
  const clientMatch = fullMessage.match(/client: ([^, ]+)/);
  if (clientMatch) ip = clientMatch[1];
  
  let request = '-';
  const requestMatch = fullMessage.match(/request: "([^"]+)"/);
  if (requestMatch) request = requestMatch[1];
  
  let cleanMessage = fullMessage;
  const clientIdx = fullMessage.indexOf(', client: ');
  if (clientIdx !== -1) {
    cleanMessage = fullMessage.substring(0, clientIdx);
  }
  
  const hourStr = dateStr.substring(0, 13);
  
  return {
    date: dateStr,
    dateOnly: dateOnly,
    timeOnly: timeOnly,
    hourStr: hourStr,
    level: level,
    message: cleanMessage,
    ip: ip,
    request: request,
    type: 'error',
    rawLine: line
  };
}

async function nginxAnalyzeErrorLogs() {
  let input = document.getElementById('nginx-error-log-input').value;
  if (input.startsWith('[File loaded:')) {
    input = window.nginxErrorLoadedText;
  }
  if (!input || !input.trim()) { hideLoader(); return; }
  
  if (input !== '[PRE-PARSED]') {
    const lines = input.split('\n');
    window.nginxErrorParsedLogs = [];
    
    lines.forEach(line => {
      line = line.trim();
      if (!line) return;
      const parsed = nginxParseErrorLine(line);
      if (parsed) {
        window.nginxErrorParsedLogs.push(parsed);
      }
    });
  }
  
  nginxApplyStreamFilters('error');
}

async function nginxAggregateAndRenderErrorLog() {
  const uniqueDates = [...new Set(window.nginxErrorParsedLogs.map(l => l.dateOnly).filter(Boolean))].sort();
  const dateSelect = document.getElementById('nx-error-date-filter');
  if (dateSelect && dateSelect.options.length <= 1) {
    const currVal = dateSelect.value;
    dateSelect.innerHTML = '<option value="">All dates</option>' + uniqueDates.map(d => `<option value="${d}">${d}</option>`).join('');
    dateSelect.value = currVal || '';
  }

  const logs = window.nxStreamState.errorFiltered || window.nginxErrorParsedLogs;
  document.getElementById('nginx-error-input-card').style.display = 'none';
  document.getElementById('nginx-error-results').style.display = 'flex';
  
  if (logs.length === 0) {
    document.getElementById('nx-err-total').innerText = '0';
    hideLoader();
    return;
  }
  
  document.getElementById('nx-err-total').innerText = logs.length.toLocaleString();
  
  let levelsMap = {};
  let ipsMap = {};
  let messagesMap = {};
  let requestsMap = {};
  let hoursMap = {};
  
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    levelsMap[log.level] = (levelsMap[log.level] || 0) + 1;
    hoursMap[log.hourStr] = (hoursMap[log.hourStr] || 0) + 1;
    if (log.ip !== '-') ipsMap[log.ip] = (ipsMap[log.ip] || 0) + 1;
    messagesMap[log.message] = (messagesMap[log.message] || 0) + 1;
    if (log.request !== '-') requestsMap[log.request] = (requestsMap[log.request] || 0) + 1;
  }
  
  document.getElementById('nx-err-levels').innerText = Object.keys(levelsMap).length.toLocaleString();
  document.getElementById('nx-err-clients').innerText = Object.keys(ipsMap).length.toLocaleString();
  
  let maxHour = '-';
  let maxHourCount = 0;
  for (const h in hoursMap) {
    if (hoursMap[h] > maxHourCount) {
      maxHourCount = hoursMap[h];
      maxHour = h;
    }
  }
  document.getElementById('nx-err-active-hour').innerText = maxHour;
  
  const levelHtml = Object.entries(levelsMap)
    .sort((a,b) => b[1]-a[1])
    .map(entry => {
      const pct = ((entry[1]/logs.length)*100).toFixed(1);
      const color = entry[0] === 'error' || entry[0] === 'crit' ? 'var(--danger)' : 'var(--warning)';
      return `<div style="display:flex;align-items:center;gap:8px;font-size:0.8rem">
                <div style="width:60px;font-weight:600;color:${color}">${entry[0]}</div>
                <div style="flex:1;background:var(--bg-elevated);height:12px;border-radius:4px;overflow:hidden">
                  <div style="width:${pct}%;background:${color};height:100%"></div>
                </div>
                <div style="width:40px;text-align:right">${pct}%</div>
              </div>`;
    }).join('');
  document.getElementById('nx-err-level-chart').innerHTML = levelHtml || '<div style="color:var(--text-muted);font-size:0.85rem">No data</div>';
  
  const sortedHours = Object.keys(hoursMap).sort();
  let maxHCount = 0;
  sortedHours.forEach(h => { if(hoursMap[h] > maxHCount) maxHCount = hoursMap[h]; });
  
  let timeHtml = '<div style="display:flex;align-items:flex-end;gap:2px;height:100%;padding-top:10px">';
  const barCount = Math.min(sortedHours.length, 50);
  const step = Math.ceil(sortedHours.length / barCount);
  for (let i = 0; i < sortedHours.length; i += step) {
    let sum = 0;
    for (let j=0; j<step && i+j<sortedHours.length; j++) sum += hoursMap[sortedHours[i+j]];
    const pct = maxHCount > 0 ? (sum / (maxHCount*step)) * 100 : 0;
    timeHtml += `<div style="flex:1;background:var(--danger);height:${Math.max(1, pct)}%;border-radius:2px 2px 0 0" title="${sortedHours[i]}: ${sum} errors"></div>`;
  }
  timeHtml += '</div>';
  document.getElementById('nx-err-time-chart').innerHTML = timeHtml;
  
  const topIps = Object.entries(ipsMap).sort((a,b) => b[1]-a[1]).slice(0, 10);
  const ipsToFetch = [];
  document.querySelector('#nx-err-ip-table tbody').innerHTML = topIps.map((entry, i) => {
    ipsToFetch.push(entry[0]);
    return `<tr><td style="padding:var(--sp-2);border-bottom:1px solid var(--border)">${entry[0]}</td><td style="padding:var(--sp-2);border-bottom:1px solid var(--border)" id="nx-err-geo-${i}">...</td><td style="padding:var(--sp-2);border-bottom:1px solid var(--border)">${entry[1].toLocaleString('pl-PL')}</td></tr>`;
  }).join('');
  
  const geoToggle = document.getElementById('nx-err-geoip-toggle');
  if (geoToggle && !geoToggle.checked) {
    ipsToFetch.forEach((_, i) => {
      const el = document.getElementById(`nx-err-geo-${i}`);
      if (el) el.textContent = 'Disabled';
    });
  } else {
    try {
      const results = await Promise.all(ipsToFetch.map(ip =>
        fetch(`https://get.geojs.io/v1/ip/geo/${ip}.json`)
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      ));
      results.forEach((geo, i) => {
        const el = document.getElementById(`nx-err-geo-${i}`);
        if (el) {
          if (geo && geo.country) el.textContent = geo.country + (geo.city ? ` (${geo.city})` : '');
          else el.textContent = 'Unknown';
        }
      });
    } catch(e) {
      console.error(e);
      ipsToFetch.forEach((_, i) => {
        const el = document.getElementById(`nx-err-geo-${i}`);
        if (el) el.textContent = 'Error';
      });
    }
  }
  
  const topMsgs = Object.entries(messagesMap).sort((a,b) => b[1]-a[1]).slice(0, 10);
  document.querySelector('#nx-err-msg-table tbody').innerHTML = topMsgs.map(entry => {
    const msg = entry[0].replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<tr><td style="padding:var(--sp-2);border-bottom:1px solid var(--border);word-break:break-all">${msg}</td><td style="padding:var(--sp-2);border-bottom:1px solid var(--border)">${entry[1].toLocaleString('pl-PL')}</td></tr>`;
  }).join('');
  
  const topReqs = Object.entries(requestsMap).sort((a,b) => b[1]-a[1]).slice(0, 10);
  document.querySelector('#nx-err-req-table tbody').innerHTML = topReqs.map(entry => {
    const req = entry[0].replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<tr><td style="padding:var(--sp-2);border-bottom:1px solid var(--border);word-break:break-all">${req}</td><td style="padding:var(--sp-2);border-bottom:1px solid var(--border)">${entry[1].toLocaleString('pl-PL')}</td></tr>`;
  }).join('');
  
  if (document.getElementById('nx-error-tab-stream') && document.getElementById('nx-error-tab-stream').classList.contains('active')) {
    nginxApplyStreamFilters('error');
  }
  
  hideLoader();
}

window.nginxAnalyzeErrorLogs = nginxAnalyzeErrorLogs;
window.nginxAggregateAndRenderErrorLog = nginxAggregateAndRenderErrorLog;
window.nginxParseErrorLine = nginxParseErrorLine;
window.nginxSwitchTab = nginxSwitchTab;
window.nginxLoadFilesFromInput = nginxLoadFilesFromInput;
window.nginxHandleErrorDrop = nginxHandleErrorDrop;
window.nginxFormatBytes = nginxFormatBytes;
window.nginxClearFilters = nginxClearFilters;
window.nginxClearData = nginxClearData;
window.nginxSetFilter = nginxSetFilter;
window.nginxAnalyzeLogs = nginxAnalyzeLogs;
window.nginxAggregateAndRender = nginxAggregateAndRender;
window.nginxSendToAnonymizer = nginxSendToAnonymizer;


// --- Stream Viewer Logic ---
window.nxAccessStreamFilters = { search: '', statusClasses: [2, 3, 4, 5] };
window.nxErrorStreamFilters = { search: '', levels: ['info', 'notice', 'warn', 'error', 'crit', 'alert', 'emerg'] };
window.nxStreamState = {
  accessFiltered: [],
  errorFiltered: [],
  accessVisible: 0,
  errorVisible: 0,
  chunkSize: 100
};

function nginxSetView(type, view, el) {
  document.getElementById(`nx-${type}-tab-analyzer`).classList.remove('active');
  document.getElementById(`nx-${type}-tab-stream`).classList.remove('active');
  el.classList.add('active');
  
  document.getElementById(`nx-${type}-view-analyzer`).style.display = 'none';
  document.getElementById(`nx-${type}-view-stream`).style.display = 'none';
  
  document.getElementById(`nx-${type}-view-${view}`).style.display = 'flex';
}

function nginxToggleStatusClass(cls, btn) {
  btn.classList.toggle('active');
  const active = btn.classList.contains('active');
  if (active) {
    if (!window.nxAccessStreamFilters.statusClasses.includes(cls)) {
      window.nxAccessStreamFilters.statusClasses.push(cls);
    }
  } else {
    window.nxAccessStreamFilters.statusClasses = window.nxAccessStreamFilters.statusClasses.filter(c => c !== cls);
  }
  nginxApplyStreamFilters('access');
}

function nginxToggleErrorLevel(lvl, btn) {
  btn.classList.toggle('active');
  const active = btn.classList.contains('active');
  if (active) {
    if (!window.nxErrorStreamFilters.levels.includes(lvl)) {
      window.nxErrorStreamFilters.levels.push(lvl);
    }
  } else {
    window.nxErrorStreamFilters.levels = window.nxErrorStreamFilters.levels.filter(l => l !== lvl);
  }
  nginxApplyStreamFilters('error');
}

let nxFilterTimeout = null;
function nginxApplyStreamFilters(type, delay = 200) {
  clearTimeout(nxFilterTimeout);
  showLoader('Applying filters...');
  nxFilterTimeout = setTimeout(() => {
    _nginxApplyStreamFiltersSync(type);
    hideLoader();
  }, delay);
}

function _nginxApplyStreamFiltersSync(type) {
  if (type === 'access') {
    const search = document.getElementById('nx-access-search').value.toLowerCase();
    const classes = window.nxAccessStreamFilters.statusClasses;
    const timeFrom = document.getElementById('nx-access-time-from').value;
    const timeTo = document.getElementById('nx-access-time-to').value;
    const dateFilter = document.getElementById('nx-access-date-filter').value;
    window.nxStreamState.accessFiltered = window.nginxParsedLogs.filter(log => {
      if (!log) return false;
      const statusClass = Math.floor(log.status / 100);
      if (!classes.includes(statusClass)) return false;
      if (dateFilter && log.dateOnly && log.dateOnly !== dateFilter) return false;
      if (timeFrom && log.timeOnly && log.timeOnly < timeFrom) return false;
      if (timeTo && log.timeOnly && log.timeOnly > timeTo) return false;
      if (search) {
        return (log.rawLine && log.rawLine.toLowerCase().includes(search));
      }
      return true;
    });
    window.nxStreamState.accessVisible = Math.min(window.nxStreamState.chunkSize, window.nxStreamState.accessFiltered.length);
    nginxInitStreamScroll('access');
    nginxRenderStream('access');
    nginxAggregateAndRender();
  } else {
    const search = document.getElementById('nx-error-search').value.toLowerCase();
    const levels = window.nxErrorStreamFilters.levels;
    const timeFrom = document.getElementById('nx-error-time-from').value;
    const timeTo = document.getElementById('nx-error-time-to').value;
    const dateFilter = document.getElementById('nx-error-date-filter').value;
    window.nxStreamState.errorFiltered = window.nginxErrorParsedLogs.filter(log => {
      if (!log) return false;
      if (!levels.includes(log.level)) return false;
      if (dateFilter && log.dateOnly && log.dateOnly !== dateFilter) return false;
      if (timeFrom && log.timeOnly && log.timeOnly < timeFrom) return false;
      if (timeTo && log.timeOnly && log.timeOnly > timeTo) return false;
      if (search) {
        return (log.rawLine && log.rawLine.toLowerCase().includes(search));
      }
      return true;
    });
    window.nxStreamState.errorVisible = Math.min(window.nxStreamState.chunkSize, window.nxStreamState.errorFiltered.length);
    nginxInitStreamScroll('error');
    nginxRenderStream('error');
    nginxAggregateAndRenderErrorLog();
  }
}

function nginxInitStreamScroll(type) {
  const container = document.getElementById(`nx-${type}-stream-container`);
  if (!container) return;
  container.scrollTop = 0;
  container.onscroll = () => {
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 200) {
      nginxLoadMoreStream(type);
    }
  };
}

function nginxLoadMoreStream(type) {
  const stateKey = `${type}Filtered`;
  const visibleKey = `${type}Visible`;
  const total = window.nxStreamState[stateKey].length;
  if (window.nxStreamState[visibleKey] < total) {
    window.nxStreamState[visibleKey] = Math.min(total, window.nxStreamState[visibleKey] + window.nxStreamState.chunkSize);
    nginxRenderStream(type);
  }
}

function nginxColorizeLine(type, log) {
  if (!log || !log.rawLine) return '';
  let html = log.rawLine.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
  if (type === 'access') {
    // Timestamp [09/Jul/2026:12:00:00 +0200]
    html = html.replace(/\[([^\]]+)\]/g, '[<span style="color:var(--text-muted)">$1</span>]');
    
    // Request "POST /path HTTP/1.1"
    html = html.replace(/"(GET|POST|PUT|DELETE|OPTIONS|HEAD|PATCH)\s+([^"]+?)(?:\s+(HTTP\/\d\.\d))?"/g, 
      (match, method, path, proto) => {
        let res = `"<span style="color:var(--accent);font-weight:600">${method}</span> <span style="color:var(--info)">${path}</span>`;
        if (proto) res += `<span style="color:var(--text-muted)"> ${proto}</span>`;
        res += `"`;
        return res;
      });
    
    // IP Address at the start
    html = html.replace(/^((?:\d{1,3}\.){3}\d{1,3})/, '<span style="color:var(--info);font-weight:600">$1</span>');
    
    // Status Codes
    html = html.replace(/\s(2\d{2})\s/g, ' <span style="color:var(--success);font-weight:bold">$1</span> ');
    html = html.replace(/\s(3\d{2})\s/g, ' <span style="color:var(--info);font-weight:bold">$1</span> ');
    html = html.replace(/\s([45]\d{2})\s/g, ' <span style="background:var(--danger-subtle);color:var(--danger);font-weight:bold;padding:0 2px;border-radius:2px">$1</span> ');
  } else {
    html = html.replace(/\[(error|emerg|alert|crit)\]/gi, '[<span style="color:var(--danger);font-weight:bold">$1</span>]');
    html = html.replace(/\[(warn)\]/gi, '[<span style="color:var(--warning);font-weight:bold">$1</span>]');
    html = html.replace(/\[(info|notice)\]/gi, '[<span style="color:var(--info);font-weight:bold">$1</span>]');
  }
  return html;
}

function nginxRenderStream(type) {
  const list = document.getElementById(`nx-${type}-virtual-list`);
  const countEl = document.getElementById(`nx-${type}-stream-count`);
  if (!list || !countEl) return;
  
  const stateKey = `${type}Filtered`;
  const visibleKey = `${type}Visible`;
  const logs = window.nxStreamState[stateKey];
  const visible = window.nxStreamState[visibleKey];
  
  countEl.textContent = logs.length;
  
  let html = '';
  for (let i = 0; i < visible; i++) {
    const log = logs[i];
    if (!log) continue;
    let badge = '';
    if (type === 'access' && log.status >= 400) badge = `<span style="background:var(--danger);width:4px;display:inline-block;margin-right:8px;flex-shrink:0"></span>`;
    else if (type === 'error' && ['error', 'crit', 'alert', 'emerg'].includes(log.level)) badge = `<span style="background:var(--danger);width:4px;display:inline-block;margin-right:8px;flex-shrink:0"></span>`;
    else badge = `<span style="width:4px;display:inline-block;margin-right:8px;flex-shrink:0"></span>`;
    
    html += `<div style="display:flex;padding:2px 8px;border-bottom:1px solid var(--border-subtle);white-space:pre-wrap;word-break:break-all;line-height:1.4">
      ${badge}
      <div style="flex:1">${nginxColorizeLine(type, log)}</div>
    </div>`;
  }
  
  list.innerHTML = html;
}

window.nginxSetView = nginxSetView;
window.nginxToggleStatusClass = nginxToggleStatusClass;
window.nginxToggleErrorLevel = nginxToggleErrorLevel;
window.nginxApplyStreamFilters = nginxApplyStreamFilters;

export function init() {}
