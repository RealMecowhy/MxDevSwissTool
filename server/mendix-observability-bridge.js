// =========================================================================
// MENDIX OBSERVABILITY BRIDGE (Zero-Dependency Local Agent)
// =========================================================================
// This script runs locally in your Mendix project root directory.
// It watches the Mendix application log file and connects to PostgreSQL
// using the command-line 'psql' client to scrape live database metrics.
//
// Run it with: node mendix-observability-bridge.js
// =========================================================================

"use strict";

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { Client } = require('pg');
const crypto = require('crypto');

const PORT = 9999;

// =========================================================================
// SECURITY / CORS / TOKEN / BODY LIMITS
// =========================================================================
const ALLOWED_ORIGINS = [
  'http://localhost:9999',
  'http://127.0.0.1:9999'
];

function corsHeaders(req) {
  const origin = req.headers ? (req.headers.origin || '') : '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Bridge-Token',
    'Vary': 'Origin'
  };
}

const BRIDGE_TOKEN = crypto.randomBytes(24).toString('hex');
try {
  fs.writeFileSync('.bridge-token', BRIDGE_TOKEN);
} catch (e) {}

function requireToken(req, res) {
  const provided = req.headers['x-bridge-token'];
  if (provided !== BRIDGE_TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders(req) });
    res.end(JSON.stringify({ error: true, message: 'Unauthorized: missing or invalid X-Bridge-Token' }));
    return false;
  }
  return true;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

function readBody(req, res, maxBytes, onComplete) {
  let size = 0;
  const chunks = [];
  req.on('data', chunk => {
    size += chunk.length;
    if (size > maxBytes) {
      req.destroy();
      res.writeHead(413, { 'Content-Type': 'application/json', ...corsHeaders(req) });
      res.end(JSON.stringify({ error: true, message: `Payload too large (max ${maxBytes} bytes)` }));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (size <= maxBytes) onComplete(Buffer.concat(chunks));
  });
}


// Log File State
let logFilePath = '';
let lastLogSize = 0;
let logBuffer = []; // In-memory queue of recent log lines (max 1000)
let logFileWatcher = null;

// =========================================================================
// OPENTELEMETRY RECEIVER (OTLP HTTP JSON)
// =========================================================================
const OTLP_PORT = 4318;
let otelTraceBuffer = [];
let otelLogBuffer = [];
let otelMetricBuffer = [];
let otelTracesCount = 0;
let otelLogsCount = 0;
let otelMetricsCount = 0;

// Mock Server State
let mockConfig = { status: '200 OK', payload: '{"status":"ok"}', delay: 200, chaos: false };

// =========================================================================
// CUSTOM DECODER FOR OTLP PROTOBUF (Dependency-Free)
// =========================================================================

function readVarint(buffer, offset) {
  let val = 0n;
  let shift = 0n;
  while (offset < buffer.length) {
    const byte = buffer[offset++];
    val |= BigInt(byte & 0x7F) << shift;
    if (!(byte & 0x80)) break;
    shift += 7n;
  }
  return { value: val, offset };
}

function decodeProtobufRaw(buffer, start = 0, end = buffer.length) {
  const result = {};
  let offset = start;
  while (offset < end) {
    const { value: key, offset: newOffset } = readVarint(buffer, offset);
    offset = newOffset;
    const wireType = Number(key & 7n);
    const fieldNumber = Number(key >> 3n);
    
    let fieldValue;
    if (wireType === 0) { // Varint
      const { value: val, offset: nextOffset } = readVarint(buffer, offset);
      offset = nextOffset;
      fieldValue = val;
    } else if (wireType === 1) { // 64-bit
      fieldValue = buffer.subarray(offset, offset + 8);
      offset += 8;
    } else if (wireType === 2) { // Length-delimited
      const { value: len, offset: nextOffset } = readVarint(buffer, offset);
      offset = nextOffset;
      const length = Number(len);
      fieldValue = buffer.subarray(offset, offset + length);
      offset += length;
    } else if (wireType === 5) { // 32-bit
      fieldValue = buffer.subarray(offset, offset + 4);
      offset += 4;
    } else {
      throw new Error(`Unsupported wire type: ${wireType} at offset ${offset}`);
    }
    
    if (!result[fieldNumber]) {
      result[fieldNumber] = [];
    }
    result[fieldNumber].push(fieldValue);
  }
  return result;
}

function mapAnyValue(raw) {
  if (!raw) return null;
  const fields = decodeProtobufRaw(raw);
  if (fields[1]) return { stringValue: fields[1][0].toString('utf8') };
  if (fields[2]) return { boolValue: fields[2][0] !== 0n };
  if (fields[3]) return { intValue: fields[3][0].toString() };
  if (fields[4]) return { doubleValue: Buffer.from(fields[4][0]).readDoubleLE(0) };
  if (fields[5]) { // arrayValue
    const arrFields = decodeProtobufRaw(fields[5][0]);
    const values = (arrFields[1] || []).map(val => mapAnyValue(val));
    return { arrayValue: { values } };
  }
  if (fields[6]) { // kvlistValue
    const kvFields = decodeProtobufRaw(fields[6][0]);
    const values = (kvFields[1] || []).map(kv => mapKeyValue(kv));
    return { kvlistValue: { values } };
  }
  return null;
}

function mapKeyValue(raw) {
  const fields = decodeProtobufRaw(raw);
  const key = fields[1] ? fields[1][0].toString('utf8') : '';
  const value = fields[2] ? mapAnyValue(fields[2][0]) : null;
  return { key, value };
}

function mapStatus(raw) {
  if (!raw) return null;
  const fields = decodeProtobufRaw(raw);
  return {
    message: fields[1] ? fields[1][0].toString('utf8') : '',
    code: fields[2] ? Number(fields[2][0]) : 0
  };
}

function mapSpanEvent(raw) {
  const fields = decodeProtobufRaw(raw);
  const timeUnixNano = fields[1] ? Buffer.from(fields[1][0]).readBigUInt64LE(0).toString() : '0';
  const name = fields[2] ? fields[2][0].toString('utf8') : '';
  const attributes = (fields[3] || []).map(kv => mapKeyValue(kv));
  return { timeUnixNano, name, attributes };
}

function mapSpan(raw) {
  const fields = decodeProtobufRaw(raw);
  return {
    traceId: fields[1] ? fields[1][0].toString('hex') : '',
    spanId: fields[2] ? fields[2][0].toString('hex') : '',
    traceState: fields[3] ? fields[3][0].toString('utf8') : '',
    parentSpanId: fields[4] ? fields[4][0].toString('hex') : '',
    name: fields[5] ? fields[5][0].toString('utf8') : '',
    kind: fields[6] ? Number(fields[6][0]) : 0,
    startTimeUnixNano: fields[7] ? Buffer.from(fields[7][0]).readBigUInt64LE(0).toString() : '0',
    endTimeUnixNano: fields[8] ? Buffer.from(fields[8][0]).readBigUInt64LE(0).toString() : '0',
    attributes: (fields[9] || []).map(kv => mapKeyValue(kv)),
    events: (fields[10] || []).map(ev => mapSpanEvent(ev)),
    status: fields[13] ? mapStatus(fields[13][0]) : null
  };
}

function mapInstrumentationScope(raw) {
  if (!raw) return null;
  const fields = decodeProtobufRaw(raw);
  return {
    name: fields[1] ? fields[1][0].toString('utf8') : '',
    version: fields[2] ? fields[2][0].toString('utf8') : ''
  };
}

function mapScopeSpans(raw) {
  const fields = decodeProtobufRaw(raw);
  return {
    scope: fields[1] ? mapInstrumentationScope(fields[1][0]) : null,
    spans: (fields[2] || []).map(sp => mapSpan(sp))
  };
}

function mapResource(raw) {
  if (!raw) return null;
  const fields = decodeProtobufRaw(raw);
  return {
    attributes: (fields[1] || []).map(kv => mapKeyValue(kv))
  };
}

function mapResourceSpans(raw) {
  const fields = decodeProtobufRaw(raw);
  return {
    resource: fields[1] ? mapResource(fields[1][0]) : null,
    scopeSpans: (fields[2] || []).map(ss => mapScopeSpans(ss))
  };
}

function mapTracesProtobufToJson(buffer) {
  const fields = decodeProtobufRaw(buffer);
  const resourceSpans = (fields[1] || []).map(rs => mapResourceSpans(rs));
  return { resourceSpans };
}

function mapLogRecord(raw) {
  const fields = decodeProtobufRaw(raw);
  return {
    timeUnixNano: fields[1] ? Buffer.from(fields[1][0]).readBigUInt64LE(0).toString() : '0',
    severityNumber: fields[2] ? Number(fields[2][0]) : 0,
    severityText: fields[3] ? fields[3][0].toString('utf8') : '',
    body: fields[5] ? mapAnyValue(fields[5][0]) : null,
    attributes: (fields[6] || []).map(kv => mapKeyValue(kv)),
    traceId: fields[9] ? fields[9][0].toString('hex') : '',
    spanId: fields[10] ? fields[10][0].toString('hex') : '',
    observedTimeUnixNano: fields[11] ? Buffer.from(fields[11][0]).readBigUInt64LE(0).toString() : '0'
  };
}

function mapScopeLogs(raw) {
  const fields = decodeProtobufRaw(raw);
  return {
    scope: fields[1] ? mapInstrumentationScope(fields[1][0]) : null,
    logRecords: (fields[2] || []).map(lr => mapLogRecord(lr))
  };
}

function mapResourceLogs(raw) {
  const fields = decodeProtobufRaw(raw);
  return {
    resource: fields[1] ? mapResource(fields[1][0]) : null,
    scopeLogs: (fields[2] || []).map(sl => mapScopeLogs(sl))
  };
}

function mapLogsProtobufToJson(buffer) {
  const fields = decodeProtobufRaw(buffer);
  const resourceLogs = (fields[1] || []).map(rl => mapResourceLogs(rl));
  return { resourceLogs };
}

// =========================================================================
// REQUEST HANDLER
// =========================================================================

function handleOtlpRequest(req, res, buffer) {
  readBody(req, res, 20 * 1024 * 1024, (rawBody) => {
    try {
      let payload = null;
      let formatStr = 'Unknown';

      if (rawBody.length > 0) {
        const contentType = (req.headers['content-type'] || '').toLowerCase();
        if (contentType.includes('application/json')) {
          payload = JSON.parse(rawBody.toString('utf8'));
          formatStr = 'JSON';
        } else {
          // Fall back to Protobuf
          formatStr = 'Protobuf';
          if (buffer === otelTraceBuffer) {
            payload = mapTracesProtobufToJson(rawBody);
          } else if (buffer === otelLogBuffer) {
            payload = mapLogsProtobufToJson(rawBody);
          } else {
            payload = {};
          }
        }

        buffer.push({ timestamp: Date.now(), payload });
        if (buffer.length > 50) buffer.shift(); // Keep last 50 payloads
      }
      
      let typeStr = 'unknown';
      let count = 0;
      
      if (buffer === otelTraceBuffer) {
        typeStr = 'Traces';
        otelTracesCount++;
        if (payload && payload.resourceSpans) {
          payload.resourceSpans.forEach(rs => {
            if (rs.scopeSpans) {
              rs.scopeSpans.forEach(ss => {
                if (ss.spans) count += ss.spans.length;
              });
            }
          });
        }
      }
      else if (buffer === otelLogBuffer) {
        typeStr = 'Logs';
        otelLogsCount++;
        if (payload && payload.resourceLogs) {
          payload.resourceLogs.forEach(rl => {
            if (rl.scopeLogs) {
              rl.scopeLogs.forEach(sl => {
                if (sl.logRecords) count += sl.logRecords.length;
              });
            }
          });
        }
      }
      else if (buffer === otelMetricBuffer) {
        typeStr = 'Metrics';
        otelMetricsCount++;
      }
      
      console.log(`[Bridge OTLP] Successfully received ${typeStr} via ${formatStr} (items count: ${count}). Total requests: Traces=${otelTracesCount}, Logs=${otelLogsCount}`);
      
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...corsHeaders(req)
      });
      res.end(JSON.stringify({}));
    } catch (e) {
      console.error(`[Bridge OTLP] Failed to parse OTLP payload on ${req.url}: ${e.message}`);
      res.writeHead(400, {
        'Content-Type': 'application/json',
        ...corsHeaders(req)
      });
      res.end(JSON.stringify({ error: 'Invalid payload format' }));
    }
  });
}

const otlpServer = http.createServer((req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  // Parse path
  const pathOnly = req.url.split('?')[0];
  console.log(`[Bridge OTLP] Incoming ${req.method} request on path: ${req.url}`);

  // Handle OTLP paths
  if (req.method === 'POST' && pathOnly === '/v1/traces') {
    return handleOtlpRequest(req, res, otelTraceBuffer);
  }
  if (req.method === 'POST' && pathOnly === '/v1/logs') {
    return handleOtlpRequest(req, res, otelLogBuffer);
  }
  if (req.method === 'POST' && pathOnly === '/v1/metrics') {
    return handleOtlpRequest(req, res, otelMetricBuffer);
  }
  
  console.log(`[Bridge OTLP] 404 Not Found for path: ${req.url}`);
  res.writeHead(404);
  res.end();
});


// =========================================================================
// LOG FILE WATCHING (Tailing)
// =========================================================================

function initializeLogWatcher() {
  if (logFileWatcher) {
    logFileWatcher.close();
    logFileWatcher = null;
  }

  if (!logFilePath) {
    console.log('[Bridge] Scanning project directories to auto-detect Mendix log file...');
    const workspaceRoot = process.cwd();
    const possibleLogPaths = [
      path.join(workspaceRoot, 'deployment', 'log', 'node1.log'),
      path.join(workspaceRoot, 'deployment', 'log', 'runtime.log'),
      path.join(workspaceRoot, 'deployment', 'log', 'app.log')
    ];
    for (const p of possibleLogPaths) {
      if (fs.existsSync(p)) {
        logFilePath = p;
        console.log(`[Bridge] Auto-detected log file at: ${logFilePath}`);
        break;
      }
    }
  }

  if (!logFilePath || !fs.existsSync(logFilePath)) {
    console.warn('[Bridge] Warning: No active Mendix runtime log file found in standard directories.');
    return;
  }

  try {
    const stats = fs.statSync(logFilePath);
    lastLogSize = stats.size;
    
    // Read the last 50 lines to populate initial buffer
    const stream = fs.createReadStream(logFilePath, {
      start: Math.max(0, lastLogSize - 15000), // grab roughly the last 15KB
      end: lastLogSize
    });

    let data = '';
    stream.on('data', chunk => data += chunk);
    stream.on('end', () => {
      const lines = data.split(/\r?\n/).filter(Boolean);
      logBuffer = lines.slice(-200).map(line => ({
        timestamp: Date.now(),
        text: line
      }));
      console.log(`[Bridge] Initialized log buffer with ${logBuffer.length} historical lines.`);
    });

    // Set up file change listener
    logFileWatcher = fs.watch(logFilePath, (event) => {
      if (event === 'change') {
        readNewLogLines();
      }
    });

    console.log(`[Bridge] Watching log file: ${logFilePath}`);
  } catch (e) {
    console.error(`[Bridge] Error setting up log watcher: ${e.message}`);
  }
}

function readNewLogLines() {
  if (!logFilePath || !fs.existsSync(logFilePath)) return;

  try {
    const stats = fs.statSync(logFilePath);
    const newSize = stats.size;

    if (newSize < lastLogSize) {
      // File truncated (e.g. log rotated or cleared)
      console.log('[Bridge] Log file rotated or truncated.');
      lastLogSize = 0;
    }

    if (newSize > lastLogSize) {
      const length = newSize - lastLogSize;
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(logFilePath, 'r');
      
      fs.readSync(fd, buffer, 0, length, lastLogSize);
      fs.closeSync(fd);

      lastLogSize = newSize;

      const newText = buffer.toString('utf8');
      const newLines = newText.split(/\r?\n/).filter(Boolean);
      
      const ts = Date.now();
      newLines.forEach(line => {
        logBuffer.push({ timestamp: ts, text: line });
      });

      // Cap buffer size
      if (logBuffer.length > 1000) {
        logBuffer = logBuffer.slice(-1000);
      }
    }
  } catch (e) {
    console.error(`[Bridge] Error reading new log lines: ${e.message}`);
  }
}

// =========================================================================
// POSTGRESQL CONNECTOR (via pg module)
// =========================================================================

async function fetchPostgresMetrics(req, res, dbConfig) {
  const client = new Client({
    host: dbConfig.host || 'localhost',
    port: dbConfig.port || 5432,
    user: dbConfig.user || 'postgres',
    password: dbConfig.password || '',
    database: dbConfig.database || 'mendix',
  });

  try {
    await client.connect();

    // Query 1: Database overview stats (connections, size, hitrate, locks count, tables count)
    const statsSql = `
      SELECT row_to_json(t) as json_data FROM (
        SELECT
          (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) as active_conns,
          (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle') as idle_conns,
          (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') as max_conns,
          (SELECT pg_database_size(current_database())) as size_bytes,
          (SELECT COALESCE(round(100.0 * sum(heap_blks_hit) / nullif(sum(heap_blks_hit + heap_blks_read), 0), 2), 100.00) FROM pg_statio_user_tables) as hit_ratio,
          (SELECT count(*) FROM pg_locks WHERE NOT granted) as lock_waiters,
          (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public') as tables_count
      ) t;
    `;

    // Query 2: Active query sessions
    const sessionsSql = `
      SELECT coalesce(json_agg(row_to_json(t)), '[]') as json_data FROM (
        SELECT
          pid,
          state,
          round(extract(epoch from (now() - COALESCE(query_start, xact_start))) * 1000) as duration_ms,
          client_addr || ':' || client_port as client,
          query
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND state IS NOT NULL
          AND pid <> pg_backend_pid()
        ORDER BY duration_ms DESC
        LIMIT 20
      ) t;
    `;

    // Query 3: Lock Waiters (deadlocks and blocks)
    const locksSql = `
      SELECT coalesce(json_agg(row_to_json(t)), '[]') as json_data FROM (
        SELECT
          blocked_locks.pid     AS blocked_pid,
          blocking_locks.pid    AS blocking_pid,
          blocked_activity.query    AS blocked_statement,
          blocking_activity.query   AS blocking_statement,
          round(extract(epoch from (now() - blocked_activity.query_start)) * 1000) as duration_ms
        FROM pg_catalog.pg_locks         blocked_locks
        JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
        JOIN pg_catalog.pg_locks         blocking_locks
          ON blocking_locks.locktype = blocked_locks.locktype
          AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
          AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
          AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
          AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
          AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
          AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
          AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
          AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
          AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
          AND blocking_locks.pid != blocked_locks.pid
        JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
        WHERE NOT blocked_locks.granted
      ) t;
    `;

    // Query 4: Global Engine Stats
    const globalStatsSql = `
      SELECT row_to_json(t) as json_data FROM (
        SELECT 
          buffers_alloc,
          buffers_clean,
          maxwritten_clean,
          buffers_backend
        FROM pg_stat_bgwriter
      ) t;
    `;

    // Query 5: Top 5 largest tables
    const tablesSql = `
      SELECT coalesce(json_agg(row_to_json(t)), '[]') as json_data FROM (
        SELECT relname AS table_name, pg_total_relation_size(c.oid) AS total_size
        FROM pg_class c
        LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY pg_total_relation_size(c.oid) DESC
        LIMIT 5
      ) t;
    `;

    // Query 6: Table & Index Health
    const tableHealthSql = `
      SELECT coalesce(json_agg(row_to_json(t)), '[]') as json_data FROM (
        SELECT 
          t.relname AS table_name,
          t.seq_scan,
          t.idx_scan,
          t.n_dead_tup AS dead_tuples,
          round(100.0 * t.n_dead_tup / nullif(t.n_live_tup + t.n_dead_tup, 0), 2) AS bloat_ratio,
          io.heap_blks_read,
          io.heap_blks_hit,
          round(100.0 * io.heap_blks_hit / nullif(io.heap_blks_hit + io.heap_blks_read, 0), 2) AS hit_ratio
        FROM pg_stat_user_tables t
        JOIN pg_statio_user_tables io ON t.relid = io.relid
        ORDER BY (t.seq_scan + io.heap_blks_read) DESC
        LIMIT 20
      ) t;
    `;

    const resStats = await client.query(statsSql);
    const resSessions = await client.query(sessionsSql);
    const resLocks = await client.query(locksSql);
    const resGlobal = await client.query(globalStatsSql);
    const resTables = await client.query(tablesSql);
    const resTableHealth = await client.query(tableHealthSql);

    let slow_queries = [];
    let slow_queries_error = null;
    try {
      const slowQueriesSql = `
        SELECT coalesce(json_agg(row_to_json(t)), '[]') as json_data FROM (
          SELECT 
            query, 
            calls, 
            round(total_exec_time::numeric, 2) as total_time_ms, 
            round(mean_exec_time::numeric, 2) as mean_time_ms,
            rows
          FROM pg_stat_statements
          ORDER BY total_exec_time DESC
          LIMIT 20
        ) t;
      `;
      const resSlow = await client.query(slowQueriesSql);
      slow_queries = resSlow.rows[0].json_data;
    } catch (err) {
      slow_queries_error = err.message || "pg_stat_statements extension might not be enabled.";
    }

    const stats = resStats.rows[0].json_data;
    const sessions = resSessions.rows[0].json_data;
    const locks = resLocks.rows[0].json_data;
    const global_stats = resGlobal.rows[0].json_data;
    const top_tables = resTables.rows[0].json_data;
    const table_health = resTableHealth.rows[0].json_data;

    sendJson(req, res, {
      dbname: dbConfig.database,
      stats,
      sessions,
      locks,
      global_stats,
      top_tables,
      table_health,
      slow_queries,
      slow_queries_error
    });
  } catch (e) {
    sendError(req, res, `Database Query Error: ${e.message}`);
  } finally {
    await client.end().catch(console.error);
  }
}


// =========================================================================
// API ROUTING & HTTP SERVER
// =========================================================================

function sendJson(req, res, data) {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    ...corsHeaders(req)
  });
  res.end(JSON.stringify(data));
}

function sendError(req, res, message, code = 200) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    ...corsHeaders(req)
  });
  res.end(JSON.stringify({ error: true, message }));
}

const server = http.createServer((req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathOnly = url.pathname;

  // Static files server to prevent local file:// CORS errors
  const isStaticFile = pathOnly === '/' || 
                       pathOnly === '/index.html' || 
                       pathOnly.startsWith('/js/') || 
                       pathOnly.startsWith('/styles/') || 
                       pathOnly === '/logo.png' || 
                       pathOnly === '/manifest.json' ||
                       pathOnly === '/service-worker.js';

  if (pathOnly !== '/status' && !isStaticFile) {
    if (!requireToken(req, res)) return;
  }

  if (isStaticFile && req.method === 'GET') {
    const filePath = path.join(__dirname, '../public', pathOnly === '/' ? 'index.html' : pathOnly);
    fs.readFile(filePath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('File Not Found');
        }
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('Internal Server Error');
      }

      let contentType = 'text/html';
      if (filePath.endsWith('.css')) contentType = 'text/css';
      else if (filePath.endsWith('.js')) contentType = 'application/javascript';
      else if (filePath.endsWith('.json')) contentType = 'application/json';
      else if (filePath.endsWith('.png')) contentType = 'image/png';

      res.writeHead(200, {
        'Content-Type': contentType,
        ...corsHeaders(req)
      });
      res.end(content);
    });
    return;
  }

  if (pathOnly === '/status') {
    return sendJson(req, res, {
      status: 'online',
      token: BRIDGE_TOKEN,
      logFile: logFilePath || 'Not found',
      logLinesCount: logBuffer.length,
      otel: {
        port: OTLP_PORT,
        tracesReceived: otelTracesCount,
        logsReceived: otelLogsCount,
        metricsReceived: otelMetricsCount
      }
    });
  }

  if (url.pathname === '/logs') {
    const since = parseInt(url.searchParams.get('since') || '0');
    // Filter lines new since timestamp
    const filtered = logBuffer.filter(line => line.timestamp > since);
    return sendJson(req, res, {
      timestamp: Date.now(),
      lines: filtered
    });
  }
  
  if (url.pathname === '/otel/traces') {
    const since = parseInt(url.searchParams.get('since') || '0');
    const filtered = otelTraceBuffer.filter(t => t.timestamp > since);
    return sendJson(req, res, { timestamp: Date.now(), items: filtered });
  }

  if (url.pathname === '/otel/logs') {
    const since = parseInt(url.searchParams.get('since') || '0');
    const filtered = otelLogBuffer.filter(l => l.timestamp > since);
    return sendJson(req, res, { timestamp: Date.now(), items: filtered });
  }

  if (url.pathname === '/otel/metrics') {
    const since = parseInt(url.searchParams.get('since') || '0');
    const filtered = otelMetricBuffer.filter(m => m.timestamp > since);
    return sendJson(req, res, { timestamp: Date.now(), items: filtered });
  }

  if (url.pathname === '/detect-project') {
    if (req.method === 'POST') {
      readBody(req, res, 5 * 1024 * 1024, (rawBody) => {
        try {
          const payload = JSON.parse(rawBody.toString('utf8'));
          if (!payload.projectRoot) throw new Error("Missing projectRoot");
          const deploymentPath = path.join(payload.projectRoot, 'deployment');
          const metadataPath = path.join(deploymentPath, 'model', 'metadata.json');
          const configPath = path.join(deploymentPath, 'model', 'config.json');
          
          let metadata = null;
          let config = null;
          
          if (fs.existsSync(metadataPath)) metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          
          const proj = { deploymentPath, projectRoot: payload.projectRoot, metadata, config };
          sendJson(req, res, { success: true, projects: [proj], deploymentPath, projectRoot: payload.projectRoot, metadata, config });
        } catch (e) {
          sendError(req, res, `Failed manual detection: ${e.message}`, 400);
        }
      });
      return;
    }

    const extractDeploymentPath = (cmdLine) => {
      if (!cmdLine) return null;
      
      // Match runtimelauncher.jar followed by the deployment path argument
      const match = cmdLine.match(/runtimelauncher\.jar["']?\s+["']?([^"']+)["']?/i);
      if (match && match[1]) {
        return match[1];
      }
      
      // Fallback: look for \deployment directly
      const fallback = cmdLine.match(/["']?([^"']+\\deployment)["']?/i);
      if (fallback && fallback[1]) {
        return fallback[1];
      }
      return null;
    };

    const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='javaw.exe'\\" | Select-Object -ExpandProperty CommandLine"`;
    exec(cmd, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        return sendJson(req, res, { success: false, reason: `Failed to query running processes: ${error.message}` });
      }
      
      const lines = stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      let projects = [];
      
      for (const line of lines) {
        if (line.includes('runtimelauncher.jar')) {
          const deploymentPath = extractDeploymentPath(line);
          if (deploymentPath && !projects.find(p => p.deploymentPath === deploymentPath)) {
            const metadataPath = path.join(deploymentPath, 'model', 'metadata.json');
            const configPath = path.join(deploymentPath, 'model', 'config.json');
            let metadata = null;
            let config = null;
            
            try {
              if (fs.existsSync(metadataPath)) {
                metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
              }
            } catch (e) {
              console.error("Failed to read metadata.json:", e);
            }
            
            try {
              if (fs.existsSync(configPath)) {
                config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
              }
            } catch (e) {
              console.error("Failed to read config.json:", e);
            }
            
            projects.push({
              deploymentPath,
              projectRoot: path.dirname(deploymentPath),
              metadata,
              config
            });
          }
        }
      }
      
      if (projects.length === 0) {
        return sendJson(req, res, { success: false, reason: "No running Mendix runtime process found. Make sure the app is running in Studio Pro." });
      }
      
      sendJson(req, res, {
        success: true,
        projects: projects,
        // Keep top-level fields for backwards compatibility
        deploymentPath: projects[0].deploymentPath,
        projectRoot: projects[0].projectRoot,
        metadata: projects[0].metadata,
        config: projects[0].config
      });
    });
    return;
  }
  if (url.pathname === '/project-insights') {
    if (req.method === 'POST') {
      readBody(req, res, 5 * 1024 * 1024, (rawBody) => {
        try {
          const payload = JSON.parse(rawBody.toString('utf8'));
          const prj = payload.projectRoot;
          if (!prj) throw new Error("Missing projectRoot");

          const getDirSize = (dirPath) => {
            let size = 0;
            if (!fs.existsSync(dirPath)) return 0;
            const files = fs.readdirSync(dirPath);
            for (const file of files) {
              const fullPath = path.join(dirPath, file);
              const stats = fs.statSync(fullPath);
              if (stats.isFile()) size += stats.size;
              else if (stats.isDirectory()) size += getDirSize(fullPath);
            }
            return size;
          };

          const bundleSize = {
            totalMB: 0,
            jsMB: 0,
            cssMB: 0
          };
          
          try {
            bundleSize.jsMB = +(getDirSize(path.join(prj, 'deployment', 'web', 'js')) / 1024 / 1024).toFixed(2);
            bundleSize.cssMB = +(getDirSize(path.join(prj, 'deployment', 'web', 'css')) / 1024 / 1024).toFixed(2);
            bundleSize.totalMB = +(getDirSize(path.join(prj, 'deployment', 'web')) / 1024 / 1024).toFixed(2);
          } catch(e){}

          const widgets = [];
          try {
            const wDir = path.join(prj, 'widgets');
            if (fs.existsSync(wDir)) {
              widgets.push(...fs.readdirSync(wDir).filter(f => f.endsWith('.mpk')));
            }
          } catch(e){}

          const javaIssues = [];
          const scanJava = (dirPath) => {
            if (!fs.existsSync(dirPath)) return;
            const files = fs.readdirSync(dirPath);
            for (const file of files) {
              const fullPath = path.join(dirPath, file);
              const stats = fs.statSync(fullPath);
              if (stats.isFile() && fullPath.endsWith('.java')) {
                const content = fs.readFileSync(fullPath, 'utf8');
                const lines = content.split('\n');
                lines.forEach((line, i) => {
                  if (line.includes('System.out.print') || line.includes('System.err.print')) {
                    javaIssues.push({ file: path.basename(fullPath), line: i + 1, issue: 'System.out.println used instead of Core.getLogger()' });
                  }
                  if (/password\s*=\s*["'][^"']+["']/i.test(line)) {
                    javaIssues.push({ file: path.basename(fullPath), line: i + 1, issue: 'Hardcoded password detected' });
                  }
                });
              } else if (stats.isDirectory()) {
                scanJava(fullPath);
              }
            }
          };
          try {
            scanJava(path.join(prj, 'javasource'));
          } catch(e){}

          sendJson(req, res, { success: true, bundleSize, widgets, javaIssues });
        } catch (e) {
          sendError(req, res, `Insights error: ${e.message}`, 400);
        }
      });
      return;
    }
    return sendError(req, res, 'Method Not Allowed', 405);
  }


  if (url.pathname === '/postgres') {
      if (req.method === 'POST') {
        readBody(req, res, 5 * 1024 * 1024, (rawBody) => {
          try {
            const dbConfig = JSON.parse(rawBody.toString('utf8'));
            fetchPostgresMetrics(req, res, dbConfig);
          } catch (e) {
            sendError(req, res, `Invalid JSON body: ${e.message}`, 400);
          }
        });
        return;
      }
      return sendError(req, res, 'Method Not Allowed', 405);
    }

  if (url.pathname === '/prometheus') {
    // Proxy Prometheus metrics to bypass CORS
    const targetPort = url.searchParams.get('port') || '8090';
    const promUrl = `http://127.0.0.1:${targetPort}/prometheus`;
    const reqProxy = http.get(promUrl, (resp) => {
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain', ...corsHeaders(req) });
        res.end(data);
      });
    }).on("error", (err) => {
      sendError(req, res, `Failed proxying Prometheus on port ${targetPort}: ${err.message}`, 200);
    });
    return;
  }

  if (url.pathname === '/mock-config') {
    if (req.method === 'POST') {
      readBody(req, res, 5 * 1024 * 1024, (rawBody) => {
        try {
          const config = JSON.parse(rawBody.toString('utf8'));
          if (config.status !== undefined) mockConfig.status = config.status;
          if (config.payload !== undefined) mockConfig.payload = config.payload;
          if (config.delay !== undefined) mockConfig.delay = parseInt(config.delay, 10);
          if (config.chaos !== undefined) mockConfig.chaos = !!config.chaos;
          sendJson(req, res, { success: true, mockConfig });
        } catch (e) {
          sendError(req, res, `Invalid JSON body: ${e.message}`, 400);
        }
      });
      return;
    }
    return sendError(req, res, 'Method Not Allowed', 405);
  }

  if (url.pathname.startsWith('/mock')) {
    let outStatus = mockConfig.status.toString();
    let outPayload = mockConfig.payload;
    let outDelay = mockConfig.delay;

    if (mockConfig.chaos) {
      if (Math.random() > 0.8) {
        outStatus = '500 Internal Server Error';
        outPayload = '{"error": "Chaos Monkey Strike!"}';
      }
      if (Math.random() > 0.5) {
        outDelay += Math.floor(Math.random() * 2000);
      }
    }

    let statusCode = parseInt(outStatus.split(' ')[0], 10);
    if (isNaN(statusCode)) statusCode = 200;

    setTimeout(() => {
      res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        ...corsHeaders(req)
      });
      res.end(outPayload);
    }, outDelay);
    return;
  }

  if (url.pathname === '/api/perf-test') {
    if (req.method === 'POST') {
      readBody(req, res, 5 * 1024 * 1024, async (rawBody) => {
        try {
          const config = JSON.parse(rawBody.toString('utf8'));
          const targetUrl = config.url;
          const method = config.method || 'GET';
          const headers = config.headers || {};
          const payload = config.body || undefined;
          const conc = Math.min(parseInt(config.concurrency) || 1, 50);
          const count = Math.min(parseInt(config.count) || 1, 5000);

          if (!targetUrl) return sendError(req, res, 'Missing url', 400);

          const targetHost = new URL(targetUrl).hostname;
          const isPrivateOrLocal = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(targetHost);
          if (!isPrivateOrLocal && process.env.MXDEV_ALLOW_EXTERNAL_PERFTEST !== 'true') {
            return sendError(req, res, 'Perf Lab domyślnie działa tylko na adresach lokalnych/prywatnych. Ustaw zmienną środowiskową MXDEV_ALLOW_EXTERNAL_PERFTEST=true, aby testować cele zewnętrzne.', 403);
          }

          const fetchOpts = { method, headers };
          if (payload && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
            fetchOpts.body = payload;
          }

          const results = [];
          let sent = 0;
          let activeCount = 0;
          const testStartTime = Date.now();
          
          // Helper to use native fetch if available
          if (typeof fetch === 'undefined') {
             return sendError(req, res, 'Node.js version too old. fetch() is required.', 500);
          }

          const executeWorker = async () => {
             while (sent < count) {
                const id = sent++;
                const t0 = Date.now();
                try {
                  const r = await fetch(targetUrl, fetchOpts);
                  // read body to complete request
                  await r.text().catch(()=>null);
                  const t1 = Date.now();
                  results.push({ id, time: t1 - t0, status: r.status, start: t0, end: t1 });
                } catch (err) {
                  const t1 = Date.now();
                  results.push({ id, time: t1 - t0, status: 'Error', start: t0, end: t1 });
                }
             }
          };

          const workers = [];
          for (let i = 0; i < conc; i++) {
             workers.push(executeWorker());
          }

          await Promise.all(workers);
          
          sendJson(req, res, { success: true, results, duration: Date.now() - testStartTime });
        } catch (e) {
          sendError(req, res, `Failed perf test: ${e.message}`, 500);
        }
      });
      return;
    }
    return sendError(req, res, 'Method Not Allowed', 405);
  }

  // Fallback
  return sendError(req, res, 'Not Found', 404);
});

// Initialize bridge
initializeLogWatcher();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`=========================================================================`);
  console.log(`[Bridge] Mendix Observability Bridge successfully running on:`);
  console.log(`         http://localhost:${PORT}`);
});

otlpServer.listen(OTLP_PORT, '127.0.0.1', () => {
  console.log(`[Bridge] OpenTelemetry Collector (OTLP/JSON) listening on:`);
  console.log(`         http://localhost:${OTLP_PORT}  (Routes: /v1/traces, /v1/logs)`);
  console.log(`[Bridge] Keep this terminal open to feed logs, SQL metrics and OTEL traces to browser!`);
  console.log(`=========================================================================`);
});
