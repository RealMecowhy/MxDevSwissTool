// =========================================================================
// LIVE DB — read-only PostgreSQL helpers for the Observability Bridge
// =========================================================================
// Wave 6, Release 1: EXPLAIN live. These helpers run ONLY read-only work
// against a local/dev Mendix database and are wired into the Bridge as the
// /livedb/* routes. Live DB is progressive enhancement — every tool keeps
// working without a connection; these helpers only power the *live* actions.
//
// Three layers of safety (spike T7 validated all of them on a real DB):
//   1. isReadOnlySelect() — whitelist: a single SELECT/WITH statement only.
//   2. EXPLAIN without ANALYZE — the planner runs, the query does NOT execute.
//   3. BEGIN TRANSACTION READ ONLY + SET LOCAL statement_timeout — PostgreSQL
//      itself refuses any write and cancels a query that runs too long.
//
// Pure functions live here (no DB, no server) so scripts/parser-test.js can
// unit-test the guard without starting the Bridge.
// =========================================================================

'use strict';

// Remove /* block */ and -- line comments so a leading comment can't hide the
// real first keyword from the whitelist below.
function stripSqlComments(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ');
}

// Whitelist guard. Accepts only a single read-only statement that starts with
// SELECT or WITH. Multi-statement input (anything with an inner ';') is rejected
// so a second, hidden statement can never ride along. A data-modifying CTE
// (WITH ... AS (DELETE ...)) still starts with WITH and passes here, but the
// READ ONLY transaction in runExplain() is what actually blocks it — this is a
// first-line filter, not the sole protection.
function isReadOnlySelect(sql) {
  if (typeof sql !== 'string') return false;
  let s = stripSqlComments(sql).trim();
  s = s.replace(/[;\s]+$/, '').trim();      // drop trailing semicolons/whitespace
  if (!s) return false;
  if (s.indexOf(';') !== -1) return false;  // single statement only
  const head = s.replace(/^[\s(]+/, '');    // ignore leading whitespace / '('
  if (!/^(select|with)\b/i.test(head)) return false;
  // A data-modifying CTE (WITH ... AS (DELETE/UPDATE/INSERT/MERGE ...)) also
  // starts with WITH. EXPLAIN without ANALYZE never executes it, so nothing is
  // written — but we still refuse to *plan* a write query. Only WITH needs this
  // scan; a plain SELECT cannot modify data, so it stays fully permissive
  // (avoids false positives on words like 'DELETE' inside a string literal).
  if (/^with\b/i.test(head) && /\b(insert|update|delete|merge)\b/i.test(head)) return false;
  return true;
}

function mapDbConfig(dbConfig) {
  dbConfig = dbConfig || {};
  return {
    host: dbConfig.host || 'localhost',
    port: parseInt(dbConfig.port, 10) || 5432,
    user: dbConfig.user || 'postgres',
    password: dbConfig.password || '',
    database: dbConfig.database || 'postgres',
    connectionTimeoutMillis: 8000
  };
}

// Lightweight connectivity check used by the shared connection component.
async function runPing(Client, dbConfig) {
  const client = new Client(mapDbConfig(dbConfig));
  try {
    await client.connect();
    const r = await client.query('SELECT version() AS v, current_database() AS db');
    return { ok: true, version: r.rows[0].v, database: r.rows[0].db };
  } catch (e) {
    return { error: true, message: e.message };
  } finally {
    await client.end().catch(() => {});
  }
}

// Run EXPLAIN (text format, no ANALYZE) on a single read-only query and return
// the plan text that the Query Intelligence "SQL Explain" visualizer consumes.
async function runExplain(Client, dbConfig, sql, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 5000;
  if (!isReadOnlySelect(sql)) {
    return { error: true, message: 'Only a single read-only SELECT statement can be explained live.' };
  }
  const client = new Client(mapDbConfig(dbConfig));
  const stripped = stripSqlComments(sql).replace(/[;\s]+$/, '').trim();
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query('SET LOCAL statement_timeout = ' + Number(timeoutMs));
    // Text format on purpose: visualizeSqlExplain() parses the classic indented
    // EXPLAIN text (Seq Scan / cost= / Filter: / Sort Key:), NOT FORMAT JSON.
    const r = await client.query('EXPLAIN ' + stripped);
    await client.query('ROLLBACK');
    const plan = r.rows.map(row => row['QUERY PLAN']).join('\n');
    return { plan: plan };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return { error: true, message: e.message };
  } finally {
    await client.end().catch(() => {});
  }
}

// =========================================================================
// INDEX ADVISOR (Wave 6, Release 2)
// =========================================================================
// Reads PostgreSQL's own catalogs/statistics and turns them into findings.
//
// The single most important design decision here: **usage statistics lie on a
// cold database.** A freshly restored dev copy reports every index as "never
// scanned" simply because pg_stat_* counters restart at zero — the reference
// SS3DB had 597 "unused" indexes after 8 index scans total. A naive advisor
// tells you to drop them all. So findings are split in two:
//
//   * STRUCTURAL (duplicate / redundant / invalid indexes) — derived from the
//     catalog shape alone. True regardless of how warm the statistics are.
//   * USAGE-BASED (unused index, seq-scan-heavy table) — only meaningful once
//     the database has actually served traffic. Gated behind assessStatsWindow()
//     and always reported together with the stats window they came from.
//
// Pure functions (no DB, no server) so scripts/parser-test.js covers them.
// =========================================================================

const IDX_DEFAULTS = {
  minIndexBytes: 16384,       // ignore 1-2 page indexes — dropping them buys nothing
  seqScanMinScans: 50,        // below this a seq scan count is noise
  seqScanMinRows: 1000,       // small tables are *supposed* to be seq-scanned
  seqScanRatio: 0.5,          // seq scans as a share of all scans on the table
  statsOkScans: 1000,         // total index scans for full confidence
  statsLowScans: 50,          // below this the window tells us nothing at all
  statsOkAgeHours: 24,        // a window shorter than this is too narrow to judge
  maxFindings: 200
};

function num(v) { return typeof v === 'number' ? v : (v == null ? 0 : Number(v) || 0); }

// How much can we trust the usage counters? Returns 'ok' | 'low' | 'none' plus
// the reason, which the UI shows verbatim — the user must be able to see WHY a
// verdict was withheld rather than assume the database is clean.
function assessStatsWindow(input, opts) {
  const o = Object.assign({}, IDX_DEFAULTS, opts || {});
  const totalIdxScan = num(input.totalIdxScan);
  const totalSeqScan = num(input.totalSeqScan);
  const nowMs = input.nowMs || Date.now();
  const sinceMs = input.statsSince ? new Date(input.statsSince).getTime() : null;
  const ageHours = sinceMs && !isNaN(sinceMs) ? Math.max(0, (nowMs - sinceMs) / 3600000) : null;

  if (totalIdxScan + totalSeqScan < o.statsLowScans) {
    return {
      confidence: 'none', totalIdxScan: totalIdxScan, totalSeqScan: totalSeqScan,
      statsSince: input.statsSince || null, ageHours: ageHours,
      reason: 'This database has served almost no queries since its statistics were reset (' +
              (totalIdxScan + totalSeqScan) + ' scans total). Usage-based findings are hidden — ' +
              'on a freshly restored copy every index looks unused. Structural findings below are unaffected.'
    };
  }
  if (ageHours !== null && ageHours < o.statsOkAgeHours) {
    return {
      confidence: 'low', totalIdxScan: totalIdxScan, totalSeqScan: totalSeqScan,
      statsSince: input.statsSince || null, ageHours: ageHours,
      reason: 'Statistics cover only the last ' + ageHours.toFixed(1) + ' h. Nightly batches, ' +
              'month-end reports and rarely used screens may not have run yet — treat "never scanned" as a question, not a verdict.'
    };
  }
  if (totalIdxScan < o.statsOkScans) {
    return {
      confidence: 'low', totalIdxScan: totalIdxScan, totalSeqScan: totalSeqScan,
      statsSince: input.statsSince || null, ageHours: ageHours,
      reason: 'Only ' + totalIdxScan + ' index scans recorded so far — enough to spot patterns, not enough to prove an index is dead.'
    };
  }
  return {
    confidence: 'ok', totalIdxScan: totalIdxScan, totalSeqScan: totalSeqScan,
    statsSince: input.statsSince || null, ageHours: ageHours,
    reason: 'Statistics cover ' + (ageHours === null ? 'an unknown period' : ageHours.toFixed(0) + ' h') +
            ' and ' + totalIdxScan + ' index scans.'
  };
}

// Key columns are only comparable when every key attribute resolved to a real
// column name. Expression indexes (attnum 0) resolve partially, and treating
// `(a, lower(b))` as `(a)` would flag it as a duplicate of a plain index on a.
function indexKey(ix) {
  const cols = ix.keyColumns == null ? '' : String(ix.keyColumns);
  if (!cols) return null;
  const resolved = cols.split(',').filter(Boolean);
  const expected = num(ix.keyAtts) || resolved.length;
  if (resolved.length !== expected) return null;   // expression/partial resolution — not comparable
  return resolved;
}

function fmtBytes(b) {
  b = num(b);
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return Math.round(b / 1024) + ' kB';
  return b + ' B';
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

// Mendix names the indexes it generates for association columns
// `idx_<module>$<entity>_<module>$<association>`. They are recreated on every
// deploy, so "DROP INDEX" on one is undone by the next release — the real lever
// is the data model. Worth saying out loud: on the reference eShop app every
// single unused index was of exactly this kind.
function mendixIndexNote(ix) {
  const name = String(ix.name || '');
  const table = String(ix.table || '');
  if (!/\$/.test(table)) return null;
  if (/^idx_/i.test(name) && (name.match(/\$/g) || []).length >= 2) {
    return 'Mendix generates this index for an association on ' + table + ' and recreates it on every deploy — dropping it in SQL is undone by the next release. ' +
           'If it is genuinely never used, the question belongs in the domain model (is that association still navigated?), not in the database.';
  }
  return 'This table is Mendix-managed. Change indexes on the entity in Studio Pro — direct SQL is overwritten on the next deploy.';
}

// Structural pass: duplicate (identical key columns) and redundant (key columns
// are a leading prefix of another index on the same table) indexes.
function findRedundantIndexes(indexes, opts) {
  const o = Object.assign({}, IDX_DEFAULTS, opts || {});
  const findings = [];
  const byTable = new Map();
  indexes.forEach(function (ix) {
    const t = (ix.schema || 'public') + '.' + ix.table;
    if (!byTable.has(t)) byTable.set(t, []);
    byTable.get(t).push(ix);
  });

  byTable.forEach(function (list, table) {
    for (let i = 0; i < list.length; i++) {
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        const a = list[i], b = list[j];
        const ka = indexKey(a), kb = indexKey(b);
        if (!ka || !kb) continue;
        // Different access methods (btree vs gin) serve different operators.
        if ((a.am || 'btree') !== (b.am || 'btree')) continue;
        // Partial indexes with different predicates cover different rows.
        if ((a.predicate || '') !== (b.predicate || '')) continue;
        if (ka.length > kb.length) continue;

        const isPrefix = ka.every(function (c, idx) { return c === kb[idx]; });
        if (!isPrefix) continue;

        const identical = ka.length === kb.length;
        // On an identical pair only report once (the second-listed one).
        if (identical && i > j) continue;
        // A unique/primary index enforces a constraint — it is never redundant,
        // even when a wider index covers the same leading columns.
        if (a.isUnique || a.isPrimary) continue;
        // A wider *unique* index does not make the narrow one redundant for
        // lookups only if the narrow one is unique too — handled above.

        findings.push({
          kind: identical ? 'duplicate-index' : 'redundant-index',
          severity: identical ? 'high' : 'medium',
          structural: true,
          table: table,
          index: a.name,
          title: identical ?
            'Duplicate index: ' + a.name + ' and ' + b.name + ' index the same columns' :
            'Redundant index: ' + a.name + ' is a leading prefix of ' + b.name,
          detail: identical ?
            'Both indexes cover (' + ka.join(', ') + ') with the same method and predicate. PostgreSQL can only use one of them; the other costs write throughput and ' + fmtBytes(a.indexBytes) + ' of storage.' :
            '(' + ka.join(', ') + ') is the leading prefix of (' + kb.join(', ') + '). PostgreSQL can answer any lookup on ' + a.name + ' using ' + b.name + ', so the narrower index earns its ' + fmtBytes(a.indexBytes) + ' only if its smaller size measurably helps.',
          evidence: [
            a.name + ' → (' + ka.join(', ') + '), ' + fmtBytes(a.indexBytes) + ', ' + num(a.idxScan) + ' scans',
            b.name + ' → (' + kb.join(', ') + '), ' + fmtBytes(b.indexBytes) + ', ' + num(b.idxScan) + ' scans'
          ],
          verify: [
            'Confirm neither index backs a constraint: \\d ' + table + ' in psql.',
            'In Studio Pro, check whether the index is declared on the entity — Mendix recreates declared indexes on every deploy, so dropping it in the database is temporary.'
          ],
          candidate: 'DROP INDEX ' + quoteIdent(a.name) + ';',
          bytes: num(a.indexBytes)
        });
      }
    }
  });
  return findings;
}

// The main entry point. `input` is exactly what collectIndexData() returns, so
// the whole advisor can be exercised from a fixture with no database at all.
function buildIndexAdvice(input, opts) {
  const o = Object.assign({}, IDX_DEFAULTS, opts || {});
  input = input || {};
  const indexes = input.indexes || [];
  const tables = input.tables || [];

  const totalIdxScan = input.totalIdxScan != null ?
    num(input.totalIdxScan) :
    tables.reduce(function (a, t) { return a + num(t.idxScan); }, 0);
  const totalSeqScan = input.totalSeqScan != null ?
    num(input.totalSeqScan) :
    tables.reduce(function (a, t) { return a + num(t.seqScan); }, 0);

  const stats = assessStatsWindow({
    totalIdxScan: totalIdxScan, totalSeqScan: totalSeqScan,
    statsSince: input.statsSince, nowMs: input.nowMs
  }, o);

  let findings = [];

  // ── Structural: always trustworthy ────────────────────────────────────────
  indexes.forEach(function (ix) {
    if (ix.isValid === false) {
      findings.push({
        kind: 'invalid-index', severity: 'high', structural: true,
        table: (ix.schema || 'public') + '.' + ix.table, index: ix.name,
        title: 'Invalid index: ' + ix.name + ' is not usable by the planner',
        detail: 'PostgreSQL marks an index INVALID when a CREATE INDEX CONCURRENTLY failed or was interrupted. The index still consumes storage and is still maintained on every write, but no query can use it.',
        evidence: [ix.indexdef || ix.name, fmtBytes(ix.indexBytes) + ' on disk'],
        verify: [
          'SELECT indisvalid FROM pg_index WHERE indexrelid = \'' + ix.name + '\'::regclass;',
          'Check whether a deploy or a manual CREATE INDEX CONCURRENTLY was interrupted around the time it appeared.'
        ],
        candidate: 'REINDEX INDEX CONCURRENTLY ' + quoteIdent(ix.name) + ';',
        bytes: num(ix.indexBytes)
      });
    }
  });

  findings = findings.concat(findRedundantIndexes(indexes, o));

  // ── Usage-based: only when the statistics window can carry them ───────────
  if (stats.confidence !== 'none') {
    indexes.forEach(function (ix) {
      if (ix.isPrimary || ix.isUnique) return;          // constraint-backing
      if (ix.isValid === false) return;                 // already reported above
      if (num(ix.idxScan) !== 0) return;
      if (num(ix.indexBytes) < o.minIndexBytes) return; // too small to matter
      const mxNote = mendixIndexNote(ix);
      findings.push({
        kind: 'unused-index', severity: stats.confidence === 'ok' ? 'medium' : 'info',
        structural: false,
        table: (ix.schema || 'public') + '.' + ix.table, index: ix.name,
        title: 'Never scanned: ' + ix.name,
        detail: 'No scan of this index has been recorded in the current statistics window. It still slows every INSERT/UPDATE on ' + ix.table + ' and occupies ' + fmtBytes(ix.indexBytes) + '.',
        evidence: [
          ix.indexdef || ix.name,
          '0 scans since ' + (stats.statsSince || 'the last statistics reset'),
          fmtBytes(ix.indexBytes) + ' of ' + fmtBytes(ix.tableBytes) + ' table'
        ],
        mendixNote: mxNote,
        verify: [
          'Read these counters on PRODUCTION, not on a restored dev copy — a dev database has never run the reports that use this index.',
          'Check the entity in Studio Pro: a declared index is recreated on every deploy, so dropping it here only lasts until the next one.',
          'Confirm the window covers your slowest cycle (month-end, nightly batch) before concluding the index is dead.'
        ],
        candidate: 'DROP INDEX ' + quoteIdent(ix.name) + ';',
        bytes: num(ix.indexBytes)
      });
    });

    tables.forEach(function (t) {
      const seq = num(t.seqScan), idx = num(t.idxScan);
      const rows = num(t.liveTuples);
      if (seq < o.seqScanMinScans) return;
      if (rows < o.seqScanMinRows) return;              // small tables: seq scan is correct
      const total = seq + idx;
      const ratio = total ? seq / total : 0;
      if (ratio < o.seqScanRatio) return;
      const avgRead = seq ? Math.round(num(t.seqTupRead) / seq) : 0;
      findings.push({
        kind: 'seq-scan-heavy', severity: stats.confidence === 'ok' ? 'high' : 'info',
        structural: false,
        table: (t.schema || 'public') + '.' + t.table, index: null,
        title: 'Mostly sequential scans: ' + t.table,
        detail: Math.round(ratio * 100) + '% of scans on this ' + fmtBytes(t.tableBytes) + ' table (' + rows + ' live rows) read it end to end, averaging ' + avgRead + ' rows per scan. That is the shape of a filter with no supporting index.',
        evidence: [
          seq + ' sequential scans vs ' + idx + ' index scans',
          num(t.seqTupRead) + ' rows read sequentially in total'
        ],
        verify: [
          'Find the queries hitting this table in Log Query Extractor, then run "Run EXPLAIN live" on the slowest one — a Seq Scan node with a Filter names the column that wants an index.',
          'Small lookup tables are read sequentially on purpose; confirm the row count justifies an index before adding one.',
          'Add the index on the entity in Studio Pro, not directly in the database.'
        ],
        candidate: null,
        bytes: 0
      });
    });
  }

  // Highest severity first, then biggest win — the top of the list is where the
  // reclaimable storage is.
  // Note the explicit hasOwnProperty check: `rank[sev] || 3` would map the
  // top severity (rank 0) to 3 and sort the worst findings to the bottom.
  const rank = { high: 0, medium: 1, info: 2 };
  const rankOf = function (sev) { return Object.prototype.hasOwnProperty.call(rank, sev) ? rank[sev] : 3; };
  findings.sort(function (a, b) {
    const r = rankOf(a.severity) - rankOf(b.severity);
    if (r) return r;
    return b.bytes - a.bytes;
  });

  const truncated = findings.length > o.maxFindings;
  if (truncated) findings = findings.slice(0, o.maxFindings);

  const wasted = findings.reduce(function (a, f) {
    return a + (f.kind === 'unused-index' || f.kind === 'duplicate-index' ? f.bytes : 0);
  }, 0);

  return {
    stats: stats,
    findings: findings,
    truncated: truncated,
    summary: {
      indexCount: indexes.length,
      tableCount: tables.length,
      findingCount: findings.length,
      structuralCount: findings.filter(function (f) { return f.structural; }).length,
      reclaimableBytes: wasted,
      reclaimableLabel: fmtBytes(wasted)
    },
    statements: input.statements || { available: false }
  };
}

// ── SQL used by runIndexAdvisor (kept next to the shapes it produces) ────────
// indnkeyatts is PostgreSQL 11+; on 9.x/10 every attribute is a key attribute,
// so indnatts is the correct equivalent there.
function indexSql(serverVersionNum) {
  const keyAtts = serverVersionNum >= 110000 ? 'i.indnkeyatts' : 'i.indnatts';
  return `
    SELECT s.schemaname, s.relname AS table_name, s.indexrelname AS index_name,
           s.idx_scan::bigint AS idx_scan,
           pg_relation_size(s.indexrelid) AS index_bytes,
           pg_relation_size(s.relid) AS table_bytes,
           i.indisunique, i.indisprimary, i.indisvalid,
           ${keyAtts} AS key_atts,
           am.amname,
           pg_get_indexdef(i.indexrelid) AS indexdef,
           pg_get_expr(i.indpred, i.indrelid) AS predicate,
           (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
              FROM unnest(i.indkey::int[]) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = s.relid AND a.attnum = k.attnum
             WHERE k.ord <= ${keyAtts}) AS key_columns
      FROM pg_stat_user_indexes s
      JOIN pg_index i ON i.indexrelid = s.indexrelid
      JOIN pg_class c ON c.oid = s.indexrelid
      JOIN pg_am am ON am.oid = c.relam`;
}

const TABLE_SQL = `
  SELECT s.schemaname, s.relname AS table_name,
         s.seq_scan::bigint AS seq_scan, s.seq_tup_read::bigint AS seq_tup_read,
         s.idx_scan::bigint AS idx_scan, s.n_live_tup::bigint AS n_live_tup,
         pg_relation_size(s.relid) AS table_bytes
    FROM pg_stat_user_tables s`;

// Collect everything the advisor needs, inside the same READ ONLY transaction +
// statement_timeout guard as runExplain(). Never writes, never executes user SQL.
async function runIndexAdvisor(Client, dbConfig, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 15000;
  const client = new Client(mapDbConfig(dbConfig));
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query('SET LOCAL statement_timeout = ' + Number(timeoutMs));

    const ver = await client.query('SELECT current_setting(\'server_version_num\') AS v, version() AS full');
    const verNum = parseInt(ver.rows[0].v, 10) || 0;

    const ixRes = await client.query(indexSql(verNum));
    const tbRes = await client.query(TABLE_SQL);
    const rstRes = await client.query('SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()');

    // pg_stat_statements is optional. Its absence degrades the report, it never
    // fails it — most Mendix Cloud databases do not have the extension enabled.
    let statements = { available: false, reason: 'The pg_stat_statements extension is not installed on this database. Without it PostgreSQL keeps no per-query history, so this report is based on index and table counters only. To enable it: add pg_stat_statements to shared_preload_libraries, restart, then CREATE EXTENSION pg_stat_statements.' };
    try {
      const ext = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'");
      if (ext.rows.length) {
        // total_exec_time is PG13+; older servers call it total_time.
        const col = verNum >= 130000 ? 'total_exec_time' : 'total_time';
        const st = await client.query(
          'SELECT query, calls::bigint AS calls, ' + col + ' AS total_ms, ' +
          'mean_' + (verNum >= 130000 ? 'exec_' : '') + 'time AS mean_ms, rows::bigint AS rows ' +
          'FROM pg_stat_statements ORDER BY ' + col + ' DESC LIMIT 20');
        statements = {
          available: true,
          top: st.rows.map(function (r) {
            return {
              query: String(r.query || '').replace(/\s+/g, ' ').slice(0, 400),
              calls: Number(r.calls) || 0,
              totalMs: Math.round(Number(r.total_ms) || 0),
              meanMs: Math.round((Number(r.mean_ms) || 0) * 100) / 100,
              rows: Number(r.rows) || 0
            };
          })
        };
      }
    } catch (e) {
      statements = { available: false, reason: 'pg_stat_statements is installed but could not be read: ' + e.message };
    }

    await client.query('ROLLBACK');

    const indexes = ixRes.rows.map(function (r) {
      return {
        schema: r.schemaname, table: r.table_name, name: r.index_name,
        idxScan: Number(r.idx_scan) || 0,
        indexBytes: Number(r.index_bytes) || 0,
        tableBytes: Number(r.table_bytes) || 0,
        isUnique: r.indisunique === true, isPrimary: r.indisprimary === true,
        isValid: r.indisvalid !== false,
        keyAtts: Number(r.key_atts) || 0,
        am: r.amname, indexdef: r.indexdef,
        predicate: r.predicate || '',
        keyColumns: r.key_columns || ''
      };
    });
    const tables = tbRes.rows.map(function (r) {
      return {
        schema: r.schemaname, table: r.table_name,
        seqScan: Number(r.seq_scan) || 0, seqTupRead: Number(r.seq_tup_read) || 0,
        idxScan: Number(r.idx_scan) || 0, liveTuples: Number(r.n_live_tup) || 0,
        tableBytes: Number(r.table_bytes) || 0
      };
    });

    const advice = buildIndexAdvice({
      indexes: indexes, tables: tables,
      statsSince: rstRes.rows[0] && rstRes.rows[0].stats_reset ? rstRes.rows[0].stats_reset : null,
      statements: statements
    }, opts);
    advice.server = String(ver.rows[0].full || '').split(',')[0];
    return advice;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return { error: true, message: e.message };
  } finally {
    await client.end().catch(() => {});
  }
}

// =========================================================================
// DOMAIN MODEL FROM DATABASE (Wave 6, Release 3)
// =========================================================================
// Mendix keeps its own model metadata in `mendixsystem$entity`, `$attribute`
// and `$association`, so a running database can describe the domain model
// without Studio Pro or the .mpr file.
//
// Two things had to be established on real databases before this could be
// trusted, because getting either wrong silently produces a *plausible but
// wrong* diagram:
//
// 1. WHERE THE FOREIGN KEY LIVES. For column-stored associations the FK column
//    is `child_column_name` on the PARENT entity's table. On Mendix 11
//    `association.table_name` happens to name that same table, but on Mendix 9
//    it names the column instead and matches no table at all (verified: 95/95
//    associations on a 9.24 database). So the parent entity's own table_name is
//    the version-safe answer — never association.table_name.
//
// 2. WHICH SIDE IS "ONE". The parent entity holds the FK, so a parent points at
//    exactly one child: the CHILD is the "1" side and the PARENT is the "many"
//    side. That reads backwards from the column names, and reversing it would
//    flip every relationship in the diagram.
//
// Cardinality is then exact rather than guessed: a UNIQUE index on the FK
// column turns 1-* into 1-1, and for junction tables a UNIQUE index on either
// side turns *-* into 1-*. That uniqueness comes from PostgreSQL's own catalog
// (the same source the Index Advisor reads), not from Mendix metadata, whose
// constraint names are truncated at PostgreSQL's 63-character identifier limit.
// =========================================================================

// Empirically derived from Mendix 9.24 and 11.12 databases. An unknown code is
// surfaced as-is rather than guessed at — a wrong type silently misleads.
const MX_ATTR_TYPES = {
  0: 'AutoNumber', 3: 'Integer', 4: 'Long', 5: 'Decimal', 10: 'Boolean',
  20: 'DateTime', 30: 'String', 40: 'Enum', 50: 'Binary'
};

function mxTypeName(code, length) {
  const base = MX_ATTR_TYPES[code];
  if (!base) return 'Type' + code;
  if (base === 'String' && length > 0) return 'String(' + length + ')';
  return base;
}

function moduleOf(entityName) {
  const s = String(entityName || '');
  const i = s.indexOf('.');
  return i === -1 ? '(none)' : s.slice(0, i);
}

function shortNameOf(entityName) {
  const s = String(entityName || '');
  const i = s.indexOf('.');
  return i === -1 ? s : s.slice(i + 1);
}

// `uniqueColumns` is a Set of 'table|column' strings for single-column UNIQUE
// indexes, straight from the PostgreSQL catalog.
function buildDomainModel(input) {
  input = input || {};
  const entityRows = input.entities || [];
  const attrRows = input.attributes || [];
  const assocRows = input.associations || [];
  const uniq = input.uniqueColumns instanceof Set ?
    input.uniqueColumns :
    new Set(input.uniqueColumns || []);

  const byId = new Map();
  const entities = entityRows.map(function (r) {
    const e = {
      id: r.id,
      name: r.entityName,
      module: moduleOf(r.entityName),
      shortName: shortNameOf(r.entityName),
      table: r.tableName,
      superId: r.superEntityId || null,
      superName: null,
      remote: r.remote === true,
      attributes: []
    };
    byId.set(r.id, e);
    return e;
  });

  entities.forEach(function (e) {
    if (e.superId && byId.has(e.superId)) e.superName = byId.get(e.superId).name;
  });

  attrRows.forEach(function (a) {
    const e = byId.get(a.entityId);
    if (!e) return;                       // orphan metadata row — skip silently
    e.attributes.push({
      name: a.attributeName,
      column: a.columnName,
      type: mxTypeName(a.type, a.length),
      typeCode: a.type,
      length: a.length || 0,
      isAutoNumber: a.isAutoNumber === true
    });
  });
  entities.forEach(function (e) {
    e.attributes.sort(function (x, y) { return String(x.name).localeCompare(String(y.name)); });
  });

  const associations = [];
  assocRows.forEach(function (r) {
    const parent = byId.get(r.parentEntityId);
    const child = byId.get(r.childEntityId);
    if (!parent || !child) return;

    // parent_column_name = 'id' means the association is stored as a column;
    // anything else means a junction table. Verified to predict Mendix 11's
    // storage_format with no mismatches (32/32 column, 36/36 junction).
    const isColumn = r.parentColumnName === 'id';
    let oneSide, manySide, cardinality, table, columns;

    if (isColumn) {
      table = parent.table;               // NOT r.tableName — see header note
      columns = [r.childColumnName];
      // The parent holds the FK, so the child is the single side.
      oneSide = child; manySide = parent;
      cardinality = uniq.has(table + '|' + r.childColumnName) ? '1-1' : '1-*';
    } else {
      table = r.tableName;
      columns = [r.parentColumnName, r.childColumnName];
      const parentUnique = uniq.has(table + '|' + r.parentColumnName);
      const childUnique = uniq.has(table + '|' + r.childColumnName);
      if (parentUnique && childUnique) {
        cardinality = '1-1'; oneSide = child; manySide = parent;
      } else if (childUnique) {
        // Each child row appears once, so a child links to at most one parent.
        cardinality = '1-*'; oneSide = parent; manySide = child;
      } else if (parentUnique) {
        cardinality = '1-*'; oneSide = child; manySide = parent;
      } else {
        cardinality = '*-*'; oneSide = parent; manySide = child;
      }
    }

    associations.push({
      name: r.associationName,
      module: moduleOf(r.associationName),
      shortName: shortNameOf(r.associationName),
      parent: parent.name,
      child: child.name,
      one: oneSide.name,
      many: manySide.name,
      cardinality: cardinality,
      storage: isColumn ? 'column' : 'junction',
      table: table,
      columns: columns
    });
  });

  const moduleMap = new Map();
  entities.forEach(function (e) {
    if (!moduleMap.has(e.module)) moduleMap.set(e.module, { name: e.module, entityCount: 0, associationCount: 0 });
    moduleMap.get(e.module).entityCount++;
  });
  associations.forEach(function (a) {
    if (moduleMap.has(a.module)) moduleMap.get(a.module).associationCount++;
  });
  const modules = Array.from(moduleMap.values()).sort(function (a, b) {
    return b.entityCount - a.entityCount || String(a.name).localeCompare(String(b.name));
  });

  // Table → entity name, so an error mentioning `eshop$order` can be reported
  // as `eShop.Order` (consumed by the Error Decoder).
  const tableMap = {};
  entities.forEach(function (e) { if (e.table) tableMap[e.table] = e.name; });

  const cardCount = { '1-1': 0, '1-*': 0, '*-*': 0 };
  associations.forEach(function (a) { cardCount[a.cardinality] = (cardCount[a.cardinality] || 0) + 1; });

  entities.forEach(function (e) { delete e.id; delete e.superId; });

  return {
    modules: modules,
    entities: entities,
    associations: associations,
    tableMap: tableMap,
    meta: input.meta || null,
    stats: {
      entityCount: entities.length,
      attributeCount: entities.reduce(function (a, e) { return a + e.attributes.length; }, 0),
      associationCount: associations.length,
      moduleCount: modules.length,
      cardinality: cardCount,
      inheritedCount: entities.filter(function (e) { return e.superName; }).length
    }
  };
}

// Emit the exact JSON shape the Domain Model & Architecture tool already
// consumes, optionally narrowed to a set of modules. A 338-entity model is
// unreadable as one diagram, so filtering is part of the contract, not a nicety.
function domainModelToArchJson(model, moduleNames) {
  const wanted = moduleNames && moduleNames.length ? new Set(moduleNames) : null;
  const keep = function (entityName) {
    return !wanted || wanted.has(moduleOf(entityName));
  };
  const entities = model.entities.filter(function (e) { return keep(e.name); });
  const names = new Set(entities.map(function (e) { return e.name; }));
  return {
    entities: entities.map(function (e) {
      return {
        name: e.shortName,
        fullName: e.name,
        table: e.table,
        extends: e.superName || undefined,
        attributes: e.attributes.map(function (a) { return { name: a.name, type: a.type }; })
      };
    }),
    // Both ends must be present, or Mermaid would invent a bare class node for
    // an entity the user deliberately filtered out.
    associations: model.associations.filter(function (a) {
      return names.has(a.one) && names.has(a.many);
    }).map(function (a) {
      return {
        name: a.shortName,
        parent: shortNameOf(a.one),
        child: shortNameOf(a.many),
        type: a.cardinality
      };
    })
  };
}

const MODEL_SQL = {
  entity: 'SELECT id, entity_name, table_name, superentity_id, remote FROM "mendixsystem$entity"',
  attribute: 'SELECT id, entity_id, attribute_name, column_name, type, length, is_auto_number FROM "mendixsystem$attribute"',
  association: 'SELECT association_name, table_name, parent_entity_id, child_entity_id, parent_column_name, child_column_name FROM "mendixsystem$association"',
  // Single-column UNIQUE indexes are what turn 1-* into 1-1 and *-* into 1-*.
  unique: `SELECT c.relname AS tbl, a.attname AS col
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indrelid
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indisunique AND i.indnatts = 1`,
  version: 'SELECT mendixversion, sprintrprojectname FROM "mendixsystem$version" LIMIT 1'
};

async function runDomainModel(Client, dbConfig, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 20000;
  const client = new Client(mapDbConfig(dbConfig));
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query('SET LOCAL statement_timeout = ' + Number(timeoutMs));

    // A non-Mendix database (or one the user pointed at by mistake) simply has
    // no such table — say so plainly instead of surfacing a raw SQL error.
    const probe = await client.query(
      "SELECT to_regclass('public.\"mendixsystem$entity\"') IS NOT NULL AS ok");
    if (!probe.rows[0].ok) {
      await client.query('ROLLBACK');
      return {
        error: true, notMendix: true,
        message: 'No mendixsystem$entity table found — this database does not look like a Mendix application database. Point the connection at the database your app runs on.'
      };
    }

    // Sequential on purpose: a single pg Client serializes queries anyway, and
    // issuing them concurrently is deprecated (removed in pg@9).
    const ent = await client.query(MODEL_SQL.entity);
    const att = await client.query(MODEL_SQL.attribute);
    const asc = await client.query(MODEL_SQL.association);
    const unq = await client.query(MODEL_SQL.unique);

    let meta = null;
    try {
      const v = await client.query(MODEL_SQL.version);
      if (v.rows.length) {
        meta = { mendixVersion: v.rows[0].mendixversion, project: v.rows[0].sprintrprojectname };
      }
    } catch (e) { /* mendixsystem$version is not present on every version */ }

    await client.query('ROLLBACK');

    const uniqueColumns = new Set(unq.rows.map(function (r) { return r.tbl + '|' + r.col; }));

    return buildDomainModel({
      entities: ent.rows.map(function (r) {
        return {
          id: r.id, entityName: r.entity_name, tableName: r.table_name,
          superEntityId: r.superentity_id, remote: r.remote === true
        };
      }),
      attributes: att.rows.map(function (r) {
        return {
          entityId: r.entity_id, attributeName: r.attribute_name, columnName: r.column_name,
          type: r.type, length: r.length, isAutoNumber: r.is_auto_number === true
        };
      }),
      associations: asc.rows.map(function (r) {
        return {
          associationName: r.association_name, tableName: r.table_name,
          parentEntityId: r.parent_entity_id, childEntityId: r.child_entity_id,
          parentColumnName: r.parent_column_name, childColumnName: r.child_column_name
        };
      }),
      uniqueColumns: uniqueColumns,
      meta: meta
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return { error: true, message: e.message };
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = {
  isReadOnlySelect, stripSqlComments, runPing, runExplain,
  assessStatsWindow, findRedundantIndexes, buildIndexAdvice, runIndexAdvisor,
  buildDomainModel, domainModelToArchJson, mxTypeName, runDomainModel,
  IDX_DEFAULTS, MX_ATTR_TYPES
};
