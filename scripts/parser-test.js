// Unit tests for the shared Mendix log parser (public/js/tools/mendix-log-parser.js).
//
// Runs in plain Node: the module attaches createMendixLogParser to `self`, so we point
// `self` at the global before requiring it. No browser, no build step.
//
// Covers the wave-2 completion criterion "identyczny wynik parsowania na dotychczasowych
// plikach referencyjnych": the new single-pass CSV state machine is compared, record for
// record, against the historical two-pass algorithm (reproduced verbatim below) on both
// synthetic inputs and — when present locally — the real reference export.

const fs = require('fs');
const path = require('path');

global.self = global;
require('../public/js/tools/mendix-log-parser.js');
const parser = global.createMendixLogParser();

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '  — ' + detail : '')); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

// ── Historical two-pass CSV algorithm (the pre-wave-2 LQE code) ──────────────
function oldParseCSVRow(row) {
  const fields = [];
  let i = 0;
  while (i < row.length) {
    if (row[i] === '"') {
      let field = '';
      i++;
      while (i < row.length) {
        if (row[i] === '"' && i + 1 < row.length && row[i + 1] === '"') { field += '"'; i += 2; }
        else if (row[i] === '"') { i++; break; }
        else { field += row[i]; i++; }
      }
      fields.push(field);
      if (i < row.length && row[i] === ',') i++;
    } else {
      let end = row.indexOf(',', i);
      if (end === -1) end = row.length;
      fields.push(row.substring(i, end));
      i = end + 1;
    }
  }
  return fields;
}
function oldParse(text) {
  const rawLines = text.split('\n');
  const csvRows = [];
  let currentLine = '';
  let insideQuotes = false;
  let skipped = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].replace(/\r$/, '');
    currentLine += (currentLine ? '\n' : '') + line;
    let quoteCount = 0;
    for (let j = 0; j < line.length; j++) if (line[j] === '"') quoteCount++;
    if (quoteCount % 2 !== 0) insideQuotes = !insideQuotes;
    if (!insideQuotes) { csvRows.push(currentLine); currentLine = ''; }
  }
  if (currentLine) csvRows.push(currentLine);
  const records = [];
  for (const row of csvRows) {
    if (row.startsWith('Type,TimeStamp,LogNode,Message')) continue;
    const fields = oldParseCSVRow(row);
    if (fields.length < 4) { if (row.trim()) skipped++; continue; }
    records.push({ timestamp: fields[1], logNode: fields[2], message: fields[3] });
  }
  return { records, skipped };
}

// Compare only the fields LQE's extraction consumes, trimmed on both sides.
function normRec(r) { return { timestamp: (r.timestamp || '').trim(), logNode: (r.logNode || '').trim(), message: r.message || '' }; }
function assertEquivalent(name, text) {
  const oldR = oldParse(text);
  const neu = parser.parse(text);
  const a = oldR.records.map(normRec);
  const b = neu.records.map(normRec);
  let same = a.length === b.length && oldR.skipped === neu.skipped;
  if (same) for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) { same = false; break; }
  }
  ok(name, same, 'old={records:' + a.length + ',skipped:' + oldR.skipped + '} new={records:' + b.length + ',skipped:' + neu.skipped + '}');
}

// ── CSV: format detection ───────────────────────────────────────────────────
console.log('\nFormat detection');
eq('CSV header → csv', parser.parse('Type,TimeStamp,LogNode,Message\nTrace,t,N,m').format, 'csv');
eq('cloud line → live', parser.parse('2026-07-14T00:00:01.4 [runtime-container/x]  INFO - Core: hi').format, 'live');
eq('empty → csv (default)', parser.parse('').format, 'csv');

// ── CSV: single-pass state machine ──────────────────────────────────────────
console.log('\nCSV parsing');
const csvMultiline = 'Type,TimeStamp,LogNode,Message\n' +
  'Trace,2026-07-15 10:00:00.100,ConnectionBus_Retrieve,"SELECT ""a$b"".""id""\nFROM ""a$b"" WHERE x = ?"\n' +
  'Trace,2026-07-15 10:00:00.200,DataStorage_QueryPlan,"[{""Plan"":{""Node Type"":""Seq Scan""}}]"';
let r = parser.parse(csvMultiline);
eq('two records parsed', r.records.length, 2);
ok('multiline quoted field preserved', r.records[0].message.indexOf('\nFROM') !== -1, JSON.stringify(r.records[0].message));
ok('escaped quotes unescaped', r.records[0].message.indexOf('"a$b"."id"') !== -1, JSON.stringify(r.records[0].message));
eq('logNode captured', r.records[1].logNode, 'DataStorage_QueryPlan');

const csvSkip = 'Type,TimeStamp,LogNode,Message\n' +
  'Trace,2026-07-15 10:00:00.100,Core,"ok"\n' +
  'this row is broken\n' +
  '\n' +
  'Info,2026-07-15 10:00:01.000,Core,"fine"';
r = parser.parse(csvSkip);
eq('valid records kept', r.records.length, 2);
eq('malformed row counted, blank ignored', r.skipped, 1);

const csvNodes = 'Type,TimeStamp,LogNode,Message\n' +
  'Trace,t1,NodeA,"m1"\nDebug,t2,NodeB,"m2"\nWarning,t3,NodeC,"m3"';
r = parser.parse(csvNodes);
eq('multiple nodes: 3 records', r.records.length, 3);
ok('distinct nodes', r.records[0].logNode === 'NodeA' && r.records[2].logNode === 'NodeC');

// ── CSV: equivalence old vs new ─────────────────────────────────────────────
console.log('\nCSV equivalence (old two-pass vs new single-pass)');
assertEquivalent('multiline + escaped quotes', csvMultiline);
assertEquivalent('malformed + blank rows', csvSkip);
assertEquivalent('multiple nodes', csvNodes);
assertEquivalent('CRLF line endings', csvNodes.replace(/\n/g, '\r\n'));
assertEquivalent('trailing newline', csvNodes + '\n');
assertEquivalent('embedded commas in quotes',
  'Type,TimeStamp,LogNode,Message\nTrace,t,Core,"a, b, c",extra-cause');

// ── Live log parsing ────────────────────────────────────────────────────────
console.log('\nLive log parsing');
const live =
  '2026-07-14T00:00:01.4 [runtime-container/x]  INFO - Email: hi\n' +
  '2026-07-14T00:06:27.1 [runtime-container/x]  WARNING - ConnectionBus_Queries: Query executed in 3 seconds and 171 milliseconds: SELECT "t"."id" FROM "t"\n' +
  ' INNER JOIN "u" ON 1=1 WHERE "u"."x" = 5\n' +
  '2026-07-14T00:08:00.0 [runtime-container/x]  ERROR - M2EE: boom\n' +
  '\tat com.mendix.Foo.run(Foo.java:42)\n' +
  'Caused by: java.io.EOFException\n' +
  '2026-07-14T00:09:00.0 [runtime-container/x]  DEBUG - ConnectionBus_Retrieve: SQL@abc123(T1-Cff0001): SELECT "t"."id" FROM "t" WHERE "t"."id" = ?';
r = parser.parse(live);
eq('live format detected', r.format, 'live');
eq('4 log records', r.records.length, 4);
const slow = r.records[1];
ok('slow-query logNode', slow.logNode === 'ConnectionBus_Queries');
ok('slow-query SQL continuation appended', slow.message.indexOf('INNER JOIN') !== -1, JSON.stringify(slow.message));
const m2ee = r.records[2];
ok('stack-trace continuation appended', m2ee.message.indexOf('at com.mendix.Foo') !== -1 && m2ee.message.indexOf('Caused by') !== -1);
ok('SQL@ line captured under ConnectionBus_Retrieve', r.records[3].message.indexOf('SQL@abc123') === 0);
const preamble = parser.parse('garbage before any log line\n' + live);
eq('preamble line counted as skipped', preamble.skipped, 1);

// ── Reference files (local only; skipped on a clean checkout) ────────────────
console.log('\nReference files (local only)');
function firstExisting(candidates) {
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}
const la = path.join(__dirname, '..', '_local_assets');
const refCsv = firstExisting([
  path.join(la, 'Console export 2026-07-11_21-30-52.csv'),
  path.join(la, 'FilesForTest', 'Console export 2026-07-11_21-30-52.csv')
]);
if (refCsv) {
  const text = fs.readFileSync(refCsv, 'utf8');
  const oldR = oldParse(text);
  const neu = parser.parse(text);
  eq('reference CSV: format', neu.format, 'csv');
  ok('reference CSV: record count matches old', oldR.records.length === neu.records.length,
    'old=' + oldR.records.length + ' new=' + neu.records.length);
  assertEquivalent('reference CSV: record-for-record equivalence', text);
} else {
  console.log('  – reference CSV absent, skipped (repo hygiene: not committed)');
}
const refLive = path.join(__dirname, '..', '_local_assets', 'FilesForTest',
  'logs_8d888530-51c3-4167-94f7-2d4c9a1b887e_2026-07-14.txt');
if (fs.existsSync(refLive)) {
  const text = fs.readFileSync(refLive, 'utf8');
  const t0 = Date.now();
  const neu = parser.parse(text);
  const ms = Date.now() - t0;
  eq('reference live: format', neu.format, 'live');
  const slowCount = neu.records.filter(function (x) { return x.logNode === 'ConnectionBus_Queries' && /^Query executed in/.test(x.message); }).length;
  ok('reference live: 1181 slow-query warnings found', slowCount === 1181, 'got ' + slowCount);
  console.log('    (' + (text.length / (1024 * 1024)).toFixed(0) + ' MB → ' + neu.records.length + ' records in ' + ms + ' ms)');
} else {
  console.log('  – reference live log absent, skipped (PII: never committed)');
}

// ── Microflow Tracer extraction (public/js/tools/microflow-tracer.js) ────────
// The module is a plain script that attaches its pure parts to window/self,
// so pointing `window` at the global makes it requireable in Node too.
console.log('\nMicroflow Tracer extraction');
global.window = global;
require('../public/js/tools/microflow-tracer.js');
const mftExtract = global.mftExtractExecutions;
const mftTs = global.mftTsToMs;

ok('mftTsToMs parses live ISO with microseconds',
  Math.abs(mftTs('2026-07-17T10:00:00.500250') - mftTs('2026-07-17T10:00:00.000000') - 500.25) < 0.001);
ok('mftTsToMs parses Studio Pro CSV format',
  mftTs('07/11/2026 21:21:30') - mftTs('07/11/2026 21:21:29') === 1000);

const P = '[runtime-container/x]';
const mfLog = [
  '2026-07-17T10:00:00.000000 ' + P + '  DEBUG - MicroflowEngine: [100-1] Starting execution of microflow \'ModA.Parent\'',
  '2026-07-17T10:00:00.100000 ' + P + '  TRACE - MicroflowEngine: [100-1] Executing activity: {"current_activity":{"type":"Start"},"name":"ModA.Parent","type":"Microflow"}',
  '2026-07-17T10:00:00.200000 ' + P + '  TRACE - MicroflowEngine: [100-1] Executing activity: {"current_activity":{"caption":"Call child","type":"SubMicroflow"},"name":"ModA.Parent","type":"Microflow"}',
  '2026-07-17T10:00:00.250000 ' + P + '  DEBUG - MicroflowEngine: [100-1] Starting execution of microflow \'ModA.Child\'',
  '2026-07-17T10:00:00.300000 ' + P + '  TRACE - MicroflowEngine: [100-1] Executing activity: {"current_activity":{"caption":"Retrieve X","type":"RetrieveByXPath"},"name":"ModA.Child","type":"Microflow"}',
  '2026-07-17T10:00:00.700000 ' + P + '  DEBUG - MicroflowEngine: [100-1] Finished execution of microflow \'ModA.Child\'',
  '2026-07-17T10:00:01.000000 ' + P + '  DEBUG - MicroflowEngine: [100-1] Finished execution of microflow \'ModA.Parent\'',
  // second correlation ID, interleaved and never finished (log window cut)
  '2026-07-17T10:00:00.500000 ' + P + '  DEBUG - MicroflowEngine: [200-2] Starting execution of microflow \'ModB.Solo\'',
  // recursion: the same flow starts again while already on the stack
  '2026-07-17T10:00:02.000000 ' + P + '  DEBUG - MicroflowEngine: [300-3] Starting execution of microflow \'ModC.Rec\'',
  '2026-07-17T10:00:02.100000 ' + P + '  DEBUG - MicroflowEngine: [300-3] Starting execution of microflow \'ModC.Rec\'',
  '2026-07-17T10:00:02.200000 ' + P + '  DEBUG - MicroflowEngine: [300-3] Finished execution of microflow \'ModC.Rec\'',
  '2026-07-17T10:00:02.300000 ' + P + '  DEBUG - MicroflowEngine: [300-3] Finished execution of microflow \'ModC.Rec\'',
  // nested (anonymous) flow name normalization
  '2026-07-17T10:00:03.000000 ' + P + '  DEBUG - MicroflowEngine: [400-4] Starting execution of microflow \'ModD.Flow.nested.0f305fb0-28f0-46f8-8c42-06e71e5c3097\'',
  '2026-07-17T10:00:03.500000 ' + P + '  DEBUG - MicroflowEngine: [400-4] Finished execution of microflow \'ModD.Flow.nested.0f305fb0-28f0-46f8-8c42-06e71e5c3097\''
].join('\n');

const mfRecords = parser.parse(mfLog).records;
const mfOut = mftExtract(mfRecords);
eq('6 executions extracted', mfOut.executions.length, 6);
const parent = mfOut.executions.find(e => e.name === 'ModA.Parent');
const child = mfOut.executions.find(e => e.name === 'ModA.Child');
const solo = mfOut.executions.find(e => e.name === 'ModB.Solo');
ok('parent duration 1000 ms', Math.abs(parent.durationMs - 1000) < 0.001, 'got ' + parent.durationMs);
ok('child duration 450 ms', Math.abs(child.durationMs - 450) < 0.001, 'got ' + child.durationMs);
eq('child nests under parent', child.parentId, parent.id);
eq('parent has one child', parent.children.length, 1);
eq('child depth is 1', child.depth, 1);
eq('parent has 2 steps', parent.steps.length, 2);
eq('child step type parsed', child.steps[0].type, 'RetrieveByXPath');
eq('child step caption parsed', child.steps[0].caption, 'Retrieve X');
ok('parent step 1 duration = 100 ms (to next activity)', Math.abs(parent.steps[0].durationMs - 100) < 0.001, 'got ' + parent.steps[0].durationMs);
ok('parent step 2 closes at child start (50 ms)', Math.abs(parent.steps[1].durationMs - 50) < 0.001, 'got ' + parent.steps[1].durationMs);
ok('interleaved corrId stays unfinished', solo.finished === false && solo.durationMs === null);
const recs = mfOut.executions.filter(e => e.name === 'ModC.Rec');
ok('inner recursive call flagged REC', recs.some(e => e.recursive) && !recs[0].recursive);
ok('outer recursive call resolves its own Finished', recs[0].finished && Math.abs(recs[0].durationMs - 300) < 0.001);
const nested = mfOut.executions.find(e => e.name.indexOf('.nested.') !== -1);
eq('nested flow display name normalized', nested.displayName, 'ModD.Flow (nested)');
eq('correlation IDs counted', mfOut.stats.corrIds, 4);
const parentFlow = mfOut.flows.find(f => f.name === 'ModA.Parent');
ok('flow aggregate: 1 call, 1000 ms total', parentFlow.count === 1 && Math.abs(parentFlow.totalMs - 1000) < 0.001);
const recFlow = mfOut.flows.find(f => f.name === 'ModC.Rec');
ok('flow aggregate: recursion counted', recFlow.count === 2 && recFlow.recursions === 1);

// Reference: real Mendix Cloud log with MicroflowEngine DEBUG+TRACE (local only)
const refTrace = path.join(__dirname, '..', '_local_assets', 'FilesForTest', 'MxCloudApp_RealLogsWithTrace.txt');
if (fs.existsSync(refTrace)) {
  const text = fs.readFileSync(refTrace, 'utf8');
  const recs2 = parser.parse(text).records;
  const t0 = Date.now();
  const out = mftExtract(recs2);
  const ms = Date.now() - t0;
  eq('reference trace: 11137 executions', out.executions.length, 11137);
  const baseNames = new Set(out.executions.map(e => e.name.replace(/\.nested\..*$/, '')));
  eq('reference trace: 254 unique microflows', baseNames.size, 254);
  // Both corrId shapes exist in the wild: numeric (1784268324436-46, request-driven)
  // and UUID (scheduled events / background jobs) — 669 total in this file
  eq('reference trace: 669 correlation IDs', out.stats.corrIds, 669);
  eq('reference trace: 76204 activity records', out.stats.activityRecords, 76204);
  const finished = out.executions.filter(e => e.finished).length;
  console.log('    (' + (text.length / (1024 * 1024)).toFixed(0) + ' MB → ' + out.executions.length + ' executions (' + finished + ' finished) in ' + ms + ' ms)');
} else {
  console.log('  – reference trace log absent, skipped (PII: never committed)');
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
