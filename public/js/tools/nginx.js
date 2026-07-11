// NGINX LOG ANALYZER
// ============================================================
window.nginxLoadedText = null;

function nginxHandleDrop(e) {
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    nginxLoadFilesFromInput(e.dataTransfer.files);
  }
}

function nginxLoadFilesFromInput(files) {
  if (files && files.length > 0) {
    showLoader('Reading Nginx log...');
    const file = files[0];
    const reader = new FileReader();
    reader.onload = function(evt) {
      window.nginxLoadedText = evt.target.result;
      document.getElementById('nginx-log-input').value = `[File loaded: ${file.name}]\nSize: ${(file.size/1024/1024).toFixed(2)} MB\n\nClick Analyze Logs to re-run.`;
      showLoader('Analyzing logs...');
      setTimeout(() => {
        nginxAnalyzeLogs();
      }, 50);
    };
    reader.readAsText(file);
  }
}

const NGINX_REGEX = /^(\S+)\s+\S+\s+(\S+)\s+\[([^\]]+)\]\s+"(?:(\S+)\s+(\S+)\s+(\S+)|([^"]+))"\s+(\d{3})\s+(\d+|-)\s+"([^"]*)"\s+"([^"]*)"/;

function nginxParseLine(line) {
  if (line.includes('request="') && line.includes('status="')) {
    const timeMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
    const date = timeMatch ? timeMatch[1] : line.split(' ')[0];
    
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
      method: method,
      url: url,
      status: parseInt(kv.status, 10) || 0,
      bytes: parseInt(kv.response_size_in_bytes, 10) || 0,
      referer: kv.http_referer || '-',
      userAgent: kv.http_user_agent || '-'
    };
  }

  const match = line.match(NGINX_REGEX);
  if (!match) return null;
  return {
    ip: match[1],
    date: match[3],
    method: match[4] || 'UNKNOWN',
    url: match[5] || match[7] || '-',
    status: parseInt(match[8], 10),
    bytes: match[9] === '-' ? 0 : parseInt(match[9], 10),
    referer: match[10],
    userAgent: match[11]
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

  history.replaceState({ nginxFilterState: { hour: null, ip: null, url: null } }, "");
  nginxClearFilters(true);
}

async function nginxAggregateAndRender() {
  let filteredLogs = window.nginxParsedLogs;
  
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

    if (!stats.urlTimes[parsed.url]) stats.urlTimes[parsed.url] = { count: 0, totalBytes: 0 };
    stats.urlTimes[parsed.url].count++;
    stats.urlTimes[parsed.url].totalBytes += parsed.bytes;

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

  document.getElementById('nx-total-reqs').textContent = stats.total;
  document.getElementById('nx-unique-ips').textContent = Object.keys(stats.ips).length;
  document.getElementById('nx-bandwidth').textContent = nginxFormatBytes(stats.bytes);
  document.getElementById('nx-errors').textContent = stats.errors;
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
        <div style="width:35px;text-align:right">${count}</div>
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
    trHtml += `<td style="padding:4px 8px">${c}</td>`;
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
    .map(([url, d]) => [url, d.count])
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
    `<tr><td style="padding:4px 8px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;color:var(--info);text-decoration:underline" title="${u[0]}" onclick="nginxSetFilter('url', '${u[0].replace(/'/g, "\\\\'")}')">${u[0]}</td><td style="padding:4px 8px">${u[1]} hits</td></tr>`
  ).join('');

  document.getElementById('nx-bw-table').querySelector('tbody').innerHTML = bwHogs.map(u =>
    `<tr><td style="padding:4px 8px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;color:var(--info);text-decoration:underline" title="${u[0]}" onclick="nginxSetFilter('url', '${u[0].replace(/'/g, "\\\\'")}')">${u[0]}</td><td style="padding:4px 8px">${nginxFormatBytes(u[1])}</td><td style="padding:4px 8px">${u[2]}</td></tr>`
  ).join('');

  document.getElementById('nx-bots-table').querySelector('tbody').innerHTML = topBots.map(b =>
    `<tr><td style="padding:4px 8px;cursor:pointer;color:var(--info);text-decoration:underline" title="${b[0]}" onclick="nginxSetFilter('ip', '${b[0]}')">${b[0]}</td><td style="padding:4px 8px;color:var(--danger)">${b[1].reason}</td><td style="padding:4px 8px">${b[1].hits}</td></tr>`
  ).join('');

  document.getElementById('nx-ref-table').querySelector('tbody').innerHTML = toRows(topReferrers, 0);

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
window.nginxFormatBytes = nginxFormatBytes;
window.nginxClearFilters = nginxClearFilters;
window.nginxSetFilter = nginxSetFilter;
window.nginxAnalyzeLogs = nginxAnalyzeLogs;
window.nginxAggregateAndRender = nginxAggregateAndRender;
window.nginxSendToAnonymizer = nginxSendToAnonymizer;

export function init() {}
