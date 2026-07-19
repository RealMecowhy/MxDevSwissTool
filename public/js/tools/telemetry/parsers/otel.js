export function tmParseOtelMetrics(payload) {
  const parsed = {};
  if (!payload || !payload.resourceMetrics) return parsed;

  function addMetricVal(name, value, labels) {
    if (value === null || value === undefined || isNaN(value)) return;
    if (!parsed[name]) {
      parsed[name] = [];
    }
    parsed[name].push({ value: parseFloat(value), labels: labels });
  }

  payload.resourceMetrics.forEach(rm => {
    if (!rm.scopeMetrics) return;
    rm.scopeMetrics.forEach(sm => {
      if (!sm.metrics) return;
      sm.metrics.forEach(metric => {
        if (!metric.name) return;

        // Base name with dots replaced by underscores
        const baseName = metric.name.replace(/\./g, '_');
        
        // Find data points
        const dps = (metric.gauge && metric.gauge.dataPoints) ||
                    (metric.sum && metric.sum.dataPoints) ||
                    (metric.histogram && metric.histogram.dataPoints) ||
                    (metric.summary && metric.summary.dataPoints) ||
                    [];

        dps.forEach(dp => {
          // Extract labels
          const labels = {};
          if (dp.attributes) {
            dp.attributes.forEach(attr => {
              const val = attr.value;
              let strVal = '';
              if (val) {
                if (val.stringValue !== undefined) strVal = val.stringValue;
                else if (val.intValue !== undefined) strVal = val.intValue;
                else if (val.boolValue !== undefined) strVal = val.boolValue;
                else if (val.doubleValue !== undefined) strVal = val.doubleValue;
                else strVal = String(val);
              }
              labels[attr.key] = strVal;
            });
          }

          // Extract value
          const val = dp.asDouble !== undefined ? dp.asDouble :
                      (dp.asInt !== undefined ? dp.asInt :
                      (dp.value !== undefined ? dp.value : null));

          // If it is a histogram or summary, we might have count and sum instead of a single value
          if (metric.histogram || metric.summary) {
            const count = dp.count !== undefined ? dp.count : null;
            const sum = dp.sum !== undefined ? dp.sum : null;

            if (count !== null) {
              addMetricVal(`${baseName}_count`, count, labels);
              addMetricVal(`${baseName}_total`, count, labels);
              addMetricVal(`${baseName}_seconds_count`, count, labels);
            }
            if (sum !== null) {
              addMetricVal(`${baseName}_sum`, sum, labels);
              addMetricVal(`${baseName}_seconds_sum`, sum, labels);
            }
            if (dp.max !== undefined && dp.max !== null) {
              addMetricVal(`${baseName}_max`, dp.max, labels);
              addMetricVal(`${baseName}_seconds_max`, dp.max, labels);
            }
          } else {
            // Gauge or Sum
            addMetricVal(baseName, val, labels);

            // Add standard aliases/suffixes to match what Prometheus dashboard expects
            addMetricVal(`${baseName}_total`, val, labels);
            
            // JVM Memory / buffer units
            if (baseName.includes('memory') || baseName.includes('buffer')) {
              addMetricVal(`${baseName}_bytes`, val, labels);
            }
            
            // Network bytes
            if (baseName.includes('bytes_in') || baseName.includes('bytes_out')) {
              addMetricVal(`${baseName}_bytes_sum`, val, labels);
            }
          }
        });
      });
    });
  });

  // Additional custom mappings/aliases for standard Micrometer / JVM metrics
  // to perfectly match Prometheus metrics dashboard expectations
  const mappings = {
    'jvm_memory_used': ['jvm_memory_used_bytes'],
    'jvm_memory_committed': ['jvm_memory_committed_bytes'],
    'jvm_memory_max': ['jvm_memory_max_bytes'],
    'jvm_buffer_memory_used': ['jvm_buffer_memory_used_bytes'],
    'jvm_gc_memory_allocated': ['jvm_gc_memory_allocated_bytes_total'],
    'jvm_threads_states': ['jvm_threads_states_threads'],
    'jvm_threads_live': ['jvm_threads_live_threads'],
    'jvm_threads_peak': ['jvm_threads_peak_threads'],
    'jvm_classes_loaded': ['jvm_classes_loaded_classes'],
    'jetty_connections_current': ['jetty_connections_current_connections'],
    'jetty_connections_max': ['jetty_connections_max_connections'],
    'jetty_connections_bytes_in': ['jetty_connections_bytes_in_bytes_sum'],
    'jetty_connections_bytes_out': ['jetty_connections_bytes_out_bytes_sum'],
    'jetty_threads_active': ['jetty_threads_active'],
    'jetty_threads_limit': ['jetty_threads_limit']
  };

  for (const src in mappings) {
    if (parsed[src]) {
      mappings[src].forEach(target => {
        if (!parsed[target]) {
          parsed[target] = parsed[src];
        }
      });
    }
  }

  return parsed;
}

