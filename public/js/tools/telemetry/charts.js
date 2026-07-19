import { state } from './state.js';

export function tmGetChartColors() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    gridColor: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.05)',
    textColor: isDark ? '#b3b3b3' : '#666666',
    tooltipBg: isDark ? '#1f1f1f' : '#ffffff',
    tooltipBorder: isDark ? '#373737' : '#dddddd',
    tooltipColor: isDark ? '#ffffff' : '#000000'
  };
}

export function tmInitChart(chartId, type, config) {
  const ctx = document.getElementById(chartId);
  if (!ctx) return null;

  if (state.tmCharts[chartId]) {
    state.tmCharts[chartId].destroy();
  }

  const colors = tmGetChartColors();

  config.options = config.options || {};
  config.options.responsive = true;
  config.options.maintainAspectRatio = false;
  config.options.animation = { duration: 300 };
  
  config.options.plugins = config.options.plugins || {};
  config.options.plugins.tooltip = {
    backgroundColor: colors.tooltipBg,
    titleColor: colors.tooltipColor,
    bodyColor: colors.textColor,
    borderColor: colors.tooltipBorder,
    borderWidth: 1,
    padding: 8,
    boxPadding: 4,
    usePointStyle: true,
    callbacks: config.options.plugins.tooltip?.callbacks || {}
  };

  config.options.scales = config.options.scales || {};
  for (let s in config.options.scales) {
    config.options.scales[s].grid = config.options.scales[s].grid || {};
    config.options.scales[s].grid.color = colors.gridColor;
    config.options.scales[s].grid.drawBorder = false;

    config.options.scales[s].ticks = config.options.scales[s].ticks || {};
    config.options.scales[s].ticks.color = colors.textColor;
    config.options.scales[s].ticks.font = { size: 10 };
  }

  state.tmCharts[chartId] = new Chart(ctx, config);
  return state.tmCharts[chartId];
}

export function tmUpdateChartsUI() {
  const colors = tmGetChartColors();

  // 1. MEMORY CHART
  if (!state.tmCharts['tm-chart-memory']) {
    tmInitChart('tm-chart-memory', 'line', {
      type: 'line',
      data: {
        labels: state.tmHistory.timestamps,
        datasets: [
          {
            label: 'Heap Used',
            data: state.tmHistory.heapUsed,
            borderColor: '#3498db',
            backgroundColor: 'rgba(52, 152, 219, 0.1)',
            fill: true,
            borderWidth: 2,
            tension: 0.2,
            pointRadius: 2
          },
          {
            label: 'Heap Max',
            data: state.tmHistory.heapMax,
            borderColor: 'rgba(52, 152, 219, 0.5)',
            borderDash: [5, 5],
            fill: false,
            borderWidth: 1,
            tension: 0,
            pointRadius: 0
          },
          {
            label: 'Non-Heap',
            data: state.tmHistory.nonHeapUsed,
            borderColor: '#9b59b6',
            backgroundColor: 'rgba(155, 89, 182, 0.05)',
            fill: true,
            borderWidth: 1.5,
            tension: 0.2,
            pointRadius: 1
          }
        ]
      },
      options: {
        plugins: {
          legend: { display: true, position: 'top', labels: { boxWidth: 12, color: colors.textColor } }
        },
        scales: {
          y: {
            title: { display: true, text: 'MB', color: colors.textColor },
            beginAtZero: true
          },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    state.tmCharts['tm-chart-memory'].data.labels = state.tmHistory.timestamps;
    state.tmCharts['tm-chart-memory'].data.datasets[0].data = state.tmHistory.heapUsed;
    state.tmCharts['tm-chart-memory'].data.datasets[1].data = state.tmHistory.heapMax;
    state.tmCharts['tm-chart-memory'].data.datasets[2].data = state.tmHistory.nonHeapUsed;
    state.tmCharts['tm-chart-memory'].update();
  }

  // 2. CPU / THREADS CHART
  if (!state.tmCharts['tm-chart-cpu-threads']) {
    tmInitChart('tm-chart-cpu-threads', 'line', {
      type: 'line',
      data: {
        labels: state.tmHistory.timestamps,
        datasets: [
          {
            label: 'CPU Load (%)',
            data: state.tmHistory.cpuLoad,
            borderColor: '#e74c3c',
            yAxisID: 'yCPU',
            borderWidth: 2,
            fill: false,
            tension: 0.3,
            pointRadius: 1
          },
          {
            label: 'Active Threads',
            data: state.tmHistory.threadsActive,
            borderColor: '#2ecc71',
            yAxisID: 'yThreads',
            borderWidth: 2,
            fill: false,
            tension: 0.1,
            pointRadius: 1
          }
        ]
      },
      options: {
        plugins: {
          legend: { display: true, position: 'top', labels: { boxWidth: 12, color: colors.textColor } }
        },
        scales: {
          yCPU: {
            type: 'linear',
            position: 'left',
            min: 0,
            max: 100,
            title: { display: true, text: 'CPU %', color: colors.textColor }
          },
          yThreads: {
            type: 'linear',
            position: 'right',
            beginAtZero: true,
            grid: { drawOnChartArea: false },
            title: { display: true, text: 'Threads Count', color: colors.textColor }
          },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    state.tmCharts['tm-chart-cpu-threads'].data.labels = state.tmHistory.timestamps;
    state.tmCharts['tm-chart-cpu-threads'].data.datasets[0].data = state.tmHistory.cpuLoad;
    state.tmCharts['tm-chart-cpu-threads'].data.datasets[1].data = state.tmHistory.threadsActive;
    state.tmCharts['tm-chart-cpu-threads'].update();
  }

  // 3. DATABASE TRANSACTIONS
  if (!state.tmCharts['tm-chart-db']) {
    tmInitChart('tm-chart-db', 'line', {
      type: 'line',
      data: {
        labels: state.tmHistory.timestamps,
        datasets: [
          { label: 'Selects', data: state.tmHistory.dbSelects, borderColor: '#3498db', borderWidth: 1.5, fill: false, tension: 0.1, pointRadius: 1 },
          { label: 'Inserts', data: state.tmHistory.dbInserts, borderColor: '#2ecc71', borderWidth: 1.5, fill: false, tension: 0.1, pointRadius: 1 },
          { label: 'Updates', data: state.tmHistory.dbUpdates, borderColor: '#f1c40f', borderWidth: 1.5, fill: false, tension: 0.1, pointRadius: 1 },
          { label: 'Deletes', data: state.tmHistory.dbDeletes, borderColor: '#e74c3c', borderWidth: 1.5, fill: false, tension: 0.1, pointRadius: 1 },
          { label: 'Total Tx', data: state.tmHistory.dbTx, borderColor: '#9b59b6', borderWidth: 2, borderDash: [5, 5], fill: false, tension: 0.1, pointRadius: 0 }
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          y: { title: { display: true, text: 'Queries / s', color: colors.textColor }, beginAtZero: true },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    state.tmCharts['tm-chart-db'].data.labels = state.tmHistory.timestamps;
    state.tmCharts['tm-chart-db'].data.datasets[0].data = state.tmHistory.dbSelects;
    state.tmCharts['tm-chart-db'].data.datasets[1].data = state.tmHistory.dbInserts;
    state.tmCharts['tm-chart-db'].data.datasets[2].data = state.tmHistory.dbUpdates;
    state.tmCharts['tm-chart-db'].data.datasets[3].data = state.tmHistory.dbDeletes;
    state.tmCharts['tm-chart-db'].data.datasets[4].data = state.tmHistory.dbTx;
    state.tmCharts['tm-chart-db'].update();
  }

  // 4. REQUESTS AND LATENCY
  if (!state.tmCharts['tm-chart-requests']) {
    tmInitChart('tm-chart-requests', 'line', {
      type: 'line',
      data: {
        labels: state.tmHistory.timestamps,
        datasets: [
          { label: 'Requests/s', data: state.tmHistory.requestsSec, borderColor: '#e67e22', yAxisID: 'yReqs', borderWidth: 2, fill: false, tension: 0.2, pointRadius: 1 },
          { label: 'Latency (ms)', data: state.tmHistory.latencyMs, borderColor: '#9b59b6', yAxisID: 'yLatency', borderWidth: 1.5, fill: false, tension: 0.2, pointRadius: 1 }
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          yReqs: { type: 'linear', position: 'left', beginAtZero: true, title: { display: true, text: 'Reqs/s', color: colors.textColor } },
          yLatency: { type: 'linear', position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'Latency (ms)', color: colors.textColor } },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    state.tmCharts['tm-chart-requests'].data.labels = state.tmHistory.timestamps;
    state.tmCharts['tm-chart-requests'].data.datasets[0].data = state.tmHistory.requestsSec;
    state.tmCharts['tm-chart-requests'].data.datasets[1].data = state.tmHistory.latencyMs;
    state.tmCharts['tm-chart-requests'].update();
  }

  // 5. GARBAGE COLLECTION
  if (!state.tmCharts['tm-chart-gc']) {
    tmInitChart('tm-chart-gc', 'bar', {
      type: 'bar',
      data: {
        labels: state.tmHistory.timestamps,
        datasets: [
          { label: 'GC Count', data: state.tmHistory.gcCounts, backgroundColor: '#f39c12', yAxisID: 'yCount', barThickness: 6 },
          { label: 'GC Duration (ms)', data: state.tmHistory.gcTimes, backgroundColor: '#d35400', yAxisID: 'yTime', barThickness: 6 }
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          yCount: { type: 'linear', position: 'left', beginAtZero: true, ticks: { stepSize: 1 }, title: { display: true, text: 'GC Count', color: colors.textColor } },
          yTime: { type: 'linear', position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'Duration (ms)', color: colors.textColor } },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    state.tmCharts['tm-chart-gc'].data.labels = state.tmHistory.timestamps;
    state.tmCharts['tm-chart-gc'].data.datasets[0].data = state.tmHistory.gcCounts;
    state.tmCharts['tm-chart-gc'].data.datasets[1].data = state.tmHistory.gcTimes;
    state.tmCharts['tm-chart-gc'].update();
  }

  // 6. SESSIONS
  if (!state.tmCharts['tm-chart-sessions']) {
    tmInitChart('tm-chart-sessions', 'line', {
      type: 'line',
      data: {
        labels: state.tmHistory.timestamps,
        datasets: [
          { label: 'Named User Sessions', data: state.tmHistory.sessionsNamed, borderColor: '#3498db', borderWidth: 2, fill: true, backgroundColor: 'rgba(52, 152, 219, 0.1)', tension: 0.1, pointRadius: 1 },
          { label: 'Anonymous Sessions', data: state.tmHistory.sessionsAnon, borderColor: '#95a5a6', borderWidth: 2, fill: true, backgroundColor: 'rgba(149, 165, 166, 0.1)', tension: 0.1, pointRadius: 1 },
          { label: 'Total Named Users', data: state.tmHistory.sessionsNamedTotal, borderColor: '#2ecc71', borderWidth: 2, borderDash: [5, 5], fill: false, tension: 0.1, pointRadius: 0 }
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          y: { title: { display: true, text: 'Count', color: colors.textColor }, beginAtZero: true, ticks: { stepSize: 1 } },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    state.tmCharts['tm-chart-sessions'].data.labels = state.tmHistory.timestamps;
    state.tmCharts['tm-chart-sessions'].data.datasets[0].data = state.tmHistory.sessionsNamed;
    state.tmCharts['tm-chart-sessions'].data.datasets[1].data = state.tmHistory.sessionsAnon;
    state.tmCharts['tm-chart-sessions'].data.datasets[2].data = state.tmHistory.sessionsNamedTotal;
    state.tmCharts['tm-chart-sessions'].update();
  }

  // 7. TASK QUEUES
  if (!state.tmCharts['tm-chart-taskqueues']) {
    tmInitChart('tm-chart-taskqueues', 'line', {
      type: 'line',
      data: {
        labels: state.tmHistory.timestamps,
        datasets: []
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          y: { title: { display: true, text: 'Active Threads', color: colors.textColor }, beginAtZero: true, ticks: { stepSize: 1 } },
          x: { grid: { display: false } }
        }
      }
    });
  }
  
  if (state.tmCharts['tm-chart-taskqueues']) {
    let qKeys = Object.keys(state.tmHistory.taskQueues);
    let datasets = qKeys.map((q, idx) => {
      const lineColors = ['#f1c40f', '#e67e22', '#e74c3c', '#9b59b6', '#34495e'];
      return {
        label: q,
        data: state.tmHistory.taskQueues[q],
        borderColor: lineColors[idx % lineColors.length],
        borderWidth: 2,
        fill: false,
        tension: 0.1,
        pointRadius: 1
      };
    });
    state.tmCharts['tm-chart-taskqueues'].data.labels = state.tmHistory.timestamps;
    state.tmCharts['tm-chart-taskqueues'].data.datasets = datasets;
    state.tmCharts['tm-chart-taskqueues'].update();
  }

  // 8. BACKGROUND TASKS
  if (!state.tmCharts['tm-chart-tasks']) {
    tmInitChart('tm-chart-tasks', 'bar', {
      type: 'bar',
      data: {
        labels: state.tmHistory.maxTasksLabels,
        datasets: [
          { label: 'Max Execution Time (s)', data: state.tmHistory.maxTasksValues, backgroundColor: '#3498db', barThickness: 20 }
        ]
      },
      options: {
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: { title: { display: true, text: 'Time (seconds)', color: colors.textColor }, beginAtZero: true },
          y: { grid: { display: false } }
        }
      }
    });
  } else {
    state.tmCharts['tm-chart-tasks'].data.labels = state.tmHistory.maxTasksLabels;
    state.tmCharts['tm-chart-tasks'].data.datasets[0].data = state.tmHistory.maxTasksValues;
    state.tmCharts['tm-chart-tasks'].update();
  }

  // 9. Database Connection Pool
  if (!state.tmCharts['tm-chart-dbpool']) {
    tmInitChart('tm-chart-dbpool', 'line', {
      type: 'line',
      data: {
        labels: state.tmHistory.timestamps,
        datasets: [
          { label: 'Active', data: state.tmHistory.poolActive, borderColor: '#e74c3c', borderWidth: 2, fill: false, tension: 0.1, pointRadius: 1 },
          { label: 'Idle', data: state.tmHistory.poolIdle, borderColor: '#2ecc71', borderWidth: 2, fill: false, tension: 0.1, pointRadius: 1 },
          { label: 'Waiters', data: state.tmHistory.poolWaiters, borderColor: '#f1c40f', borderWidth: 2, borderDash: [5, 5], fill: true, backgroundColor: 'rgba(241, 196, 15, 0.2)', tension: 0.1, pointRadius: 1 }
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          y: { title: { display: true, text: 'Connections / Threads', color: colors.textColor }, beginAtZero: true, ticks: { stepSize: 1 } },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    state.tmCharts['tm-chart-dbpool'].data.labels = state.tmHistory.timestamps;
    state.tmCharts['tm-chart-dbpool'].data.datasets[0].data = state.tmHistory.poolActive;
    state.tmCharts['tm-chart-dbpool'].data.datasets[1].data = state.tmHistory.poolIdle;
    state.tmCharts['tm-chart-dbpool'].data.datasets[2].data = state.tmHistory.poolWaiters;
    state.tmCharts['tm-chart-dbpool'].update();
  }

  // 10. HTTP Server Connections
  if (!state.tmCharts['tm-chart-httpconns']) {
    tmInitChart('tm-chart-httpconns', 'line', {
      type: 'line',
      data: {
        labels: state.tmHistory.timestamps,
        datasets: [
          { label: 'Current', data: state.tmHistory.httpConns, borderColor: '#3498db', borderWidth: 2, fill: true, backgroundColor: 'rgba(52, 152, 219, 0.2)', tension: 0.1, pointRadius: 1 },
          { label: 'Max', data: state.tmHistory.httpConnsMax, borderColor: '#e67e22', borderWidth: 2, borderDash: [5, 5], fill: false, tension: 0.1, pointRadius: 0 }
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          y: { title: { display: true, text: 'Connections', color: colors.textColor }, beginAtZero: true, ticks: { stepSize: 1 } },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    state.tmCharts['tm-chart-httpconns'].data.labels = state.tmHistory.timestamps;
    state.tmCharts['tm-chart-httpconns'].data.datasets[0].data = state.tmHistory.httpConns;
    state.tmCharts['tm-chart-httpconns'].data.datasets[1].data = state.tmHistory.httpConnsMax;
    state.tmCharts['tm-chart-httpconns'].update();
  }

  // 11. Network Traffic Rate
  if (!state.tmCharts['tm-chart-network']) {
    tmInitChart('tm-chart-network', 'line', {
      type: 'line',
      data: {
        labels: state.tmHistory.timestamps,
        datasets: [
          { label: 'Inbound (KB/s)', data: state.tmHistory.netInSec, borderColor: '#2ecc71', borderWidth: 2, fill: true, backgroundColor: 'rgba(46, 204, 113, 0.1)', tension: 0.2, pointRadius: 1 },
          { label: 'Outbound (KB/s)', data: state.tmHistory.netOutSec, borderColor: '#9b59b6', borderWidth: 2, fill: true, backgroundColor: 'rgba(155, 89, 182, 0.1)', tension: 0.2, pointRadius: 1 }
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          y: { title: { display: true, text: 'KB / s', color: colors.textColor }, beginAtZero: true },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    state.tmCharts['tm-chart-network'].data.labels = state.tmHistory.timestamps;
    state.tmCharts['tm-chart-network'].data.datasets[0].data = state.tmHistory.netInSec;
    state.tmCharts['tm-chart-network'].data.datasets[1].data = state.tmHistory.netOutSec;
    state.tmCharts['tm-chart-network'].update();
  }

  // 12. Task Queue Wait Times
  if (!state.tmCharts['tm-chart-taskwaits']) {
    tmInitChart('tm-chart-taskwaits', 'line', {
      type: 'line',
      data: {
        labels: state.tmHistory.timestamps,
        datasets: [
          { label: 'Max Wait Time (s)', data: state.tmHistory.queueWaitMax, borderColor: '#e74c3c', borderWidth: 2, fill: true, backgroundColor: 'rgba(231, 76, 60, 0.2)', tension: 0.1, pointRadius: 2 }
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          y: { title: { display: true, text: 'Seconds', color: colors.textColor }, beginAtZero: true },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    state.tmCharts['tm-chart-taskwaits'].data.labels = state.tmHistory.timestamps;
    state.tmCharts['tm-chart-taskwaits'].data.datasets[0].data = state.tmHistory.queueWaitMax;
    state.tmCharts['tm-chart-taskwaits'].update();
  }

  // 13. JVM Thread States
  if (!state.tmCharts['tm-chart-threadstates']) {
    tmInitChart('tm-chart-threadstates', 'bar', {
      type: 'bar',
      data: {
        labels: state.tmHistory.timestamps,
        datasets: [
          { label: 'Runnable', data: state.tmHistory.threadRunnable, backgroundColor: '#2ecc71' },
          { label: 'Waiting', data: state.tmHistory.threadWaiting, backgroundColor: '#f1c40f' },
          { label: 'Blocked', data: state.tmHistory.threadBlocked, backgroundColor: '#e74c3c' }
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Thread Count', color: colors.textColor } }
        }
      }
    });
  } else {
    state.tmCharts['tm-chart-threadstates'].data.labels = state.tmHistory.timestamps;
    state.tmCharts['tm-chart-threadstates'].data.datasets[0].data = state.tmHistory.threadRunnable;
    state.tmCharts['tm-chart-threadstates'].data.datasets[1].data = state.tmHistory.threadWaiting;
    state.tmCharts['tm-chart-threadstates'].data.datasets[2].data = state.tmHistory.threadBlocked;
    state.tmCharts['tm-chart-threadstates'].update();
  }

  // 14. JVM Off-Heap Buffers & Allocation
  if (!state.tmCharts['tm-chart-jvmextra']) {
    tmInitChart('tm-chart-jvmextra', 'line', {
      type: 'line',
      data: {
        labels: state.tmHistory.timestamps,
        datasets: [
          { label: 'Direct Buffer Used (MB)', data: state.tmHistory.bufferUsed, borderColor: '#e67e22', yAxisID: 'yLeft', borderWidth: 2, fill: false, tension: 0.1, pointRadius: 1 },
          { label: 'Loaded Classes (k)', data: state.tmHistory.classesLoaded, borderColor: '#95a5a6', yAxisID: 'yLeft', borderWidth: 2, borderDash: [5, 5], fill: false, tension: 0.1, pointRadius: 0 },
          { label: 'Alloc Rate (MB/s)', data: state.tmHistory.allocRate, borderColor: '#3498db', yAxisID: 'yRight', borderWidth: 2, fill: true, backgroundColor: 'rgba(52, 152, 219, 0.1)', tension: 0.2, pointRadius: 1 }
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: colors.textColor } } },
        scales: {
          yLeft: { type: 'linear', position: 'left', beginAtZero: true, title: { display: true, text: 'MB / Count', color: colors.textColor } },
          yRight: { type: 'linear', position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'MB / s', color: colors.textColor } },
          x: { grid: { display: false } }
        }
      }
    });
  } else {
    state.tmCharts['tm-chart-jvmextra'].data.labels = state.tmHistory.timestamps;
    state.tmCharts['tm-chart-jvmextra'].data.datasets[0].data = state.tmHistory.bufferUsed;
    state.tmCharts['tm-chart-jvmextra'].data.datasets[1].data = state.tmHistory.classesLoaded;
    state.tmCharts['tm-chart-jvmextra'].data.datasets[2].data = state.tmHistory.allocRate;
    state.tmCharts['tm-chart-jvmextra'].update();
  }

  // Dynamic grid update
  for (let c in state.tmCharts) {
    if (state.tmCharts[c]) {
      const scales = state.tmCharts[c].options.scales;
      for (let s in scales) {
        if (scales[s].grid) scales[s].grid.color = colors.gridColor;
        if (scales[s].ticks) scales[s].ticks.color = colors.textColor;
      }
      if (state.tmCharts[c].options.plugins.legend && state.tmCharts[c].options.plugins.legend.labels) {
        state.tmCharts[c].options.plugins.legend.labels.color = colors.textColor;
      }
      state.tmCharts[c].options.plugins.tooltip.backgroundColor = colors.tooltipBg;
      state.tmCharts[c].options.plugins.tooltip.titleColor = colors.tooltipColor;
      state.tmCharts[c].options.plugins.tooltip.borderColor = colors.tooltipBorder;
      state.tmCharts[c].update('none');
    }
  }
}

