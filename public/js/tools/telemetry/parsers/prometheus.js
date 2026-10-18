// Prometheus text exposition format, one sample per line:
//   name{label="value",...} value [timestamp]
// Label values are quoted strings with \\ \" \n escapes, so a comma, '=' or '}'
// inside one is part of the value — a split on those characters misreads
// uri="/api/{id}" and label="a,b=c". Names may contain ':' (recording rules).
function tmParsePromLine(line) {
  const nameMatch = /^[a-zA-Z_:][a-zA-Z0-9_:]*/.exec(line);
  if (!nameMatch) return null;
  const name = nameMatch[0];
  let i = name.length;
  const labels = Object.create(null);

  if (line[i] === '{') {
    i++;
    for (;;) {
      while (line[i] === ' ' || line[i] === '\t') i++;
      if (line[i] === '}') { i++; break; }
      const key = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(line.slice(i));
      if (!key) return null;
      i += key[0].length;
      while (line[i] === ' ' || line[i] === '\t') i++;
      if (line[i] !== '=') return null;
      i++;
      while (line[i] === ' ' || line[i] === '\t') i++;
      if (line[i] !== '"') return null;
      i++;
      let val = '';
      for (;;) {
        if (i >= line.length) return null;            // unterminated value
        const c = line[i];
        if (c === '"') { i++; break; }
        if (c === '\\') {
          const n = line[i + 1];
          if (n === 'n') val += '\n';
          else if (n === '\\' || n === '"') val += n;
          else val += '\\' + (n === undefined ? '' : n);
          i += 2;
          continue;
        }
        val += c;
        i++;
      }
      labels[key[0]] = val;
      while (line[i] === ' ' || line[i] === '\t') i++;
      if (line[i] === ',') { i++; continue; }
      if (line[i] === '}') { i++; break; }
      return null;
    }
  }

  const rest = line.slice(i).trim().split(/\s+/);
  if (rest.length < 1 || rest.length > 2 || !rest[0]) return null;
  if (rest.length === 2 && !/^-?\d+$/.test(rest[1])) return null;   // optional timestamp
  const raw = rest[0];
  let value;
  if (/^nan$/i.test(raw)) value = NaN;
  else if (/^\+?inf(inity)?$/i.test(raw)) value = Infinity;
  else if (/^-inf(inity)?$/i.test(raw)) value = -Infinity;
  else if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) value = parseFloat(raw);
  else return null;
  return { name: name, labels: labels, value: value };
}

// metrics has no prototype: a metric called `constructor` or `__proto__` is a
// name like any other, not a property of Object.
export function tmParsePrometheusTextDetailed(text) {
  const metrics = Object.create(null);
  let rejected = 0;

  for (let line of String(text).split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const s = tmParsePromLine(line);
    if (!s) { rejected++; continue; }
    if (!metrics[s.name]) metrics[s.name] = [];
    metrics[s.name].push({ value: s.value, labels: s.labels });
  }

  return { metrics: metrics, rejected: rejected };
}

export function tmParsePrometheusText(text) {
  return tmParsePrometheusTextDetailed(text).metrics;
}

function labelsMatch(item, labelFilters) {
  for (const k in labelFilters) {
    if (item.labels[k] !== labelFilters[k]) return false;
  }
  return true;
}

// A value of NaN or +-Inf is the exporter saying "no measurement" (a CPU gauge
// before its first sample is NaN), so it counts as absent.
//
// With a label filter, no matching series is `null`: falling back to the first
// series answered "how many busy threads?" with the idle count.
export function tmGetMetricValue(parsedMetrics, name, labelFilters = {}) {
  const list = parsedMetrics[name];
  if (!list) return null;

  for (const item of list) {
    if (labelsMatch(item, labelFilters)) return Number.isFinite(item.value) ? item.value : null;
  }

  return null;
}

// Sum over the matching series. Only a negative value is skipped (-1 is how a
// max is reported when there is no limit); 0 is a real result.
export function tmGetMetricSum(parsedMetrics, name, labelFilters = {}) {
  const list = parsedMetrics[name];
  if (!list) return null;
  let sum = 0;
  let found = false;
  for (const item of list) {
    if (labelsMatch(item, labelFilters) && Number.isFinite(item.value) && item.value >= 0) {
      sum += item.value;
      found = true;
    }
  }
  return found ? sum : null;
}
