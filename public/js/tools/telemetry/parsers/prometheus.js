export function tmParsePrometheusText(text) {
  const lines = text.split('\n');
  const metrics = {};

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\{([^}]+)\})?\s+([eE0-9.+-]+|NaN|-?Infinity)(?:\s+\d+)?$/i);
    if (!match) continue;

    const name = match[1];
    const labelsStr = match[2];
    const val = parseFloat(match[3]);

    const labels = {};
    if (labelsStr) {
      const parts = labelsStr.split(',');
      for (let p of parts) {
        const lp = p.split('=');
        if (lp.length === 2) {
          const lKey = lp[0].trim();
          const lVal = lp[1].trim().replace(/^"|"$/g, '');
          labels[lKey] = lVal;
        }
      }
    }

    if (!metrics[name]) {
      metrics[name] = [];
    }
    metrics[name].push({ value: val, labels: labels });
  }

  return metrics;
}

export function tmGetMetricValue(parsedMetrics, name, labelFilters = {}) {
  const list = parsedMetrics[name];
  if (!list) return null;

  for (let item of list) {
    let match = true;
    for (let k in labelFilters) {
      if (item.labels[k] !== labelFilters[k]) {
        match = false;
        break;
      }
    }
    if (match) return item.value;
  }
  
  return list[0].value;
}

export function tmGetMetricSum(parsedMetrics, name, labelFilters = {}) {
  const list = parsedMetrics[name];
  if (!list) return null;
  let sum = 0;
  let found = false;
  for (let item of list) {
    let match = true;
    for (let k in labelFilters) {
      if (item.labels[k] !== labelFilters[k]) {
        match = false;
        break;
      }
    }
    if (match && item.value > 0) { // ignore -1 max values
      sum += item.value;
      found = true;
    }
  }
  return found ? sum : null;
}

