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

module.exports = { isReadOnlySelect, stripSqlComments, runPing, runExplain };
