// PERFORMANCE LAB (Module G)

let plStopFlag = false;
let plActiveCount = 0;
let plResults = [];
let plStartTimes = {};
let plCharts = {};
let plLastChartUpdate = 0;
let plTestStartTime = 0;

function plInitCharts() {
  // Destroy existing
  ['timeline', 'throughput', 'histogram', 'status'].forEach(id => {
    if (plCharts[id]) {
      plCharts[id].destroy();
      plCharts[id] = null;
    }
  });

  if (typeof Chart === 'undefined') return;

  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { display: false } },
    scales: { x: { grid: { color: '#333' }, ticks: { color: '#aaa' } }, y: { grid: { color: '#333' }, ticks: { color: '#aaa' } } }
  };

  const timelineCtx = document.getElementById('pl-chart-timeline');
  if (timelineCtx) {
    plCharts['timeline'] = new Chart(timelineCtx, {
      type: 'scatter',
      data: { datasets: [{ label: 'Response Time', data: [], backgroundColor: '#e84393' }] },
      options: {
        ...commonOptions,
        plugins: { ...commonOptions.plugins, title: { display: true, text: 'Response Time over Time (ms)', color: '#fff' } },
        scales: { x: { title: { display: true, text: 'Time since start (s)', color: '#aaa' }, ...commonOptions.scales.x }, y: { title: { display: true, text: 'Latency (ms)', color: '#aaa' }, ...commonOptions.scales.y, beginAtZero: true } }
      }
    });
  }

  const throughputCtx = document.getElementById('pl-chart-throughput');
  if (throughputCtx) {
    plCharts['throughput'] = new Chart(throughputCtx, {
      type: 'bar',
      data: { labels: [], datasets: [{ label: 'Requests/sec', data: [], backgroundColor: '#0984e3' }] },
      options: {
        ...commonOptions,
        plugins: { ...commonOptions.plugins, title: { display: true, text: 'Throughput (Requests / second)', color: '#fff' } },
        scales: { x: { ...commonOptions.scales.x }, y: { ...commonOptions.scales.y, beginAtZero: true } }
      }
    });
  }

  const histogramCtx = document.getElementById('pl-chart-histogram');
  if (histogramCtx) {
    plCharts['histogram'] = new Chart(histogramCtx, {
      type: 'bar',
      data: { labels: [], datasets: [{ label: 'Requests', data: [], backgroundColor: '#fdcb6e' }] },
      options: {
        ...commonOptions,
        plugins: { ...commonOptions.plugins, title: { display: true, text: 'Latency Distribution', color: '#fff' } },
        scales: { x: { ...commonOptions.scales.x }, y: { ...commonOptions.scales.y, beginAtZero: true } }
      }
    });
  }

  const statusCtx = document.getElementById('pl-chart-status');
  if (statusCtx) {
    plCharts['status'] = new Chart(statusCtx, {
      type: 'doughnut',
      data: { labels: [], datasets: [{ data: [], backgroundColor: ['#00b894', '#d63031', '#feca57', '#a29bfe', '#636e72'] }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { position: 'right', labels: { color: '#aaa' } }, title: { display: true, text: 'Status Codes', color: '#fff' } }
      }
    });
  }
}

function plUpdateCharts() {
  if (plResults.length === 0 || !plCharts['timeline']) return;

  // Timeline
  if (plCharts['timeline']) {
    const scatterData = plResults.filter(r => typeof r.time === 'number' && typeof r.start === 'number').map(r => ({
      x: ((r.start - plTestStartTime) / 1000).toFixed(2),
      y: r.time
    }));
    plCharts['timeline'].data.datasets[0].data = scatterData;
    plCharts['timeline'].update();
  }

  // Throughput (bucketing by completion time in seconds)
  if (plCharts['throughput']) {
    const buckets = {};
    let maxSec = 0;
    plResults.forEach(r => {
      if (typeof r.end === 'number') {
        const sec = Math.floor((r.end - plTestStartTime) / 1000);
        buckets[sec] = (buckets[sec] || 0) + 1;
        if (sec > maxSec) maxSec = sec;
      }
    });
    const labels = [];
    const data = [];
    for (let i = 0; i <= maxSec; i++) {
      labels.push(i + 's');
      data.push(buckets[i] || 0);
    }
    plCharts['throughput'].data.labels = labels;
    plCharts['throughput'].data.datasets[0].data = data;
    plCharts['throughput'].update();
  }

  // Histogram
  if (plCharts['histogram']) {
    const times = plResults.filter(r => typeof r.time === 'number').map(r => r.time);
    if (times.length > 0) {
      const maxTime = Math.max(...times);
      const binCount = 10;
      const binSize = Math.max(1, Math.ceil(maxTime / binCount));
      const bins = new Array(binCount).fill(0);
      times.forEach(t => {
        let binIdx = Math.floor(t / binSize);
        if (binIdx >= binCount) binIdx = binCount - 1;
        bins[binIdx]++;
      });
      plCharts['histogram'].data.labels = bins.map((_, i) => `${i * binSize}-${(i + 1) * binSize}ms`);
      plCharts['histogram'].data.datasets[0].data = bins;
      plCharts['histogram'].update();
    }
  }

  // Status Codes
  if (plCharts['status']) {
    const counts = {};
    plResults.forEach(r => {
      const s = String(r.status);
      counts[s] = (counts[s] || 0) + 1;
    });
    plCharts['status'].data.labels = Object.keys(counts);
    plCharts['status'].data.datasets[0].data = Object.values(counts);
    plCharts['status'].update();
  }
}

function plStart() {
  const url = document.getElementById('pl-url').value;
  const conc = parseInt(document.getElementById('pl-concurrency').value);
  const count = parseInt(document.getElementById('pl-count').value);
  const modeElement = document.getElementById('pl-mode');
  const mode = modeElement ? modeElement.value : 'cors';
  const method = document.getElementById('pl-method').value;
  
  if (!url) return alert('Enter URL');
  
  let headers = {};
  const headersStr = document.getElementById('pl-headers').value.trim();
  if (headersStr) {
    try {
      headers = JSON.parse(headersStr);
    } catch (e) {
      return alert('Headers must be a valid JSON object');
    }
  }

  const fetchOpts = { method, mode, cache: 'no-store', headers };
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    const bodyStr = document.getElementById('pl-body').value.trim();
    if (bodyStr) fetchOpts.body = bodyStr;
  }
  
  plStopFlag = false;
  plResults = [];
  plTestStartTime = performance.now();
  plLastChartUpdate = performance.now();
  
  const engine = document.getElementById('pl-engine') ? document.getElementById('pl-engine').value : 'browser';
  
  document.getElementById('pl-empty-state').style.display = 'none';
  document.getElementById('pl-results-content').style.display = 'flex';
  const exportBtn = document.getElementById('pl-btn-export');
  if (exportBtn) exportBtn.style.display = 'none';

  if (engine === 'server') {
     document.getElementById('pl-btn-start').style.display = 'none';
     document.getElementById('pl-btn-stop').style.display = 'inline-block';
     document.getElementById('pl-status').innerText = 'Running on Server (Turbo)...';
     document.getElementById('pl-cors-warn').style.display = 'none';
     plInitCharts();
     
     fetch('http://localhost:9999/api/perf-test', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ url, method, headers, body: fetchOpts.body, concurrency: conc, count })
     })
     .then(res => res.json())
     .then(data => {
       if (!data.success) {
         alert("Server error: " + (data.reason || data.error || "Unknown"));
       } else {
         plResults = data.results;
         if (exportBtn) exportBtn.style.display = 'inline-block';
       }
     })
     .catch(err => {
       alert("Failed to reach Turbo Backend. Ensure mendix-observability-bridge.js is running.");
     })
     .finally(() => {
       plFinish();
     });
     return;
  }
  
  document.getElementById('pl-btn-start').style.display = 'none';
  document.getElementById('pl-btn-stop').style.display = 'inline-block';
  document.getElementById('pl-status').innerText = 'Running...';
  document.getElementById('pl-cors-warn').style.display = 'none';
  
  plInitCharts();
  
  let sent = 0;
  
  const worker = () => {
    if (plStopFlag || sent >= count) return;
    
    const id = sent++;
    plActiveCount++;
    const t0 = performance.now();
    
    fetch(url, fetchOpts)
      .then(res => {
        const t1 = performance.now();
        plResults.push({ id, time: t1 - t0, status: res.status, start: t0, end: t1 });
      })
      .catch(err => {
        const t1 = performance.now();
        const duration = t1 - t0;
        plResults.push({ id, time: duration, status: 'Error', start: t0, end: t1 });
        if (duration < 150) {
           document.getElementById('pl-cors-warn').style.display = 'block';
        }
      })
      .finally(() => {
        plActiveCount--;
        plUpdateUI();
        if (sent < count && !plStopFlag) worker();
        else if (plActiveCount === 0) plFinish();
      });
  };
  
  for (let i = 0; i < conc; i++) worker();
}

function plStop() {
  plStopFlag = true;
  document.getElementById('pl-status').innerText = 'Stopping...';
}

function plFinish() {
  document.getElementById('pl-btn-start').style.display = 'inline-block';
  document.getElementById('pl-btn-stop').style.display = 'none';
  document.getElementById('pl-status').innerText = 'Completed.';
  const exportBtn = document.getElementById('pl-btn-export');
  if (exportBtn && plResults.length > 0) exportBtn.style.display = 'inline-block';
  plUpdateUI(true); // Force final chart render
}

function plUpdateUI(forceChartRender = false) {
  if (plResults.length === 0) return;
  
  const times = plResults.filter(r => typeof r.time === 'number').map(r => r.time);
  if (times.length === 0) return;
  
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const max = Math.max(...times);
  const min = Math.min(...times);
  const errors = plResults.filter(r => r.status >= 400 || r.status === 'Error').length;
  
  times.sort((a, b) => a - b);
  const getPercentile = (p) => times[Math.floor(p / 100 * (times.length - 1))];
  const p50 = getPercentile(50);
  const p95 = getPercentile(95);
  const p99 = getPercentile(99);
  
  document.getElementById('pl-stats-avg').innerText = avg.toFixed(1) + ' ms';
  document.getElementById('pl-stats-max').innerText = max.toFixed(1) + ' ms';
  document.getElementById('pl-stats-min').innerText = min.toFixed(1) + ' ms';
  document.getElementById('pl-stats-err').innerText = errors;
  document.getElementById('pl-stats-req').innerText = plResults.length;
  document.getElementById('pl-stats-p50').innerText = p50.toFixed(1) + ' ms';
  document.getElementById('pl-stats-p95').innerText = p95.toFixed(1) + ' ms';
  document.getElementById('pl-stats-p99').innerText = p99.toFixed(1) + ' ms';

  const now = performance.now();
  if (forceChartRender || (now - plLastChartUpdate > 1000)) {
    plUpdateCharts();
    plLastChartUpdate = now;
  }
}


window.plMethodChanged = function() {
  const method = document.getElementById('pl-method').value;
  const bodyGroup = document.getElementById('pl-body-group');
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    bodyGroup.style.display = 'block';
  } else {
    bodyGroup.style.display = 'none';
  }
};

window.plCheckConcurrency = function() {
  const conc = parseInt(document.getElementById('pl-concurrency').value) || 0;
  const warn = document.getElementById('pl-concurrency-warn');
  const engine = document.getElementById('pl-engine') ? document.getElementById('pl-engine').value : 'browser';
  if (conc > 6 && engine === 'browser') {
    warn.style.display = 'inline-block';
  } else {
    warn.style.display = 'none';
  }
};

window.plSavePreset = function() {
  const preset = {
    url: document.getElementById('pl-url').value,
    method: document.getElementById('pl-method').value,
    headers: document.getElementById('pl-headers').value,
    body: document.getElementById('pl-body').value,
    conc: document.getElementById('pl-concurrency').value,
    count: document.getElementById('pl-count').value,
    engine: document.getElementById('pl-engine') ? document.getElementById('pl-engine').value : 'browser'
  };
  localStorage.setItem('perfLabPreset', JSON.stringify(preset));
  alert('Preset saved to browser memory.');
};

window.plLoadPreset = function() {
  const saved = localStorage.getItem('perfLabPreset');
  if (!saved) return alert('No preset found in memory.');
  try {
    const preset = JSON.parse(saved);
    if (preset.url) document.getElementById('pl-url').value = preset.url;
    if (preset.method) { document.getElementById('pl-method').value = preset.method; window.plMethodChanged(); }
    if (preset.headers) document.getElementById('pl-headers').value = preset.headers;
    if (preset.body) document.getElementById('pl-body').value = preset.body;
    if (preset.conc) document.getElementById('pl-concurrency').value = preset.conc;
    if (preset.count) document.getElementById('pl-count').value = preset.count;
    if (preset.engine && document.getElementById('pl-engine')) document.getElementById('pl-engine').value = preset.engine;
    window.plCheckConcurrency();
  } catch(e) {
    alert('Failed to load preset');
  }
};

window.plExportCSV = function() {
  if (plResults.length === 0) return alert("No results to export.");
  let csv = "RequestID,LatencyMs,StatusCode,StartTime,EndTime\n";
  plResults.forEach(r => {
    csv += `${r.id},${r.time},${r.status},${r.start},${r.end}\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `perf_lab_results_${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};

// --- AUTO-GENERATED ESM EXPORTS ---
window.plStart = plStart;
window.plStop = plStop;
window.plFinish = plFinish;
window.plUpdateUI = plUpdateUI;

export function init() {}
