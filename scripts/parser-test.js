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
// Regression: the Nginx analyzer resolves its own access-log date and passes an
// epoch Number to lqeSetTimeWindow, whose filter routes both bounds through this
// helper. Before the type guard that hit `.match` on a Number and threw, which
// killed the "SQL in window" cross-link after the chip had already been drawn.
ok('mftTsToMs passes an epoch Number through unchanged (Nginx cross-link)',
  mftTs(1784268324436) === 1784268324436);
ok('mftTsToMs rejects a non-finite Number instead of throwing',
  isNaN(mftTs(NaN)) && isNaN(mftTs(Infinity)));

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

// ── MFT: correlation-ID segmentation (numeric requests vs UUID scheduled events) ──
// Both shapes appear in the wild and must key independent call stacks: the same
// microflow running concurrently under a request corrId and a scheduled-event corrId
// must NOT be mistaken for recursion, and each Finished must close its own frame.
console.log('\nMicroflow Tracer: corrId segmentation');
const REQ = '1784268324436-46';                          // numeric — request-driven
const SE  = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';      // UUID — scheduled event
const segLog = [
  '2026-07-17T11:00:00.000000 ' + P + '  DEBUG - MicroflowEngine: [' + REQ + '] Starting execution of microflow \'ModX.Shared\'',
  '2026-07-17T11:00:00.100000 ' + P + '  DEBUG - MicroflowEngine: [' + SE  + '] Starting execution of microflow \'ModX.Shared\'',
  '2026-07-17T11:00:00.300000 ' + P + '  DEBUG - MicroflowEngine: [' + REQ + '] Finished execution of microflow \'ModX.Shared\'',
  '2026-07-17T11:00:00.500000 ' + P + '  DEBUG - MicroflowEngine: [' + SE  + '] Finished execution of microflow \'ModX.Shared\''
].join('\n');
const segOut = mftExtract(parser.parse(segLog).records);
eq('two corrId shapes counted separately', segOut.stats.corrIds, 2);
eq('same flow on two corrIds → two executions', segOut.executions.length, 2);
ok('neither execution flagged recursive (separate stacks)', segOut.executions.every(e => !e.recursive));
const reqExec = segOut.executions.find(e => e.corrId === REQ);
const seExec = segOut.executions.find(e => e.corrId === SE);
ok('request execution closes its own frame (300 ms)', reqExec.finished && Math.abs(reqExec.durationMs - 300) < 0.001, reqExec && reqExec.durationMs);
ok('scheduled-event execution closes its own frame (400 ms)', seExec.finished && Math.abs(seExec.durationMs - 400) < 0.001, seExec && seExec.durationMs);
ok('both are depth-0 roots (no cross-corrId nesting)', reqExec.depth === 0 && seExec.depth === 0 && reqExec.parentId === null && seExec.parentId === null);

// ── MFT: N+1 detection (database retrieves inside a loop) ──
console.log('\nMicroflow Tracer: N+1 detection');
const mftDetectN1 = global.mftDetectNPlusOne;
const n1Log = [
  '2026-07-17T11:00:00.000000 ' + P + '  DEBUG - MicroflowEngine: [n1-1] Starting execution of microflow \'Mod.LoopFlow\'',
  // Loop setup
  '2026-07-17T11:00:00.100000 ' + P + '  TRACE - MicroflowEngine: [n1-1] Executing activity: {"current_activity":{"type":"RetrieveByXPath","caption":"Get List"},"name":"Mod.LoopFlow","type":"Microflow"}',
  // Iteration 1
  '2026-07-17T11:00:00.200000 ' + P + '  TRACE - MicroflowEngine: [n1-1] Executing activity: {"current_activity":{"type":"ListLoop","caption":""},"name":"Mod.LoopFlow","type":"Microflow"}',
  '2026-07-17T11:00:00.250000 ' + P + '  TRACE - MicroflowEngine: [n1-1] Executing activity: {"current_activity":{"type":"RetrieveByXPath","caption":"Get Details"},"name":"Mod.LoopFlow","type":"Microflow"}',
  // Iteration 2
  '2026-07-17T11:00:00.300000 ' + P + '  TRACE - MicroflowEngine: [n1-1] Executing activity: {"current_activity":{"type":"ListLoop","caption":""},"name":"Mod.LoopFlow","type":"Microflow"}',
  '2026-07-17T11:00:00.350000 ' + P + '  TRACE - MicroflowEngine: [n1-1] Executing activity: {"current_activity":{"type":"RetrieveByXPath","caption":"Get Details"},"name":"Mod.LoopFlow","type":"Microflow"}',
  // Iteration 3
  '2026-07-17T11:00:00.400000 ' + P + '  TRACE - MicroflowEngine: [n1-1] Executing activity: {"current_activity":{"type":"ListLoop","caption":""},"name":"Mod.LoopFlow","type":"Microflow"}',
  '2026-07-17T11:00:00.450000 ' + P + '  TRACE - MicroflowEngine: [n1-1] Executing activity: {"current_activity":{"type":"RetrieveByXPath","caption":"Get Details"},"name":"Mod.LoopFlow","type":"Microflow"}',
  // Consecutive DB calls without loop (e.g. poor man's unrolled loop) -> should trigger pass 2
  '2026-07-17T11:00:00.500000 ' + P + '  TRACE - MicroflowEngine: [n1-1] Executing activity: {"current_activity":{"type":"RetrieveByAssociation","caption":"Get Children"},"name":"Mod.LoopFlow","type":"Microflow"}',
  '2026-07-17T11:00:00.550000 ' + P + '  TRACE - MicroflowEngine: [n1-1] Executing activity: {"current_activity":{"type":"RetrieveByAssociation","caption":"Get Children"},"name":"Mod.LoopFlow","type":"Microflow"}',
  '2026-07-17T11:00:00.600000 ' + P + '  TRACE - MicroflowEngine: [n1-1] Executing activity: {"current_activity":{"type":"RetrieveByAssociation","caption":"Get Children"},"name":"Mod.LoopFlow","type":"Microflow"}',
  '2026-07-17T11:00:00.700000 ' + P + '  DEBUG - MicroflowEngine: [n1-1] Finished execution of microflow \'Mod.LoopFlow\''
].join('\n');
const n1Out = mftExtract(parser.parse(n1Log).records);
const n1Count = mftDetectN1(n1Out.executions);
eq('detector finds 2 patterns', n1Count, 2);
const n1Exec = n1Out.executions[0];
ok('execution has nPlusOne array', Array.isArray(n1Exec.nPlusOne) && n1Exec.nPlusOne.length === 2);
const loopN1 = n1Exec.nPlusOne.find(d => d.type === 'RetrieveByXPath' && d.caption === 'Get Details');
ok('loop-aware pass detects 3 iterations', loopN1 && loopN1.count === 3);
ok('loop-aware pass sums duration (150ms total)', loopN1 && Math.abs(loopN1.totalMs - 150) < 0.001);
const consecN1 = n1Exec.nPlusOne.find(d => d.type === 'RetrieveByAssociation' && d.caption === 'Get Children');
ok('consecutive pass detects 3 calls', consecN1 && consecN1.count === 3);

// Shape B (the dominant real-world case): the loop body calls a sub-microflow
// that retrieves. Each iteration's sub-microflow is a SEPARATE child execution
// holding one retrieve, so detection must aggregate over the loop owner's subtree.
const n1SubLog = [
  '2026-07-17T11:10:00.000000 ' + P + '  DEBUG - MicroflowEngine: [n1-2] Starting execution of microflow \'Mod.Parent\'',
  '2026-07-17T11:10:00.050000 ' + P + '  TRACE - MicroflowEngine: [n1-2] Executing activity: {"current_activity":{"type":"ListLoop","caption":""},"name":"Mod.Parent","type":"Microflow"}',
  // iteration 1 → sub-microflow retrieves once
  '2026-07-17T11:10:00.100000 ' + P + '  DEBUG - MicroflowEngine: [n1-2] Starting execution of microflow \'Mod.Child\'',
  '2026-07-17T11:10:00.150000 ' + P + '  TRACE - MicroflowEngine: [n1-2] Executing activity: {"current_activity":{"type":"RetrieveByXPath","caption":"Get One"},"name":"Mod.Child","type":"Microflow"}',
  '2026-07-17T11:10:00.180000 ' + P + '  DEBUG - MicroflowEngine: [n1-2] Finished execution of microflow \'Mod.Child\'',
  // iteration 2
  '2026-07-17T11:10:00.200000 ' + P + '  DEBUG - MicroflowEngine: [n1-2] Starting execution of microflow \'Mod.Child\'',
  '2026-07-17T11:10:00.250000 ' + P + '  TRACE - MicroflowEngine: [n1-2] Executing activity: {"current_activity":{"type":"RetrieveByXPath","caption":"Get One"},"name":"Mod.Child","type":"Microflow"}',
  '2026-07-17T11:10:00.280000 ' + P + '  DEBUG - MicroflowEngine: [n1-2] Finished execution of microflow \'Mod.Child\'',
  // iteration 3
  '2026-07-17T11:10:00.300000 ' + P + '  DEBUG - MicroflowEngine: [n1-2] Starting execution of microflow \'Mod.Child\'',
  '2026-07-17T11:10:00.350000 ' + P + '  TRACE - MicroflowEngine: [n1-2] Executing activity: {"current_activity":{"type":"RetrieveByXPath","caption":"Get One"},"name":"Mod.Child","type":"Microflow"}',
  '2026-07-17T11:10:00.380000 ' + P + '  DEBUG - MicroflowEngine: [n1-2] Finished execution of microflow \'Mod.Child\'',
  '2026-07-17T11:10:00.400000 ' + P + '  DEBUG - MicroflowEngine: [n1-2] Finished execution of microflow \'Mod.Parent\''
].join('\n');
const n1SubOut = mftExtract(parser.parse(n1SubLog).records);
mftDetectN1(n1SubOut.executions);
const parentExec = n1SubOut.executions.find(e => e.name === 'Mod.Parent');
const childExecs = n1SubOut.executions.filter(e => e.name === 'Mod.Child');
const subHit = parentExec && parentExec.nPlusOne.find(d => d.type === 'RetrieveByXPath' && d.caption === 'Get One');
ok('subtree pass flags loop owner (retrieve in sub-microflow ×3)', subHit && subHit.count === 3);
ok('sub-microflow children are not individually flagged', childExecs.length === 3 && childExecs.every(e => e.nPlusOne.length === 0));

// ── MFT: scheduled events & background monitor ──
// A "run" is a depth-0 execution on a UUID correlation ID. Request-driven work
// (numeric corrId) and sub-microflows must stay out of the aggregation.
console.log('\nMicroflow Tracer: background monitor');
const mftBackground = global.mftBuildBackgroundView;
const U = n => String(n).repeat(8) + '-' + String(n).repeat(4) + '-4' + String(n).repeat(3) + '-8' + String(n).repeat(3) + '-' + String(n).repeat(12);
const bgStart = (ts, id, flow) => '2026-07-17T' + ts + ' ' + P + '  DEBUG - MicroflowEngine: [' + id + '] Starting execution of microflow \'' + flow + '\'';
const bgEnd = (ts, id, flow) => '2026-07-17T' + ts + ' ' + P + '  DEBUG - MicroflowEngine: [' + id + '] Finished execution of microflow \'' + flow + '\'';
const bgLog = [
  // four nightly runs, five minutes apart, getting slower over time
  bgStart('10:00:00.000000', U(1), 'Ops.Nightly'),
  bgStart('10:00:00.020000', U(1), 'Ops.Sub'),          // sub-microflow — not a run
  bgEnd('10:00:00.060000', U(1), 'Ops.Sub'),
  bgEnd('10:00:00.100000', U(1), 'Ops.Nightly'),
  bgStart('10:05:00.000000', U(2), 'Ops.Nightly'),
  bgEnd('10:05:00.120000', U(2), 'Ops.Nightly'),
  bgStart('10:10:00.000000', U(3), 'Ops.Nightly'),
  bgEnd('10:10:00.400000', U(3), 'Ops.Nightly'),
  bgStart('10:15:00.000000', U(4), 'Ops.Nightly'),
  bgEnd('10:15:00.500000', U(4), 'Ops.Nightly'),
  // same microflow, request-driven — must not be counted as a background run
  bgStart('10:16:00.000000', '1784268324436-46', 'Ops.Nightly'),
  bgEnd('10:16:00.900000', '1784268324436-46', 'Ops.Nightly'),
  // two runs of the same event overlapping by 5 s
  bgStart('10:20:00.000000', U(5), 'Ops.Overlap'),
  bgStart('10:20:05.000000', U(6), 'Ops.Overlap'),
  bgEnd('10:20:10.000000', U(5), 'Ops.Overlap'),
  bgEnd('10:20:12.000000', U(6), 'Ops.Overlap'),
  // started, never finished (log window ends mid-run)
  bgStart('10:30:00.000000', U(7), 'Ops.Stuck')
].join('\n');
const bgOut = mftBackground(mftExtract(parser.parse(bgLog).records).executions, []);
eq('background: three events aggregated', bgOut.events.length, 3);
eq('background: request-driven runs excluded from events', bgOut.runs, 7);
eq('background: request-driven runs counted separately', bgOut.requestRuns, 1);
const bgNightly = bgOut.events.find(e => e.name === 'Ops.Nightly');
eq('background: four runs of the nightly event', bgNightly.runs, 4);
ok('background: sub-microflow is not an event of its own', !bgOut.events.some(e => e.name === 'Ops.Sub'));
ok('background: min/median/max durations', bgNightly.minMs === 100 && bgNightly.medianMs === 260 && bgNightly.maxMs === 500,
  bgNightly.minMs + '/' + bgNightly.medianMs + '/' + bgNightly.maxMs);
eq('background: median start-to-start interval is the schedule', bgNightly.medianIntervalMs, 300000);
eq('background: slowing runs trend up', bgNightly.trend.dir, 'up');
ok('background: trend compares half-medians (110 → 450)',
  bgNightly.trend.firstHalfMs === 110 && bgNightly.trend.secondHalfMs === 450,
  bgNightly.trend.firstHalfMs + ' → ' + bgNightly.trend.secondHalfMs);
const bgOverlap = bgOut.events.find(e => e.name === 'Ops.Overlap');
eq('background: overlapping runs detected', bgOverlap.overlapCount, 1);
eq('background: overlap duration measured', bgOverlap.overlaps[0].overlapMs, 5000);
eq('background: overlaps totalled across events', bgOut.overlapCount, 1);
const bgStuck = bgOut.events.find(e => e.name === 'Ops.Stuck');
ok('background: unfinished run has no duration stats', bgStuck.unfinished === 1 && bgStuck.medianMs === null);
eq('background: unfinished totalled across events', bgOut.unfinished, 1);
ok('background: events sorted by run count', bgOut.events[0].name === 'Ops.Nightly');
// A single run cannot trend and must not pretend to (data-driven rule).
ok('background: a single run yields no trend', bgStuck.trend === null);
ok('background: a single run yields no interval', bgStuck.medianIntervalMs === null);
// Empty input: no invented events, and the caller can tell there was no engine data.
const bgEmpty = mftBackground([], []);
ok('background: empty input yields no events and no engine data',
  bgEmpty.events.length === 0 && bgEmpty.hasEngineData === false && bgEmpty.errors.length === 0);

// Fallback for INFO-only logs: MicroflowEngine is silent, but background failures
// are not — those are worth surfacing instead of an empty view.
const bgErrLog = [
  '2026-07-17T12:00:00.000000 ' + P + '  ERROR - TaskQueue: Task MDM.UPD_UserData failed',
  '2026-07-17T12:00:01.000000 ' + P + '  ERROR - TaskQueue: Task MDM.UPD_UserData failed',
  '2026-07-17T12:00:02.000000 ' + P + '  WARNING - TaskQueue: Retrying task',
  '2026-07-17T12:00:03.000000 ' + P + '  ERROR - Core: Error executing scheduled event Ops.Nightly',
  '2026-07-17T12:00:04.000000 ' + P + '  ERROR - Jetty: Unrelated request failure'
].join('\n');
const bgErr = mftBackground([], parser.parse(bgErrLog).records);
eq('background fallback: two node groups (queue + scheduled event)', bgErr.errors.length, 2);
eq('background fallback: repeated task failures counted', bgErr.errors[0].count, 2);
eq('background fallback: node name kept', bgErr.errors[0].node, 'TaskQueue');
ok('background fallback: warnings are not failures', !bgErr.errors.some(e => e.count > 2));
ok('background fallback: unrelated ERROR nodes ignored', !bgErr.errors.some(e => e.node === 'Jetty'));
ok('background fallback: scheduled-event ERROR matched by message, not node',
  bgErr.errors.some(e => e.node === 'Core' && e.count === 1));
ok('background fallback: first/last timestamps kept',
  bgErr.errors[0].firstTs === '2026-07-17T12:00:00.000000' && bgErr.errors[0].lastTs === '2026-07-17T12:00:01.000000');

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
  // N+1 detection must fire on the real log (regression guard: the split loop
  // owner delegates its retrieves to sub-microflows, so subtree aggregation is
  // required). This file contains a textbook 3040× RetrieveByXPath in a ListLoop.
  const realN1 = mftDetectN1(out.executions);
  ok('reference trace: N+1 detector fires on real data', realN1 > 0, 'got ' + realN1);
  const worst = out.executions
    .filter(e => e.nPlusOne && e.nPlusOne.length)
    .map(e => e.nPlusOne[0].count)
    .sort((a, b) => b - a)[0] || 0;
  ok('reference trace: worst offender is a large loop (≥1000×)', worst >= 1000, 'worst=' + worst);
  // Background monitor on real data: 312 background runs across 22 distinct
  // events, against 357 request-driven ones — the corrId split is what separates
  // them, and getting it wrong shows up immediately in these counts.
  const bgRef = global.mftBuildBackgroundView(out.executions, recs2);
  eq('reference trace: 312 background runs', bgRef.runs, 312);
  eq('reference trace: 357 request-driven runs', bgRef.requestRuns, 357);
  eq('reference trace: 22 background events', bgRef.events.length, 22);
  const qStats = bgRef.events.find(e => e.name === 'Queues.QueuesStats');
  eq('reference trace: Queues.QueuesStats ran 91 times', qStats.runs, 91);
  ok('reference trace: its median interval is the 5-minute schedule',
    Math.abs(qStats.medianIntervalMs - 300000) < 1000, 'got ' + qStats.medianIntervalMs);
  ok('reference trace: overlapping background runs found', bgRef.overlapCount === 4, 'got ' + bgRef.overlapCount);
} else {
  console.log('  – reference trace log absent, skipped (PII: never committed)');
}

// ── Log Query Extractor aggregation (public/js/tools/log-query-extractor.js) ──
// The module attaches its pure extractor to window; pointing `window` at the global
// (already done above for MFT) makes lqeExtractQueries requireable in Node.
console.log('\nLog Query Extractor aggregation');
require('../public/js/tools/log-query-extractor.js');
const lqeExtract = global.lqeExtractQueries;

const TR = '  TRACE - ';
const lqeLog = [
  // Query A: XPath source + SQL + params + result (row count) + linked plan (via xpathId)
  '2026-07-17T10:00:00.000000 ' + P + TR + 'ConnectionBus_Retrieve: Incoming query of type XPath: [abc001] //Sales.Order[Status=\'Open\']',
  '2026-07-17T10:00:00.010000 ' + P + TR + 'ConnectionBus_Retrieve: SQL@aaa111(T1-Cff01): SELECT "sales$order"."id" FROM "sales$order" WHERE "status" = ?',
  '2026-07-17T10:00:00.020000 ' + P + TR + 'ConnectionBus_Retrieve: SQL@aaa111(T1-Cff01): Select params: \'Open\'',
  '2026-07-17T10:00:00.030000 ' + P + TR + 'ConnectionBus_Retrieve: SQL@aaa111(T1-Cff01): [abc001] Data table (3 row(s))',
  '2026-07-17T10:00:00.040000 ' + P + TR + 'DataStorage_QueryPlan: Query Plan: [abc001] [{"Plan":{"Node Type":"Seq Scan","Total Cost":12.5},"Execution Time":4.2,"Planning Time":0.3}]',
  // Query B: identical statement, different bound value → same signature as A (N+1 duplicate)
  '2026-07-17T10:00:00.050000 ' + P + TR + 'ConnectionBus_Retrieve: SQL@aaa222(T1-Cff01): SELECT "sales$order"."id" FROM "sales$order" WHERE "status" = ?',
  '2026-07-17T10:00:00.060000 ' + P + TR + 'ConnectionBus_Retrieve: SQL@aaa222(T1-Cff01): [def002] Data table (1 row(s))',
  // Query C: UPDATE with inline numeric literals → normalized to ? in the signature.
  // Its own result line carries an xpathId (no plan logged for it), so it is NOT
  // eligible for the unlinked plan below — that must flow to query D instead.
  '2026-07-17T10:00:00.070000 ' + P + TR + 'ConnectionBus_Update: SQL@ccc333(T1-Cff01): UPDATE "sales$order" SET "amount" = 5 WHERE "id" = 42',
  '2026-07-17T10:00:00.080000 ' + P + TR + 'ConnectionBus_Update: SQL@ccc333(T1-Cff01): [aa99bb] Data table (1 row(s))',
  // Slow-query WARNING — full SQL + duration at default log levels, no TRACE needed
  '2026-07-17T10:00:01.000000 ' + P + '  WARNING - ConnectionBus_Queries: Query executed in 3 seconds and 100 milliseconds: SELECT "big"."id" FROM "big"',
  // Query D: no xpathId — receives the unlinked plan below (FIFO, first eligible query wins)
  '2026-07-17T10:00:02.000000 ' + P + TR + 'ConnectionBus_Retrieve: SQL@ddd444(T1-Cff01): SELECT "cust"."name" FROM "cust"',
  '2026-07-17T10:00:02.010000 ' + P + TR + 'DataStorage_QueryPlan: Query Plan: [{"Plan":{"Node Type":"Index Scan","Total Cost":3.1},"Execution Time":1.1}]',
  // Query E: the two shapes real logs use for bound values, which the synthetic
  // fixtures above do not cover — a JSON document as a single parameter (its own
  // commas must not split it) and a third value spilled onto its own line, which
  // the runtime writes WITHOUT the colon after the (Tx-Cyy) part.
  '2026-07-17T10:00:03.000000 ' + P + TR + 'ConnectionBus_Update: SQL@eee555(T1-Cff01): UPDATE "system$backgroundjob" SET "endtime" = ?, "result" = ? WHERE "id" = ?',
  '2026-07-17T10:00:03.010000 ' + P + TR + 'ConnectionBus_Update: SQL@eee555(T1-Cff01): Update params 1-2: 2026-07-17 10:00:03.000, {"body":{"changes":{"1":{"Name":{"value":"a, b"}},"2":{"Name":{"value":"c"}}}}}',
  '2026-07-17T10:00:03.020000 ' + P + TR + 'ConnectionBus_Update: SQL@eee555(T1-Cff01) Update param 3: 7318349405133931'
].join('\n');

const lqeRecs = parser.parse(lqeLog).records;
eq('LQE fixture parsed as live', parser.parse(lqeLog).format, 'live');
const qs = lqeExtract(lqeRecs);
eq('six queries extracted', qs.length, 6);
const qById = id => qs.find(q => q.sqlId === id);
const qA = qById('aaa111'), qB = qById('aaa222'), qC = qById('ccc333'), qD = qById('ddd444');
const qSlow = qs.find(q => q.slowWarning);

// Statement-type classification
eq('SELECT classified', qA.type, 'SELECT');
eq('UPDATE classified', qC.type, 'UPDATE');

// Duplicate detection (N+1): normalized signature groups A and B
eq('duplicate SELECTs share a signature', qA.signature, qB.signature);
ok('both duplicates report dupCount 2', qA.dupCount === 2 && qB.dupCount === 2, 'A=' + qA.dupCount + ' B=' + qB.dupCount);
eq('non-duplicated query has dupCount 1', qC.dupCount, 1);
ok('numeric literals normalized to ? in signature', qC.signature.indexOf('5') === -1 && qC.signature.indexOf('42') === -1, qC.signature);

// Plan linking via xpathId — duration/cost/planning time lifted out of the plan JSON
ok('plan linked by xpathId', qA.xpathId === 'abc001' && qA.queryPlan.length > 0);
eq('execution time from linked plan', qA.duration, '4.200 ms');
eq('total cost from linked plan', qA.cost, 12.5);
eq('planning time from linked plan', qA.planningTime, '0.300 ms');
eq('row count captured from result line', qA.rows, '3');
ok('params parsed off the Select-params line', qA.params.length === 1 && qA.params[0] === '\'Open\'', JSON.stringify(qA.params));

// Bound values as real logs write them (see query E). Both shapes used to be
// mishandled: the JSON document was split on its internal commas into dozens of
// fragments, and the spilled third value was dropped with its whole line because
// that line has no colon after (Tx-Cyy) — leaving a bare `?` in the rebuilt SQL.
const qE = qById('eee555');
eq('spilled "param 3" line is not dropped', qE.params.length, 3);
eq('a JSON parameter survives its own commas whole', qE.params[1],
  '{"body":{"changes":{"1":{"Name":{"value":"a, b"}},"2":{"Name":{"value":"c"}}}}}');
eq('the value after the JSON one is still its own parameter', qE.params[2], '7318349405133931');
eq('every placeholder has a value', (qE.sql.match(/\?/g) || []).length, qE.params.length);

// Unlinked plan (no xpathId) assigned FIFO to the first eligible query; slow warnings never consume one
ok('unlinked plan assigned to first plan-less query', qD.duration === '1.100 ms' && qD.cost === 3.1, qD.duration + '/' + qD.cost);
ok('duplicate B without its own plan stays unlinked', qB.queryPlan === '' && qB.duration === null);

// Slow-query warning ingestion
ok('slow-query warning ingested', !!qSlow && qSlow.duration === '3100 ms', qSlow && qSlow.duration);
ok('slow-query warning did not swallow a plan', qSlow.queryPlan === '');

// ── "By statement" aggregate (wave 15) ───────────────────────────────────────
// Folds executions onto the signature the duplicate detector already computes,
// so the question "which statement costs the most in total" becomes answerable.
// The contract that matters: a total is only ever summed from the executions the
// log actually timed, and a group with none reports null — not 0 ms.
const lqeAgg = global.lqeAggregateByStatement;
const groups = lqeAgg(qs);
eq('by statement: 6 executions fold into 5 statements', groups.length, 5);

const gDup = groups.find(g => g.count === 2);
ok('by statement: A and B share one group', !!gDup);
eq('by statement: duplicate group counts both executions', gDup.count, 2);
eq('by statement: only the timed execution feeds the total', gDup.timedCount, 1);
ok('by statement: total is the measured 4.2 ms, not doubled', Math.abs(gDup.sumMs - 4.2) < 1e-9, gDup.sumMs);
ok('by statement: average is over timed executions only', Math.abs(gDup.avgMs - 4.2) < 1e-9, gDup.avgMs);
eq('by statement: worst execution is the timed one', gDup.worst.sqlId, 'aaa111');

const gUntimed = groups.find(g => g.sample.sqlId === 'ccc333');
eq('by statement: an untimed statement reports null total, not zero', gUntimed.sumMs, null);
eq('by statement: an untimed statement reports null average', gUntimed.avgMs, null);
eq('by statement: an untimed statement reports null max', gUntimed.maxMs, null);
eq('by statement: an untimed group is still represented by its first execution', gUntimed.worst.sqlId, 'ccc333');

eq('by statement: default order is total cost first', groups[0].sumMs, 3100);
eq('by statement: the slow warning is counted as one', groups[0].slowCount, 1);
eq('by statement: statements without a slow warning report zero', gDup.slowCount, 0);
eq('by statement: empty input yields no groups', lqeAgg([]).length, 0);

// ── REST & WS Extractor pairing (public/js/tools/ws-rest-extractor.js) ───────
// Written test-first (wave 4). The pairing contract: requests and responses are
// matched FIFO per (logNode + method + URL); overlapping in-flight requests with
// the same key get an `uncertain` flag because FIFO is an assumption, not a fact.
// The interleave fixture reproduces a REAL case from MxCloudApp_RealLogsWithTrace.txt
// (two POSTs to the same endpoint in flight at once, lines 105699/105704).
console.log('\nREST & WS Extractor pairing');
require('../public/js/tools/ws-rest-extractor.js');
const wsreExtract = global.wsreExtractCalls;

const wsreLog = [
  // (1) Consume happy path — anchor gives corrId + microflow, timeout captured,
  // headers + JSON bodies parsed, duration from the request→response delta.
  '2026-07-17T12:00:00.000000 ' + P + TR + 'MicroflowEngine: [900-1] Executing activity: {"current_activity":{"caption":"Call REST (POST)","type":"CallRest"},"name":"Mod.SendData","type":"Microflow"}',
  '2026-07-17T12:00:00.001000 ' + P + TR + 'REST Consume: Creating http client for api.example.com with timeout = 10s',
  '2026-07-17T12:00:00.001500 ' + P + '  DEBUG - REST Consume: Using a timeout of 10 seconds',
  '2026-07-17T12:00:00.002000 ' + P + TR + 'REST Consume: Request content for POST request to https://api.example.com/rest/send/v1/data HTTP/1.1',
  'Content-Type: application/json',
  'Authorization: (omitted)',
  '{"RequestID":1,"Code":"A"}',
  '2026-07-17T12:00:00.502000 ' + P + TR + 'REST Consume: Response content for POST request to https://api.example.com/rest/send/v1/data',
  'HTTP/1.1 200 OK',
  'Content-Type: application/json;charset=utf-8',
  '{"ok":true}',

  // (2) REAL interleave case — two calls to the SAME method+URL in flight at once
  // (each with its own CallRest anchor), then both responses. FIFO must pair
  // req1→resp1 / req2→resp2 and BOTH calls must carry the uncertainty flag.
  '2026-07-17T12:01:00.000000 ' + P + TR + 'MicroflowEngine: [3769f9ea-dd81-4306-8f0e-121a8af66755] Executing activity: {"current_activity":{"caption":"Call REST (POST)","type":"CallRest"},"name":"MyTT.SendShipment","type":"Microflow"}',
  '2026-07-17T12:01:00.004000 ' + P + TR + 'MicroflowEngine: [a81f0323-947d-48c3-98ae-77a671cc8bbf] Executing activity: {"current_activity":{"caption":"Call REST (POST)","type":"CallRest"},"name":"MyTT.SendShipment","type":"Microflow"}',
  '2026-07-17T12:01:00.006000 ' + P + TR + 'REST Consume: Request content for POST request to https://api.example.com/rest/ship/v1/shipment HTTP/1.1',
  'Content-Type: application/json',
  '{"shipment":1}',
  '2026-07-17T12:01:00.007000 ' + P + TR + 'REST Consume: Request content for POST request to https://api.example.com/rest/ship/v1/shipment HTTP/1.1',
  'Content-Type: application/json',
  '{"shipment":2}',
  '2026-07-17T12:01:01.148000 ' + P + TR + 'REST Consume: Response content for POST request to https://api.example.com/rest/ship/v1/shipment',
  'HTTP/1.1 200 OK',
  '{"received":1}',
  '2026-07-17T12:01:01.149000 ' + P + TR + 'REST Consume: Response content for POST request to https://api.example.com/rest/ship/v1/shipment',
  'HTTP/1.1 500 Internal Server Error',
  '{"received":2}',

  // (3) Consume without a response (client timeout suspect — 10s timeout known)
  '2026-07-17T12:02:00.000000 ' + P + TR + 'REST Consume: Creating http client for dead.example.com with timeout = 10s',
  '2026-07-17T12:02:00.001000 ' + P + TR + 'REST Consume: Request content for GET request to https://dead.example.com/rest/ping HTTP/1.1',
  'Accept: application/json',

  // (4) SOAP consume (WebServices) — SOAPAction header, XML bodies, own FIFO key
  '2026-07-17T12:03:00.000000 ' + P + TR + 'MicroflowEngine: [900-2] Executing activity: {"current_activity":{"caption":"Call web service \'getHeader\'","type":"CallWebservice"},"name":"Integration.GetInvoiceData","type":"Microflow"}',
  '2026-07-17T12:03:00.050000 ' + P + TR + 'WebServices: Created soap request:',
  '<soapenv:Envelope><soapenv:Body><ns1:HeaderRequest><compCode>PL14</compCode></ns1:HeaderRequest></soapenv:Body></soapenv:Envelope>',
  '2026-07-17T12:03:00.060000 ' + P + TR + 'WebServices: Creating http client for soap.example.com with timeout = 10s',
  '2026-07-17T12:03:00.100000 ' + P + TR + 'WebServices: Request content for POST request to https://soap.example.com/Invoices/InvoiceService HTTP/1.1',
  'SOAPAction: "urn:getHeader"',
  'Content-Type: text/xml; charset=UTF-8',
  '<soapenv:Envelope><soapenv:Body><ns1:HeaderRequest><compCode>PL14</compCode></ns1:HeaderRequest></soapenv:Body></soapenv:Envelope>',
  '2026-07-17T12:03:00.433000 ' + P + TR + 'WebServices: Response content for POST request to https://soap.example.com/Invoices/InvoiceService',
  'HTTP/1.1 200 OK',
  'content-type: text/xml; charset=utf-8',
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<soapenv:Envelope><soapenv:Body><HeaderResponse/></soapenv:Body></soapenv:Envelope>',

  // (5) REST Publish matched operation — routing noise must be ignored, operation
  // captured, response 200 with body, duration = incoming→outgoing delta
  '2026-07-17T12:04:00.000000 ' + P + TR + 'REST Publish: Incoming request from 127.0.0.1: POST http://app.example.com/rest/calculator/v1/httpRequest?request=42&cost=0',
  'Accept: application/json',
  'traceparent: 00-68e15ede94f821a5b33f1cfd4433e811-d6de9389113ea824-00',
  'Content-Length: 0',
  '2026-07-17T12:04:00.001000 ' + P + TR + 'REST Publish: Path \'calculator/v1/httpRequest\' did not match \'getquotation/quotation\', continuing...',
  '2026-07-17T12:04:00.002000 ' + P + TR + 'REST Publish: Executing operation POST rest/calculator/v1/httpRequest',
  '2026-07-17T12:04:00.003000 ' + P + TR + 'REST Publish: Query parameter \'request\' (microflow parameter \'request\') has value \'42\'',
  '2026-07-17T12:04:00.356000 ' + P + TR + 'REST Publish: Outgoing response:',
  'HTTP/1.1 200',
  'Cache-Control: no-store',
  'Total cost error - Please check the information',

  // (6) REST Publish unmatched → 404 close with reason
  '2026-07-17T12:05:00.000000 ' + P + TR + 'REST Publish: Incoming request from 127.0.0.1: GET http://app.example.com/rest/default/V1/guest-carts',
  'Accept: */*',
  '2026-07-17T12:05:00.002000 ' + P + '  DEBUG - REST Publish: Responding with 404 Not Found, because no operation matches http://app.example.com/rest/default/V1/guest-carts',

  // (7) WS Publish (incoming SOAP) — service name, per-record headers, request data
  // continuation, chunked response, Finished closes the call
  '2026-07-17T12:06:00.000000 ' + P + '  DEBUG - WebServices: Incoming web service request from 127.0.0.1 for service \'AppUser_Create_Update\'',
  '2026-07-17T12:06:00.000500 ' + P + TR + 'WebServices: Incoming web service request data: ',
  '<soapenv:Envelope><soapenv:Body><ns1:Operation><User><Name>x@example.com</Name></User></ns1:Operation></soapenv:Body></soapenv:Envelope>',
  '2026-07-17T12:06:00.001000 ' + P + TR + 'WebServices: Header soapaction: "http://www.example.com/Operation"',
  '2026-07-17T12:06:00.001500 ' + P + TR + 'WebServices: Header Content-Type: text/xml; charset=UTF-8',
  '2026-07-17T12:06:00.363000 ' + P + TR + 'WebServices: [Operation chunk: 1] <?xml version=\'1.0\' encoding=\'UTF-8\'?><soap:Envelope><soap:Body><tns:OperationResponse><Error>false</Error></tns:OperationResponse></soap:Body></soap:Envelope>',
  '2026-07-17T12:06:00.364000 ' + P + '  DEBUG - WebServices: Finished handling web service request for service \'AppUser_Create_Update\'',
  '2026-07-17T12:06:00.368000 ' + P + '  DEBUG - WebServices: Web service request from 127.0.0.1 finished'
].join('\n');

const wsreRecs = parser.parse(wsreLog).records;
const wsreOut = wsreExtract(wsreRecs);
const calls = wsreOut.calls;
eq('8 calls extracted', calls.length, 8);

// (1) Consume happy path
const c1 = calls.find(c => c.url && c.url.indexOf('/rest/send/v1/data') !== -1);
ok('consume call found', !!c1);
eq('consume node', c1.node, 'REST Consume');
eq('consume direction', c1.direction, 'out');
eq('consume method', c1.method, 'POST');
eq('consume status 200', c1.status, 200);
ok('consume duration 500 ms', Math.abs(c1.durationMs - 500) < 0.001, 'got ' + c1.durationMs);
eq('consume timeout captured', c1.timeoutSec, 10);
ok('consume request headers parsed', c1.requestHeaders.some(h => h.name === 'Content-Type' && h.value === 'application/json'), JSON.stringify(c1.requestHeaders));
ok('consume response headers parsed', c1.responseHeaders.some(h => h.name.toLowerCase() === 'content-type'), JSON.stringify(c1.responseHeaders));
eq('consume request body', c1.requestBody, '{"RequestID":1,"Code":"A"}');
eq('consume response body', c1.responseBody, '{"ok":true}');
ok('consume not flagged uncertain', !c1.uncertain);
eq('anchor corrId attached', c1.corrId, '900-1');
eq('anchor microflow attached', c1.microflow, 'Mod.SendData');

// (2) Interleave: FIFO per (method+URL) + uncertainty flag on both
const ship = calls.filter(c => c.url && c.url.indexOf('/rest/ship/v1/shipment') !== -1);
eq('two interleaved calls extracted', ship.length, 2);
eq('FIFO: first request gets first response', ship[0].responseBody, '{"received":1}');
eq('FIFO: second request gets second response', ship[1].responseBody, '{"received":2}');
eq('FIFO: first status 200', ship[0].status, 200);
eq('FIFO: second status 500', ship[1].status, 500);
ok('both interleaved calls flagged uncertain', ship[0].uncertain && ship[1].uncertain);
eq('interleave: first anchor corrId', ship[0].corrId, '3769f9ea-dd81-4306-8f0e-121a8af66755');
eq('interleave: second anchor corrId', ship[1].corrId, 'a81f0323-947d-48c3-98ae-77a671cc8bbf');
ok('durations from own pair (1142/1142 ms)', Math.abs(ship[0].durationMs - 1142) < 0.001 && Math.abs(ship[1].durationMs - 1142) < 0.001,
  ship[0].durationMs + '/' + ship[1].durationMs);

// (3) Unanswered request → no response, timeout suspect
const dead = calls.find(c => c.url && c.url.indexOf('dead.example.com') !== -1);
ok('unanswered call kept', !!dead && dead.status === null);
ok('unanswered call has no duration', dead.durationMs === null);
ok('unanswered call flagged as timeout suspect', dead.timeoutSuspect === true);

// (4) SOAP consume
const soap = calls.find(c => c.node === 'WebServices' && c.direction === 'out');
ok('SOAP consume found', !!soap);
eq('SOAP consume kind', soap.kind, 'soap');
eq('SOAP status 200', soap.status, 200);
ok('SOAP duration 333 ms', Math.abs(soap.durationMs - 333) < 0.001, 'got ' + soap.durationMs);
ok('SOAPAction header kept', soap.requestHeaders.some(h => h.name === 'SOAPAction'));
ok('SOAP request body is the envelope', soap.requestBody.indexOf('<soapenv:Envelope>') === 0);
ok('SOAP response body includes xml prolog line', soap.responseBody.indexOf('<?xml') === 0 && soap.responseBody.indexOf('HeaderResponse') !== -1);
eq('CallWebservice anchor corrId', soap.corrId, '900-2');
eq('CallWebservice anchor microflow', soap.microflow, 'Integration.GetInvoiceData');

// (5) REST Publish matched
const pub = calls.find(c => c.node === 'REST Publish' && c.status === 200);
ok('publish call found', !!pub);
eq('publish direction', pub.direction, 'in');
eq('publish method', pub.method, 'POST');
eq('publish operation captured', pub.operation, 'rest/calculator/v1/httpRequest');
ok('publish routing noise not in headers', !pub.requestHeaders.some(h => /did not match/.test(h.value)));
ok('publish request headers parsed', pub.requestHeaders.some(h => h.name === 'traceparent'));
eq('publish response body', pub.responseBody, 'Total cost error - Please check the information');
ok('publish duration 356 ms', Math.abs(pub.durationMs - 356) < 0.001, 'got ' + pub.durationMs);

// (6) REST Publish 404
const pub404 = calls.find(c => c.node === 'REST Publish' && c.status === 404);
ok('404 publish call found', !!pub404);
eq('404 status text', pub404.statusText, 'Not Found');
ok('404 reason kept', /no operation matches/.test(pub404.responseBody), JSON.stringify(pub404.responseBody));

// (7) WS Publish (incoming SOAP)
const wsIn = calls.find(c => c.node === 'WebServices' && c.direction === 'in');
ok('WS publish call found', !!wsIn);
eq('WS publish service', wsIn.service, 'AppUser_Create_Update');
ok('WS publish request body captured', wsIn.requestBody.indexOf('<soapenv:Envelope>') === 0);
ok('WS publish per-record headers collected', wsIn.requestHeaders.some(h => h.name === 'soapaction'));
ok('WS publish chunked response captured', wsIn.responseBody.indexOf('OperationResponse') !== -1);
eq('WS publish operation from chunk marker', wsIn.operation, 'Operation');
ok('WS publish duration 364 ms', Math.abs(wsIn.durationMs - 364) < 0.001, 'got ' + wsIn.durationMs);

// Stats
ok('stats: total matches', wsreOut.stats.total === 8);
eq('stats: uncertain count', wsreOut.stats.uncertain, 2);
eq('stats: unanswered count', wsreOut.stats.unanswered, 1);

// ── 9.8: per-endpoint "Total Transferred" (wsreEndpointTotals) ───────────────
// Byte size uses .length as a Node fallback (no Blob global) — fine for these
// ASCII fixtures where UTF-8 byte count equals character count.
console.log('\nWSRE — per-endpoint transferred bytes');
const wsreEndpointTotals = global.wsreEndpointTotals;
const wsreEndpointFn = global.wsreEndpoint;
const shipmentCalls = calls.filter(c => wsreEndpointFn(c) === 'https://api.example.com/rest/ship/v1/shipment');
eq('endpoint totals: two calls share the shipment endpoint', shipmentCalls.length, 2);
const totals = wsreEndpointTotals(calls);
const shipmentTotal = totals.get('https://api.example.com/rest/ship/v1/shipment');
ok('endpoint totals: shipment entry present', !!shipmentTotal);
eq('endpoint totals: call count aggregated per endpoint', shipmentTotal.count, 2);
const expectedShipmentBytes = shipmentCalls.reduce((sum, c) => sum + (c.requestBody || '').length + (c.responseBody || '').length, 0);
eq('endpoint totals: bytes summed across calls to the same endpoint', shipmentTotal.bytes, expectedShipmentBytes);
ok('endpoint totals: an endpoint with a single call is not conflated with others',
  totals.get('https://api.example.com/rest/send/v1/data').count === 1);

// ── "By endpoint" aggregate (wave 16) ────────────────────────────────────────
// An integration incident is "endpoint X fires 300× per page open", not
// "call #4172 took 900 ms". Same contract as the Query Extractor's statement
// view: totals are summed only over the calls the log actually timed, and an
// endpoint with no paired response reports null rather than 0 ms.
console.log('\nWSRE — by endpoint');
const wsreAgg = global.wsreAggregateByEndpoint;
const eps = wsreAgg(calls);
const epBy = {};
eps.forEach(function (g) { epBy[g.endpoint] = g; });

const epShip = epBy['https://api.example.com/rest/ship/v1/shipment'];
ok('by endpoint: the two shipment calls fold into one row', !!epShip);
eq('by endpoint: call count', epShip.count, 2);
eq('by endpoint: both calls were timed', epShip.timedCount, 2);
eq('by endpoint: the 500 response is counted as an error', epShip.errors, 1);
ok('by endpoint: total is the sum of both durations',
  Math.abs(epShip.sumMs - (ship[0].durationMs + ship[1].durationMs)) < 0.001, epShip.sumMs);
ok('by endpoint: average is the total over the timed calls',
  Math.abs(epShip.avgMs - epShip.sumMs / 2) < 0.001, epShip.avgMs);
eq('by endpoint: max is the slowest single call', epShip.maxMs, Math.max(ship[0].durationMs, ship[1].durationMs));
eq('by endpoint: uncertain pairings are carried through', epShip.uncertain, 2);

const epDead = epBy['https://dead.example.com/rest/ping'];
ok('by endpoint: the unanswered call still gets a row', !!epDead);
eq('by endpoint: it is counted as having no response', epDead.unanswered, 1);
eq('by endpoint: an endpoint the log never timed reports null total, not zero', epDead.sumMs, null);
eq('by endpoint: ...and null average', epDead.avgMs, null);
eq('by endpoint: ...and is still represented by its own call', epDead.worst.url, 'https://dead.example.com/rest/ping');

eq('by endpoint: every call lands in exactly one group',
  eps.reduce(function (n, g) { return n + g.count; }, 0), calls.length);
ok('by endpoint: default order is total time first',
  eps[0].sumMs === null || eps.every(function (g) { return g.sumMs === null || g.sumMs <= eps[0].sumMs; }),
  JSON.stringify(eps.map(function (g) { return g.sumMs; })));
eq('by endpoint: empty input yields no groups', wsreAgg([]).length, 0);
eq('endpoint totals: empty call list yields an empty map', wsreEndpointTotals([]).size, 0);

// Reference: the same real trace log used by MFT/LQE reference tests (local only)
if (fs.existsSync(refTrace)) {
  const text = fs.readFileSync(refTrace, 'utf8');
  const recs3 = parser.parse(text).records;
  const t0 = Date.now();
  const out = wsreExtract(recs3);
  const ms = Date.now() - t0;
  eq('reference trace: 31 calls', out.calls.length, 31);
  eq('reference trace: 11 REST Consume', out.calls.filter(c => c.node === 'REST Consume').length, 11);
  eq('reference trace: 4 REST Publish', out.calls.filter(c => c.node === 'REST Publish').length, 4);
  eq('reference trace: 6 SOAP consume', out.calls.filter(c => c.node === 'WebServices' && c.direction === 'out').length, 6);
  eq('reference trace: 10 SOAP publish', out.calls.filter(c => c.node === 'WebServices' && c.direction === 'in').length, 10);
  // Two REAL overlaps exist in this file: the interleaved shipment POST pair
  // (REST Consume) and two concurrent AppUser_Create_Update WS publish requests.
  const uncertain = out.calls.filter(c => c.uncertain);
  eq('reference trace: real interleaves flagged (4 uncertain)', uncertain.length, 4);
  eq('reference trace: interleaved consume pair is the shipment POST',
    uncertain.filter(c => /myorderintegration\/v1\/shipment$/.test(c.url)).length, 2);
  eq('reference trace: overlapping WS publish pair flagged',
    uncertain.filter(c => c.service === 'AppUser_Create_Update').length, 2);
  const withAnchor = out.calls.filter(c => c.corrId).length;
  ok('reference trace: anchors attached to consume calls (>= 15)', withAnchor >= 15, 'got ' + withAnchor);
  const answered = out.calls.filter(c => c.direction === 'out' && c.status !== null).length;
  eq('reference trace: every outgoing call got its response', answered, 17);
  console.log('    (' + (text.length / (1024 * 1024)).toFixed(0) + ' MB → ' + out.calls.length + ' calls in ' + ms + ' ms)');
} else {
  console.log('  – reference trace log absent, skipped (PII: never committed)');
}

// ── Log Insights aggregation (public/js/tools/log-viewer.js) ─────────────────
// log-viewer.js is imported by core.js as an ES module (it carries `export
// function init()`), so unlike the other tools it can't be require()d as-is.
// Strip the `export ` keyword and compile the rest in a CommonJS wrapper — the
// pure logExtractInsights + helpers attach to window (pointed at global above).
// The extractor honors the data-driven rule: only categories that occur produce
// a card, and a clean INFO-level log yields zero categories.
console.log('\nLog Insights aggregation');
const lvPath = path.join(__dirname, '..', 'public', 'js', 'tools', 'log-viewer.js');
const lvSrc = fs.readFileSync(lvPath, 'utf8').replace(/^export\s+/gm, '');
const NodeModule = require('module');
const lvModule = new NodeModule(lvPath, module);
lvModule.filename = lvPath;
lvModule.paths = NodeModule._nodeModulePaths(path.dirname(lvPath));
lvModule._compile(lvSrc, lvPath);
const logInsights = global.logExtractInsights;

const insLog = [
  // Access denied — same microflow denied to two users, a third microflow to one
  '2026-07-18T09:00:00.000000 ' + P + '  WARNING - WebUI: User \'a@ex.com\' attempted to execute runtime operation \'OP1\' (microflow call \'Mod.ACT_Secret\') but does not have the required permission.',
  '2026-07-18T09:00:01.000000 ' + P + '  WARNING - WebUI: User \'b@ex.com\' attempted to execute runtime operation \'OP1\' (microflow call \'Mod.ACT_Secret\') but does not have the required permission.',
  '2026-07-18T09:00:02.000000 ' + P + '  WARNING - WebUI: User \'a@ex.com\' attempted to execute runtime operation \'OP9\' (microflow call \'Mod.ACT_Other\') but does not have the required permission.',
  // Missing parameters (WebUI, different problem)
  '2026-07-18T09:00:03.000000 ' + P + '  WARNING - WebUI: The runtime operation \'OP2\' is missing parameters: [CurrentObject]. This might lead to an unresolvable XPath.',
  // Session state bloat — two requests, peak 450
  '2026-07-18T09:00:04.000000 ' + P + '  WARNING - RequestStatistics: Request state size of 315 objects exceeds the threshold of 300 objects.',
  '2026-07-18T09:00:05.000000 ' + P + '  WARNING - RequestStatistics: Request state size of 450 objects exceeds the threshold of 300 objects.',
  // TaskQueue retry loop — MDM.UPD_UserData fails 6× from one queue, plus one other task
  '2026-07-18T09:00:06.000000 ' + P + '   ERROR - TaskQueue: Failed to execute task \'MDM.UPD_UserData(Account=X@1)\' from task queue \'Queues.Schedule\'.',
  '2026-07-18T09:00:07.000000 ' + P + '   ERROR - TaskQueue: Failed to execute task \'MDM.UPD_UserData(Account=X@1)\' from task queue \'Queues.Schedule\'.',
  '2026-07-18T09:00:08.000000 ' + P + '   ERROR - TaskQueue: Failed to execute task \'MDM.UPD_UserData(Account=X@1)\' from task queue \'Queues.Schedule\'.',
  '2026-07-18T09:00:09.000000 ' + P + '   ERROR - TaskQueue: Failed to execute task \'MDM.UPD_UserData(Account=X@1)\' from task queue \'Queues.Schedule\'.',
  '2026-07-18T09:00:10.000000 ' + P + '   ERROR - TaskQueue: Failed to execute task \'MDM.UPD_UserData(Account=X@1)\' from task queue \'Queues.Schedule\'.',
  '2026-07-18T09:00:11.000000 ' + P + '   ERROR - TaskQueue: Failed to execute task \'MDM.UPD_UserData(Account=X@1)\' from task queue \'Queues.Schedule\'.',
  '2026-07-18T09:00:12.000000 ' + P + '   ERROR - TaskQueue: Failed to execute task \'Parking.SmsNotification(Id=9)\' from task queue \'Queues.Sms\'.',
  // Generic per-node error hotspot (SAML_SSO)
  '2026-07-18T09:00:13.000000 ' + P + '   ERROR - SAML_SSO: null',
  '2026-07-18T09:00:14.000000 ' + P + '   ERROR - SAML_SSO: null',
  '2026-07-18T09:00:15.000000 ' + P + '   ERROR - SAML_SSO: null',
  // Below-threshold warnings (Core ×2) must NOT surface as a hotspot by default
  '2026-07-18T09:00:16.000000 ' + P + '  WARNING - Core: minor thing happened',
  '2026-07-18T09:00:17.000000 ' + P + '  WARNING - Core: minor thing happened again',
  // Noise that must be ignored entirely
  '2026-07-18T09:00:18.000000 ' + P + '    INFO - Core: business as usual',
  '2026-07-18T09:00:19.000000 ' + P + '   DEBUG - MicroflowEngine: [1-1] Starting execution of microflow \'Mod.Flow\''
].join('\n');

const insRecs = parser.parse(insLog).records;
const ins = logInsights(insRecs);
const catBy = {};
ins.categories.forEach(function (c) { catBy[c.key] = c; });

eq('insights: stats count errors', ins.stats.errors, 10);
// 3 perm-denied + 1 missing-params + 2 session-bloat + 2 sub-threshold Core = 8
eq('insights: stats count warnings', ins.stats.warnings, 8);

// Access denied
ok('insights: perm-denied category present', !!catBy['perm-denied']);
eq('perm-denied: total count', catBy['perm-denied'].count, 3);
eq('perm-denied: 2 microflows in breakdown', catBy['perm-denied'].items.length, 2);
eq('perm-denied: top microflow is ACT_Secret ×2', catBy['perm-denied'].items[0].label, 'Mod.ACT_Secret');
eq('perm-denied: top microflow count', catBy['perm-denied'].items[0].count, 2);
ok('perm-denied: subtitle names 2 users', /2 user/.test(catBy['perm-denied'].subtitle), catBy['perm-denied'].subtitle);
eq('perm-denied: item filter searches microflow', catBy['perm-denied'].items[0].filter.search, 'Mod.ACT_Secret');

// Missing params is a distinct category (not folded into perm-denied)
ok('insights: missing-params category present', !!catBy['missing-params']);
eq('missing-params: count', catBy['missing-params'].count, 1);

// Session bloat — peak size reported
ok('insights: session-bloat category present', !!catBy['session-bloat']);
eq('session-bloat: count', catBy['session-bloat'].count, 2);
ok('session-bloat: subtitle reports peak 450', /peak 450/.test(catBy['session-bloat'].subtitle), catBy['session-bloat'].subtitle);

// TaskQueue failures — retry loop surfaced
ok('insights: taskqueue-fail category present', !!catBy['taskqueue-fail']);
eq('taskqueue-fail: total failures', catBy['taskqueue-fail'].count, 7);
eq('taskqueue-fail: severity error', catBy['taskqueue-fail'].severity, 'error');
ok('taskqueue-fail: retry loop noted in subtitle', /retry-loop/.test(catBy['taskqueue-fail'].subtitle), catBy['taskqueue-fail'].subtitle);
eq('taskqueue-fail: top task is MDM.UPD_UserData', catBy['taskqueue-fail'].items[0].filter.search, 'MDM.UPD_UserData');
eq('taskqueue-fail: top task count', catBy['taskqueue-fail'].items[0].count, 6);

// Generic per-node hotspot
ok('insights: SAML_SSO error hotspot present', !!catBy['node-error-SAML_SSO']);
eq('SAML_SSO hotspot count', catBy['node-error-SAML_SSO'].count, 3);

// Below-threshold Core warnings must not produce a card by default...
ok('insights: sub-threshold Core warnings suppressed', !catBy['node-warning-Core']);
// ...but a lower threshold surfaces them (data-driven knob)
const insLow = logInsights(insRecs, { warnHotspotMin: 1 });
ok('insights: Core warnings appear at warnHotspotMin=1',
  insLow.categories.some(function (c) { return c.key === 'node-warning-Core' && c.count === 2; }));

// Sorting: error categories rank before warning categories
const firstWarnIdx = ins.categories.findIndex(function (c) { return c.severity === 'warning'; });
const lastErrIdx = ins.categories.map(function (c) { return c.severity; }).lastIndexOf('error');
ok('insights: all error cards sort before warning cards', lastErrIdx < firstWarnIdx, lastErrIdx + '/' + firstWarnIdx);

// ── Slow-query warnings + verbose nodes (wave 15) ────────────────────────────
// Two categories derived from data the tool already had. Their own fixture, so
// the counts asserted above stay untouched.
const insLog2 = [
  // Slow-query warnings: two executions of one statement (differing only in the
  // bound id, so they must group) plus a second statement.
  '2026-07-19T09:00:00.000000 ' + P + '  WARNING - ConnectionBus_Queries: Query executed in 4 seconds and 200 milliseconds: SELECT "sales$order"."id" FROM "sales$order" WHERE "id" = 42',
  '2026-07-19T09:00:01.000000 ' + P + '  WARNING - ConnectionBus_Queries: Query executed in 1100 milliseconds: SELECT "sales$order"."id" FROM "sales$order" WHERE "id" = 77',
  '2026-07-19T09:00:02.000000 ' + P + '  WARNING - ConnectionBus_Queries: Query executed in 900 milliseconds: SELECT "cust"."name" FROM "cust"',
  // A WARNING from the same node that is NOT a slow query must stay a warning,
  // not be swallowed by the slow-query card.
  '2026-07-19T09:00:03.000000 ' + P + '  WARNING - ConnectionBus_Queries: Connection pool is nearly exhausted'
]
  // A node left at TRACE: 30 entries, over the 25-entry floor.
  .concat(Array.from({ length: 30 }, (_, i) =>
    '2026-07-19T09:01:' + String(i % 60).padStart(2, '0') + '.000000 ' + P + '  TRACE - ConnectionBus_Retrieve: SQL@x' + i + '(T1-C1): SELECT 1'))
  // Incidental debug logging: 3 entries, below the floor — must not surface.
  .concat([
    '2026-07-19T09:02:00.000000 ' + P + '   DEBUG - Core: tick',
    '2026-07-19T09:02:01.000000 ' + P + '   DEBUG - Core: tick',
    '2026-07-19T09:02:02.000000 ' + P + '   DEBUG - Core: tick'
  ]).join('\n');

const ins2 = logInsights(parser.parse(insLog2).records);
const catBy2 = {};
ins2.categories.forEach(function (c) { catBy2[c.key] = c; });

ok('insights: slow-queries category present', !!catBy2['slow-queries']);
eq('slow-queries: counts every warning', catBy2['slow-queries'].count, 3);
eq('slow-queries: severity warning', catBy2['slow-queries'].severity, 'warning');
eq('slow-queries: two distinct statements', catBy2['slow-queries'].items.length, 2);
eq('slow-queries: the repeated statement ranks first', catBy2['slow-queries'].items[0].count, 2);
ok('slow-queries: worst duration reported in seconds', /worst 4\.2 s/.test(catBy2['slow-queries'].subtitle), catBy2['slow-queries'].subtitle);
ok('slow-queries: breakdown searches the raw statement, not the normalized label',
  catBy2['slow-queries'].items[0].filter.search.indexOf('SELECT "sales$order"') === 0,
  catBy2['slow-queries'].items[0].filter.search);
// The search has to match every execution the card counted, not just the first
// one logged — otherwise a card reading "2×" filters the stream down to one row.
ok('slow-queries: the search stops where the bound value varies',
  catBy2['slow-queries'].items[0].filter.search.indexOf('42') === -1 &&
  /WHERE "id" = $/.test(catBy2['slow-queries'].items[0].filter.search),
  catBy2['slow-queries'].items[0].filter.search);
eq('slow-queries: offers the Query Extractor cross-link', catBy2['slow-queries'].crossLink, 'log-query-extractor');

// The unrelated warning from the same node must survive as a generic hotspot —
// proving the slow-query card consumed only its own entries.
const ins2Low = logInsights(parser.parse(insLog2).records, { warnHotspotMin: 1 });
const genericCbq = ins2Low.categories.find(function (c) { return c.key === 'node-warning-ConnectionBus_Queries'; });
ok('slow-queries: the non-slow warning is left for the generic hotspot', !!genericCbq);
eq('slow-queries: exactly one warning left unconsumed', genericCbq && genericCbq.count, 1);

ok('insights: verbose-nodes category present', !!catBy2['verbose-nodes']);
eq('verbose-nodes: severity info (a fact, not a problem)', catBy2['verbose-nodes'].severity, 'info');
eq('verbose-nodes: counts only the nodes over the floor', catBy2['verbose-nodes'].count, 30);
eq('verbose-nodes: one qualifying node', catBy2['verbose-nodes'].items.length, 1);
ok('verbose-nodes: names the node and its share',
  /^ConnectionBus_Retrieve\b.*% of the log$/.test(catBy2['verbose-nodes'].items[0].label),
  catBy2['verbose-nodes'].items[0].label);
eq('verbose-nodes: breakdown filters to TRACE/DEBUG of that node', catBy2['verbose-nodes'].items[0].filter.levels, 'TRACE,DEBUG');
ok('verbose-nodes: incidental DEBUG stays below the floor',
  !catBy2['verbose-nodes'].items.some(function (it) { return /^Core\b/.test(it.label); }));

// ...and the floor is a knob, like warnHotspotMin
const ins2Verbose = logInsights(parser.parse(insLog2).records, { verboseMin: 1 });
const vb = ins2Verbose.categories.find(function (c) { return c.key === 'verbose-nodes'; });
eq('verbose-nodes: Core appears at verboseMin=1', vb.items.length, 2);
eq('verbose-nodes: count follows the lowered floor', vb.count, 33);

// Observations sort after problems, however many entries they count
eq('insights: the info card sorts last', ins2.categories[ins2.categories.length - 1].key, 'verbose-nodes');

// Data-driven rule: a clean INFO-level log yields no categories at all
const cleanLog = [
  '2026-07-18T10:00:00.000000 ' + P + '    INFO - Core: started',
  '2026-07-18T10:00:01.000000 ' + P + '    INFO - Jetty: listening',
  '2026-07-18T10:00:02.000000 ' + P + '   DEBUG - Core: tick'
].join('\n');
const cleanIns = logInsights(parser.parse(cleanLog).records);
eq('insights: clean INFO log → zero categories', cleanIns.categories.length, 0);
eq('insights: empty input → zero categories', logInsights([]).categories.length, 0);

// Reference: real INFO-level production log (local only, PII — never committed).
// This is the 14.07 log from the SE/Log-Insights analysis: it carries a genuine
// MDM.UPD_UserData retry loop, permission denials and request-state bloat.
const refInfo = path.join(__dirname, '..', '_local_assets', 'FilesForTest', 'logs_8d888530-51c3-4167-94f7-2d4c9a1b887e_2026-07-14.txt');
if (fs.existsSync(refInfo)) {
  const text = fs.readFileSync(refInfo, 'utf8');
  const recs4 = parser.parse(text).records;
  const t0 = Date.now();
  const out = logInsights(recs4);
  const ms = Date.now() - t0;
  const by = {};
  out.categories.forEach(function (c) { by[c.key] = c; });
  eq('reference INFO: TaskQueue failures = 118', by['taskqueue-fail'] && by['taskqueue-fail'].count, 118);
  eq('reference INFO: MDM.UPD_UserData is the top failing task', by['taskqueue-fail'].items[0].filter.search, 'MDM.UPD_UserData');
  eq('reference INFO: MDM.UPD_UserData failed 103×', by['taskqueue-fail'].items[0].count, 103);
  eq('reference INFO: permission denials = 14', by['perm-denied'] && by['perm-denied'].count, 14);
  eq('reference INFO: session-state bloat warnings = 5', by['session-bloat'] && by['session-bloat'].count, 5);
  eq('reference INFO: SAML_SSO error hotspot = 266', by['node-error-SAML_SSO'] && by['node-error-SAML_SSO'].count, 266);
  console.log('    (' + (text.length / (1024 * 1024)).toFixed(0) + ' MB → ' + out.stats.records + ' records, ' + out.categories.length + ' categories in ' + ms + ' ms)');
} else {
  console.log('  – reference INFO log absent, skipped (PII: never committed)');
}

// ── Gantt time axis (public/js/tools/log-viewer.js) ──────────────────────────
// logGanttAxis resolves entries onto one monotonic epoch axis. It used to anchor
// every entry to a fixed 1970-01-01 from an HH:MM:SS match, which threw the date
// away: a log crossing midnight sorted backwards and the chart bailed out with
// "logs have same timestamp". Three timestamp shapes have to keep working.
console.log('\nGantt time axis');
const ganttAxis = global.logGanttAxis;

const isoAxis = ganttAxis([
  { ts: '2026-07-18T23:59:59.000000' },
  { ts: '2026-07-19T00:00:01.000000' }
]);
ok('gantt: full ISO log crossing midnight moves forward, not backwards',
  isoAxis[1].ms - isoAxis[0].ms === 2000);

const csvAxis = ganttAxis([
  { ts: '07/18/2026 23:59:59' },
  { ts: '07/19/2026 00:00:04' }
]);
ok('gantt: Studio Pro CSV export resolves through mftTsToMs',
  csvAxis.length === 2 && csvAxis[1].ms - csvAxis[0].ms === 5000);

// LOG_PAT_TIME produces date-less stamps; they must still plot, and must carry a
// day offset forward when the clock wraps instead of jumping back 24 hours.
const timeOnlyAxis = ganttAxis([
  { ts: '23:59:58' },
  { ts: '23:59:59' },
  { ts: '00:00:02' }
]);
eq('gantt: time-only log still plots every entry', timeOnlyAxis.length, 3);
ok('gantt: time-only log crossing midnight stays monotonic',
  timeOnlyAxis[2].ms - timeOnlyAxis[1].ms === 3000);

eq('gantt: unparseable stamps are dropped rather than plotted at zero',
  ganttAxis([{ ts: 'not a time' }, { ts: '' }]).length, 0);

// ── Level matrix pivot (public/js/tools/log-viewer.js) ───────────────────────
// logBuildLevelMatrix attaches to window (pointed at global above) when the
// log-viewer module was compiled for the Insights tests. It pivots parsed records
// by log node × severity, honoring the data-driven rule: only levels/nodes that
// occur produce columns/rows. Reuses the insLog distribution asserted above.
console.log('\nLevel matrix pivot');
const logMatrix = global.logBuildLevelMatrix;

const mtx = logMatrix(insRecs);
// Present levels only, in canonical order (no TRACE/CRITICAL in this fixture)
eq('matrix: levels present in canonical order', mtx.levels.join(','), 'DEBUG,INFO,WARN,ERROR');
eq('matrix: grand total = 20 records', mtx.grandTotal, 20);
eq('matrix: node count = 6', mtx.nodeCount, 6);
// Nodes rank by ERROR+CRITICAL volume, then total
eq('matrix: TaskQueue is the top (noisiest-error) node', mtx.nodes[0].node, 'TaskQueue');
eq('matrix: TaskQueue error count = 7', mtx.nodes[0].counts.ERROR, 7);
eq('matrix: SAML_SSO ranks second', mtx.nodes[1].node, 'SAML_SSO');
eq('matrix: SAML_SSO error count = 3', mtx.nodes[1].counts.ERROR, 3);
// Column (level) totals
eq('matrix: WARN column total = 8', mtx.levelTotals.WARN, 8);
eq('matrix: ERROR column total = 10', mtx.levelTotals.ERROR, 10);
eq('matrix: INFO column total = 1', mtx.levelTotals.INFO, 1);
eq('matrix: DEBUG column total = 1', mtx.levelTotals.DEBUG, 1);
// A pure INFO/WARN node keeps its own row and per-level split
const webui = mtx.nodes.find(function (n) { return n.node === 'WebUI'; });
eq('matrix: WebUI WARN count = 4', webui.counts.WARN, 4);
eq('matrix: WebUI has no ERROR bucket', webui.counts.ERROR, undefined);
eq('matrix: WebUI total = 4', webui.total, 4);

// Data-driven rule: empty input → no rows, no columns, nothing to pivot
const emptyMtx = logMatrix([]);
eq('matrix: empty input → 0 grand total', emptyMtx.grandTotal, 0);
eq('matrix: empty input → 0 nodes', emptyMtx.nodes.length, 0);
eq('matrix: empty input → 0 levels', emptyMtx.levels.length, 0);

// Clean INFO/DEBUG log → only those two columns appear
const cleanMtx = logMatrix(parser.parse(cleanLog).records);
eq('matrix: clean log levels = DEBUG,INFO only', cleanMtx.levels.join(','), 'DEBUG,INFO');
eq('matrix: clean log node count = 2', cleanMtx.nodeCount, 2);

// Level normalization + unknown-level rejection + node|logNode fallback
const rawMtx = logMatrix([
  { level: 'WARNING', logNode: 'A' },  // → WARN
  { level: 'FATAL', logNode: 'A' },    // → ERROR
  { level: 'INFO', node: 'B' },        // node (not logNode) still resolves
  { level: 'SOMETHINGWEIRD', logNode: 'C' } // unknown level dropped, node C never appears
]);
eq('matrix: normalized/known levels only → grand total 3', rawMtx.grandTotal, 3);
eq('matrix: unknown-level node C dropped → 2 nodes', rawMtx.nodeCount, 2);
eq('matrix: FATAL normalized into ERROR total', rawMtx.levelTotals.ERROR, 1);
eq('matrix: WARNING normalized into WARN total', rawMtx.levelTotals.WARN, 1);
eq('matrix: present levels canonical-ordered', rawMtx.levels.join(','), 'INFO,WARN,ERROR');
ok('matrix: node field resolves when logNode absent', !!rawMtx.nodes.find(function (n) { return n.node === 'B'; }));

// ── Mendix Error Decoder ruleset (public/js/tools/error-decoder.js) ──────────
// The decoder is a plain script attaching edxDecode to window/self (window is
// already pointed at the global above), so it require()s directly like MFT/WSRE.
// Contract: decode mechanisms only, always expose the matched pattern, and — the
// data-driven rule — return NO match rather than a guess for unknown input.
console.log('\nError Decoder ruleset');
require('../public/js/tools/error-decoder.js');
const edxDecode = global.edxDecode;

function edxIds(text) { return edxDecode(text).matches.map(function (m) { return m.id; }); }
function edxTop(text) { return edxDecode(text).matches[0]; }

// Data-driven rule: unknown / empty input yields zero cards, never a guess.
eq('errdec: empty input → no matches', edxDecode('').matches.length, 0);
eq('errdec: whitespace input → no matches', edxDecode('   \n  ').matches.length, 0);
eq('errdec: unrecognized text → no matches',
  edxDecode('Everything is fine, nothing to see here.').matches.length, 0);

// Each headline signature is recognized.
ok('errdec: unique constraint', edxIds('ERROR: duplicate key value violates unique constraint "account_email_key"').indexOf('pg-unique-violation') !== -1);
ok('errdec: not-null constraint', edxIds('null value in column "name" violates not-null constraint').indexOf('pg-notnull-violation') !== -1);
ok('errdec: foreign key', edxIds('violates foreign key constraint "customer_order_fk"').indexOf('pg-fk-violation') !== -1);
ok('errdec: deadlock', edxIds('ERROR: deadlock detected').indexOf('pg-deadlock') !== -1);
ok('errdec: statement timeout', edxIds('ERROR: canceling statement due to statement timeout').indexOf('pg-statement-timeout') !== -1);
ok('errdec: pool exhausted', edxIds('Cannot get a connection, pool error Timeout waiting for idle object').indexOf('db-pool-exhausted') !== -1);
ok('errdec: nonexistent object', edxIds("Trying to retrieve nonexistent object with id 'Sales.Order_281474976710656'").indexOf('mendix-nonexistent-object') !== -1);
ok('errdec: heap OOM', edxIds('java.lang.OutOfMemoryError: Java heap space').indexOf('oom-heap') !== -1);
ok('errdec: metaspace OOM', edxIds('java.lang.OutOfMemoryError: Metaspace').indexOf('oom-metaspace') !== -1);
ok('errdec: gc overhead OOM', edxIds('java.lang.OutOfMemoryError: GC overhead limit exceeded').indexOf('oom-gc-overhead') !== -1);
ok('errdec: native thread OOM', edxIds('java.lang.OutOfMemoryError: unable to create new native thread').indexOf('oom-native-thread') !== -1);
ok('errdec: jetty EOF', edxIds('org.eclipse.jetty.io.EofException: Early EOF').indexOf('jetty-eof') !== -1);
ok('errdec: socket read timeout', edxIds('java.net.SocketTimeoutException: Read timed out').indexOf('socket-read-timeout') !== -1);
ok('errdec: TLS PKIX', edxIds('sun.security.validator.ValidatorException: PKIX path building failed').indexOf('ssl-pkix') !== -1);
ok('errdec: connection refused', edxIds('java.net.ConnectException: Connection refused').indexOf('connection-refused') !== -1);
ok('errdec: SAML audience', edxIds('SAML assertion invalid: Audience urn:acc:sp is not valid').indexOf('saml-audience') !== -1);
ok('errdec: SAML clock/NotOnOrAfter', edxIds('Assertion Conditions NotOnOrAfter 2026-07-18T09:00:00Z has passed').indexOf('saml-clock') !== -1);
ok('errdec: port in use', edxIds('java.net.BindException: Address already in use').indexOf('port-in-use') !== -1);
ok('errdec: NPE', edxIds('java.lang.NullPointerException').indexOf('npe') !== -1);

// The matched pattern is always exposed (owner contract: user judges the fit).
const uniqTop = edxTop('ERROR: duplicate key value violates unique constraint "account_email_key"');
ok('errdec: matchedText echoes the signature', /account_email_key/.test(uniqTop.matchedText), uniqTop.matchedText);
eq('errdec: card carries category', uniqTop.category, 'Database');
ok('errdec: mechanism is non-empty prose', uniqTop.mechanism.length > 40);
ok('errdec: causes is a non-empty list', Array.isArray(uniqTop.causes) && uniqTop.causes.length >= 2);
ok('errdec: checks is a non-empty list', Array.isArray(uniqTop.checks) && uniqTop.checks.length >= 1);
ok('errdec: at least one check references a tool', uniqTop.checks.some(function (c) { return !!c.tool; }));
ok('errdec: unique-violation check points at LQE', uniqTop.checks.some(function (c) { return c.tool === 'log-query-extractor'; }));

// A real wrapped stack: the specific root cause must outrank the generic wrapper.
const wrapped = [
  'com.mendix.modules.microflowengine.MicroflowException: Error in (sub)microflow call',
  '\tat com.mendix.modules.microflowengine.MicroflowEngine.execute(MicroflowEngine.java:120)',
  'Caused by: java.net.SocketTimeoutException: Read timed out',
  '\tat java.base/java.net.SocketInputStream.socketRead0(Native Method)'
].join('\n');
const wrappedIds = edxIds(wrapped);
ok('errdec: wrapped stack matches both wrapper and root', wrappedIds.indexOf('microflow-exception') !== -1 && wrappedIds.indexOf('socket-read-timeout') !== -1);
eq('errdec: specific root cause ranks first, not the wrapper', edxTop(wrapped).id, 'socket-read-timeout');
ok('errdec: stack trace detected in input', edxDecode(wrapped).input.hasStackTrace);

// Specificity: a specific DB signature outranks a bare NPE when both appear.
const mixed = 'java.lang.NullPointerException\nCaused by: ERROR: deadlock detected';
eq('errdec: DB deadlock outranks NPE', edxTop(mixed).id, 'pg-deadlock');

// ── Rules mined from real production logs (wave 19) ─────────────────────────
// Every signature below was taken verbatim from ERROR/CRITICAL records in the
// reference logs, not from documentation. Before them the decoder recognised
// 10% of that corpus by volume; the four rules that fired were mostly scanner
// 404s — it knew the rare tail and missed everything common.
ok('errdec: runtime request wrapper',
  edxIds("Connector: An error has occurred while handling the request. [User 'a@b.c' with session id 'ff08e210-0000-0000-0000-000000001d27' and roles 'User']")
    .indexOf('mx-request-handler-error') !== -1);
ok('errdec: published REST failure',
  edxIds('REST Publish: An unexpected error occurred while handling REST request').indexOf('mx-rest-publish-failed') !== -1);
ok('errdec: published web service failure',
  edxIds('WebServices: An error occurred processing the webservice request').indexOf('mx-ws-publish-failed') !== -1);
ok('errdec: web service input parameters',
  edxIds("WebServices: Couldn't handle input parameters").indexOf('mx-ws-input-parameters') !== -1);
ok('errdec: task queue failure',
  edxIds("TaskQueue: Failed to execute task 'MDM.UPD_UserData(Account=X@1)' from task queue 'Queues.Schedule'.")
    .indexOf('mx-taskqueue-failed') !== -1);
ok('errdec: request state size',
  edxIds('RequestStatistics: Request state size of 450 objects exceeds the threshold of 300 objects.')
    .indexOf('mx-request-state-size') !== -1);
ok('errdec: FileDocument without a file',
  edxIds('Connector: The Comments.Attachment file could not be found.').indexOf('mx-file-not-found') !== -1);
ok('errdec: blocked file cleanup',
  edxIds('Core: Prevented deletion of one or more files that are still in use').indexOf('mx-file-in-use') !== -1);
ok('errdec: SAML duplicate response',
  edxIds('SAML_SSO: Unable to validate Response. Error: Request has already received a response')
    .indexOf('saml-duplicate-response') !== -1);

// The most frequent line in the whole corpus (4 023×) carries no message at all.
// It is only decodable *with* its log node — a bare "null" must stay unmatched,
// which is what keeps this rule from firing on every NullPointerException.
ok('errdec: SAML null message needs its log node',
  edxIds('SAML_SSO: null').indexOf('saml-empty-error') !== -1);
eq('errdec: a bare "null" is not a SAML error', edxIds('null').length, 0);
ok('errdec: a null-message NPE does not become a SAML error',
  edxIds('java.lang.NullPointerException: null').indexOf('saml-empty-error') === -1);
ok('errdec: the outbound SAML variant is the same family',
  edxIds('SAML_SSO: Error occurred while making request: null').indexOf('saml-empty-error') !== -1);
ok('errdec: ...and it says which leg failed',
  /making a request/i.test(edxTop('SAML_SSO: Error occurred while making request: null').mechanism));

// Ranking: the wrappers must never outrank the cause underneath them.
const handlerWithCause = [
  "Connector: An error has occurred while handling the request. [User 'a@b.c' with roles 'User']",
  'com.mendix.modules.microflowengine.MicroflowException: Error in (sub)microflow call',
  'Caused by: ERROR: deadlock detected'
].join('\n');
eq('errdec: the root cause outranks the request wrapper', edxTop(handlerWithCause).id, 'pg-deadlock');
ok('errdec: ...and the wrapper is still reported alongside it',
  edxIds(handlerWithCause).indexOf('mx-request-handler-error') !== -1);
const samlAndReal = 'SAML_SSO: null\nCaused by: sun.security.validator.ValidatorException: PKIX path building failed';
eq('errdec: an information-free SAML line never outranks a real signature', edxTop(samlAndReal).id, 'ssl-pkix');

// Contract: every new rule carries all three sections and at least one tool link.
['mx-request-handler-error', 'mx-rest-publish-failed', 'mx-ws-publish-failed', 'mx-ws-input-parameters',
 'mx-taskqueue-failed', 'mx-request-state-size', 'mx-file-not-found', 'mx-file-in-use',
 'saml-duplicate-response', 'saml-empty-error'].forEach(function (id) {
  const rule = global.EDX_RULES.filter(function (r) { return r.id === id; })[0];
  ok('errdec: ' + id + ' is registered', !!rule);
  if (!rule) return;
  const m = ['x'];
  ok('errdec: ' + id + ' explains a mechanism', rule.mechanism(m).length > 60);
  ok('errdec: ' + id + ' lists causes as hypotheses', rule.causes(m).length >= 2);
  ok('errdec: ' + id + ' offers checks', rule.checks(m).length >= 1);
  // The decoder is not a fix advisor — no rule may instruct.
  const prose = rule.mechanism(m) + ' ' + rule.causes(m).join(' ') + ' ' + rule.checks(m).map(function (c) { return c.text; }).join(' ');
  ok('errdec: ' + id + ' does not prescribe a fix',
    !/\b(you should|you must|simply add|just add|fix it by)\b/i.test(prose));
});

// A single-line message with no stack still decodes and reports no stack trace.
ok('errdec: single-line message → no stack flag', !edxDecode('java.lang.OutOfMemoryError: Java heap space').input.hasStackTrace);

// ── Wave 9 ruleset expansion (30+ patterns) ──────────────────────────────────
ok('errdec: too many clients', edxIds('FATAL: sorry, too many clients already').indexOf('pg-too-many-clients') !== -1);
ok('errdec: transaction aborted', edxIds('ERROR: current transaction is aborted, commands ignored until end of transaction block').indexOf('pg-transaction-aborted') !== -1);
ok('errdec: value too long', edxIds('ERROR: value too long for type character varying(50)').indexOf('pg-value-too-long') !== -1);
ok('errdec: out of shared memory', edxIds('ERROR: out of shared memory\nHINT: You might need to increase max_locks_per_transaction').indexOf('pg-out-of-shared-memory') !== -1);
ok('errdec: disk full', edxIds('ERROR: could not extend file "base/16400/16490": No space left on device').indexOf('pg-disk-full') !== -1);
ok('errdec: Mendix optimistic lock conflict', edxIds('com.mendix.systemwideinterfaces.connectionbus.data.ConcurrentModificationRuntimeException').indexOf('mendix-concurrent-modification') !== -1);
ok('errdec: StackOverflowError', edxIds('java.lang.StackOverflowError').indexOf('stack-overflow') !== -1);
ok('errdec: plain-Java ConcurrentModificationException', edxIds('java.util.ConcurrentModificationException').indexOf('java-concurrent-modification') !== -1);
ok('errdec: NoClassDefFoundError', edxIds('java.lang.NoClassDefFoundError: com/foo/Bar').indexOf('no-class-def-found') !== -1);
ok('errdec: NoSuchMethodError', edxIds("java.lang.NoSuchMethodError: 'void com.foo.Bar.baz()'").indexOf('no-such-method-error') !== -1);
ok('errdec: UnknownHostException', edxIds('java.net.UnknownHostException: api.example.internal').indexOf('unknown-host') !== -1);
ok('errdec: ruleset has at least 30 patterns', global.EDX_RULES.length >= 30, global.EDX_RULES.length);

// ── 404 static-file / scanner-probe rule (real MxCloud runtime log lines) ─────
ok('errdec: 404 file not found matches',
  edxIds('2026-07-17T00:10:57.791076 [runtime-container/27mj7]  ERROR - Connector: 404 - file not found for file: magento_version').indexOf('http-404-file-not-found') !== -1);
const edx404 = edxTop('ERROR - Connector: 404 - file not found for file: magento_version');
eq('errdec: 404 rule is categorized Platform', edx404.category, 'Platform');
ok('errdec: 404 mechanism names the requested file', /magento_version/.test(edx404.mechanism), edx404.mechanism);
ok('errdec: 404 flags a known probe name', /classic probe target/.test(edx404.causes[0]), edx404.causes[0]);
ok('errdec: 404 check points at the Nginx analyzer', edx404.checks.some(function (c) { return c.tool === 'nginx-log'; }));
// A URL-encoded scanner path is decoded for display (wp-content%2F... → wp-content/...).
ok('errdec: 404 decodes a %-encoded probe path',
  /wp-content\/plugins/.test(edxTop('ERROR - Connector: 404 - file not found for file: wp-content%2Fplugins%2Fadvanced-text-widget%2Freadme.txt').mechanism));
// Malformed %-encoding must not throw — it falls back to the raw captured name.
ok('errdec: 404 survives malformed %-encoding',
  edxIds('ERROR - Connector: 404 - file not found for file: bad%2').indexOf('http-404-file-not-found') !== -1);
// A non-probe file name still matches the rule but carries no "probe" emphasis.
ok('errdec: 404 without a known probe name omits the emphasis',
  !/classic probe target/.test(edxTop('ERROR - Connector: 404 - file not found for file: brochure2024').causes[0]));
// The attacker-controlled path is HTML-escaped where the card embeds it
// (a no-space payload is captured whole by \S+, so this really exercises escaping).
ok('errdec: 404 escapes an HTML-bearing probe path in the mechanism',
  !/<script>/.test(edxTop('ERROR - Connector: 404 - file not found for file: <script>alert(1)</script>').mechanism));

// ── REST-publish 404 "no operation matches" (real MxCloud DEBUG log line) ─────
const rest404line = '2026-07-17T00:10:59.251887 [runtime-container/27mj7]  DEBUG - REST Publish: Responding with 404 Not Found, because no operation matches http://weborderentry100-accp.mendixcloud.com/rest/default/V1/guest-carts';
ok('errdec: REST-publish 404 matches',
  edxIds(rest404line).indexOf('http-404-rest-no-operation') !== -1);
const edxRest404 = edxTop(rest404line);
eq('errdec: REST-publish 404 is categorized Platform', edxRest404.category, 'Platform');
ok('errdec: REST-publish 404 mechanism names the requested URL', /guest-carts/.test(edxRest404.mechanism), edxRest404.mechanism);
ok('errdec: REST-publish 404 flags a known probe path', /classic probe target/.test(edxRest404.causes[0]), edxRest404.causes[0]);
ok('errdec: REST-publish 404 check points at the Nginx analyzer', edxRest404.checks.some(function (c) { return c.tool === 'nginx-log'; }));
// It must NOT be confused with the static-file 404 (distinct signature/rule).
ok('errdec: REST-publish 404 is not the static-file 404 rule', edxIds(rest404line).indexOf('http-404-file-not-found') === -1);
// A genuine own-API mismatch still matches but carries no probe emphasis.
ok('errdec: REST-publish 404 without a probe path omits the emphasis',
  !/classic probe target/.test(edxTop('REST Publish: Responding with 404 Not Found, because no operation matches https://app.example.com/rest/orders/v2/list').causes[0]));

// Clean stack trace: strips per-line Mendix Cloud log prefixes, leaves raw
// "at ..."/"Caused by:" continuation lines (which never carry one) untouched,
// and drops blank lines — never touches matching (edxDecode doesn't anchor to
// line starts), only readability.
const edxCleanStackTrace = global.edxCleanStackTrace;
const dirtyTrace = [
  "2026-07-18T09:14:22.517 [runtime-container/abc]  ERROR - Connector: com.mendix.systemwideinterfaces.core.UserException: boom",
  "",
  "\tat com.mendix.modules.microflowengine.MicroflowEngine.executeMicroflow(MicroflowEngine.java:120)",
  "Caused by: java.lang.NullPointerException"
].join('\n');
const cleaned = edxCleanStackTrace(dirtyTrace);
ok('errdec: clean strips the cloud log prefix', cleaned.indexOf('com.mendix.systemwideinterfaces.core.UserException: boom') === 0, cleaned);
ok('errdec: clean keeps unprefixed stack frames verbatim', cleaned.indexOf('\tat com.mendix.modules.microflowengine.MicroflowEngine.executeMicroflow(MicroflowEngine.java:120)') !== -1);
ok('errdec: clean drops blank lines', cleaned.split('\n').every(function (l) { return l.trim() !== ''; }));
eq('errdec: clean is a no-op on already-plain text', edxCleanStackTrace('Caused by: java.lang.NullPointerException'), 'Caused by: java.lang.NullPointerException');

// ── Shared export helpers (public/js/components/exporters.js) ────────────────
// Pure builders attach to window/self; the browser-only download/copy wrappers
// are guarded by `typeof document`, so require() in Node loads just the builders.
console.log('\nExport helpers');
require('../public/js/components/exporters.js');
const toCsv = global.mtExportToCsv;
const toMd = global.mtExportToMarkdown;
const toHtml = global.mtExportToHtml;

const expHeader = ['Type', 'SQL'];
const expRows = [['Retrieve', 'SELECT "a$b"."id" FROM "a$b"'], ['Slow', 'x, "quoted" value']];

const csv = toCsv(expHeader, expRows);
ok('csv: header quoted', csv.split('\r\n')[0] === '"Type","SQL"', csv.split('\r\n')[0]);
ok('csv: embedded quotes doubled', csv.indexOf('""quoted"" value') !== -1, csv);
eq('csv: row count = header + data', csv.split('\r\n').length, 3);
ok('csv: uses CRLF line endings', csv.indexOf('\r\n') !== -1);

const md = toMd(expHeader, expRows);
ok('md: has separator row', md.split('\n')[1] === '|---|---|', md.split('\n')[1]);
ok('md: pipes in cells escaped', toMd(['A'], [['x|y']]).indexOf('x\\|y') !== -1);
ok('md: newlines in cells flattened', toMd(['A'], [['x\ny']]).indexOf('x y') !== -1);

const html = toHtml({ title: 'Q & <Report>', subtitle: 'sub', meta: [{ label: 'Rows', value: 2 }], columns: expHeader, rows: expRows });
ok('html: is a self-contained document', /^<!doctype html>/i.test(html) && html.indexOf('</html>') !== -1);
ok('html: no external resource references', html.indexOf('http://') === -1 && html.indexOf('https://') === -1 && html.indexOf('src=') === -1);
ok('html: title HTML-escaped', html.indexOf('Q &amp; &lt;Report&gt;') !== -1);
ok('html: cell content escaped', html.indexOf('&quot;a$b&quot;') !== -1 || html.indexOf('&quot;quoted&quot;') !== -1);
ok('html: renders a data cell', html.indexOf('<td>Retrieve</td>') !== -1);
ok('html: sections mode renders multiple tables', (function () {
  const h = toHtml({ title: 'Incident', sections: [{ title: 'SQL', columns: ['A'], rows: [['1']] }, { title: 'Microflows', columns: ['B'], rows: [['2']] }] });
  return (h.match(/<h2>/g) || []).length === 2;
})());
ok('html: empty rows → "No rows." not a broken table', toHtml({ title: 'x', columns: ['A'], rows: [] }).indexOf('No rows.') !== -1);

// ── Incident Report model builder (mtBuildIncidentReport) ────────────────────
console.log('\nIncident Report builder');
const buildIncident = global.mtBuildIncidentReport;
const secA = { id: 'log-viewer', title: 'Log Viewer — errors', subtitle: '2 errors', columns: ['Time', 'Msg'], rows: [['t1', 'boom'], ['t2', 'bang']], total: 2, firstMs: 1000, lastMs: 5000 };
const secB = { id: 'nginx-log', title: 'Nginx', subtitle: '1 request', columns: ['Time', 'Status'], rows: [['t3', 500]], total: 1, firstMs: 2000, lastMs: 8000 };

const model = buildIncident([secA, null, secB], { title: 'Checkout incident', notes: 'prod, morning' });
eq('incident: null sections dropped', model.sections.length, 2);
eq('incident: title carried', model.title, 'Checkout incident');
ok('incident: subtitle is the auto-summary, starting with the period', /^Period: /.test(model.subtitle), model.subtitle);
eq('incident: notes carried as the separate top-level note (not the subtitle)', model.note, 'prod, morning');
ok('incident: meta lists both source ids', model.meta.some(function (m) { return m.label === 'Sources' && /log-viewer/.test(m.value) && /nginx-log/.test(m.value); }));
ok('incident: total rows summed across sections', model.meta.some(function (m) { return m.label === 'Total rows' && m.value === 3; }));
ok('incident: default window spans min→max of section data', model.meta.some(function (m) { return m.label === 'Time window' && /1970-01-01 00:00:01.*1970-01-01 00:00:08/.test(m.value); }), JSON.stringify(model.meta[0]));

const modelWin = buildIncident([secA], { fromMs: 1500, toMs: 4000 });
ok('incident: explicit window overrides the data span', modelWin.meta.some(function (m) { return m.label === 'Time window' && /00:00:01.*00:00:04/.test(m.value); }));
eq('incident: no sections → empty sections array', buildIncident([], {}).sections.length, 0);

// The built model round-trips through the HTML exporter into a real report.
const incidentHtml = toHtml(model);
ok('incident: renders both section headings', (incidentHtml.match(/<h2>/g) || []).length === 2);
ok('incident: self-contained, no external refs', /^<!doctype html>/i.test(incidentHtml) && !/https?:\/\//.test(incidentHtml));
ok('incident: notes render as a distinct context box in the HTML', incidentHtml.indexOf('class="context"') !== -1 && incidentHtml.indexOf('prod, morning') !== -1);
ok('incident: no notes → no context box', toHtml(buildIncident([secA], {})).indexOf('class="context"') === -1);

// ── Executive summary (mtIncidentSummary) — 9.7: data-driven, no invented metrics ──
console.log('\nIncident Report — executive summary');
const summarize = global.mtIncidentSummary;
const logSecWithLevels = {
  id: 'log-viewer', title: 'Log Viewer', subtitle: '3 entries',
  columns: ['Time', 'Level', 'Node', 'Message'],
  rows: [['t1', 'ERROR', 'Core', 'x'], ['t2', 'WARN', 'Core', 'y'], ['t3', 'CRITICAL', 'Core', 'z']]
};
const lqeSecWithDurations = {
  id: 'log-query-extractor', title: 'LQE', subtitle: '3 queries',
  columns: ['Type', 'Tx-Conn', 'Timestamp', 'Duration (ms)', 'Cost', 'Rows', 'Dup', 'SQL'],
  rows: [['SELECT', 'a', 't', 50, '', '', '', 'x'], ['SELECT', 'a', 't', 1500, '', '', '', 'y'], ['SELECT', 'a', 't', 3000, '', '', '', 'z']]
};
const wsreSecWithErrors = { id: 'ws-rest-extractor', title: 'WSRE', subtitle: '5 calls · 2 with error status', columns: [], rows: [] };
const jvmSecWithDeadlock = {
  id: 'thread-dump', title: 'JVM', subtitle: '',
  columns: ['Metric', 'Value'],
  rows: [['BLOCKED', 1], ['Deadlocks detected', 2]]
};

ok('summary: counts errors+critical from Log Viewer, not warnings',
  summarize([logSecWithLevels], 'W1 → W2').indexOf('2 errors') !== -1);
ok('summary: counts LQE queries over 1s as slow',
  summarize([lqeSecWithDurations], 'W').indexOf('2 slow queries (>1s)') !== -1);
ok('summary: pulls WSRE failed-call count from its own subtitle',
  summarize([wsreSecWithErrors], 'W').indexOf('2 failed calls') !== -1);
ok('summary: surfaces JVM deadlocks when present',
  summarize([jvmSecWithDeadlock], 'W').indexOf('2 deadlocks') !== -1);
eq('summary: always leads with the period', summarize([], 'X → Y'), 'Period: X → Y');
ok('summary: a source with no matching columns contributes no clause',
  summarize([{ id: 'nginx-log', title: 'n', subtitle: '', columns: ['Time', 'Status'], rows: [['t', 500]] }], 'W') === 'Period: W');

// ── Live DB — EXPLAIN live guard (Wave 6, server/livedb.js) ──────────────────
// The whitelist is the first of three safety layers (whitelist + EXPLAIN-without-
// ANALYZE + READ ONLY transaction). Pure, so it unit-tests without a database.
const livedb = require('../server/livedb.js');
ok('livedb: plain SELECT allowed', livedb.isReadOnlySelect('SELECT 1') === true);
ok('livedb: SELECT with whitespace/case allowed', livedb.isReadOnlySelect('  select * from foo where a=1  ') === true);
ok('livedb: read-only WITH…SELECT allowed', livedb.isReadOnlySelect('WITH x AS (SELECT 1) SELECT * FROM x') === true);
ok('livedb: single trailing semicolon allowed', livedb.isReadOnlySelect('SELECT 1;') === true);
ok('livedb: leading block comment allowed', livedb.isReadOnlySelect('/* c */ SELECT 1') === true);
ok('livedb: leading line comment allowed', livedb.isReadOnlySelect('-- c\nSELECT 1') === true);
ok('livedb: leading paren allowed', livedb.isReadOnlySelect('(SELECT 1)') === true);
ok('livedb: DELETE keyword inside a string literal still read-only', livedb.isReadOnlySelect("SELECT * FROM audit WHERE action='DELETE'") === true);
ok('livedb: multi-statement rejected', livedb.isReadOnlySelect('SELECT 1; DROP TABLE t') === false);
ok('livedb: UPDATE rejected', livedb.isReadOnlySelect('UPDATE t SET a=1') === false);
ok('livedb: DELETE rejected', livedb.isReadOnlySelect('DELETE FROM t') === false);
ok('livedb: DROP rejected', livedb.isReadOnlySelect('DROP TABLE t') === false);
ok('livedb: comment hiding a write rejected', livedb.isReadOnlySelect('/* x */ DROP TABLE t') === false);
ok('livedb: data-modifying CTE rejected', livedb.isReadOnlySelect('WITH d AS (DELETE FROM t RETURNING 1) SELECT * FROM d') === false);
ok('livedb: empty rejected', livedb.isReadOnlySelect('') === false);
ok('livedb: non-string rejected', livedb.isReadOnlySelect(null) === false);

// ── Live DB — Index Advisor (Wave 6 R2, server/livedb.js) ───────────────────
// The advisor's central rule: usage counters are worthless on a cold database,
// structural findings are not. These fixtures pin both halves of that split.
function ixFix(over) {
  return Object.assign({
    schema: 'public', table: 'orders', name: 'idx_a', idxScan: 100,
    indexBytes: 1048576, tableBytes: 10485760, isUnique: false, isPrimary: false,
    isValid: true, keyAtts: 1, am: 'btree', predicate: '', keyColumns: 'customer_id',
    indexdef: 'CREATE INDEX idx_a ON orders (customer_id)'
  }, over || {});
}
function tbFix(over) {
  return Object.assign({
    schema: 'public', table: 'orders', seqScan: 0, seqTupRead: 0,
    idxScan: 1000, liveTuples: 50000, tableBytes: 10485760
  }, over || {});
}
// A warm window: plenty of scans, reset well in the past.
const WARM = { statsSince: '2026-07-01T00:00:00Z', nowMs: Date.parse('2026-07-19T00:00:00Z'), totalIdxScan: 500000, totalSeqScan: 100 };
function advise(indexes, tables, over) {
  return livedb.buildIndexAdvice(Object.assign({ indexes: indexes, tables: tables || [] }, WARM, over || {}));
}

// -- statistics window assessment --
eq('advisor: cold database → no confidence',
  livedb.assessStatsWindow({ totalIdxScan: 8, totalSeqScan: 26, statsSince: '2026-07-19T12:00:00Z', nowMs: Date.parse('2026-07-19T13:00:00Z') }).confidence, 'none');
eq('advisor: warm but young window → low confidence',
  livedb.assessStatsWindow({ totalIdxScan: 90000, totalSeqScan: 10, statsSince: '2026-07-19T00:00:00Z', nowMs: Date.parse('2026-07-19T06:00:00Z') }).confidence, 'low');
eq('advisor: few scans over a long window → low confidence',
  livedb.assessStatsWindow({ totalIdxScan: 200, totalSeqScan: 10, statsSince: '2026-06-01T00:00:00Z', nowMs: Date.parse('2026-07-19T00:00:00Z') }).confidence, 'low');
eq('advisor: long warm window → ok',
  livedb.assessStatsWindow({ totalIdxScan: 500000, totalSeqScan: 100, statsSince: '2026-06-01T00:00:00Z', nowMs: Date.parse('2026-07-19T00:00:00Z') }).confidence, 'ok');
ok('advisor: withheld verdict always explains itself',
  /almost no queries/.test(livedb.assessStatsWindow({ totalIdxScan: 1, totalSeqScan: 1 }).reason));

// -- the SS3DB trap: a restored copy must NOT be told to drop 597 indexes --
const coldAdvice = livedb.buildIndexAdvice({
  indexes: [ixFix({ idxScan: 0 }), ixFix({ name: 'idx_b', idxScan: 0, keyColumns: 'status' })],
  tables: [tbFix({ seqScan: 20, idxScan: 0 })],
  totalIdxScan: 8, totalSeqScan: 26,
  statsSince: '2026-07-19T12:00:00Z', nowMs: Date.parse('2026-07-19T13:00:00Z')
});
eq('advisor: cold DB suppresses every unused-index finding',
  coldAdvice.findings.filter(function (f) { return f.kind === 'unused-index'; }).length, 0);
eq('advisor: cold DB suppresses seq-scan findings too',
  coldAdvice.findings.filter(function (f) { return f.kind === 'seq-scan-heavy'; }).length, 0);

// -- unused indexes, once the window earns it --
const unused = advise([ixFix({ idxScan: 0 })]);
eq('advisor: warm window reports the unused index', unused.findings.length, 1);
eq('advisor: unused index is usage-based, not structural', unused.findings[0].structural, false);
ok('advisor: unused finding warns against reading dev counters',
  unused.findings[0].verify.some(function (v) { return /PRODUCTION/.test(v); }));
ok('advisor: unused finding warns that Studio Pro recreates the index',
  unused.findings[0].verify.some(function (v) { return /Studio Pro/.test(v); }));
// Mendix regenerates association indexes on every deploy — a DROP is temporary.
ok('advisor: Mendix association index carries the deploy warning',
  /recreates it on every deploy/.test(
    advise([ixFix({ idxScan: 0, table: 'eshop$order', name: 'idx_eshop$order_eshop$customer_order' })]).findings[0].mendixNote));
ok('advisor: other Mendix tables still get the Studio Pro note',
  /Studio Pro/.test(advise([ixFix({ idxScan: 0, table: 'eshop$order', name: 'custom_ix' })]).findings[0].mendixNote));
eq('advisor: non-Mendix table gets no Mendix note',
  advise([ixFix({ idxScan: 0, table: 'plain_table', name: 'custom_ix' })]).findings[0].mendixNote, null);
eq('advisor: primary key is never reported as unused',
  advise([ixFix({ idxScan: 0, isPrimary: true, isUnique: true })]).findings.length, 0);
eq('advisor: unique constraint index is never reported as unused',
  advise([ixFix({ idxScan: 0, isUnique: true })]).findings.length, 0);
eq('advisor: tiny unused index is below the noise floor',
  advise([ixFix({ idxScan: 0, indexBytes: 8192 })]).findings.length, 0);
eq('advisor: a scanned index is not reported', advise([ixFix({ idxScan: 1 })]).findings.length, 0);

// -- structural findings survive a cold window --
const coldDup = livedb.buildIndexAdvice({
  indexes: [ixFix({ name: 'idx_a', idxScan: 0 }), ixFix({ name: 'idx_dup', idxScan: 0 })],
  tables: [], totalIdxScan: 2, totalSeqScan: 2
});
eq('advisor: duplicate index reported even on a cold database', coldDup.findings.length, 1);
eq('advisor: duplicate is flagged structural', coldDup.findings[0].kind, 'duplicate-index');
eq('advisor: identical pair reported once, not twice',
  advise([ixFix({ name: 'idx_a' }), ixFix({ name: 'idx_dup' })]).findings.length, 1);

// -- prefix redundancy --
const redundant = advise([
  ixFix({ name: 'idx_narrow', keyColumns: 'customer_id', keyAtts: 1 }),
  ixFix({ name: 'idx_wide', keyColumns: 'customer_id,created_at', keyAtts: 2 })
]);
eq('advisor: prefix index flagged redundant', redundant.findings[0].kind, 'redundant-index');
eq('advisor: the narrow index is the one named', redundant.findings[0].index, 'idx_narrow');
eq('advisor: wider index is not redundant against the narrow one',
  redundant.findings.filter(function (f) { return f.index === 'idx_wide'; }).length, 0);
eq('advisor: non-prefix column order is not redundant',
  advise([ixFix({ name: 'i1', keyColumns: 'created_at', keyAtts: 1 }),
          ixFix({ name: 'i2', keyColumns: 'customer_id,created_at', keyAtts: 2 })]).findings.length, 0);
eq('advisor: unique index is never redundant against a wider one',
  advise([ixFix({ name: 'uq', keyColumns: 'email', keyAtts: 1, isUnique: true }),
          ixFix({ name: 'wide', keyColumns: 'email,tenant', keyAtts: 2 })]).findings.length, 0);
eq('advisor: different access methods are not duplicates',
  advise([ixFix({ name: 'b', am: 'btree' }), ixFix({ name: 'g', am: 'gin' })]).findings.length, 0);
eq('advisor: partial indexes with different predicates are not duplicates',
  advise([ixFix({ name: 'p1', predicate: 'active' }), ixFix({ name: 'p2', predicate: 'NOT active' })]).findings.length, 0);
eq('advisor: same predicate still duplicates',
  advise([ixFix({ name: 'p1', predicate: 'active' }), ixFix({ name: 'p2', predicate: 'active' })]).findings.length, 1);
eq('advisor: indexes on different tables are never compared',
  advise([ixFix({ name: 'x', table: 'orders' }), ixFix({ name: 'y', table: 'invoices' })]).findings.length, 0);
// Expression indexes resolve partially — treating (a, lower(b)) as (a) would be
// a false duplicate against a plain index on a.
eq('advisor: partially resolved expression index is not compared',
  advise([ixFix({ name: 'plain', keyColumns: 'customer_id', keyAtts: 1 }),
          ixFix({ name: 'expr', keyColumns: 'customer_id', keyAtts: 2 })]).findings.length, 0);

// -- invalid index --
const invalid = advise([ixFix({ isValid: false, idxScan: 0 })]);
eq('advisor: invalid index reported once', invalid.findings.length, 1);
eq('advisor: invalid index outranks unused', invalid.findings[0].kind, 'invalid-index');
eq('advisor: invalid index is structural', invalid.findings[0].structural, true);

// -- sequential scan pressure --
const seqHeavy = advise([], [tbFix({ seqScan: 500, seqTupRead: 25000000, idxScan: 10, liveTuples: 50000 })]);
eq('advisor: seq-scan-heavy table reported', seqHeavy.findings[0].kind, 'seq-scan-heavy');
ok('advisor: seq-scan finding points at EXPLAIN live',
  seqHeavy.findings[0].verify.some(function (v) { return /EXPLAIN live/.test(v); }));
eq('advisor: small table is allowed to be seq-scanned',
  advise([], [tbFix({ seqScan: 500, seqTupRead: 50000, idxScan: 0, liveTuples: 200 })]).findings.length, 0);
eq('advisor: a handful of seq scans is noise',
  advise([], [tbFix({ seqScan: 10, seqTupRead: 500000, idxScan: 0 })]).findings.length, 0);
eq('advisor: index-dominated table is fine',
  advise([], [tbFix({ seqScan: 100, seqTupRead: 5000000, idxScan: 100000 })]).findings.length, 0);

// -- ordering, summary, data-driven empty state --
const mixedIdx = advise([
  ixFix({ name: 'small_unused', idxScan: 0, indexBytes: 1048576 }),
  ixFix({ name: 'big_unused', idxScan: 0, indexBytes: 99999999, keyColumns: 'note', keyAtts: 1 }),
  ixFix({ name: 'broken', isValid: false, keyColumns: 'other', keyAtts: 1 })
]);
eq('advisor: high severity sorts first', mixedIdx.findings[0].severity, 'high');
eq('advisor: within a severity the biggest index wins', mixedIdx.findings[1].index, 'big_unused');
ok('advisor: reclaimable storage is summed and labelled',
  mixedIdx.summary.reclaimableBytes > 99999999 && /MB/.test(mixedIdx.summary.reclaimableLabel));
const clean = advise([ixFix({ idxScan: 500 })], [tbFix()]);
eq('advisor: healthy database yields zero findings', clean.findings.length, 0);
eq('advisor: healthy database still reports what it inspected', clean.summary.indexCount, 1);
eq('advisor: no pg_stat_statements degrades rather than fails',
  livedb.buildIndexAdvice({ indexes: [], tables: [] }).statements.available, false);
eq('advisor: empty input is not an error', livedb.buildIndexAdvice({}).findings.length, 0);

// -- table→entity translation in the Error Decoder (fed by the live model) --
// PostgreSQL names tables, developers think in entities. Only active once a
// model has been loaded; with no map the section stays absent (data principle).
const edxMap = global.edxMapTables;
const EDX_TBL = { 'eshop$order': 'eShop.Order', 'eshop$orderline': 'eShop.OrderLine' };
eq('errdec/model: no map loaded → no translation', edxMap('duplicate key in eshop$order', null).length, 0);
eq('errdec/model: table in the message is translated',
  edxMap('ERROR: duplicate key value violates unique constraint on eshop$order', EDX_TBL)[0].entity, 'eShop.Order');
eq('errdec/model: unrelated message translates nothing',
  edxMap('java.lang.OutOfMemoryError: Java heap space', EDX_TBL).length, 0);
eq('errdec/model: matching is case-insensitive',
  edxMap('constraint on ESHOP$ORDER failed', EDX_TBL).length, 1);
// The longer table name must be reported first, otherwise `eshop$orderline`
// gets described as `eShop.Order`.
eq('errdec/model: most specific table first',
  edxMap('violation on eshop$orderline', EDX_TBL)[0].entity, 'eShop.OrderLine');

// ── Live DB — Domain Model from database (Wave 6 R3, server/livedb.js) ──────
// Two facts decide whether the generated diagram is right or merely plausible:
// where the FK column lives (parent's table, NOT association.table_name — they
// differ on Mendix 9) and which side is "one" (the child, because the parent
// holds the FK). Both are pinned here.
const DM_ENTITIES = [
  { id: 'e1', entityName: 'eShop.Category', tableName: 'eshop$category' },
  { id: 'e2', entityName: 'eShop.Product', tableName: 'eshop$product' },
  { id: 'e3', entityName: 'System.Image', tableName: 'system$image', superEntityId: 'e4' },
  { id: 'e4', entityName: 'System.FileDocument', tableName: 'system$filedocument' },
  { id: 'e5', entityName: 'Sales.Tag', tableName: 'sales$tag' }
];
const DM_ATTRS = [
  { entityId: 'e2', attributeName: 'Name', columnName: 'name', type: 30, length: 200 },
  { entityId: 'e2', attributeName: 'Price', columnName: 'price', type: 5, length: 0 },
  { entityId: 'e2', attributeName: 'Active', columnName: 'active', type: 10, length: 0 },
  { entityId: 'e1', attributeName: 'Code', columnName: 'code', type: 3, length: 0 },
  { entityId: 'e9', attributeName: 'Orphan', columnName: 'orphan', type: 30, length: 0 }
];
// Category_Product: FK column lives on the PRODUCT (parent) table.
const DM_COLUMN_ASSOC = {
  associationName: 'eShop.Category_Product', tableName: 'eshop$product',
  parentEntityId: 'e2', childEntityId: 'e1',
  parentColumnName: 'id', childColumnName: 'eshop$category_product'
};
// Mendix 9 shape: table_name names the COLUMN and matches no table at all.
const DM_MX9_ASSOC = {
  associationName: 'System.owner', tableName: 'system$owner',
  parentEntityId: 'e2', childEntityId: 'e1',
  parentColumnName: 'id', childColumnName: 'system$owner'
};
const DM_JUNCTION_ASSOC = {
  associationName: 'Sales.Product_Tag', tableName: 'sales$product_tag',
  parentEntityId: 'e2', childEntityId: 'e5',
  parentColumnName: 'eshop$productid', childColumnName: 'sales$tagid'
};
function dm(assocs, uniqueColumns) {
  return livedb.buildDomainModel({
    entities: DM_ENTITIES, attributes: DM_ATTRS,
    associations: assocs || [], uniqueColumns: uniqueColumns || []
  });
}

// -- entities, attributes, types --
const dmBase = dm();
eq('domain: entities reconstructed', dmBase.stats.entityCount, 5);
eq('domain: module split from Module.Entity', dmBase.entities[0].module, 'eShop');
eq('domain: short name split from Module.Entity', dmBase.entities[0].shortName, 'Category');
eq('domain: attributes attached to their entity',
  dmBase.entities.find(function (e) { return e.name === 'eShop.Product'; }).attributes.length, 3);
eq('domain: orphan attribute row ignored', dmBase.stats.attributeCount, 4);
eq('domain: inheritance resolved to the super entity name',
  dmBase.entities.find(function (e) { return e.name === 'System.Image'; }).superName, 'System.FileDocument');
eq('domain: inherited entities counted', dmBase.stats.inheritedCount, 1);
eq('domain: table→entity map for the Error Decoder', dmBase.tableMap['eshop$product'], 'eShop.Product');
// Type codes, empirically confirmed on Mendix 9.24 and 11.12.
eq('domain: type 30 is String with length', livedb.mxTypeName(30, 200), 'String(200)');
eq('domain: type 30 without length stays String', livedb.mxTypeName(30, 0), 'String');
eq('domain: type 5 is Decimal', livedb.mxTypeName(5, 0), 'Decimal');
eq('domain: type 10 is Boolean', livedb.mxTypeName(10, 0), 'Boolean');
eq('domain: type 20 is DateTime', livedb.mxTypeName(20, 0), 'DateTime');
eq('domain: type 40 is Enum', livedb.mxTypeName(40, 8), 'Enum');
eq('domain: type 0 is AutoNumber', livedb.mxTypeName(0, 0), 'AutoNumber');
eq('domain: unknown type code is surfaced, not guessed', livedb.mxTypeName(99, 0), 'Type99');

// -- column-stored association: direction and FK location --
const dmCol = dm([DM_COLUMN_ASSOC]);
const aCol = dmCol.associations[0];
eq('domain: column storage detected via parent_column_name=id', aCol.storage, 'column');
// The parent holds the FK, so the CHILD is the "1" side. Reversing this flips
// every relationship in the diagram.
eq('domain: child entity is the ONE side', aCol.one, 'eShop.Category');
eq('domain: parent entity is the MANY side', aCol.many, 'eShop.Product');
eq('domain: column association is 1-* without a unique index', aCol.cardinality, '1-*');
eq('domain: FK table is the parent entity table', aCol.table, 'eshop$product');
// Mendix 9: association.table_name is the column name and matches no table.
const aMx9 = dm([DM_MX9_ASSOC]).associations[0];
eq('domain: Mx9 FK table resolved from the parent entity, not table_name', aMx9.table, 'eshop$product');
eq('domain: Mx9 association still directed child→one', aMx9.one, 'eShop.Category');
// A unique index on the FK column makes it 1-1.
eq('domain: unique FK column upgrades 1-* to 1-1',
  dm([DM_COLUMN_ASSOC], ['eshop$product|eshop$category_product']).associations[0].cardinality, '1-1');
eq('domain: a unique index on an unrelated column changes nothing',
  dm([DM_COLUMN_ASSOC], ['eshop$product|name']).associations[0].cardinality, '1-*');

// -- junction-table association --
const aJun = dm([DM_JUNCTION_ASSOC]).associations[0];
eq('domain: junction storage detected', aJun.storage, 'junction');
eq('domain: junction without unique indexes is *-*', aJun.cardinality, '*-*');
eq('domain: junction table name kept', aJun.table, 'sales$product_tag');
eq('domain: junction records both FK columns', aJun.columns.length, 2);
// Unique on the child column means each child links to at most one parent.
const aJunChildU = dm([DM_JUNCTION_ASSOC], ['sales$product_tag|sales$tagid']).associations[0];
eq('domain: unique child column makes it 1-*', aJunChildU.cardinality, '1-*');
eq('domain: with a unique child column the parent is the ONE side', aJunChildU.one, 'eShop.Product');
const aJunParentU = dm([DM_JUNCTION_ASSOC], ['sales$product_tag|eshop$productid']).associations[0];
eq('domain: unique parent column also yields 1-*', aJunParentU.cardinality, '1-*');
eq('domain: with a unique parent column the child is the ONE side', aJunParentU.one, 'Sales.Tag');
eq('domain: both columns unique yields 1-1',
  dm([DM_JUNCTION_ASSOC], ['sales$product_tag|sales$tagid', 'sales$product_tag|eshop$productid']).associations[0].cardinality, '1-1');
// An association whose entity is missing must not invent a node.
eq('domain: association with an unknown entity is dropped',
  dm([{ associationName: 'X.Broken', tableName: 't', parentEntityId: 'zz', childEntityId: 'e1', parentColumnName: 'id', childColumnName: 'c' }]).associations.length, 0);

// -- modules and stats --
const dmFull = dm([DM_COLUMN_ASSOC, DM_JUNCTION_ASSOC]);
eq('domain: modules aggregated', dmFull.stats.moduleCount, 3);
eq('domain: modules sorted by entity count', dmFull.modules[0].name, 'eShop');
eq('domain: cardinality distribution counted', dmFull.stats.cardinality['*-*'], 1);
eq('domain: empty input is not an error', livedb.buildDomainModel({}).stats.entityCount, 0);

// -- projection into the Architecture tool's JSON shape --
const arch = livedb.domainModelToArchJson(dmFull);
eq('domain→arch: every entity projected', arch.entities.length, 5);
eq('domain→arch: entity uses the short name', arch.entities[0].name, 'Category');
eq('domain→arch: attributes carry a rendered type',
  arch.entities.find(function (e) { return e.name === 'Product'; }).attributes.find(function (a) { return a.name === 'Name'; }).type, 'String(200)');
eq('domain→arch: inheritance projected', arch.entities.find(function (e) { return e.name === 'Image'; }).extends, 'System.FileDocument');
eq('domain→arch: association parent is the ONE side',
  arch.associations.find(function (a) { return a.name === 'Category_Product'; }).parent, 'Category');
eq('domain→arch: association child is the MANY side',
  arch.associations.find(function (a) { return a.name === 'Category_Product'; }).child, 'Product');
// Filtering matters: a 338-entity model is unreadable as a single diagram.
const archEshop = livedb.domainModelToArchJson(dmFull, ['eShop']);
eq('domain→arch: module filter narrows entities', archEshop.entities.length, 2);
eq('domain→arch: association kept when both ends survive the filter',
  archEshop.associations.length, 1);
const archSales = livedb.domainModelToArchJson(dmFull, ['Sales']);
eq('domain→arch: association dropped when one end is filtered out',
  archSales.associations.length, 0);

// ── Data Hub v0 — shared loaded-file summary and targets ────────────────────
// The component is an IIFE that skips every DOM branch when `document` is
// undefined, so requiring it in Node yields just the pure builders.
console.log('\nData Hub');
require('../public/js/components/data-hub.js');
const hubSummary = global.mtHubSummary;
const hubTargets = global.mtHubTargets;

// -- summary line --
// Nothing loaded must produce nothing at all (data-driven principle): the bar
// renders an empty shell only if this returns a truthy object.
eq('hub: no source yields no summary', hubSummary(null), null);
eq('hub: a source without a name yields no summary', hubSummary({ text: 'x' }), null);

const hubSrc = {
  name: 'app.log', size: 3 * 1024 * 1024, format: 'live', records: 176986,
  text: 'raw', origin: 'log-viewer', loadedIn: ['log-viewer']
};
const hubS = hubSummary(hubSrc);
eq('hub: summary keeps the file name', hubS.name, 'app.log');
eq('hub: size rendered in MB', hubS.sizeText, '3.0 MB');
eq('hub: record count is thousands-separated', hubS.recordsText, '176,986 records');
eq('hub: live format gets a human label', hubS.formatText, 'Mendix Cloud live log');
eq('hub: summary line joins the parts',
  hubS.line, 'Loaded: app.log · 3.0 MB · 176,986 records · Mendix Cloud live log');
eq('hub: csv format gets its own label',
  hubSummary({ name: 'a.csv', text: 'x', format: 'csv' }).formatText, 'Studio Pro CSV export');
// An unknown/absent format must not invent a label.
eq('hub: unknown format contributes nothing',
  hubSummary({ name: 'a.log', text: 'x', format: 'zzz' }).formatText, '');
eq('hub: a source with only a name still yields a line',
  hubSummary({ name: 'a.log', text: 'x' }).line, 'Loaded: a.log');
// Singular/plural and size units are the kind of detail that silently looks wrong.
eq('hub: one record is singular', hubSummary({ name: 'a', text: 'x', records: 1 }).recordsText, '1 record');
eq('hub: zero records is still reported', hubSummary({ name: 'a', text: 'x', records: 0 }).recordsText, '0 records');
eq('hub: bytes below 1 KB stay bytes', global.mtHubFormatBytes(512), '512 B');
eq('hub: kilobytes rendered with one decimal', global.mtHubFormatBytes(2048), '2.0 KB');
eq('hub: a missing size contributes nothing', hubSummary({ name: 'a', text: 'x' }).sizeText, '');
// The Log Viewer accepts several files at once; the Hub carries one, and says so.
eq('hub: sibling files counted', hubSummary(Object.assign({ siblings: 2 }, hubSrc)).siblings, 2);
eq('hub: no siblings by default', hubS.siblings, 0);

// -- open-in targets --
eq('hub: no source offers no targets', hubTargets(null, 'log-viewer').length, 0);
const hubT = hubTargets(hubSrc, 'log-query-extractor');
eq('hub: all four log tools are offered', hubT.length, 4);
eq('hub: the active tool is flagged as current',
  hubT.filter(t => t.current).map(t => t.id).join(), 'log-query-extractor');
eq('hub: the tool that parsed the file is flagged as loaded',
  hubT.find(t => t.id === 'log-viewer').loaded, true);
eq('hub: an untouched tool is not flagged as loaded',
  hubT.find(t => t.id === 'microflow-tracer').loaded, false);
eq('hub: each target names the global it hands off to',
  hubT.find(t => t.id === 'ws-rest-extractor').fn, 'wsreLoadText');
// current and loaded are independent: the origin tool can also be the active one.
const hubT2 = hubTargets(hubSrc, 'log-viewer');
eq('hub: origin tool is both current and loaded',
  hubT2.find(t => t.id === 'log-viewer').current && hubT2.find(t => t.id === 'log-viewer').loaded, true);
eq('hub: a source with no loadedIn marks nothing as loaded',
  hubTargets({ name: 'a', text: 'x' }, 'log-viewer').filter(t => t.loaded).length, 0);

// ============================================================================
// Excel Converter (.xlsx → JSON / CSV) — public/js/tools/xlsx-converter.js
// ============================================================================
// The tool reads .xlsx with the native DecompressionStream and a hand-written
// XML scanner (no DOMParser, so everything below runs in plain Node). The ZIP
// reader is exercised against a real archive built here with zlib — the same
// bytes Excel would produce — because a reader that only ever sees fixtures
// made by its own writer proves nothing.
console.log('\nExcel Converter');
require('../public/js/tools/xlsx-converter.js');

// The ZIP writer lives in scripts/lib/xlsx-fixture.js — shared with the
// screenshot pipeline, which needs a demo workbook built the same way.
const { buildZip, buildDemoWorkbook } = require('./lib/xlsx-fixture.js');

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// ── XML text decoding ───────────────────────────────────────────────────────
eq('xlsx: plain text passes through untouched', global.xlsDecodeXmlText('Order ID'), 'Order ID');
eq('xlsx: named entities decoded', global.xlsDecodeXmlText('a &amp; b &lt;c&gt;'), 'a & b <c>');
eq('xlsx: decimal and hex character references decoded',
  global.xlsDecodeXmlText('&#65;&#x42;'), 'AB');
// Excel escapes characters that are illegal in XML as _xHHHH_.
eq('xlsx: _xHHHH_ escape decoded to its character',
  global.xlsDecodeXmlText('line_x000D_break'), 'line\rbreak');
// …and escapes a literal "_x000D_" by escaping its underscore first. Decoding
// left to right consumes _x005F_ and leaves the rest as text — if this ever
// regresses, a cell reading "_x000D_" silently becomes a carriage return.
eq('xlsx: an escaped literal escape survives as text',
  global.xlsDecodeXmlText('_x005F_x000D_'), '_x000D_');

// ── Column references ───────────────────────────────────────────────────────
eq('xlsx: column A is index 0', global.xlsColToIndex('A1'), 0);
eq('xlsx: column Z is index 25', global.xlsColToIndex('Z10'), 25);
eq('xlsx: column AA is index 26', global.xlsColToIndex('AA1'), 26);
eq('xlsx: column BC is index 54', global.xlsColToIndex('BC7'), 54);
eq('xlsx: index 0 is column A', global.xlsIndexToCol(0), 'A');
eq('xlsx: index 26 is column AA', global.xlsIndexToCol(26), 'AA');
eq('xlsx: index 701 is column ZZ', global.xlsIndexToCol(701), 'ZZ');
eq('xlsx: column round-trips through both directions',
  global.xlsColToIndex(global.xlsIndexToCol(1000)), 1000);

// ── Date formats ────────────────────────────────────────────────────────────
eq('xlsx: General is not a date format', global.xlsIsDateFormat('General'), false);
eq('xlsx: a numeric format is not a date format', global.xlsIsDateFormat('#,##0.00'), false);
eq('xlsx: a d/m/y format is a date format', global.xlsIsDateFormat('dd/mm/yyyy'), true);
// [Red] and [$-409] are decoration and must not read as month/day tokens…
eq('xlsx: a colour-conditioned numeric format is not a date',
  global.xlsIsDateFormat('[Red]#,##0.00'), false);
eq('xlsx: a locale-tagged numeric format is not a date',
  global.xlsIsDateFormat('[$-409]#,##0'), false);
// …but [h]:mm is an elapsed-time format and must survive the bracket stripping.
eq('xlsx: an elapsed-time format is a date format', global.xlsIsDateFormat('[h]:mm:ss'), true);
eq('xlsx: quoted literals do not create false positives',
  global.xlsIsDateFormat('0.00" days"'), false);

// ── Serial → ISO ────────────────────────────────────────────────────────────
eq('xlsx: a whole serial becomes a bare date', global.xlsSerialToIso(45352, false), '2024-03-01');
eq('xlsx: a fractional serial keeps its time', global.xlsSerialToIso(45353.5, false), '2024-03-02T12:00:00');
eq('xlsx: a sub-day serial is a time of day', global.xlsSerialToIso(0.5, false), '12:00:00');
// Excel counts a 29 February 1900 that never existed; serials below 60 need the
// extra day or every date in the first two months of 1900 lands a day early.
eq('xlsx: serial 1 is 1 January 1900', global.xlsSerialToIso(1, false), '1900-01-01');
eq('xlsx: serial 61 is 1 March 1900', global.xlsSerialToIso(61, false), '1900-03-01');
eq('xlsx: the phantom leap day resolves to a real date',
  global.xlsSerialToIso(60, false), '1900-02-28');
eq('xlsx: the 1904 date system uses its own epoch',
  global.xlsSerialToIso(100, true), '1904-04-10');
eq('xlsx: a non-numeric serial has no date', global.xlsSerialToIso('x', false), null);
eq('xlsx: a negative serial has no date', global.xlsSerialToIso(-5, false), null);
// Floating point noise from Excel must not leak into the seconds field.
eq('xlsx: near-integer serials snap to the second',
  global.xlsSerialToIso(45352.749999997, false), '2024-03-01T18:00:00');

// ── ISO → Serial (inverse), column type override (11.4) ───────────────────
eq('xlsx: ISO → serial round-trips a whole date', global.xlsIsoToSerial(global.xlsSerialToIso(45352, false), false), 45352);
eq('xlsx: ISO → serial round-trips a date+time', global.xlsIsoToSerial(global.xlsSerialToIso(45353.5, false), false), 45353.5);
eq('xlsx: a bare time of day round-trips', global.xlsIsoToSerial('12:00:00', false), 0.5);
eq('xlsx: an unparseable string has no serial', global.xlsIsoToSerial('not a date', false), null);

eq('xlsx coerce: empty stays empty regardless of target type', global.xlsCoerceCell('', 'number', false), '');
eq('xlsx coerce: null stays null', global.xlsCoerceCell(null, 'date', false), null);
eq('xlsx coerce: number → string', global.xlsCoerceCell(42, 'string', false), '42');
eq('xlsx coerce: numeric text → number', global.xlsCoerceCell('42', 'number', false), 42);
eq('xlsx coerce: a serial number reinterpreted as a date', global.xlsCoerceCell(45352, 'date', false), '2024-03-01');
eq('xlsx coerce: an auto-detected ISO date reinterpreted back as a number is its serial', global.xlsCoerceCell('2024-03-01', 'number', false), 45352);
eq('xlsx coerce: non-numeric text asked for "number" is left as-is, not zeroed', global.xlsCoerceCell('N/A', 'number', false), 'N/A');

const xlsOverrideRows = [['Name', 'Value'], ['A', 45352], ['B', 45353]];
const xlsOverridden = global.xlsOverriddenSheetRows(xlsOverrideRows, true, { 1: 'date' }, false);
eq('xlsx override: the header row is untouched in object/CSV mode', xlsOverridden[0][1], 'Value');
eq('xlsx override: data rows are coerced per the override', xlsOverridden[1][1], '2024-03-01');
eq('xlsx override: no overrides set returns the original rows unchanged', global.xlsOverriddenSheetRows(xlsOverrideRows, true, {}, false), xlsOverrideRows);
const xlsArrayModeRows = [['A', 45352], ['B', 45353]];
const xlsOverriddenArrays = global.xlsOverriddenSheetRows(xlsArrayModeRows, false, { 1: 'date' }, false);
eq('xlsx override: in array mode (no header concept) row 0 is coerced too', xlsOverriddenArrays[0][1], '2024-03-01');

// ── Workbook / rels / shared strings / styles ───────────────────────────────
const wbXml = '<workbook><workbookPr date1904="1"/><sheets>' +
  '<sheet name="Orders &amp; Lines" sheetId="1" r:id="rId3"/>' +
  '<sheet name="Archive" sheetId="2" state="hidden" r:id="rId1"/>' +
  '</sheets></workbook>';
const wb = global.xlsParseWorkbook(wbXml);
eq('xlsx: both sheets found', wb.sheets.length, 2);
// Tab order comes from workbook.xml and is not recoverable from file names —
// sheet1.xml can be the second tab.
eq('xlsx: sheets keep workbook (tab) order', wb.sheets.map(s => s.rid).join(), 'rId3,rId1');
eq('xlsx: entities in a sheet name are decoded', wb.sheets[0].name, 'Orders & Lines');
eq('xlsx: a hidden sheet is flagged', wb.sheets[1].hidden, true);
eq('xlsx: a normal sheet is not flagged hidden', wb.sheets[0].hidden, false);
eq('xlsx: the 1904 date system is picked up', wb.date1904, true);
eq('xlsx: no workbookPr means the 1900 date system',
  global.xlsParseWorkbook('<workbook><sheets/></workbook>').date1904, false);

const rels = global.xlsParseRels(
  '<Relationships><Relationship Id="rId3" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId1" Target="/xl/worksheets/sheet2.xml"/></Relationships>');
eq('xlsx: relationship targets resolved by id', rels.rId3, 'worksheets/sheet1.xml');
eq('xlsx: an absolute relationship target is preserved', rels.rId1, '/xl/worksheets/sheet2.xml');

const sst = global.xlsParseSharedStrings(
  '<sst><si><t>Order ID</t></si><si><r><t>Ship</t></r><r><t>ped</t></r></si>' +
  '<si/><si><t xml:space="preserve"> pad </t></si></sst>');
eq('xlsx: four shared strings read', sst.length, 4);
// A string styled mid-word is stored as several runs; joining them is the
// difference between "Shipped" and "Ship".
eq('xlsx: rich-text runs are joined into one string', sst[1], 'Shipped');
eq('xlsx: an empty <si/> is an empty string', sst[2], '');
eq('xlsx: preserved whitespace is kept', sst[3], ' pad ');

// cellStyleXfs is a decoy: it looks identical to cellXfs but is NOT what a
// cell's s="N" indexes into. Reading it would shift every style by one and
// turn the first numeric column into 1900-era dates.
const stylesXml = '<styleSheet>' +
  '<numFmts count="1"><numFmt numFmtId="165" formatCode="dd/mm/yyyy hh:mm"/></numFmts>' +
  '<cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs>' +
  '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="165"/><xf numFmtId="4"/></cellXfs>' +
  '</styleSheet>';
const styles = global.xlsParseStyles(stylesXml);
eq('xlsx: only cellXfs entries are counted', styles.dateXf.length, 4);
eq('xlsx: the General style is not a date', styles.dateXf[0], false);
eq('xlsx: a built-in date format is a date', styles.dateXf[1], true);
eq('xlsx: a custom date format is a date', styles.dateXf[2], true);
eq('xlsx: a built-in numeric format is not a date', styles.dateXf[3], false);
eq('xlsx: a workbook with no styles yields no date styles',
  global.xlsParseStyles('').dateXf.length, 0);

// ── Sheet parsing ───────────────────────────────────────────────────────────
const sheetXml = '<worksheet><sheetData>' +
  '<row r="3"><c r="A3" t="s"><v>0</v></c><c r="B3" t="s"><v>1</v></c><c r="C3" t="s"><v>2</v></c><c r="D3" t="s"><v>3</v></c><c r="E3" t="s"><v>4</v></c></row>' +
  '<row r="4"><c r="A4"><v>1001</v></c><c r="B4" t="s"><v>5</v></c><c r="C4" s="1"><v>45352</v></c><c r="D4" s="3"><v>1234.5</v></c><c r="E4" t="b"><v>1</v></c></row>' +
  '<row r="5"><c r="A5"><v>1002</v></c><c r="B5" t="inlineStr"><is><t>Inline &lt;Name&gt;</t></is></c><c r="C5" s="2"><v>45353.5</v></c><c r="D5" s="3"><f>D4*2</f><v>2469</v></c><c r="E5" t="b"><v>0</v></c></row>' +
  '<row r="6"><c r="A6"><v>1003</v></c><c r="E6" t="e"><v>#N/A</v></c></row>' +
  '<row r="8"><c r="A8"><v>1004</v></c></row>' +
  '</sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>';
const sheetShared = ['Order ID', 'Customer', 'Placed', 'Amount', 'Shipped', 'ACME'];
const sheet = global.xlsParseSheet(sheetXml, {
  shared: sheetShared, dateXf: styles.dateXf, date1904: false
});

// Data starts at row 3; handing the two blank rows through would make the
// header detector key the JSON by "A", "B", "C".
eq('xlsx: empty leading rows are trimmed', sheet.skippedTop, 2);
eq('xlsx: rows counted from the first non-empty one', sheet.rows.length, 6);
eq('xlsx: shared strings resolved in the header', sheet.rows[0].join('|'),
  'Order ID|Customer|Placed|Amount|Shipped');
eq('xlsx: a plain number stays a number', sheet.rows[1][0], 1001);
eq('xlsx: a date-styled number becomes an ISO date', sheet.rows[1][2], '2024-03-01');
// numFmtId 4 is "#,##0.00" — a number that must NOT be read as a date.
eq('xlsx: a numeric-styled number is left alone', sheet.rows[1][3], 1234.5);
eq('xlsx: TRUE booleans are booleans', sheet.rows[1][4], true);
eq('xlsx: FALSE booleans are booleans', sheet.rows[2][4], false);
eq('xlsx: an inline string is read', sheet.rows[2][1], 'Inline <Name>');
eq('xlsx: a custom date format keeps the time', sheet.rows[2][2], '2024-03-02T12:00:00');
// A converter wants the cached result, not the formula text.
eq('xlsx: a formula cell yields its cached value', sheet.rows[2][3], 2469);
eq('xlsx: an error cell is surfaced verbatim', sheet.rows[3][4], '#N/A');
eq('xlsx: a gap between cells leaves the columns empty', sheet.rows[3][1], undefined);
// Row 7 has no <row> element at all, and must stay a row rather than closing
// the gap — its position is data.
eq('xlsx: an interior empty row is preserved', sheet.rows[4].length, 0);
eq('xlsx: rows after an interior gap keep their values', sheet.rows[5][0], 1004);
eq('xlsx: merged ranges are counted', sheet.merged, 1);

// The serial escape hatch: some pipelines want the raw number back.
const serialSheet = global.xlsParseSheet(sheetXml, {
  shared: sheetShared, dateXf: styles.dateXf, date1904: false, dates: 'serial'
});
eq('xlsx: dates:serial leaves the raw serial number', serialSheet.rows[1][2], 45352);

eq('xlsx: a sheet with no rows parses to nothing',
  global.xlsParseSheet('<worksheet><sheetData/></worksheet>', {}).rows.length, 0);
// A cell with no r= attribute is positional — writers do emit these.
eq('xlsx: cells without a reference fall back to their position',
  global.xlsParseSheet('<worksheet><sheetData><row r="1"><c><v>7</v></c><c><v>8</v></c></row></sheetData></worksheet>', {})
    .rows[0].join('|'), '7|8');
eq('xlsx: a self-closing row is an empty row',
  global.xlsParseSheet('<worksheet><sheetData><row r="1"/><row r="2"><c r="A2"><v>1</v></c></row></sheetData></worksheet>', {})
    .rows.length, 1);

// ── Header names ────────────────────────────────────────────────────────────
eq('xlsx: header cells become field names',
  global.xlsHeaderNames(['Id', 'Name'], 2).join(), 'Id,Name');
eq('xlsx: header names are trimmed',
  global.xlsHeaderNames(['  Id  '], 1)[0], 'Id');
// A blank header still needs an addressable field, and a repeated one must not
// overwrite the first column.
eq('xlsx: a blank header cell falls back to its column letter',
  global.xlsHeaderNames(['Id', '', 'Name'], 3).join(), 'Id,B,Name');
eq('xlsx: duplicate headers are suffixed, never dropped',
  global.xlsHeaderNames(['Name', 'Name', 'Name'], 3).join(), 'Name,Name_2,Name_3');
eq('xlsx: columns past the header row still get names',
  global.xlsHeaderNames(['Id'], 3).join(), 'Id,B,C');

// ── rows → JSON ─────────────────────────────────────────────────────────────
const json = global.xlsRowsToJson(sheet.rows, { mode: 'objects' });
eq('xlsx: the header row is not a record', json.length, 5);
eq('xlsx: values are keyed by header name', json[0]['Order ID'], 1001);
eq('xlsx: dates arrive as ISO strings', json[0].Placed, '2024-03-01');
eq('xlsx: booleans stay booleans in JSON', json[0].Shipped, true);
// Rectangular shape: a missing cell is null, not an absent key — consumers
// should not have to distinguish "no column" from "no value".
eq('xlsx: an empty cell is null', json[2].Customer, null);
eq('xlsx: every record has every key', Object.keys(json[3]).join(), 'Order ID,Customer,Placed,Amount,Shipped');
const jsonArrays = global.xlsRowsToJson(sheet.rows, { mode: 'arrays' });
eq('xlsx: array mode keeps the header row', jsonArrays.length, 6);
eq('xlsx: array mode pads rows to a rectangle', jsonArrays[4].length, 5);
eq('xlsx: array mode nulls the padding', jsonArrays[4][0], null);
eq('xlsx: an empty sheet converts to an empty array',
  global.xlsRowsToJson([], { mode: 'objects' }).length, 0);

// ── rows → CSV ──────────────────────────────────────────────────────────────
const xlsCsv = global.xlsRowsToCsv(sheet.rows, {});
eq('xlsx: CSV starts with the header row', xlsCsv.split('\r\n')[0],
  '"Order ID","Customer","Placed","Amount","Shipped"');
eq('xlsx: CSV renders booleans the way Excel does', xlsCsv.split('\r\n')[1].indexOf('"TRUE"') > -1, true);
eq('xlsx: CSV leaves missing cells empty', xlsCsv.split('\r\n')[3], '"1003","","","","#N/A"');
// The interior blank row keeps its line — dropping it would shift every row
// number below it relative to the workbook.
eq('xlsx: an interior empty row is still a CSV line', xlsCsv.split('\r\n')[4], '"","","","",""');
eq('xlsx: CSV has one line per row plus the header', xlsCsv.split('\r\n').length, 6);
const csvSemi = global.xlsRowsToCsv(sheet.rows, { delimiter: ';' });
// A Polish/German Excel reads ',' as the decimal separator, so ';' is what
// makes a double-click open in columns rather than one mashed field.
eq('xlsx: the delimiter is configurable', csvSemi.split('\r\n')[0],
  '"Order ID";"Customer";"Placed";"Amount";"Shipped"');
eq('xlsx: an empty sheet produces no CSV', global.xlsRowsToCsv([], {}), '');

// The shared exporter grew these options instead of the tool getting its own
// CSV writer — check the original behaviour is untouched.
eq('csv helper: default quoting is unchanged',
  global.mtExportToCsv(['a', 'b'], [['1', '2']]), '"a","b"\r\n"1","2"');
eq('csv helper: minimal quoting leaves clean fields bare',
  global.mtExportToCsv(['a', 'b'], [['1', 'x,y']], { quote: 'minimal' }), 'a,b\r\n1,"x,y"');
eq('csv helper: minimal quoting still quotes embedded newlines',
  global.mtExportToCsv(['a'], [['x\ny']], { quote: 'minimal' }), 'a\r\n"x\ny"');
eq('csv helper: a semicolon delimiter triggers quoting on semicolons',
  global.mtExportToCsv(['a'], [['x;y']], { delimiter: ';', quote: 'minimal' }), 'a\r\n"x;y"');
eq('csv helper: embedded quotes are doubled',
  global.mtExportToCsv(['a'], [['say "hi"']]), '"a"\r\n"say ""hi"""');

// ── ZIP reader + full workbook read (async) ─────────────────────────────────
// DecompressionStream is async, so these run in a promise and the summary
// waits for them.
async function runXlsxAsyncTests() {
  console.log('\nExcel Converter — archive reading');

  const parts = [
    { name: '[Content_Types].xml', data: '<Types/>', store: true },
    { name: 'xl/workbook.xml', data:
      '<workbook><sheets>' +
      '<sheet name="Orders &amp; Lines" sheetId="1" r:id="rId3"/>' +
      '<sheet name="Archive" sheetId="2" state="hidden" r:id="rId1"/>' +
      '</sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data:
      '<Relationships>' +
      '<Relationship Id="rId3" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId1" Target="/xl/worksheets/sheet2.xml"/>' +
      '</Relationships>' },
    { name: 'xl/sharedStrings.xml', data:
      '<sst><si><t>Order ID</t></si><si><t>Customer</t></si><si><t>Placed</t></si>' +
      '<si><t>Amount</t></si><si><t>Shipped</t></si>' +
      '<si><t>Zażółć &amp; gęślą jaźń</t></si></sst>' },
    { name: 'xl/styles.xml', data: stylesXml, store: true },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
    { name: 'xl/worksheets/sheet2.xml', data: '<worksheet><sheetData/></worksheet>', store: true }
  ];
  const buf = toArrayBuffer(buildZip(parts));

  const zip = global.xlsOpenZip(buf);
  eq('zip: every entry is listed', zip.names.length, parts.length);
  eq('zip: an entry is found by name', zip.has('xl/workbook.xml'), true);
  eq('zip: a missing entry is reported missing', zip.has('xl/nope.xml'), false);
  const wbText = await zip.text('xl/workbook.xml');
  eq('zip: a deflated entry inflates back to its source', wbText, parts[1].data);
  const ctText = await zip.text('[Content_Types].xml');
  eq('zip: a stored entry is read without inflating', ctText, '<Types/>');

  // Non-ASCII must survive the ZIP → UTF-8 → JSON path intact; this is the
  // single most likely thing to break silently for a Polish user.
  const sstText = await zip.text('xl/sharedStrings.xml');
  eq('zip: UTF-8 content survives decompression',
    sstText.indexOf('Zażółć') > -1, true);

  const book = await global.xlsReadWorkbook(buf, { fileName: 'orders.xlsx' });
  eq('workbook: the file name is carried through', book.fileName, 'orders.xlsx');
  eq('workbook: both sheets are read', book.sheets.length, 2);
  eq('workbook: sheets keep tab order, not file order', book.sheets[0].name, 'Orders & Lines');
  eq('workbook: the hidden sheet is still read and flagged', book.sheets[1].hidden, true);
  eq('workbook: the first sheet has its rows', book.sheets[0].rows.length, 6);
  eq('workbook: a date cell decoded end to end', book.sheets[0].rows[1][2], '2024-03-01');
  eq('workbook: a shared string decoded end to end', book.sheets[0].rows[1][1], 'Zażółć & gęślą jaźń');
  // An absolute rels target ("/xl/worksheets/sheet2.xml") resolves to the same
  // entry as a relative one.
  eq('workbook: an absolute relationship target resolves', book.sheets[1].missing, undefined);
  eq('workbook: an empty sheet reports no rows', book.sheets[1].rows.length, 0);

  // Failure modes must name the problem, not throw a parse error at the user.
  let msg = '';
  try { global.xlsOpenZip(toArrayBuffer(Buffer.from('this is not a zip at all'))); }
  catch (e) { msg = e.message; }
  eq('workbook: a non-ZIP file is rejected by name', /not a valid \.xlsx/i.test(msg), true);

  msg = '';
  const ole = Buffer.alloc(64);
  ole[0] = 0xD0; ole[1] = 0xCF; ole[2] = 0x11; ole[3] = 0xE0;
  try { global.xlsOpenZip(toArrayBuffer(ole)); } catch (e) { msg = e.message; }
  eq('workbook: a legacy .xls is named as such, with the fix',
    /legacy \.xls/i.test(msg) && /Save As/i.test(msg), true);

  msg = '';
  const plainZip = toArrayBuffer(buildZip([{ name: 'readme.txt', data: 'hello' }]));
  try { await global.xlsReadWorkbook(plainZip); } catch (e) { msg = e.message; }
  eq('workbook: a ZIP that is not a workbook says so',
    /not an Excel workbook/i.test(msg), true);

  // The demo workbook the screenshot pipeline builds — asserted here so a
  // broken fixture surfaces in `npm test` rather than as a wrong-looking PNG
  // nobody re-reads.
  const demo = await global.xlsReadWorkbook(toArrayBuffer(buildDemoWorkbook()), { fileName: 'demo.xlsx' });
  eq('demo workbook: three sheets', demo.sheets.length, 3);
  eq('demo workbook: sheet names', demo.sheets.map(s => s.name).join(), 'Products,Categories,Scratch notes');
  eq('demo workbook: the scratch sheet is hidden', demo.sheets[2].hidden, true);
  eq('demo workbook: the leading empty row is trimmed', demo.sheets[0].skippedTop, 1);
  eq('demo workbook: header row intact', demo.sheets[0].rows[0].join('|'),
    'Product code|Name|Category|Price|Updated|Active');
  eq('demo workbook: Polish characters survive', demo.sheets[0].rows[1][1], 'Zażółć gęślą jaźń');
  eq('demo workbook: a date column converts', demo.sheets[0].rows[1][4], '2026-03-01');
  eq('demo workbook: a date-time column keeps its time', demo.sheets[0].rows[2][4], '2026-03-02T09:30:00');
  // The money column is numFmtId 4 — the format most likely to be misread as a
  // date, since it sits right next to one.
  eq('demo workbook: the money column stays numeric', demo.sheets[0].rows[1][3], 129.99);
  eq('demo workbook: a formula yields its cached value', demo.sheets[0].rows[4][3], 1.78);
  eq('demo workbook: booleans survive', demo.sheets[0].rows[3][5], false);
  eq('demo workbook: an empty cell stays empty', demo.sheets[0].rows[5][2], undefined);

  const demoJson = global.xlsRowsToJson(demo.sheets[0].rows, { mode: 'objects' });
  eq('demo workbook: six product records', demoJson.length, 6);
  eq('demo workbook: records keyed by header', demoJson[0]['Product code'], 'PRD-1001');
  eq('demo workbook: a blank cell is null in JSON', demoJson[4].Category, null);
}

// =========================================================================
// DATA FACTORY — SCHEMA IMPORT (DDL / mendixsystem$)
// =========================================================================
// Two things decide whether an imported schema is useful or quietly wrong:
// the DDL splitter (a comma inside numeric(10,2) or CHECK (x IN (1,2)) is NOT
// a column boundary) and the generator inference, where an ordered rule list
// has to resolve real collisions — EmailAddress is an email, not an address;
// PhoneNumber is a phone, not a number; and a name rule must never win over
// an incompatible column type (city_id is an integer, not a city).
console.log('\nData Factory — schema import');
require('../public/js/tools/data-factory-import.js');

// ── DDL: structure ──────────────────────────────────────────────────────────
const ddlSimple = global.dfParseDdl(`
  CREATE TABLE customer (
    id bigint NOT NULL,
    fullname character varying(200),
    emailaddress varchar(255)
  );`);
eq('ddl: one table parsed', ddlSimple.tables.length, 1);
eq('ddl: table name', ddlSimple.tables[0].name, 'customer');
eq('ddl: three columns', ddlSimple.tables[0].columns.length, 3);
eq('ddl: column name', ddlSimple.tables[0].columns[1].name, 'fullname');
eq('ddl: multi-word type kept whole', ddlSimple.tables[0].columns[1].sqlType, 'character varying');
eq('ddl: length captured', ddlSimple.tables[0].columns[1].length, 200);
eq('ddl: NOT NULL captured', ddlSimple.tables[0].columns[0].notNull, true);

// A Mendix table name is quoted because of the `$`; the quotes are not part of
// the identifier and must not leak into the column/field names either.
const ddlMx = global.dfParseDdl('CREATE TABLE public."eshop$order" ("id" bigint, "ordernumber" varchar(20));');
eq('ddl: quoted Mendix table name unquoted', ddlMx.tables[0].name, 'eshop$order');
eq('ddl: schema captured separately', ddlMx.tables[0].schema, 'public');
eq('ddl: quoted column name unquoted', ddlMx.tables[0].columns[1].name, 'ordernumber');

eq('ddl: IF NOT EXISTS tolerated',
  global.dfParseDdl('CREATE TABLE IF NOT EXISTS t (a int);').tables[0].name, 't');

// The splitter must respect parentheses. Splitting on every comma turns three
// columns into five and invents columns called "2)" — the classic failure.
const ddlParens = global.dfParseDdl(`
  CREATE TABLE t (
    price numeric(10,2),
    status integer CHECK (status IN (1, 2, 3)),
    label varchar(50)
  );`);
eq('ddl: a comma inside numeric(p,s) is not a column boundary', ddlParens.tables[0].columns.length, 3);
eq('ddl: precision captured', ddlParens.tables[0].columns[0].precision, 10);
eq('ddl: scale captured', ddlParens.tables[0].columns[0].scale, 2);
eq('ddl: a comma inside CHECK (...) is not a column boundary', ddlParens.tables[0].columns[1].name, 'status');

// Table-level constraints look exactly like columns to a naive parser.
const ddlConstraints = global.dfParseDdl(`
  CREATE TABLE t (
    id uuid,
    owner bigint,
    PRIMARY KEY (id),
    CONSTRAINT fk_owner FOREIGN KEY (owner) REFERENCES other (id),
    UNIQUE (owner)
  );`);
eq('ddl: table-level constraints are not columns', ddlConstraints.tables[0].columns.length, 2);
eq('ddl: PRIMARY KEY (col) marks the column', ddlConstraints.tables[0].columns[0].isPrimary, true);
eq('ddl: a non-key column stays unmarked', ddlConstraints.tables[0].columns[1].isPrimary, false);
eq('ddl: inline PRIMARY KEY marks the column',
  global.dfParseDdl('CREATE TABLE t (id bigint PRIMARY KEY, a int);').tables[0].columns[0].isPrimary, true);

// Comments must go — but only real comments.
eq('ddl: line comment removed',
  global.dfParseDdl('CREATE TABLE t (\n a int, -- the id, really\n b int\n);').tables[0].columns.length, 2);
eq('ddl: block comment removed',
  global.dfParseDdl('CREATE TABLE t (a int, /* b int, */ c int);').tables[0].columns.length, 2);
// A `--` inside a string literal is data, not a comment. Stripping it swallows
// the rest of the line and takes the following columns with it.
const ddlLiteral = global.dfParseDdl("CREATE TABLE t (a varchar(10) DEFAULT 'x--y', b int, c int);");
eq('ddl: -- inside a string literal is not a comment', ddlLiteral.tables[0].columns.length, 3);

eq('ddl: multiple tables parsed',
  global.dfParseDdl('CREATE TABLE a (x int); CREATE TABLE b (y int);').tables.length, 2);

// SQL Server and Oracle: Mendix runs on all three databases, so a DDL export
// will not always be PostgreSQL.
const ddlMssql = global.dfParseDdl('CREATE TABLE [dbo].[Customer] ([Id] bigint, [Name] nvarchar(200), [Active] bit);');
eq('ddl: bracket-quoted table name', ddlMssql.tables[0].name, 'Customer');
eq('ddl: bracket-quoted column name', ddlMssql.tables[0].columns[1].name, 'Name');
const ddlOracle = global.dfParseDdl('CREATE TABLE t (a VARCHAR2(50), b NUMBER(10,0), c NUMBER(10,2));');
eq('ddl: Oracle VARCHAR2 recognised', ddlOracle.tables[0].columns[0].sqlType, 'varchar2');

// Nothing to parse must say so rather than return an empty success.
eq('ddl: input without CREATE TABLE yields no tables', global.dfParseDdl('SELECT 1;').tables.length, 0);
ok('ddl: input without CREATE TABLE explains itself', global.dfParseDdl('SELECT 1;').warnings.length > 0);
ok('ddl: unbalanced parentheses reported, not crashed',
  global.dfParseDdl('CREATE TABLE t (a int,').warnings.length > 0);

// ── SQL type → generator ────────────────────────────────────────────────────
function sqlGen(type, name, extra) {
  const col = Object.assign({ name: name || 'col', sqlType: type, length: 0, precision: 0, scale: 0 }, extra || {});
  return global.dfInferColumn(col).type;
}
eq('type: uuid → UUID', sqlGen('uuid'), 'UUID');
eq('type: varchar → String', sqlGen('varchar'), 'String');
eq('type: text → String', sqlGen('text'), 'String');
eq('type: integer → Integer', sqlGen('integer'), 'Integer');
eq('type: bigint → Number', sqlGen('bigint'), 'Number');
eq('type: numeric with scale → Decimal', sqlGen('numeric', 'col', { precision: 10, scale: 2 }), 'Decimal');
// NUMBER(10,0) is Oracle's integer. Treating it as a decimal produces "12.34"
// where the column only ever holds whole numbers.
eq('type: numeric with zero scale → Integer', sqlGen('numeric', 'col', { precision: 10, scale: 0 }), 'Integer');
// A bare `numeric` is unconstrained arbitrary precision — in practice money.
// Reading its absent precision as "scale 0" turns every price into an integer.
eq('type: numeric without precision → Decimal', sqlGen('numeric'), 'Decimal');
eq('type: boolean → Boolean', sqlGen('boolean'), 'Boolean');
eq('type: SQL Server bit → Boolean', sqlGen('bit'), 'Boolean');
eq('type: timestamp → Date', sqlGen('timestamp'), 'Date');
eq('type: datetime2 → Date', sqlGen('datetime2'), 'Date');
eq('type: jsonb → String', sqlGen('jsonb'), 'String');
eq('type: uniqueidentifier → UUID', sqlGen('uniqueidentifier'), 'UUID');
// An unknown type is a String with a stated reason — never a silent guess.
eq('type: unknown type falls back to String', sqlGen('geography'), 'String');
ok('type: unknown type says why', /geography/i.test(global.dfInferColumn({ name: 'c', sqlType: 'geography' }).note || ''));
// Binary columns are dropped rather than filled with random text: a mock BLOB
// is not data, it is noise that breaks the import it was made for.
eq('type: bytea is not a generator', global.dfInferColumn({ name: 'c', sqlType: 'bytea' }).type, null);
ok('type: bytea is reported as skipped', global.dfInferColumn({ name: 'c', sqlType: 'bytea' }).skip === true);

// ── Name → generator, and the collisions that matter ────────────────────────
eq('name: email → Email', sqlGen('varchar', 'email'), 'Email');
// "emailaddress" contains "address"; the email rule has to win.
eq('name: EmailAddress → Email, not Address', sqlGen('varchar', 'EmailAddress'), 'Email');
// "phonenumber" contains "number"; the phone rule has to win.
eq('name: PhoneNumber → Phone, not Number', sqlGen('varchar', 'PhoneNumber'), 'Phone');
// "companyname" contains "name"; the company rule has to win.
eq('name: CompanyName → Company', sqlGen('varchar', 'CompanyName'), 'Company');
eq('name: first_name → Name', sqlGen('varchar', 'first_name'), 'Name');
eq('name: LastName → Surname', sqlGen('varchar', 'LastName'), 'Surname');
eq('name: FullName → FullName', sqlGen('varchar', 'FullName'), 'FullName');
eq('name: City → City', sqlGen('varchar', 'City'), 'City');
eq('name: Country → Country', sqlGen('varchar', 'Country'), 'Country');
eq('name: StreetLine1 → Address', sqlGen('varchar', 'StreetLine1'), 'Address');
eq('name: IPAddress → IP Address', sqlGen('varchar', 'IPAddress'), 'IP Address');
eq('name: Price → Decimal', sqlGen('numeric', 'Price', { precision: 10, scale: 2 }), 'Decimal');
eq('name: Quantity → Positive value', sqlGen('integer', 'Quantity'), 'Positive value');
// A generic *Name is NOT a person. FullName here would fill a product column
// with "John Smith" — plausible-looking and wrong.
eq('name: ProductName stays a String', sqlGen('varchar', 'ProductName'), 'String');
// Mendix lower-cases and concatenates column names in the DATABASE, so the DDL
// path hands over one unsplittable token. These have no camel-case or
// underscore to tokenise on and must still resolve — this is the main DDL case,
// not an edge case.
eq('name: mainphonenumber (no separators) → Phone', sqlGen('varchar', 'mainphonenumber'), 'Phone');
eq('name: shippingstreet (no separators) → Address', sqlGen('varchar', 'shippingstreet'), 'Address');
eq('name: buyercity (no separators) → City', sqlGen('varchar', 'buyercity'), 'City');
eq('name: emailaddress (no separators) → Email', sqlGen('varchar', 'emailaddress'), 'Email');
eq('name: customername (no separators) → FullName', sqlGen('varchar', 'customername'), 'FullName');
// …while the short words stay strict, or "ip" would claim shippingstreet and
// zipcode, and "tel" would claim hotel.
eq('name: shippingstreet is not an IP address', sqlGen('varchar', 'shippingstreet'), 'Address');
eq('name: zipcode is not an IP address', sqlGen('varchar', 'zipcode'), 'String');
eq('name: hotelname is not a phone number', sqlGen('varchar', 'hotelname'), 'String');
// Substring matching on the whole name is not a near-miss, it is wrong: these
// three are real attribute names from the reference database that a substring
// rule mis-classified. Tokenising the name first is what fixes them.
eq('name: BankAccountOwner is not a City ("accoun"+"towner" contains "town")',
  sqlGen('varchar', 'BankAccountOwner'), 'String');
eq('name: Capacity is not a City ("capa"+"city")', sqlGen('integer', 'Capacity'), 'Integer');
eq('name: Discount is a Decimal, not a count', sqlGen('numeric', 'Discount', { precision: 8, scale: 2 }), 'Decimal');
// A URL is text and is not the organisation that owns it.
eq('name: OrganizationURL stays a String', sqlGen('varchar', 'OrganizationURL'), 'String');
eq('name: organizationurl (no separators) stays a String', sqlGen('varchar', 'organizationurl'), 'String');
eq('name: BuyerPhoneNo → Phone', sqlGen('varchar', 'BuyerPhoneNo'), 'Phone');
// The decisive rule: a name hint may never override the column's type family.
eq('name: city_id is an integer, not a City', sqlGen('integer', 'city_id'), 'Integer');
eq('name: CountryId is an integer, not a Country', sqlGen('bigint', 'CountryId'), 'Number');
eq('name: an email column typed boolean stays Boolean', sqlGen('boolean', 'email_verified'), 'Boolean');
// A primary key is positive by nature; a uuid key is a UUID.
eq('name: numeric primary key → Positive value', sqlGen('bigint', 'id', { isPrimary: true }), 'Positive value');
eq('name: uuid primary key → UUID', sqlGen('uuid', 'id', { isPrimary: true }), 'UUID');

// ── Building a Data Factory schema from a parsed table ──────────────────────
const built = global.dfSchemaFromTable(global.dfParseDdl(`
  CREATE TABLE "eshop$customer" (
    id bigint PRIMARY KEY,
    fullname varchar(200),
    emailaddress varchar(255),
    photo bytea,
    createddate timestamp
  );`).tables[0]);
eq('schema: binary column excluded', built.schema.length, 4);
eq('schema: field names preserved verbatim', built.schema[1].name, 'fullname');
eq('schema: inferred generator applied', built.schema[2].type, 'Email');
eq('schema: skipped column reported', built.skipped.length, 1);
ok('schema: skipped column names the reason', /binary/i.test(built.skipped[0].reason));
// A table with no usable column must produce an explicit note, not an empty
// schema that looks like a successful import.
const allBinary = global.dfSchemaFromTable({ name: 't', columns: [{ name: 'a', sqlType: 'bytea' }] });
eq('schema: a table of only binary columns yields no schema', allBinary.schema.length, 0);
ok('schema: and says so', allBinary.notes.length > 0);

// ── Mendix attribute types (mendixsystem$attribute, via /livedb/model) ──────
function mxGen(type, name) {
  return global.dfInferAttribute({ name: name || 'attr', type: type }).type;
}
eq('mx: String(200) → String', mxGen('String(200)'), 'String');
eq('mx: Integer → Integer', mxGen('Integer'), 'Integer');
eq('mx: Long → Integer', mxGen('Long'), 'Integer');
eq('mx: Decimal → Decimal', mxGen('Decimal'), 'Decimal');
eq('mx: Boolean → Boolean', mxGen('Boolean'), 'Boolean');
eq('mx: DateTime → Date', mxGen('DateTime'), 'Date');
eq('mx: AutoNumber → Positive value', mxGen('AutoNumber'), 'Positive value');
eq('mx: name inference works on Mendix types too', mxGen('String(255)', 'EmailAddress'), 'Email');
// Enumeration values are NOT in the database metadata, so the tool must not
// pretend it knows them — it maps to String and says what to do instead.
eq('mx: Enum → String', mxGen('Enum'), 'String');
ok('mx: Enum explains that values are not in the metadata',
  /enumer/i.test(global.dfInferAttribute({ name: 'Status', type: 'Enum' }).note || ''));
// An enum is a closed set of codes, so the name must NOT steer the generator —
// AddressType and CompanyType (both real) would otherwise be filled with
// street addresses and company names.
eq('mx: an enum named AddressType is still text', mxGen('Enum', 'AddressType'), 'String');
eq('mx: an enum named CompanyType is still text', mxGen('Enum', 'CompanyType'), 'String');
eq('mx: Binary is skipped', global.dfInferAttribute({ name: 'Contents', type: 'Binary' }).type, null);
// An attribute code this build has never seen must be surfaced, not guessed.
eq('mx: an unknown Mendix type falls back to String', mxGen('Type77'), 'String');

const entSchema = global.dfSchemaFromEntity({
  name: 'eShop.Customer', shortName: 'Customer', table: 'eshop$customer',
  attributes: [
    { name: 'FullName', type: 'String(200)' },
    { name: 'EmailAddress', type: 'String(255)' },
    { name: 'Contents', type: 'Binary' },
    { name: 'CreatedDate', type: 'DateTime' }
  ]
});
eq('entity: binary attribute excluded from the schema', entSchema.schema.length, 3);
eq('entity: attribute names used as field names', entSchema.schema[0].name, 'FullName');
eq('entity: email attribute inferred', entSchema.schema[1].type, 'Email');
eq('entity: skipped attribute reported', entSchema.skipped.length, 1);
// An entity with no attributes at all is a real shape in Mendix (an empty
// specialization) — it must not render as a successful empty import.
ok('entity: an attribute-less entity is explained',
  global.dfSchemaFromEntity({ name: 'A.B', attributes: [] }).notes.length > 0);

// =========================================================================
// DATA FACTORY — RELATIONAL DB SEED
// =========================================================================
// The relational seed builds a SQL INSERT script from the live schema. Three
// pure pieces decide whether the script is correct: the topological order (a
// parent must be inserted before the child that references it), the FK
// distribution (skew is what makes "some customers have hundreds of orders, some
// none" instead of everyone having the same), and the literal formatting (an
// over-long string or over-precise decimal must be clamped to the real column).
console.log('\nData Factory — relational DB seed');
require('../public/js/tools/data-factory-seed.js');

// ── Topological order ───────────────────────────────────────────────────────
const seedAssoc = [
  { storage: 'column', one: 'S.Customer', many: 'S.Order', cardinality: '1-*', columns: ['customer'] },
  { storage: 'column', one: 'S.Order', many: 'S.OrderLine', cardinality: '1-*', columns: ['order'] },
  { storage: 'junction', one: 'S.Order', many: 'S.Tag', cardinality: '*-*', columns: ['a', 'b'] }
];
const seedTopo = global.seedTopoOrder(['S.OrderLine', 'S.Order', 'S.Customer'], seedAssoc);
ok('topo: the ONE side comes before the MANY side (Customer before Order)',
  seedTopo.order.indexOf('S.Customer') < seedTopo.order.indexOf('S.Order'));
ok('topo: Order before OrderLine', seedTopo.order.indexOf('S.Order') < seedTopo.order.indexOf('S.OrderLine'));
eq('topo: a junction association imposes no ordering', seedTopo.cyclic.length, 0);
// A mutual dependency cannot be ordered — it must be reported, not silently
// dropped, so the caller can warn and fall back to nullable/existing ids.
const seedCyc = global.seedTopoOrder(['A', 'B'], [
  { storage: 'column', one: 'A', many: 'B', columns: ['a'] },
  { storage: 'column', one: 'B', many: 'A', columns: ['b'] }
]);
ok('topo: a mutual dependency is reported as a cycle', seedCyc.cyclic.length > 0);
eq('topo: every node is still returned despite the cycle', seedCyc.order.length, 2);

// ── FK distribution ─────────────────────────────────────────────────────────
const seedParents = []; for (let i = 1; i <= 50; i++) seedParents.push(i);
const seedSkew = global.seedDistribute(seedParents, 500,
  { mode: 'skew', cardinality: '1-*', optional: false, orphanFraction: 0.2, skew: 1.2 }, global.seedRng(42));
eq('distribute: exactly one assignment per child row', seedSkew.length, 500);
ok('distribute: every assignment is a real parent id',
  seedSkew.every(function (x) { return seedParents.indexOf(x) !== -1; }));
const seedSkewStats = global.seedDistributionStats(seedParents, seedSkew);
ok('distribute: a guaranteed orphan fraction really leaves parents with none', seedSkewStats.zero >= 10);
ok('distribute: skew produces a heavy head (max far above the median)',
  seedSkewStats.max > seedSkewStats.median * 3);

const seedUni = global.seedDistribute([1, 2, 3, 4], 400,
  { mode: 'uniform', cardinality: '1-*', optional: false }, global.seedRng(7));
const seedUniStats = global.seedDistributionStats([1, 2, 3, 4], seedUni);
ok('distribute: uniform spreads across every parent (none left at zero)', seedUniStats.zero === 0);

// 1-1 draws without replacement — the FK carries a UNIQUE index.
const seed11 = global.seedDistribute([1, 2, 3, 4, 5], 5,
  { cardinality: '1-1', optional: false }, global.seedRng(1));
const seed11NonNull = seed11.filter(function (x) { return x !== null; });
eq('distribute 1-1: no parent is used twice', new Set(seed11NonNull).size, seed11NonNull.length);
const seed11Short = global.seedDistribute([1, 2], 5,
  { cardinality: '1-1', optional: true, nullFraction: 0 }, global.seedRng(1));
ok('distribute 1-1: children beyond the parent count get null',
  seed11Short.filter(function (x) { return x !== null; }).length <= 2);

// ── Column family + SQL literal ─────────────────────────────────────────────
eq('family: character varying → text', global.seedColumnFamily({ dataType: 'character varying' }), 'text');
eq('family: bigint → bigint', global.seedColumnFamily({ dataType: 'bigint' }), 'bigint');
eq('family: numeric → exact', global.seedColumnFamily({ dataType: 'numeric' }), 'exact');
eq('family: boolean → bool', global.seedColumnFamily({ dataType: 'boolean' }), 'bool');
eq('family: timestamp → date', global.seedColumnFamily({ dataType: 'timestamp without time zone' }), 'date');
eq('family: uuid → uuid', global.seedColumnFamily({ dataType: 'uuid' }), 'uuid');
eq('family: falls back to udt_name when data_type is opaque',
  global.seedColumnFamily({ dataType: '', udtName: 'int8' }), 'bigint');

eq('literal: null → NULL', global.seedSqlLiteral(null, { family: 'text' }), 'NULL');
eq('literal: text is quoted and single-quotes are doubled',
  global.seedSqlLiteral("O'Brien", { family: 'text' }), "'O''Brien'");
eq('literal: a string is clamped to character_maximum_length',
  global.seedSqlLiteral('abcdefghij', { family: 'text', maxLength: 5 }), "'abcde'");
eq('literal: an integer is rounded and unquoted', global.seedSqlLiteral(3.9, { family: 'int' }), '4');
eq('literal: exact honours numeric scale', global.seedSqlLiteral(3.14159, { family: 'exact', numericScale: 2 }), '3.14');
eq('literal: exact with scale 0 is a whole number', global.seedSqlLiteral(3.99, { family: 'exact', numericScale: 0 }), '4');
eq('literal: exact clamps a value that would overflow numeric(precision, scale)',
  global.seedSqlLiteral(9999.99, { family: 'exact', numericScale: 2, numericPrecision: 5 }), '999.99');
eq('literal: exact clamps a negative overflow too',
  global.seedSqlLiteral(-9999.99, { family: 'exact', numericScale: 2, numericPrecision: 5 }), '-999.99');
eq('literal: exact leaves an in-range value untouched when precision is known',
  global.seedSqlLiteral(42.5, { family: 'exact', numericScale: 2, numericPrecision: 5 }), '42.50');
eq('literal: exact without a known precision is not clamped (unbounded numeric)',
  global.seedSqlLiteral(9999.99, { family: 'exact', numericScale: 2 }), '9999.99');
eq('literal: boolean true', global.seedSqlLiteral(true, { family: 'bool' }), 'true');
eq('literal: boolean false', global.seedSqlLiteral(false, { family: 'bool' }), 'false');
eq('literal: a date value is quoted',
  global.seedSqlLiteral('2020-01-01 12:00:00', { family: 'date' }), "'2020-01-01 12:00:00'");

// (value generation moved to the shared engine — see "generator engine" tests)

// ── INSERT assembly ─────────────────────────────────────────────────────────
const seedIns = global.seedInsertStatement('eshop$order', ['id', 'customer'], [['1', '10'], ['2', 'NULL']]);
ok('insert: table and columns are quoted identifiers',
  seedIns.indexOf('INSERT INTO "eshop$order" ("id", "customer") VALUES') === 0);
ok('insert: every row is present', /\(1, 10\)/.test(seedIns) && /\(2, NULL\)/.test(seedIns));
ok('insert: the statement is terminated', /;\s*$/.test(seedIns));

// =========================================================================
// DATA FACTORY — GENERATOR ENGINE (declarative, parametrized)
// =========================================================================
// The value engine shared by every output. What matters is that PARAMETERS
// actually constrain the value (a Date stays inside its range, a Number inside
// min/max), that the two cross-cutting knobs work (emptyPercent makes holes,
// unique never collides — a duplicate would abort the whole SQL transaction),
// and that weighting a Custom list biases the pick (skew = realism).
console.log('\nData Factory — generator engine');
require('../public/js/tools/data-factory-generators.js');
var gRng = global.dfgRng(20260724);

// ── parameters actually constrain the value ──
var nums = [], i;
for (i = 0; i < 500; i++) nums.push(global.dfgGenerate('Integer', { min: 10, max: 20 }, { rowIndex: i }, gRng));
ok('gen: Number min/max is respected', nums.every(function (n) { return n >= 10 && n <= 20; }));
var dec = global.dfgGenerate('Decimal', { min: 0, max: 100, scale: 2 }, { rowIndex: 0 }, gRng);
ok('gen: Decimal honours scale (≤ 2 places)', /^\d+(\.\d{1,2})?$/.test(String(dec)));

var lo = Date.parse('2025-01-01'), hi = Date.parse('2025-12-31T23:59:59Z');
var dates = [];
for (i = 0; i < 300; i++) dates.push(global.dfgGenerate('Date', { from: '2025-01-01', to: '2025-12-31' }, { rowIndex: i }, gRng));
ok('gen: Date stays inside the given range', dates.every(function (d) { var t = Date.parse(d.replace(' ', 'T') + 'Z'); return t >= lo - 86400000 && t <= hi + 86400000; }));

// ── Boolean % biases the coin ──
var trues = 0;
for (i = 0; i < 2000; i++) if (global.dfgGenerate('Boolean', { truePercent: 90 }, { rowIndex: i }, gRng) === true) trues++;
ok('gen: Boolean truePercent≈90 skews strongly true', trues > 1650 && trues < 1950);

// ── region pools ──
var euCountries = { Poland:1, Germany:1, France:1, Spain:1, Italy:1, Netherlands:1, Sweden:1, Austria:1, Czechia:1, Portugal:1, Denmark:1, Ireland:1, Belgium:1, Norway:1, Finland:1, Greece:1 };
var okEu = true;
for (i = 0; i < 200; i++) if (!euCountries[global.dfgGenerate('Country', { region: 'europe' }, { rowIndex: i }, gRng)]) okEu = false;
ok('gen: Country region=europe stays European', okEu);
var plNames = {};
['Jan','Anna','Piotr','Katarzyna','Andrzej','Małgorzata','Tomasz','Agnieszka','Marcin','Barbara','Krzysztof','Ewa','Paweł','Magdalena','Michał','Joanna'].forEach(function (n) { plNames[n] = 1; });
ok('gen: Name region=polish yields a Polish first name',
  plNames[global.dfgGenerate('Name', { region: 'polish' }, { rowIndex: 0 }, gRng)] === 1);

// ── Pattern mask ──
var pat = global.dfgGenerate('Pattern', { mask: 'ORD-#####' }, { rowIndex: 0 }, gRng);
ok('gen: Pattern fills # with digits and keeps literals', /^ORD-\d{5}$/.test(pat));
var pat2 = global.dfgGenerate('Pattern', { mask: '??-##' }, { rowIndex: 0 }, gRng);
ok('gen: Pattern ? is an uppercase letter', /^[A-Z]{2}-\d{2}$/.test(pat2));

// ── Sequence is sequential AND unique ──
eq('gen: Sequence pads and prefixes', global.dfgGenerate('Sequence', { prefix: 'INV-', start: 1, width: 5 }, { rowIndex: 0 }), 'INV-00001');
eq('gen: Sequence advances with rowIndex', global.dfgGenerate('Sequence', { prefix: 'INV-', start: 1, width: 5 }, { rowIndex: 41 }), 'INV-00042');
var seqSet = {};
for (i = 0; i < 1000; i++) seqSet[global.dfgGenerate('Sequence', { prefix: 'X', start: 0, width: 4 }, { rowIndex: i })] = 1;
eq('gen: Sequence never repeats', Object.keys(seqSet).length, 1000);

// ── Custom list weights bias the pick ──
var wc = { A: 0, B: 0, C: 0 };
for (i = 0; i < 500; i++) wc[global.dfgGenerate('Custom list', { values: ['A', 'B', 'C'], weights: [0, 10, 0] }, { rowIndex: i }, gRng)]++;
ok('gen: a zero-weight value is never picked', wc.A === 0 && wc.C === 0);
eq('gen: the only weighted value is always picked', wc.B, 500);

// ── cross-cutting: emptyPercent + uniqueness ──
var allNull = true;
for (i = 0; i < 100; i++) if (global.dfgGenerate('Name', {}, { emptyPercent: 100, rowIndex: i }, gRng) !== null) allNull = false;
ok('gen: emptyPercent=100 always yields null', allNull);
var noNull = true;
for (i = 0; i < 100; i++) if (global.dfgGenerate('Name', {}, { emptyPercent: 0, rowIndex: i }, gRng) === null) noNull = false;
ok('gen: emptyPercent=0 never yields null', noNull);
var mails = {};
for (i = 0; i < 1000; i++) mails[global.dfgGenerate('Email', {}, { unique: true, rowIndex: i }, gRng)] = 1;
eq('gen: unique e-mails never collide across 1000 rows', Object.keys(mails).length, 1000);
ok('gen: a unique e-mail is still a valid address',
  /^[^@\s]+@[^@\s]+$/.test(global.dfgGenerate('Email', {}, { unique: true, rowIndex: 7 }, gRng)));

// ── metadata for the UI ──
var meta = global.dfgList();
ok('gen: dfgList exposes generators with params', Array.isArray(meta) && meta.length > 15);
ok('gen: Date generator declares from/to params',
  meta.find(function (g) { return g.id === 'Date'; }).params.map(function (p) { return p.key; }).join(',') === 'from,to');
eq('gen: dfgFamily maps Boolean to bool', global.dfgFamily('Boolean'), 'bool');

// =========================================================================
// DATA FACTORY — OUTPUT LAYER (CSV / JSON / XML serializers)
// =========================================================================
console.log('\nData Factory — output layer');
require('../public/js/tools/data-factory-output.js');

var oCols = ['Name', 'Note', 'Active', 'Score'];
var oRows = [['Jane, Ann', 'line1\nline2', true, 3], ['Bob "B"', null, false, null]];

var oCsv = global.dfoCsv(oCols, oRows);
ok('output csv: header present', oCsv.split('\n')[0] === 'Name,Note,Active,Score');
ok('output csv: a comma forces quoting', /"Jane, Ann"/.test(oCsv));
ok('output csv: an embedded quote is doubled', /"Bob ""B"""/.test(oCsv));
ok('output csv: a newline in a field is quoted, not a new row', oCsv.split('\n').length === 4);
ok('output csv: boolean rendered as true/false', /,true,/.test(oCsv) && /,false,/.test(oCsv));

var oJson = JSON.parse(global.dfoJson(oCols, oRows));
eq('output json: one object per row', oJson.length, 2);
eq('output json: values keyed by column', oJson[0].Name, 'Jane, Ann');
eq('output json: boolean preserved as boolean', oJson[0].Active, true);
eq('output json: null preserved as null', oJson[1].Note, null);

var oXml = global.dfoXml(oCols, oRows, { root: 'People', record: 'Person' });
ok('output xml: custom root/record used', /<People>/.test(oXml) && /<Person>/.test(oXml));
ok('output xml: special chars escaped', /Bob &quot;B&quot;|Bob "B"/.test(oXml));
ok('output xml: a null field is an absent node', oXml.indexOf('<Note></Note>') === -1);
ok('output xml: dispatcher routes by format', global.dfoSerialize('json', oCols, oRows) === global.dfoJson(oCols, oRows));

// ── Mendix REST import payload (11.6) ──
var oRest = JSON.parse(global.dfoMendixRest(oCols, oRows, { entityType: 'MyFirstModule.Customer' }));
eq('output mendix-rest: one object per row', oRest.length, 2);
eq('output mendix-rest: every object carries $entityType', oRest[0]['$entityType'], 'MyFirstModule.Customer');
eq('output mendix-rest: attribute fields sit alongside $entityType', oRest[0].Name, 'Jane, Ann');
eq('output mendix-rest: null values are preserved, not dropped', oRest[1].Note, null);
ok('output mendix-rest: $entityType is always the first key (visible at a glance)', Object.keys(oRest[0])[0] === '$entityType');
eq('output mendix-rest: no entityType supplied uses a visible placeholder, never a guess', JSON.parse(global.dfoMendixRest(oCols, oRows, {}))[0]['$entityType'], 'Module.Entity');
ok('output mendix-rest: dispatcher routes to it too', global.dfoSerialize('mendix-rest', oCols, oRows, { entityType: 'X.Y' }) === global.dfoMendixRest(oCols, oRows, { entityType: 'X.Y' }));

// =========================================================================
// SQL / OQL FORMATTING ENGINE
// =========================================================================
// The old prettifySQL/formatOql both ran a blind `\s+` collapse and `\bKW\b`
// match over the WHOLE input, so a keyword sitting inside a string literal or
// a comment got uppercased and relocated as if it were code. These tests
// pin the failure cases the audit called out by name.
console.log('\nSQL/OQL formatting engine');
require('../public/js/tools/sql-engine.js');

const sqeMasked1 = global.sqeMask("WHERE name = 'ORDER BY' AND x = 1");
eq('mask: one string token extracted', sqeMasked1.tokens.length, 1);
eq('mask: token keeps the keyword verbatim', sqeMasked1.tokens[0].raw, "'ORDER BY'");
ok('mask: masked text has no literal ORDER BY left', sqeMasked1.masked.indexOf('ORDER BY') === -1);
eq('unmask: round-trips to the original string', global.sqeUnmask(sqeMasked1.masked, sqeMasked1.tokens), "WHERE name = 'ORDER BY' AND x = 1");

const sqeMasked2 = global.sqeMask("SELECT 1 -- FROM legacy\nFROM real_table");
eq('mask: line comment extracted as its own token', sqeMasked2.tokens[0].raw, '-- FROM legacy');
ok('mask: FROM inside the comment is not visible to a keyword scan', sqeMasked2.masked.indexOf('FROM legacy') === -1);
ok('mask: FROM in real code still visible', /FROM real_table/.test(sqeMasked2.masked));

const sqeMasked3 = global.sqeMask("/* multi\nline */ SELECT 1");
eq('mask: block comment spans newlines as one token', sqeMasked3.tokens[0].raw, '/* multi\nline */');

const sqeMasked4 = global.sqeMask("SET x = ''''"); // '''' = an escaped single quote inside the literal
eq('mask: doubled-quote escape stays inside the string token', sqeMasked4.tokens[0].raw, "''''");

// ── top-level split ──────────────────────────────────────────────────────
const sqeSplit1 = global.sqeSplitTopLevel('a, b, c');
eq('split: three plain items', sqeSplit1.length, 3);
eq('split: items trimmed', sqeSplit1[1], 'b');

const sqeSplit2 = global.sqeSplitTopLevel("price numeric(10,2), name text");
eq('split: a comma inside parens is not a boundary', sqeSplit2.length, 2);
eq('split: the paren-bearing column stays whole', sqeSplit2[0], 'price numeric(10,2)');

const sqeSplit3 = global.sqeSplitTopLevel('(SELECT a, b FROM t), c');
eq('split: a comma inside a subquery is not a boundary', sqeSplit3.length, 2);

// ── prettify (the real regression target: a keyword hiding in a literal) ──
const sqePrettyOpts = {
  breakKeywords: ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'JOIN'],
  indentKeywords: ['AND', 'OR'],
  listKeywords: ['SELECT', 'GROUP BY', 'ORDER BY']
};
const sqePretty1 = global.sqePrettify("SELECT a, b FROM t WHERE name = 'ORDER BY' AND x = 1", sqePrettyOpts);
ok('prettify: the literal ORDER BY is not treated as the keyword',
  sqePretty1.indexOf("'ORDER BY'") !== -1 && sqePretty1.split('\n').filter(function (l) { return /^ORDER BY/.test(l.trim()); }).length === 0);
ok('prettify: SELECT columns split one per line', /SELECT\n\s+a,\n\s+b/.test(sqePretty1));
ok('prettify: WHERE starts its own line', /\nWHERE /.test(sqePretty1));

const sqePretty2 = global.sqePrettify('numeric(10,2)', { breakKeywords: [], indentKeywords: [], listKeywords: [] });
eq('prettify: passthrough with no keyword lists configured', sqePretty2, 'numeric(10,2)');

const sqePretty3 = global.sqePrettify("SELECT 1 -- pick the columns\nFROM t", sqePrettyOpts);
ok('prettify: a comment survives formatting unchanged', sqePretty3.indexOf('-- pick the columns') !== -1);

// ── 7.6: configurable indent width + keyword case (SQL Formatter settings) ──
const sqePretty4Space = global.sqePrettify('select a, b from t', Object.assign({}, sqePrettyOpts, { indentSize: 4 }));
ok('prettify: indentSize=4 uses 4-space list indent', /SELECT\n {4}a,\n {4}b/.test(sqePretty4Space));

const sqePrettyLower = global.sqePrettify('SELECT a FROM t WHERE a > 1', Object.assign({}, sqePrettyOpts, { keywordCase: 'lower' }));
ok('prettify: keywordCase=lower lowercases keywords', /^select\n {2}a\nfrom t\nwhere a > 1$/.test(sqePrettyLower));

const sqePrettyPreserve = global.sqePrettify('Select a From t Where a > 1', Object.assign({}, sqePrettyOpts, { keywordCase: 'preserve' }));
ok('prettify: keywordCase=preserve keeps the original casing', sqePrettyPreserve.indexOf('Select') !== -1 && sqePrettyPreserve.indexOf('From') !== -1 && sqePrettyPreserve.indexOf('Where') !== -1);
ok('prettify: keywordCase=preserve still recognizes mixed-case SELECT for list-splitting', /Select\n {2}a/.test(sqePrettyPreserve));

// ── subqueries format recursively; other parens stay inline ──
// A parenthesized group whose content begins with SELECT is a subquery: it is
// pretty-printed on its own, one indent level deeper, with the opening paren on
// the clause line and the closing paren back at the clause indent. Every other
// paren group (function args, an IN value-list, a grouped AND/OR) stays inline,
// its closing paren never misplaced — the original depth-0 guarantee.
const sqePrettySubquery = global.sqePrettify(
  "SELECT id, (SELECT count(*) FROM orders o WHERE o.customer_id = c.id) AS order_count FROM customers c",
  sqePrettyOpts);
ok('prettify: outer SELECT list splits into id + the subquery column',
  /SELECT\n\s+id,\n\s+\(/.test(sqePrettySubquery));
ok('prettify: the subquery body is formatted and indented deeper than its call',
  /\n {2}\(\n {4}SELECT\n {6}count\(\*\)\n {4}FROM orders o\n {4}WHERE o\.customer_id = c\.id\n {2}\) AS order_count/.test(sqePrettySubquery));
ok('prettify: no subquery keyword leaks to the outer (depth-0) column split',
  sqePrettySubquery.split('\n').filter(function (l) { return /^\s*FROM orders/.test(l); }).length === 1);

// A nested IN (SELECT …) opens its paren on the AND line and lays the inner
// query out below — the real readability win over the old one-line behaviour.
const sqePrettyInSub = global.sqePrettify(
  "SELECT a FROM t WHERE a = 1 AND b IN (SELECT x FROM u WHERE u.k = 2)",
  sqePrettyOpts);
ok('prettify: IN-subquery opens its paren on the clause line',
  /\n\s+AND b IN \(\n/.test(sqePrettyInSub));
ok('prettify: IN-subquery inner SELECT/FROM are formatted and indented',
  /\(\n\s+SELECT\n\s+x\n\s+FROM u\n\s+WHERE u\.k = 2\n\s+\)/.test(sqePrettyInSub));

const sqePrettyGrouped = global.sqePrettify("SELECT a FROM t WHERE a = 1 AND (b = 2 OR c = 3)", sqePrettyOpts);
ok('prettify: OR inside a grouped condition does not start its own line',
  sqePrettyGrouped.split('\n').filter(function (l) { return /^\s*OR /.test(l); }).length === 0);
ok('prettify: the grouped condition stays intact on the AND line',
  sqePrettyGrouped.indexOf('AND (b = 2 OR c = 3)') !== -1);

// =========================================================================
// FORMAT VIEW — shared tokenizer / grouping (format-view.js)
// =========================================================================
console.log('\nFormat view — shared tokenizer');
// escHtml touches `document` at load in the browser; a minimal stub matching
// its real behaviour is enough to exercise the rendering here.
if (!global.escHtml) {
  global.escHtml = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
}
require('../public/js/tools/format-view.js');

const fvKw = global.fvWords('kw', ['and', 'or', 'not']);
const fvNum = global.fvRe('num', '\\d+(?:\\.\\d+)?');
const fvId = global.fvRe('id', '[A-Za-z_]\\w*');
const fvParen = global.fvRe('paren', '[()]');
const fvMatchers = [global.fvRe('ws', '[ \\t]+'), fvNum, fvKw, fvId, fvParen];

const fvT1 = global.fvTokenize('a and 12', fvMatchers).filter(function (t) { return t.t !== 'ws'; });
eq('fvTokenize: three non-ws tokens', fvT1.length, 3);
eq('fvTokenize: keyword recognised', fvT1[1].t, 'kw');
eq('fvTokenize: number recognised', fvT1[2].t, 'num');

// The word-boundary relaxation: a keyword glued to a DIGIT still splits (a
// number cannot contain letters), but glued to a LETTER stays one identifier.
const fvGlued = global.fvTokenize('1000and', fvMatchers);
eq('fvTokenize: keyword after a digit splits off', fvGlued.length, 2);
eq('fvTokenize: the number half is a number', fvGlued[0].t, 'num');
eq('fvTokenize: the keyword half is a keyword', fvGlued[1].t, 'kw');
const fvLetterGlue = global.fvTokenize('fooand', fvMatchers);
eq('fvTokenize: keyword glued after a letter stays one identifier', fvLetterGlue.length, 1);
eq('fvTokenize: …and is tagged as an identifier, not a keyword', fvLetterGlue[0].t, 'id');

const fvGrp = global.fvTokenize('(a(b))', fvMatchers);
global.fvAssignBrackets(fvGrp);
const fvOpens = fvGrp.filter(function (t) { return t.v === '('; });
const fvCloses = fvGrp.filter(function (t) { return t.v === ')'; });
eq('fvAssignBrackets: outer ( pairs with the last )', fvOpens[0].g, fvCloses[fvCloses.length - 1].g);
eq('fvAssignBrackets: inner ( pairs with the inner )', fvOpens[1].g, fvCloses[0].g);
ok('fvAssignBrackets: the two pairs have distinct group ids', fvOpens[0].g !== fvOpens[1].g);

const fvHtml = global.fvTokensToHtml([{ t: 'kw', v: 'and', g: 3 }, { t: 'ws', v: ' ' }, { t: 'num', v: '1' }]);
ok('fvTokensToHtml: grouped token carries data-g', /<span class="ftok fk-kw" data-g="3">and<\/span>/.test(fvHtml));
ok('fvTokensToHtml: whitespace is emitted raw, no span', fvHtml.indexOf('> <') !== -1);

// =========================================================================
// MICROFLOW EXPRESSION FORMATTER
// =========================================================================
console.log('\nMicroflow Expression Formatter');
require('../public/js/tools/microflow-expression.js');

const mefSimple = global.mefFormat("if ($Customer/Status = 'Active') then $Customer/Email else 'unknown'");
ok('mef: breaks before if/then/else', /^if /.test(mefSimple) && /\nthen /.test(mefSimple) && /\nelse /.test(mefSimple));
ok('mef: the string literal is untouched', mefSimple.indexOf("'Active'") !== -1 && mefSimple.indexOf("'unknown'") !== -1);

const mefNested = global.mefFormat("if (($A > 10) and ($B < 5)) then (if ($C = true) then 1 else 2) else 3");
const mefNestedLines = mefNested.split('\n');
eq('mef: outer if/then/else at depth 0', mefNestedLines[0].indexOf('if ((') === 0, true);
eq('mef: the nested if is indented one level', mefNestedLines[2], '  if ($C = true)');
ok('mef: the nested then/else are indented to match the nested if', mefNestedLines[3].indexOf('  then') === 0 && mefNestedLines[4].indexOf('  else') === 0);
ok('mef: the outer else is back at depth 0', mefNestedLines[5].indexOf('else 3') === 0);

const mefElseIf = global.mefFormat("if (a) then 1 else if (b) then 2 else 3");
ok('mef: else-if is kept as one unit, not split into else + if', /\nelse if \(b\)/.test(mefElseIf));

const mefKeywordInString = global.mefFormat("if ($Status = 'then this') then 1 else 2");
ok('mef: a keyword hiding inside a string literal is not treated as a break point',
  mefKeywordInString.indexOf("'then this'") !== -1 && mefKeywordInString.split('\n').filter(function (l) { return /^\s*then this/.test(l); }).length === 0);

// The glue-fix: spaces are stripped from the pasted input, and canonical
// spacing plus line breaks must be re-inserted.
const mefGlued = global.mefFormat("if$A/Type='x'and$B>1000.0then'Y'else'Z'");
ok('mef glue-fix: no keyword stays glued to its neighbour',
  /\bif \$A\/Type = 'x' and \$B > 1000\.0\b/.test(mefGlued.replace(/\n/g, ' ')));
ok('mef glue-fix: then/else still break onto their own lines',
  /\nthen 'Y'/.test(mefGlued) && /\nelse 'Z'/.test(mefGlued));

const mefHl = global.mefHighlight(global.mefFormat("if (empty($Customer/Email)) then trim($Customer/Name) else $Customer/Email"));
ok('mef highlight: if/then/else are control tokens', /<span class="ftok fk-ctrl"[^>]*>if<\/span>/.test(mefHl) && /<span class="ftok fk-ctrl"[^>]*>then<\/span>/.test(mefHl));
ok('mef highlight: empty wrapped as a keyword, not a function', /<span class="ftok fk-kw">empty<\/span>/.test(mefHl));
ok('mef highlight: trim wrapped as a Mendix function', /<span class="ftok fk-fn">trim<\/span>/.test(mefHl));
ok('mef highlight: the $Customer path wrapped as a variable', /<span class="ftok fk-var">\$Customer\/Email<\/span>/.test(mefHl));
ok('mef highlight: no leaked mask placeholder', mefHl.indexOf(String.fromCharCode(0)) === -1);

// if/then/else and their parens each get a shared hover group.
const mefGrp = global.mefHighlight(global.mefFormat("if (a) then 1 else 2"));
const mefIf = mefGrp.match(/<span class="ftok fk-ctrl" data-g="(\d+)">if<\/span>/);
const mefThen = mefGrp.match(/<span class="ftok fk-ctrl" data-g="(\d+)">then<\/span>/);
const mefElse = mefGrp.match(/<span class="ftok fk-ctrl" data-g="(\d+)">else<\/span>/);
ok('mef grouping: if/then/else share one hover group', !!mefIf && mefIf[1] === mefThen[1] && mefIf[1] === mefElse[1]);
const mefParens = mefGrp.match(/<span class="ftok fk-paren" data-g="(\d+)">[()]<\/span>/g) || [];
ok('mef grouping: the ( and ) are grouped for bracket matching', mefParens.length === 2);

// =========================================================================
// SQL FORMATTER — tokenizer highlighting (sql.js)
// =========================================================================
console.log('\nSQL Formatter highlighting');
require('../public/js/tools/sql.js');

const sqlHl = global.sqlHighlight("SELECT SUM(a * b) AS total FROM Sales.Customer WHERE Status = 'Active'");
ok('sql highlight: keywords coloured', /<span class="ftok fk-kw">SELECT<\/span>/.test(sqlHl));
ok('sql highlight: functions get their own colour', /<span class="ftok fk-fn">SUM<\/span>/.test(sqlHl));
ok('sql highlight: operators get their own colour', /<span class="ftok fk-op">\*<\/span>/.test(sqlHl));
ok('sql highlight: a column path is one variable token', /<span class="ftok fk-var">Sales\.Customer<\/span>/.test(sqlHl));
ok('sql highlight: string literal coloured, keyword inside it untouched', /<span class="ftok fk-str">'Active'<\/span>/.test(sqlHl));
const sqlParens = (sqlHl.match(/<span class="ftok fk-paren" data-g="\d+">/g) || []);
ok('sql highlight: matching parens grouped for hover', sqlParens.length === 2);

// A keyword hiding inside a literal must not be recoloured as a keyword.
const sqlLitKw = global.sqlHighlight("WHERE name = 'ORDER BY'");
ok('sql highlight: ORDER BY inside a string stays a string, not a keyword',
  /<span class="ftok fk-str">'ORDER BY'<\/span>/.test(sqlLitKw) && sqlLitKw.indexOf('fk-kw">ORDER') === -1);

// =========================================================================
// XPATH FORMATTER — tokenizer highlighting (xpath.js)
// =========================================================================
console.log('\nXPath Formatter highlighting');
require('../public/js/tools/xpath.js');

const xpHl = global.xpathHighlight("[starts-with(Name, 'Test') and Status = 'Active']");
ok('xpath highlight: hyphenated function name spanned whole', /<span class="ftok fk-fn">starts-with<\/span>/.test(xpHl));
ok('xpath highlight: and coloured as a keyword', /<span class="ftok fk-kw">and<\/span>/.test(xpHl));
const xpBrackets = (xpHl.match(/<span class="ftok fk-bracket" data-g="\d+">/g) || []);
ok('xpath highlight: the [ ] constraint brackets are grouped', xpBrackets.length === 2);

// =========================================================================
// JSON TREE — bracket matching (json.js renderJsonTree)
// =========================================================================
console.log('\nJSON tree bracket matching');
require('../public/js/tools/json.js');

const jtHtml = global.renderJsonTree({ a: [1, 2] }, 0);
const jtOpenObj = jtHtml.match(/data-g="([^"]+)">\{<\/span>/);
ok('json tree: the opening { is a brace tagged with a group id', !!jtOpenObj);
ok('json tree: the { and } (plus the collapsed-placeholder copy) share the group',
  jtHtml.split('data-g="' + jtOpenObj[1] + '"').length - 1 === 3);
const jtOpenArr = jtHtml.match(/data-g="([^"]+)">\[<\/span>/);
ok('json tree: the [ is tagged with a DIFFERENT group id than the {',
  !!jtOpenArr && jtOpenArr[1] !== jtOpenObj[1]);

// =========================================================================
// XPATH — deep-hop detection (7.7)
// =========================================================================
console.log('\nXPath deep-hop detection');
require('../public/js/tools/xpath.js');

eq('xpath hops: a real 2-hop association path is named',
  global.xpathDeepHops("[Mod.A/Mod.B/Attr = '1']").join('>'), 'Mod.A>Mod.B');

// code review fix: a literal '/' inside a string constraint (URL, date, or
// any value containing a slash) must never be split into fake hop segments —
// sqeMask now runs before the bracket content is split on '/'.
eq('xpath hops: a string literal containing slashes yields no fake hops',
  global.xpathDeepHops("[Name = 'a/b/c']").length, 0);
eq('xpath hops: a URL-valued attribute yields no fake hops',
  global.xpathDeepHops("[WebsiteUrl = 'https://example.com/path']").length, 0);
eq('xpath hops: a dd/mm/yyyy-style date string yields no fake hops',
  global.xpathDeepHops("[CreatedDate = '31/12/2026']").length, 0);

// =========================================================================
// JWT DECODER — signature verification helpers (8.3/8.4)
// =========================================================================
console.log('\nJWT Decoder');
require('../public/js/tools/jwt.js');

const jwtB64 = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
eq('jwt: base64url JSON decodes', global.jwtBase64UrlDecodeJson(jwtB64).alg, 'RS256');
eq('jwt: malformed base64url returns null, not a throw', global.jwtBase64UrlDecodeJson('not-json-!!!'), null);

ok('jwt: a known claim (exp) gets a title tooltip', /title="[^"]*[Ee]xpiration/.test(global.jwtClaimCell('exp')));
eq('jwt: an unknown claim gets no tooltip wrapper', global.jwtClaimCell('custom_claim'), 'custom_claim');

const jwkA = { kty: 'RSA', kid: 'key-a', n: 'x', e: 'AQAB' };
const jwkB = { kty: 'RSA', kid: 'key-b', n: 'y', e: 'AQAB' };
eq('jwt: JWKS key selected by matching kid', global.jwtSelectJwk({ keys: [jwkA, jwkB] }, { alg: 'RS256', kid: 'key-b' }).kid, 'key-b');
eq('jwt: JWKS falls back to matching kty when no kid matches', global.jwtSelectJwk({ keys: [jwkA, jwkB] }, { alg: 'RS256', kid: 'unknown' }).kid, 'key-a');
eq('jwt: a bare JWK (not a JWKS) is used directly', global.jwtSelectJwk(jwkA, { alg: 'RS256' }).kid, 'key-a');

// =========================================================================
// ENCODER / DECODER — auto-detect, recursive decode, binary round-trip (10.1)
// =========================================================================
console.log('\nEncoder / Decoder');
require('../public/js/tools/encoder.js');

// Data-driven rule: only claim a type when decoding actually succeeds and
// produces something — plain prose must never be misdetected.
eq('encoder detect: real Base64 text is recognized', global.encDetectType(Buffer.from('Hello Mendix world').toString('base64')), 'base64');
eq('encoder detect: real URL-encoding is recognized', global.encDetectType('a%20b%2Fc'), 'url');
eq('encoder detect: plain prose is not misdetected as anything', global.encDetectType('The quick brown fox jumps'), null);
eq('encoder detect: short base64-alphabet word stays undetected (ambiguous)', global.encDetectType('Test'), null);
eq('encoder detect: empty input detects nothing', global.encDetectType(''), null);

// Recursive decode: stops as soon as the value stabilizes, never loops forever.
const doubleUrl = encodeURIComponent(encodeURIComponent('a b/c'));
const r1 = global.encDecodeRecursiveValue('url', doubleUrl, 10);
eq('encoder recursive: double URL-encoding fully unwound', r1.result, 'a b/c');
eq('encoder recursive: reports 2 layers for double-encoding', r1.layers, 2);
const r2 = global.encDecodeRecursiveValue('url', 'plain text', 10);
eq('encoder recursive: plain text (nothing to decode) reports 0 layers', r2.layers, 0);
eq('encoder recursive: plain text passes through unchanged', r2.result, 'plain text');

// Binary round-trip: bytes survive encode→decode exactly (the reason the file
// path bypasses the text-based unescape/encodeURIComponent trick).
const rawBytes = new Uint8Array([0, 1, 2, 253, 254, 255, 65, 66, 67]);
const b64 = global.encBytesToBase64(rawBytes);
const roundTrip = global.encBase64ToBytes(b64);
ok('encoder binary round-trip: byte-for-byte identical', roundTrip.length === rawBytes.length && rawBytes.every((b, idx) => roundTrip[idx] === b));

// =========================================================================
// TIMESTAMP CONVERTER — epoch-aware parsing, Mendix token preview (10.2)
// =========================================================================
console.log('\nTimestamp Converter');
require('../public/js/tools/timestamp.js');

eq('timestamp parse: 13-digit epoch ms', global.tsParseDate('1716220800000').getTime(), 1716220800000);
eq('timestamp parse: 10-digit epoch s', global.tsParseDate('1716220800').getTime(), 1716220800000);
eq('timestamp parse: ISO 8601 string', global.tsParseDate('2024-05-20T12:00:00Z').getTime(), Date.parse('2024-05-20T12:00:00Z'));
eq('timestamp parse: unparseable input returns null, not a throw', global.tsParseDate('not a date'), null);
eq('timestamp parse: empty input returns null', global.tsParseDate(''), null);

// Data-driven rule: only tokens whose value is unambiguous by construction —
// no EndOf* (Mendix docs don't pin the boundary) and BeginOfCurrentWeek(UTC)
// carries a note rather than being presented as authoritative.
const tokenFixedNow = new Date(2026, 6, 24, 15, 42, 7, 0); // Friday 2026-07-24 15:42:07 local
const tokens = global.tsMendixTokenPreview(tokenFixedNow);
const tokenById = Object.fromEntries(tokens.map(t => [t.token, t]));
eq('mendix tokens: CurrentDateTime is the given instant', tokenById['[%CurrentDateTime%]'].date.getTime(), tokenFixedNow.getTime());
eq('mendix tokens: BeginOfCurrentDay truncates to local midnight', tokenById['[%BeginOfCurrentDay%]'].date.toTimeString().slice(0, 8), '00:00:00');
eq('mendix tokens: BeginOfCurrentHour truncates to the hour', tokenById['[%BeginOfCurrentHour%]'].date.getMinutes(), 0);
eq('mendix tokens: BeginOfCurrentMonth is day 1', tokenById['[%BeginOfCurrentMonth%]'].date.getDate(), 1);
eq('mendix tokens: BeginOfCurrentYear is Jan 1', tokenById['[%BeginOfCurrentYear%]'].date.getMonth(), 0);
eq('mendix tokens: BeginOfCurrentWeek lands on a Monday (ISO-8601)', tokenById['[%BeginOfCurrentWeek%]'].date.getDay(), 1);
ok('mendix tokens: BeginOfCurrentWeek carries a locale caveat, not asserted as authoritative', !!tokenById['[%BeginOfCurrentWeek%]'].note);
ok('mendix tokens: no EndOf* token is fabricated (Mendix docs leave the boundary unspecified)', !tokens.some(t => /EndOf/.test(t.token)));

// =========================================================================
// JAVA REGEX TESTER — Mendix/NL presets, replace preview (10.3)
// =========================================================================
console.log('\nRegex Tester');
require('../public/js/tools/regex.js');

const rxPresets = global.REGEX_PRESETS;
function rxPreset(id) { return rxPresets.find(p => p.id === id); }
ok('regex presets: email accepts a real address', new RegExp(rxPreset('email').pattern).test('dev@mendix.com'));
ok('regex presets: email rejects a bare word', !new RegExp(rxPreset('email').pattern).test('notanemail'));
ok('regex presets: Dutch phone accepts a mobile number', new RegExp(rxPreset('nl-phone').pattern).test('0612345678'));
ok('regex presets: Dutch phone rejects too few digits', !new RegExp(rxPreset('nl-phone').pattern).test('061234'));
ok('regex presets: Dutch BSN accepts 9 digits', new RegExp(rxPreset('nl-bsn').pattern).test('123456789'));
ok('regex presets: Dutch BSN rejects 8 digits', !new RegExp(rxPreset('nl-bsn').pattern).test('12345678'));
ok('regex presets: BSN preset is honest about being format-only, not a checksum', /11-proef/.test(rxPreset('nl-bsn').note));
ok('regex presets: Dutch IBAN accepts NL + 4 letters + 10 digits', new RegExp(rxPreset('nl-iban').pattern).test('NL91ABNA0417164300'));
ok('regex presets: Dutch IBAN rejects a German IBAN', !new RegExp(rxPreset('nl-iban').pattern).test('DE89370400440532013000'));
ok('regex presets: Mendix entity path accepts Module.Entity', new RegExp(rxPreset('mx-entity-path').pattern).test('Sales.Order'));
ok('regex presets: Mendix entity path accepts an association chain', new RegExp(rxPreset('mx-entity-path').pattern).test('Sales.Order_Customer/Sales.Customer'));
ok('regex presets: Mendix entity path rejects a bare word', !new RegExp(rxPreset('mx-entity-path').pattern).test('Order'));

const rxRepl = global.regexReplacePreview;
eq('regex replace: group reference substitution', rxRepl('(\\w+)@(\\w+)', '', 'dev@mendix', '$2:$1').result, 'mendix:dev');
eq('regex replace: empty replacement is skipped (returns null, not an empty result)', rxRepl('a', '', 'abc', ''), null);
ok('regex replace: an invalid pattern reports an error instead of throwing', !!rxRepl('(', '', 'abc', 'x').error);

// =========================================================================
// PASSWORD GENERATOR — strength meter, Mendix Cloud preset charset (10.4)
// =========================================================================
console.log('\nPassword Generator');
require('../public/js/tools/password-generator.js');

eq('pwd entropy: 0 for empty/degenerate input', global.pwdEntropyBits(0, 26), 0);
eq('pwd entropy: length * log2(charset size)', global.pwdEntropyBits(8, 26), 8 * Math.log2(26));
eq('pwd strength label: short/small-charset password is Weak', global.pwdStrengthLabel(20), 'Weak');
eq('pwd strength label: a 20-char full-charset password is Very strong', global.pwdStrengthLabel(global.pwdEntropyBits(20, 95)) , 'Very strong');
ok('pwd crack time: near-zero entropy is near-instant', global.pwdCrackTimeSeconds(1, 1e10) < 1);
eq('pwd duration format: sub-second stays human ("< 1 second")', global.pwdFormatDuration(0.4), '< 1 second');
ok('pwd duration format: a multi-year duration is expressed in years', /years?$/.test(global.pwdFormatDuration(31536000 * 5)));
eq('pwd charset: Mendix Cloud preset (upper+lower+num+spec) is all four sets combined', global.pwdBuildCharset({ up: true, low: true, num: true, spec: true }).length, 26 + 26 + 10 + 29);
eq('pwd charset: no boxes checked yields an empty charset', global.pwdBuildCharset({}), '');

// =========================================================================
// TEXT DIFF — change stats, ignore-whitespace comparison (10.5)
// =========================================================================
console.log('\nText Diff');
require('../public/js/tools/diff.js');

eq('diff normalize: ignoreWs collapses internal runs and trims', global.diffNormalizeLine('  a   b  ', true), 'a b');
eq('diff normalize: ignoreWs off leaves the line untouched', global.diffNormalizeLine('  a   b  ', false), '  a   b  ');

// Data-driven rule: diffStats counts what diffCompare actually classified
// (the 'col' array), not a separate re-derivation that could drift from it.
eq('diff stats: counts added/removed/modified from the aligned column', JSON.stringify(global.diffStats([['equal','x'],['added','y'],['removed','z'],['mod','a','b'],['mod','c','d']])), JSON.stringify({added:1,removed:1,modified:2}));
eq('diff stats: an all-equal diff reports zero changes', JSON.stringify(global.diffStats([['equal','x'],['equal','y']])), JSON.stringify({added:0,removed:0,modified:0}));

// Ignore whitespace: a line differing only by whitespace becomes 'equal'
// instead of a removed+added pair, once compared through the normalized key.
const wsA = ['line one', '  line two  ', 'line three'];
const wsB = ['line one', 'line two', 'line three'];
const withWs = global.computeDiff(wsA, wsB);
const withoutWs = global.computeDiff(wsA, wsB, l => global.diffNormalizeLine(l, true));
ok('diff ignore-ws off: a whitespace-only difference shows as a real change', withWs.some(d => d[0] === 'added' || d[0] === 'removed'));
ok('diff ignore-ws on: a whitespace-only difference is treated as equal', withoutWs.every(d => d[0] === 'equal'));

// =========================================================================
// HTTP STATUS CODES — search (already existed), "In Mendix" column (10.6)
// =========================================================================
console.log('\nHTTP Status Codes');
require('../public/js/tools/http-codes.js');

const httpCodes = global.HTTP_CODES;
eq('http codes: 22 codes total (unchanged by the 10.6 content pass)', httpCodes.length, 22);
ok('http codes: every code has a non-empty "In Mendix" note', httpCodes.every(c => c.mendix && c.mendix.trim().length > 0));
ok('http codes: the Mendix note is distinct from the generic description (no duplication)', httpCodes.every(c => c.mendix !== c.desc));
ok('http search: matches by code number', global.httpMatchesSearch(httpCodes.find(c => c.code === 404), '404'));
ok('http search: matches by name', global.httpMatchesSearch(httpCodes.find(c => c.code === 404), 'not found'));
ok('http search: matches Mendix-specific content too (not just the generic desc)', global.httpMatchesSearch(httpCodes.find(c => c.code === 403), 'microflow'));
ok('http search: a non-matching query excludes the code', !global.httpMatchesSearch(httpCodes.find(c => c.code === 404), 'gateway timeout'));

// =========================================================================
// API ECONOMICS — real GZIP measurement, $select hint, compare mode (10.7)
// =========================================================================
console.log('\nAPI Economics');
require('../public/js/tools/api-economics.js');

const econPayload = { id: 1, name: 'Order 1', notes: null, tags: [], meta: {}, customer: { id: 2, name: 'Order 1', middleName: null } };
const econTrav = global.apiEconTraverse(econPayload);
eq('api-econ traverse: counts every key occurrence, including nested', econTrav.fieldCounts.name, 2);
eq('api-econ traverse: id is counted at both the top level and inside the nested customer', econTrav.fieldCounts.id, 2);
const econAlwaysEmpty = global.apiEconAlwaysEmptyFields(econTrav.fieldCounts, econTrav.fieldEmptyCounts);
eq('api-econ $select hint: fields empty in every occurrence are flagged', econAlwaysEmpty.join(','), 'meta,middleName,notes,tags');
ok('api-econ $select hint: a field with even one real value is not flagged (name has data)', !econAlwaysEmpty.includes('name'));

async function runApiEconAsyncTests() {
  // Data-driven rule: the size is a real CompressionStream measurement, not
  // the old hardcoded 35% guess — must actually shrink well-compressible JSON.
  const repetitive = JSON.stringify({ items: Array.from({ length: 50 }, () => ({ id: 1, status: 'ACTIVE' })) });
  const gz = await global.apiEconGzipSize(repetitive);
  ok('api-econ gzip: CompressionStream is available in this Node runtime for the test', gz !== null);
  ok('api-econ gzip: a real measurement, smaller than the uncompressed input', gz > 0 && gz < new Blob([repetitive]).size);

  const resultA = await global.apiEconAnalyzePayload(JSON.stringify({ a: 1, b: 2 }));
  const resultB = await global.apiEconAnalyzePayload(JSON.stringify({ a: 1 }));
  ok('api-econ analyze: parses valid JSON and measures all three sizes', resultA.error === null && resultA.minifiedSize > 0 && resultA.gzipSize > 0);
  const invalid = await global.apiEconAnalyzePayload('{not json');
  ok('api-econ analyze: invalid JSON reports an error instead of throwing', !!invalid.error);
  const cmp = global.apiEconCompareSummary(resultA, resultB);
  ok('api-econ compare: payload B (fewer fields) is smaller than A', cmp.minifiedDelta < 0);
}

// =========================================================================
// PERFORMANCE LAB — theme-aware chart colors (10.8, section-A bug fix)
// =========================================================================
console.log('\nPerformance Lab');
require('../public/js/tools/perf-lab.js');

// perf-lab.js reads document.documentElement at call time (not at require
// time), so a minimal stand-in for the theme attribute is enough here —
// restored immediately after so it can't leak into any other section.
const realDocument = global.document;
global.document = { documentElement: { getAttribute: () => 'dark' } };
const darkColors = global.plGetChartColors();
global.document.documentElement.getAttribute = () => 'light';
const lightColors = global.plGetChartColors();
global.document = realDocument;

ok('perf-lab colors: dark and light themes produce different grid colors (bug: was a hardcoded #333 for both)', darkColors.gridColor !== lightColors.gridColor);
ok('perf-lab colors: dark and light themes produce different title colors (bug: was a hardcoded #fff for both, invisible on light)', darkColors.titleColor !== lightColors.titleColor);
eq('perf-lab colors: light-theme title is dark text (readable on a light background)', lightColors.titleColor, '#1a1a1a');
eq('perf-lab colors: dark-theme title is light text (readable on a dark background)', darkColors.titleColor, '#ffffff');

// =========================================================================
// JSON FORMATTER — path breadcrumb + Find in JSON (11.1)
// =========================================================================
console.log('\nJSON Formatter');
require('../public/js/tools/json.js');

eq('json path: bare identifier key uses dot form', global.jsonPathSegment('$.orders[0]', 'customer'), '$.orders[0].customer');
eq('json path: non-identifier key falls back to bracket form', global.jsonPathSegment('$', 'first name'), '$["first name"]');
eq('json path: a quote in the key is escaped', global.jsonPathSegment('$', 'a"b'), '$["a\\"b"]');

const jsonSample = { orders: [ { id: 1, customer: { name: 'Jane Doe', email: 'jane@example.com' } }, { id: 2, customer: { name: 'Bob' } } ], count: 2 };
ok('json find: matches a nested string value and reports its full path', global.jsonFindMatches(jsonSample, 'jane').includes('$.orders[0].customer.name'));
ok('json find: matches a key name too, not just values', global.jsonFindMatches(jsonSample, 'email').includes('$.orders[0].customer.email'));
ok('json find: matches a number leaf by its string form', global.jsonFindMatches(jsonSample, '2').some(function (p) { return p === '$.count' || p === '$.orders[1].id'; }));
eq('json find: case-insensitive', global.jsonFindMatches(jsonSample, 'JANE').length, global.jsonFindMatches(jsonSample, 'jane').length);
eq('json find: empty query matches nothing', global.jsonFindMatches(jsonSample, '').length, 0);
eq('json find: no match returns an empty array, not a thrown error', global.jsonFindMatches(jsonSample, 'zzzznotfound').length, 0);

// =========================================================================
// XML FORMATTER — namespace-prefix display toggle (11.2)
// =========================================================================
console.log('\nXML Formatter');
require('../public/js/tools/xml.js');

eq('xml ns display: shown as-is by default', global.xmlDisplayName('soap:Envelope'), 'soap:Envelope');
eq('xml ns display: prefix stripped when hidden', global.xmlDisplayName('soap:Envelope', true), 'Envelope');
eq('xml ns display: name without a prefix is unaffected', global.xmlDisplayName('Envelope', true), 'Envelope');
eq('xml ns display: explicit hide=false shows the prefix even if the module default were flipped', global.xmlDisplayName('soap:Envelope', false), 'soap:Envelope');
// (Native document.evaluate()/DOMParser XPath behavior is browser-only — verified via Puppeteer, not here.)

// =========================================================================
// CHARACTER SANITIZER — "Clean" change summary + "Why this matters" (11.3)
// =========================================================================
console.log('\nCharacter Sanitizer');
require('../public/js/tools/char-sanitizer.js');

eq('sanitizer summary: zero changes says so explicitly, not silence', global.csFormatCleanSummary({ mojibake: 0, invisibleControl: 0, xml: 0, nbsp: 0 }), 'No changes — nothing to clean for the selected options.');
eq('sanitizer summary: singular wording for a count of 1', global.csFormatCleanSummary({ mojibake: 1, invisibleControl: 0, xml: 0, nbsp: 0 }), '1 character changed: 1 mojibake character repaired.');
ok('sanitizer summary: plural wording for counts > 1', /2 mojibake characters repaired/.test(global.csFormatCleanSummary({ mojibake: 2, invisibleControl: 0, xml: 0, nbsp: 0 })));
const csMultiSummary = global.csFormatCleanSummary({ mojibake: 1, invisibleControl: 2, xml: 3, nbsp: 4 });
ok('sanitizer summary: multiple categories are all listed', /10 characters changed/.test(csMultiSummary) && /mojibake/.test(csMultiSummary) && /hidden\/control/.test(csMultiSummary) && /invalid XML/.test(csMultiSummary) && /NBSP/.test(csMultiSummary), csMultiSummary);

// Every category the analyzer can actually emit has a "why this matters" tooltip —
// otherwise the Statistics table silently drops the explanation for that row.
const csCategoriesEmitted = ['invisible', 'control', 'xml-invalid', 'mojibake', 'non-ascii'];
csCategoriesEmitted.forEach(function (c) {
  ok('sanitizer why-matters: "' + c + '" has a non-empty tooltip', typeof global.CS_WHY_MATTERS[c] === 'string' && global.CS_WHY_MATTERS[c].length > 20);
});

// =========================================================================
// MARKDOWN — Mendix snippet library (11.5; "Copy as HTML" already existed)
// =========================================================================
console.log('\nMarkdown');
require('../public/js/tools/markdown.js');

['entity', 'microflow', 'release-notes'].forEach(function (key) {
  ok('markdown snippet: "' + key + '" is registered with non-empty markdown', typeof global.MD_SNIPPETS[key] === 'object' && global.MD_SNIPPETS[key].md.length > 10);
});
eq('markdown snippet insert: empty editor gets no leading blank line', global.mdSnippetInsertText('', '## X\n'), '## X\n');
eq('markdown snippet insert: caret right after a blank line gets no extra blank line', global.mdSnippetInsertText('Some text\n\n', '## X\n'), '## X\n');
eq('markdown snippet insert: caret at end of a single newline gets one more, not two', global.mdSnippetInsertText('Some text\n', '## X\n'), '\n## X\n');
eq('markdown snippet insert: caret mid-paragraph gets a full blank-line separator', global.mdSnippetInsertText('Some text', '## X\n'), '\n\n## X\n');

// =========================================================================
// HAR ANALYZER — waterfall grouping, duplicate-call detection, body decoding (12.1)
// =========================================================================
console.log('\nHAR Analyzer');
require('../public/js/tools/har-analyzer.js');

// harDetectDuplicates: back-to-back identical calls, not just "same group somewhere".
const harNoDups = [
  { action: 'ExecuteAction', detail: 'A', time: 10, startMs: 0 },
  { action: 'ExecuteAction', detail: 'B', time: 10, startMs: 10 },
  { action: 'ExecuteAction', detail: 'A', time: 10, startMs: 20 }
];
eq('duplicate detection: non-adjacent repeats are not flagged', global.harDetectDuplicates(harNoDups).length, 0);

const harWithDups = [
  { action: 'RetrieveByXPath', detail: 'X', time: 15, startMs: 0 },
  { action: 'RetrieveByXPath', detail: 'X', time: 12, startMs: 20 },
  { action: 'RetrieveByXPath', detail: 'X', time: 11, startMs: 45 },
  { action: 'ExecuteAction', detail: 'Y', time: 5, startMs: 60 }
];
const harDups = global.harDetectDuplicates(harWithDups);
eq('duplicate detection: finds one run of 3', harDups.length, 1);
eq('duplicate detection: run count is 3', harDups[0].count, 3);
eq('duplicate detection: span is last.startMs - first.startMs', harDups[0].spanMs, 45);
eq('duplicate detection: wasted time excludes the first call', harDups[0].wastedMs, 23);
eq('duplicate detection: single call never counts as a run', global.harDetectDuplicates([harWithDups[3]]).length, 0);

// harClassify: three Mendix protocols count. Recognising only /xas/ made the tool
// blind to published REST/OData — a HAR from a Mendix 9/10 app serving a React or
// native client rendered "no calls found" while the traffic sat right there.
const harReq = (url, method, body) => ({
  request: { url: url, method: method || 'GET', postData: body ? { text: body } : undefined }
});
const harCls = global.harClassify;

eq('classify: a static asset is still not a Mendix call',
  harCls(harReq('https://app.mendixcloud.com/css/main.css')), null);
const harXas = harCls(harReq('https://app.mendixcloud.com/xas/', 'POST',
  '{"action":"retrieve_by_xpath","params":{"xpath":"//Sales.Order"}}'));
eq('classify: XAS body decoding is unchanged', harXas.action, 'retrieve_by_xpath');
eq('classify: an XAS retrieve is marked as a read', harXas.read, true);

const harRest = harCls(harReq('https://app.mendixcloud.com/rest/orders/v1/orders/42'));
eq('classify: published REST is recognised', harRest.action, 'REST GET');
eq('classify: REST path ids collapse so repeats group together', harRest.detail, '/rest/orders/v1/orders/{id}');
eq('classify: a REST GET counts as a read', harRest.read, true);
eq('classify: a REST POST is not a read',
  harCls(harReq('https://app.mendixcloud.com/rest/orders/v1/orders', 'POST')).read, false);

const harOdata = harCls(harReq("https://app.mendixcloud.com/odata/sales/v1/Orders(guid'8f14e45f')"));
eq('classify: published OData is recognised', harOdata.action, 'OData GET');
eq('classify: OData key predicates collapse to one group', harOdata.detail, '/odata/sales/v1/Orders({id})');

// GUID path segments collapse too — Mendix hands out GUID ids far more often than
// integers, so missing these would leave every call in its own group of one.
eq('classify: GUID path segments collapse',
  global.harApiTemplate('/rest/x/v1/item/3f2504e0-4f89-11d3-9a0c-0305e82c3301'), '/rest/x/v1/item/{id}');
eq('classify: non-id segments are left alone',
  global.harApiTemplate('/rest/orders/v1/orders'), '/rest/orders/v1/orders');

// harGroupByPage: buckets by pageref, preserving first-appearance order; falls back
// to a single unlabeled group (title=null) when the HAR has no `pages` array.
const harPageItems = [
  { action: 'a', detail: '', pageref: 'page_1' },
  { action: 'b', detail: '', pageref: 'page_2' },
  { action: 'c', detail: '', pageref: 'page_1' }
];
const harPages = [{ id: 'page_1', title: 'Home' }, { id: 'page_2', title: 'Detail' }];
const harGrouped = global.harGroupByPage(harPageItems, harPages);
eq('page grouping: two pages, first-appearance order', harGrouped.map(function (g) { return g.pageId; }).join(','), 'page_1,page_2');
eq('page grouping: titles resolved from har.log.pages', harGrouped[0].title, 'Home');
eq('page grouping: items stay in original chronological order within a page', harGrouped[0].items.map(function (x) { return x.action; }).join(','), 'a,c');
const harUngrouped = global.harGroupByPage([{ action: 'a', detail: '' }], []);
eq('page grouping: no pages array → single group with null title', harUngrouped.length, 1);
eq('page grouping: no pages array → title is null, not a guess', harUngrouped[0].title, null);

// harContentText: base64-encoded response content decodes to real UTF-8 bytes
// (not the escape/unescape textual trick, which mangles multi-byte characters).
eq('content decode: plain text passes through', global.harContentText({ text: 'hello' }), 'hello');
eq('content decode: empty content is empty string', global.harContentText(null), '');
const harUtf8Sample = '{"city":"Zürich"}';
const harB64 = Buffer.from(harUtf8Sample, 'utf-8').toString('base64');
eq('content decode: base64-encoded UTF-8 (incl. multi-byte char) decodes correctly', global.harContentText({ text: harB64, encoding: 'base64' }), harUtf8Sample);

// harBarColor: pure classification used to color the waterfall bars.
eq('bar color: retrieve → info', global.harBarColor('RetrieveByXPath'), 'var(--info)');
eq('bar color: execute → accent', global.harBarColor('ExecuteAction'), 'var(--accent)');
eq('bar color: commit → success', global.harBarColor('CommitObjects'), 'var(--success)');
eq('bar color: unknown action → muted, not a guess', global.harBarColor('xas'), 'var(--text-muted)');

// =========================================================================
// DOMAIN MODEL & ARCHITECTURE — module dependency graph (12.2)
// =========================================================================
console.log('\nDomain Model & Architecture — module dependency graph');
require('../public/js/tools/architecture.js');

eq('module of: qualified name', global.archModuleOf('eShop.Customer'), 'eShop');
eq('module of: unqualified name → (none)', global.archModuleOf('Customer'), '(none)');
eq('mermaid id: sanitizes non-alnum', global.archMermaidId('My Module!'), 'm_My_Module_');

const archModel = {
  modules: [{ name: 'eShop', entityCount: 3 }, { name: 'System', entityCount: 10 }, { name: 'Admin', entityCount: 2 }],
  associations: [
    { one: 'eShop.Customer', many: 'eShop.Order' },
    { one: 'eShop.Customer', many: 'System.User' },
    { one: 'eShop.Customer', many: 'System.User' },
    { one: 'Admin.Role', many: 'System.User' }
  ]
};
const archGraph = global.archBuildModuleGraph(archModel);
eq('module graph: one node per module', archGraph.nodes.length, 3);
eq('module graph: same-module association produces no edge', archGraph.edges.filter(function (e) { return e.a === e.b; }).length, 0);
eq('module graph: two distinct cross-module edges', archGraph.edges.length, 2);
const archEdgeES = archGraph.edges.find(function (e) { return (e.a === 'System' && e.b === 'eShop') || (e.a === 'eShop' && e.b === 'System'); });
ok('module graph: repeated cross-module association is counted, not deduped to 1', !!archEdgeES && archEdgeES.count === 2);

const archCode = global.archModuleGraphToMermaid(archGraph);
ok('module mermaid: starts with graph LR', archCode.indexOf('graph LR') === 0);
ok('module mermaid: node label includes entity count', /eShop \(3\)/.test(archCode));
ok('module mermaid: edge label includes cross-module count', /---\|"2"\|/.test(archCode));
ok('module mermaid: empty model shows an explicit placeholder, not a blank diagram', /No modules loaded/.test(global.archModuleGraphToMermaid({ nodes: [], edges: [] })));

// =========================================================================
// QUERY INTELLIGENCE — OQL association-join → SQL JOIN translation (12.3)
// =========================================================================
console.log('\nQuery Intelligence — OQL association joins');
require('../public/js/tools/query-intelligence.js');

const qiJoinOql = 'SELECT c.Name, o.Amount FROM eShop.Customer c INNER JOIN c/eShop.Customer_Order/eShop.Order o WHERE o.Amount > 100';
const qiJoinSql = global.oqlTranslateAssociationJoins(qiJoinOql);
ok('association join: rewrites to a real JOIN keyword', /INNER JOIN eshop\$order o/.test(qiJoinSql));
ok('association join: ON clause references the parent alias id', /ON c\.id = o\./.test(qiJoinSql));
ok('association join: FK column guess is flagged with a verification comment, not presented as fact', /verify the FK column/.test(qiJoinSql));
ok('association join: association name appears in the comment for the reader to check', /Customer_Order/.test(qiJoinSql));
eq('association join: FROM clause (no JOIN keyword) is left untouched by this step', global.oqlTranslateAssociationJoins('FROM eShop.Customer c'), 'FROM eShop.Customer c');

const qiLeftJoin = global.oqlTranslateAssociationJoins('LEFT JOIN c/eShop.Customer_Order/eShop.Order o');
ok('association join: LEFT JOIN keyword preserved', /^LEFT JOIN eshop\$order o ON/.test(qiLeftJoin));

const qiNoAlias = global.oqlTranslateAssociationJoins('JOIN c/eShop.Customer_Order/eShop.Order');
ok('association join: missing target alias falls back to a derived one, not a blank', /ON c\.id = eshop_order\./.test(qiNoAlias));

['duplicates', 'countByAssociation', 'dateRangeFilter'].forEach(function (key) {
  const p = global.OQL_PATTERNS[key];
  ok('OQL pattern "' + key + '" is registered with non-empty OQL and a label', !!p && typeof p.oql === 'string' && p.oql.length > 10 && typeof p.label === 'string');
});
ok('OQL pattern "dateRangeFilter" uses only verified Mendix tokens (no invented EndOf*/BeginOfNext*)', !/EndOf|BeginOfNext/.test(global.OQL_PATTERNS.dateRangeFilter.oql));

// =========================================================================
// XPATH FORMATTER — XPath → OQL conversion (12.4)
// =========================================================================
console.log('\nXPath → OQL conversion');
require('../public/js/tools/xpath.js');

const xoSimple = global.xpathToOql("[Status = 'Active']");
eq('xpath→oql: bare constraint gets an honest entity placeholder', xoSimple.oql.indexOf('FROM <Module.Entity> e') !== -1, true);
ok('xpath→oql: bare constraint notes the missing root entity', xoSimple.notes.some(function (n) { return /No root entity/.test(n); }));
ok('xpath→oql: simple comparison translated to alias.Attr', /e\.Status = 'Active'/.test(xoSimple.oql));

const xoRoot = global.xpathToOql("//eShop.Customer[Status = 'Active']");
eq('xpath→oql: root entity recognized when the //Module.Entity prefix is present', xoRoot.notes.length, 0);
ok('xpath→oql: FROM clause uses the real entity', /FROM eShop\.Customer e/.test(xoRoot.oql));
ok('xpath→oql: WHERE clause is correct', /WHERE e\.Status = 'Active'/.test(xoRoot.oql));

const xoAndOr = global.xpathToOql("//eShop.Customer[Status = 'Active' and Age > 18]");
ok('xpath→oql: AND preserved between two conditions', /e\.Status = 'Active' AND e\.Age > 18/.test(xoAndOr.oql));

const xoContains = global.xpathToOql("//eShop.Customer[contains(Name, 'Corp')]");
ok('xpath→oql: contains() becomes a LIKE wildcard on both sides', /e\.Name LIKE '%Corp%'/.test(xoContains.oql));

const xoStartsWith = global.xpathToOql("//eShop.Customer[starts-with(Name, 'Acme')]");
ok('xpath→oql: starts-with() becomes a trailing-wildcard LIKE', /e\.Name LIKE 'Acme%'/.test(xoStartsWith.oql));

const xoHop = global.xpathToOql("//eShop.Customer[Orders/Amount > 100]");
ok('xpath→oql: association hop is flagged, not guessed', xoHop.notes.some(function (n) { return /association hop not translated/.test(n); }));
ok('xpath→oql: untranslated condition fails loudly instead of silently widening the query', /UNTRANSLATED/.test(xoHop.oql) && /#FIX_ME#/.test(xoHop.oql));

const xoNot = global.xpathToOql("//eShop.Customer[not(Status = 'Blocked')]");
ok('xpath→oql: not(...) is flagged, not guessed', xoNot.notes.some(function (n) { return /not\(\.\.\.\) condition/.test(n); }));

eq('xpath→oql: empty input produces empty output, not a placeholder query', global.xpathToOql('').oql, '');

const xoSlashInString = global.xpathToOql("//eShop.Customer[WebsiteUrl = 'https://example.com/path']");
eq('xpath→oql: a slash inside a string literal is never mistaken for an association hop', xoSlashInString.notes.length, 0);
ok('xpath→oql: the URL value survives untouched', /e\.WebsiteUrl = 'https:\/\/example\.com\/path'/.test(xoSlashInString.oql));

// =========================================================================
// ODATA BUILDER — filter builder, expand paths, URL history (12.5)
// =========================================================================
console.log('\nOData Builder');
require('../public/js/tools/odata.js');

eq('filter value: number stays unquoted', global.odataFormatFilterValue('42'), '42');
eq('filter value: decimal stays unquoted', global.odataFormatFilterValue('3.14'), '3.14');
eq('filter value: boolean stays unquoted and lowercased', global.odataFormatFilterValue('TRUE'), 'true');
eq('filter value: string gets single-quoted', global.odataFormatFilterValue('Alice'), "'Alice'");
eq('filter value: embedded quote is doubled (OData string escape)', global.odataFormatFilterValue("O'Brien"), "'O''Brien'");

const odFilterRows = [
  { attr: 'Name', op: 'eq', value: 'Alice' },
  { attr: 'Age', op: 'gt', value: '18' },
  { attr: 'Email', op: 'contains', value: 'corp.com' },
  { attr: '', op: 'eq', value: 'ignored — no attribute' },
  { attr: 'Ignored', op: 'eq', value: '' }
];
eq('filter builder: comparisons + function form, incomplete rows dropped',
  global.odataBuildFilterExpr(odFilterRows),
  "Name eq 'Alice' and Age gt 18 and contains(Email,'corp.com')");
eq('filter builder: empty row list yields empty string, not "and"', global.odataBuildFilterExpr([]), '');

const odUrl = global.odataBuildUrl({ base: 'https://app.example.com/odata/Svc/v1', entity: 'Customers', filter: "Name eq 'Alice'", select: '', expand: '', orderby: '', top: '10', skip: '', count: '', format: '' });
eq('build URL: entity + $filter + $top, value URL-encoded', odUrl, "https://app.example.com/odata/Svc/v1/Customers?$filter=Name%20eq%20'Alice'&$top=10");

const odParsed = global.odataParseUrl(odUrl);
eq('parse URL: base recovered', odParsed.base, 'https://app.example.com/odata/Svc/v1');
eq('parse URL: entity recovered', odParsed.entity, 'Customers');
eq('parse URL: $filter recovered and decoded', odParsed.filter, "Name eq 'Alice'");
eq('parse URL: $top recovered', odParsed.top, '10');
eq('parse URL round-trips through build again', global.odataBuildUrl(Object.assign({ format: '', count: '' }, odParsed)), odUrl);

const odNoParams = global.odataBuildUrl({ base: 'https://app.example.com/odata/Svc/v1', entity: '', filter: '', select: '', expand: '', orderby: '', top: '', skip: '', count: '', format: '' });
eq('build URL: no entity/params falls back to base URL only', odNoParams, 'https://app.example.com/odata/Svc/v1');

// =========================================================================
// SAML / OIDC DEBUGGER — X.509 certificate parsing + clock-skew hint (12.6)
// =========================================================================
console.log('\nSAML Debugger — X.509 + clock skew');
require('../public/js/tools/saml-debugger.js');

// Synthetic self-signed cert (openssl req -x509 -newkey rsa:2048 -days 365
// -subj "/C=NL/O=MxDevTest/CN=idp.example.com"), not a real IdP — generated
// purely to give the DER walker a real ASN.1 structure to parse. Verified
// against `openssl x509 -noout -subject -issuer -dates` before pasting here.
const samlTestCertB64 = 'MIIDVzCCAj+gAwIBAgIUJGgIt6rFQnUHq9WXkw1P+PnnhHkwDQYJKoZIhvcNAQELBQAwOzELMAkGA1UEBhMCTkwxEjAQBgNVBAoMCU14RGV2VGVzdDEYMBYGA1UEAwwPaWRwLmV4YW1wbGUuY29tMB4XDTI2MDcyNDIxMTg1M1oXDTI3MDcyNDIxMTg1M1owOzELMAkGA1UEBhMCTkwxEjAQBgNVBAoMCU14RGV2VGVzdDEYMBYGA1UEAwwPaWRwLmV4YW1wbGUuY29tMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsunyxgFuPobeDljc1v6C0SAzno6AFp8G2L6HGAyU2UmOFozSgrPfgkKk/C9S/Gkn8/o8ezzJIuI0265dlcckuFXj21YPuJD1xy8L3mGr9OfZUrQGcL28bI4uRKle99HoHJU2BPEl/SrMXAlRfB93c/G/W+f4WDipeHwEuszBKYycxJWe6R87c1SLQX5Y5F7c++3tfzdmThqTsXyvoBy6dur3Suo/HpdgjhGGx2EE2N+m64jPoRea9zR5k65w9sO9LcAOUa7cgTipIpKBFzuX47nfYnPRAh5XiyWeSG0DF2hDU48L8QPsQBLtNgjonSKD4/jpUtCSrGc07gy+a7xy3QIDAQABo1MwUTAdBgNVHQ4EFgQUHx/Y3rXDWZZEbsJBrCGi74OdHU0wHwYDVR0jBBgwFoAUHx/Y3rXDWZZEbsJBrCGi74OdHU0wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAN3tFl3ILd9FZSiGiNKWZ4fVQHHmPskSb3FWNM2x+6xGkK26FshtsVr+5M28CreljptXsZHSzr1kRBWkJNarjwEZZ7vE9MyEJ4uLMdQdKHpV2L0Tp5nVNTQDMNYPrbTbGysDWTpBRVqx4HIqbiuj9OXMjB9/iOz9HEM2fkM6NQ3To1Wc3aKcVfSuw8t1Q04/oQxTtsnA4Wu04ykOo27RdIbvOkM2WGmiXqnFdSdsQ+UZ57AJ1hbYWWfAE0RBhq502PfdZXJdrn/K5+waJNZ7Bk8zSe7wa2qewP7pLc5oj6xUCKEQNyWsTpFcd0TC92z1c3h8q8N4ZxqUIpbhrr1FHFA==';

const samlCert = global.x509ParseCertificate(samlTestCertB64);
eq('x509: Issuer matches `openssl x509 -noout -issuer`', samlCert.issuer, 'C=NL, O=MxDevTest, CN=idp.example.com');
eq('x509: Subject matches `openssl x509 -noout -subject`', samlCert.subject, 'C=NL, O=MxDevTest, CN=idp.example.com');
eq('x509: notBefore matches openssl (2026-07-24 21:18:53 UTC)', samlCert.notBefore.toISOString(), '2026-07-24T21:18:53.000Z');
eq('x509: notAfter matches openssl (2027-07-24 21:18:53 UTC, 365 days later)', samlCert.notAfter.toISOString(), '2027-07-24T21:18:53.000Z');
eq('x509: not expired (notAfter is in 2027)', samlCert.isExpired, false);

eq('x509: empty input is not an error, just nothing to show', global.x509ParseCertificate(''), null);
ok('x509: garbage Base64-looking input reports a parse error, not a crash', !!global.x509ParseCertificate('AAAA').error);
ok('x509: invalid Base64 reports an error', !!global.x509ParseCertificate('not-base64!!!').error);

// A validity field whose bytes are not a real date must decode to null, not to an
// Invalid Date that throws when the renderer calls toISOString() on it.
const samlBadTimeBytes = new Uint8Array(Array.from('ZZ0101000000Z').map(function (c) { return c.charCodeAt(0); }));
eq('x509: an unparseable UTCTime decodes to null, not a throwing Invalid Date',
  global.x509DecodeTime(samlBadTimeBytes, { tag: 0x17, valueStart: 0, valueEnd: samlBadTimeBytes.length }), null);

eq('clock skew: NotBefore in the past → no warning', global.samlClockSkewMinutes('2020-01-01T00:00:00Z', Date.now()), null);
eq('clock skew: no NotBefore → no warning', global.samlClockSkewMinutes(null, Date.now()), null);
eq('clock skew: NotBefore 5 minutes in the future → 5', global.samlClockSkewMinutes(new Date(Date.now() + 5 * 60000).toISOString(), Date.now()), 5);
eq('clock skew: unparseable NotBefore → no warning, not NaN', global.samlClockSkewMinutes('not-a-date', Date.now()), null);

// =========================================================================
// MEMORY INSPECTOR — GC log format auto-detection (12.7)
// =========================================================================
console.log('\nMemory Inspector — GC log parsing');
require('../public/js/tools/memory-inspector.js');

const miUnifiedLog = [
  '[2026-07-24T10:15:23.456+0200][123.456s][info][gc] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 512M->128M(2048M) 12.345ms',
  '[2026-07-24T10:16:23.456+0200][183.456s][info][gc] GC(1) Pause Young (Normal) (G1 Evacuation Pause) 600M->150M(2048M) 15.000ms',
  '[2026-07-24T10:20:23.456+0200][423.456s][info][gc] GC(2) Pause Full (System.gc()) 1024M->256M(2048M) 45.678ms'
].join('\n');
const miVerboseLog = [
  '2026-07-24T10:15:23.456+0200: 123.456: [GC (Allocation Failure) [PSYoungGen: 524288K->65536K(611328K)] 1048576K->602112K(2097152K), 0.0234567 secs] [Times: user=0.05 sys=0.01, real=0.02 secs]',
  '2026-07-24T10:15:25.789+0200: 125.789: [Full GC (Ergonomics) [PSYoungGen: 65536K->0K(611328K)] [ParOldGen: 536576K->450000K(1398272K)] 602112K->450000K(2009600K), 0.1234567 secs]'
].join('\n');

eq('GC format: unified (-Xlog:gc) detected', global.miDetectGcFormat(miUnifiedLog), 'unified');
eq('GC format: classic (-verbose:gc) detected', global.miDetectGcFormat(miVerboseLog), 'verbose');
eq('GC format: a jmap histogram is not mistaken for a GC log', global.miDetectGcFormat('   1:       12450      152043000  com.mendix.core.objectmanagement.MendixObjectImpl'), null);

const miUnifiedParsed = global.miParseGcLog(miUnifiedLog);
eq('unified parse: all 3 GC(N) lines parsed (regression: G1 annotation text contains a digit)', miUnifiedParsed.events.length, 3);
eq('unified parse: units normalized to KB (512M -> 524288K)', miUnifiedParsed.events[0].beforeKb, 524288);
eq('unified parse: 3rd event is the Full GC', miUnifiedParsed.events[2].type, 'Full');

const miVerboseParsed = global.miParseGcLog(miVerboseLog);
eq('verbose parse: both lines parsed', miVerboseParsed.events.length, 2);
eq('verbose parse: overall total taken (last K->K(K) triple), not the nested PSYoungGen one', miVerboseParsed.events[0].beforeKb, 1048576);
eq('verbose parse: Full GC line classified as Full', miVerboseParsed.events[1].type, 'Full');
eq('verbose parse: seconds converted to ms', miVerboseParsed.events[0].durationMs, 23.4567);

const miGcSummary = global.miSummarizeGc(miUnifiedParsed.events);
eq('GC summary: 2 Young events counted', miGcSummary.Young.count, 2);
eq('GC summary: max duration is the larger of the two Young pauses', miGcSummary.Young.maxMs, 15);

// =========================================================================
// JVM HEALTH — thread dump comparison + group-by-lock (12.7)
// =========================================================================
console.log('\nJVM Health — thread dump comparison + group-by-lock');
require('../public/js/tools/jvm-health.js');

const jvmDumpBefore = [
  '"pool-1-thread-1" #10 prio=5',
  '   java.lang.Thread.State: RUNNABLE',
  '        at com.mendix.core.Work.run(Work.java:1)',
  '',
  '"pool-1-thread-2" #11 prio=5',
  '   java.lang.Thread.State: BLOCKED (on object monitor)',
  '        at com.mendix.core.Lock.acquire(Lock.java:1)',
  '        - waiting to lock <0x1> (a java.lang.Object)',
  '',
  '"pool-1-thread-3" #12 prio=5',
  '   java.lang.Thread.State: BLOCKED (on object monitor)',
  '        - waiting to lock <0x1> (a java.lang.Object)'
].join('\n');
const jvmDumpAfter = [
  '"pool-1-thread-1" #10 prio=5',
  '   java.lang.Thread.State: BLOCKED (on object monitor)',
  '        - waiting to lock <0x1> (a java.lang.Object)',
  '',
  '"pool-1-thread-2" #11 prio=5',
  '   java.lang.Thread.State: RUNNABLE',
  '        at com.mendix.core.Work.run(Work.java:2)',
  '',
  '"pool-1-thread-4" #13 prio=5',
  '   java.lang.Thread.State: RUNNABLE',
  '        at com.mendix.core.Work.run(Work.java:3)'
].join('\n');

const jvmParsedBefore = global.jvmParseThreadDump(jvmDumpBefore);
eq('thread dump parse: 3 threads found', jvmParsedBefore.all.length, 3);
eq('thread dump parse: 2 blocked', jvmParsedBefore.blocked.length, 2);

const jvmLockGroups = global.jvmGroupByLock(jvmParsedBefore.blocked);
eq('group by lock: one lock group (both blocked threads wait on <0x1>)', jvmLockGroups.length, 1);
eq('group by lock: 2 waiters on that lock', jvmLockGroups[0].waiters.length, 2);
ok('group by lock: waiter names extracted without quotes', jvmLockGroups[0].waiters.indexOf('pool-1-thread-2') !== -1);

const jvmChanges = global.jvmCompareDumps(jvmDumpBefore, jvmDumpAfter);
const jvmChangeByName = {};
jvmChanges.forEach(function (c) { jvmChangeByName[c.name] = c; });
eq('dump compare: thread-1 changed RUNNABLE -> BLOCKED', jvmChangeByName['pool-1-thread-1'].from + '->' + jvmChangeByName['pool-1-thread-1'].to, 'java.lang.Thread.State: RUNNABLE->java.lang.Thread.State: BLOCKED (on object monitor)');
eq('dump compare: thread-3 is gone in the second dump', jvmChangeByName['pool-1-thread-3'].to, '(thread gone)');
eq('dump compare: thread-4 is new in the second dump', jvmChangeByName['pool-1-thread-4'].from, '(new thread)');
eq('dump compare: exactly 4 threads changed (1 flipped, 2 flipped, 3 gone, 4 new — total distinct)', jvmChanges.length, 4);

// =========================================================================
// NGINX LOG ANALYZER — unique IPs per endpoint + Worker-based streaming parse (12.8)
// =========================================================================
console.log('\nNginx Log Analyzer');
global.addEventListener = function () {}; // nginx.js registers a popstate handler at module load
require('../public/js/tools/nginx.js');

const nginxSampleRecords = [
  { url: '/api/orders', ip: '203.0.113.5' },
  { url: '/api/orders', ip: '198.51.100.9' },
  { url: '/api/orders', ip: '203.0.113.5' }, // repeat — not double-counted
  { url: '/api/customers', ip: '203.0.113.5' }
];
eq('unique IPs per URL: two different IPs on the same URL count as 2', JSON.stringify(global.nginxUniqueIpsPerUrl(nginxSampleRecords)), '{"/api/orders":2,"/api/customers":1}');
eq('unique IPs per URL: empty record list yields an empty object', JSON.stringify(global.nginxUniqueIpsPerUrl([])), '{}');

eq('hour derivation: nginx access-log timestamp format', global.nginxDeriveHourStr('24/Jul/2026:10:15:23 +0000'), '24/Jul/2026:10');
eq('hour derivation: ISO/Mendix-style timestamp format', global.nginxDeriveHourStr('2026-07-24T10:15:23'), '2026-07-24 10');
eq('hour derivation: unrecognized format falls back to a 13-char slice, not a crash', global.nginxDeriveHourStr('unrecognized-format-string'), 'unrecognized-'.slice(0, 13));

ok('worker threshold: matches the 2 MB convention shared with LQE/MFT/WSRE', global.NGINX_WORKER_THRESHOLD === 2 * 1024 * 1024);

// nginxStreamParseFile is async (it streams a Blob) — chained into the same
// async sequence as the other async suites below so its assertions land
// before the final pass/fail count is printed, not racing it.
async function runNginxAsyncTests() {
  const line1 = '203.0.113.5 - - [24/Jul/2026:10:15:23 +0000] "GET /api/orders HTTP/1.1" 200 1234 "-" "Mozilla/5.0"';
  const line2 = '198.51.100.9 - - [24/Jul/2026:10:16:00 +0000] "GET /api/orders HTTP/1.1" 200 999 "-" "curl/8.0"';
  const blob = new Blob([line1 + '\n' + line2 + '\n']);
  const result = await global.nginxStreamParseFile(blob, false, 'access', global.nginxParseLine, undefined);
  eq('stream parse: both lines parsed into records', result.records.length, 2);
  eq('stream parse: hourStr derived per record', result.records[0].hourStr, '24/Jul/2026:10');
  eq('stream parse: unique IPs on the shared URL', JSON.stringify(global.nginxUniqueIpsPerUrl(result.records)), '{"/api/orders":2}');

  const errBlob = new Blob(['not an nginx line at all\ngarbage\n']);
  const errResult = await global.nginxStreamParseFile(errBlob, false, 'error', global.nginxParseErrorLine, undefined);
  eq('stream parse (error type): unmatched lines are scanned but not matched', errResult.scanned, 2);
  eq('stream parse (error type): first unmatched line kept as the hint sample', errResult.matched, 0);
  ok('stream parse (error type): sample captured for the format-mismatch hint', errResult.sample.length > 0);
}

// =========================================================================
// HASH GENERATOR — BCrypt verification (12.9)
// =========================================================================
// Fixtures generated with the independent `bcryptjs` library (not this app's
// code) so this is a real cross-implementation check, not just "does my
// code agree with itself". A wrong bcrypt verifier would silently tell
// someone their password does or doesn't match — this had to be checked
// against ground truth before it could ship, not just internally consistent.
console.log('\nHash Generator — BCrypt verification');
require('../public/js/tools/hash.js');

const bcryptVectors = [
  ['', '$2b$10$Am9T0RYjCCum4exhX5c5FuqixCKJvcu7IWmUf9akIZdQkru0o70hy'],
  ['a', '$2b$10$Onqr0rfKXmr.FsqSFtnMYeZVzhgVq/Qqi4s8D7pj.lz.6u.YcwD7O'],
  ['abc', '$2b$10$m2OksgQRzhBIBdr.roMH8ed7VhlEp/VFneoV.41B8sQWlC5nTkVIe'],
  ['password123', '$2b$10$QRrKB1oGDD9shEJKfv36ueW/t4DlCkAhzIXl6gAOTffP1Q1r3Z23e'],
  ['MendixCloud!2026', '$2b$10$9piOgBNZys21FOJ7WqvUSO1gqUFThgehontGnjzXkNjCnC2TTkFXS'],
  ['test', '$2b$04$ejKGb8CBDrRVQc6rXaqSoukPi7W54eu8tDOR807wTzBVdfFWNqipO'],
  ['legacyFormat', '$2a$10$yD1XmCr3edRIfSn7LmthgusARh1wT7rBe/5cqvkFJT2QH7NjUXDbK']
];
bcryptVectors.forEach(([pw, hash]) => {
  ok('bcrypt verify: "' + pw + '" matches its known-good hash (' + hash.slice(0, 7) + '…, from an independent implementation)', global.bcryptVerify(pw, hash).match === true);
});
eq('bcrypt verify: wrong password on a real hash reports no match', global.bcryptVerify('wrongpassword', bcryptVectors[3][1]).match, false);
eq('bcrypt verify: cost 12 (slower, still correct)', global.bcryptVerify('test', '$2b$12$y6x9caHz5tu/TfNL9S0pRed4BzBk7CiH6dPCFUx1gihmMHiBZwWj2').match, true);
// A pathologically high cost (2^cost rounds) would freeze the browser rather than
// finish — refuse it with an honest error instead of running the digest.
ok('bcrypt verify: an impractically high cost is refused, not run', !!global.bcryptVerify('x', '$2b$25$' + 'A'.repeat(53)).error);
ok('bcrypt verify: malformed input reports an honest error, not a crash or a false match', !!global.bcryptVerify('x', 'not-a-hash-at-all').error);
eq('bcrypt parse: rejects an out-of-range cost factor', global.bcryptParseHash('$2b$99$' + 'A'.repeat(53)), null);
eq('bcrypt parse: null for empty input', global.bcryptParseHash(''), null);

// =========================================================================
// DEVELOPER STUDIO — auto-reconnect backoff (12.11)
// =========================================================================
console.log('\nDeveloper Studio — reconnect backoff');
require('../public/js/tools/dev-studio.js');

eq('backoff: 1st attempt is 2s (2^1)', global.dsBackoffDelay(1), 2000);
eq('backoff: 2nd attempt is 4s (2^2)', global.dsBackoffDelay(2), 4000);
eq('backoff: 5th attempt is 32s, capped to 30s', global.dsBackoffDelay(5), 30000);
eq('backoff: stays capped at 30s for a long outage (attempt 20)', global.dsBackoffDelay(20), 30000);
ok('backoff: monotonically non-decreasing up to the cap', global.dsBackoffDelay(3) >= global.dsBackoffDelay(2) && global.dsBackoffDelay(2) >= global.dsBackoffDelay(1));

// =========================================================================
// OPENAPI / SWAGGER IMPORT — spec → a filled-in request
// =========================================================================
console.log('\nOpenAPI import');
require('../public/js/tools/perf-lab-openapi.js');
// Also loaded here: the last assertions in this block check that an imported
// operation actually feeds the Message Factory, which is the whole point of
// emitting {placeholders} in OpenAPI's own syntax.
require('../public/js/tools/perf-lab-messages.js');

const OAS3 = {
  openapi: '3.0.1',
  info: { title: 'Orders API' },
  servers: [{ url: '/rest/orders/v1' }],
  paths: {
    '/orders/{orderId}': {
      parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'integer' } }],
      get: { summary: 'Read one order', operationId: 'getOrder' },
      put: {
        summary: 'Replace an order',
        parameters: [
          { name: 'validate', in: 'query', required: true, schema: { type: 'boolean' } },
          { name: 'dryRun', in: 'query', required: false, schema: { type: 'boolean' } },
          { name: 'X-Correlation-Id', in: 'header', schema: { type: 'string', format: 'uuid' } }
        ],
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } }
      }
    }
  },
  components: {
    schemas: {
      Order: {
        type: 'object',
        properties: {
          orderId: { type: 'integer' },
          status: { type: 'string', enum: ['NEW', 'SHIPPED'] },
          placedAt: { type: 'string', format: 'date-time' },
          reference: { type: 'string', example: 'REF-9000' },
          customer: { $ref: '#/components/schemas/Customer' },
          lines: { type: 'array', items: { $ref: '#/components/schemas/Line' } }
        }
      },
      Customer: {
        type: 'object',
        properties: { email: { type: 'string', format: 'email' }, parent: { $ref: '#/components/schemas/Customer' } }
      },
      Line: {
        allOf: [
          { type: 'object', properties: { sku: { type: 'string' } } },
          { type: 'object', properties: { qty: { type: 'integer' } } }
        ]
      }
    }
  }
};

const p3 = global.ploParseSpec(OAS3, 'https://app.mendixcloud.com/rest/orders/v1/openapi.json');
ok('oas3: parsed', p3.ok, p3.error);
eq('oas3: version detected', p3.version, '3');
eq('oas3: title read', p3.title, 'Orders API');
eq('oas3: every method under a path becomes an operation', p3.operations.length, 2);
// A relative server URL is the Mendix default; the host only exists on the URL
// the document itself was fetched from.
eq('oas3: a relative server url resolves against the spec url', p3.baseUrl, 'https://app.mendixcloud.com/rest/orders/v1');

const put = p3.operations.filter(function (o) { return o.method === 'PUT'; })[0];
const req3 = global.ploOperationRequest(p3, put);
eq('oas3: path parameters stay as placeholders',
  req3.url, 'https://app.mendixcloud.com/rest/orders/v1/orders/{orderId}?validate={validate}');
ok('oas3: an optional query parameter is left out', req3.url.indexOf('dryRun') === -1, req3.url);
ok('oas3: a header parameter is pre-filled', /^[0-9a-f-]{36}$/.test(req3.headers['X-Correlation-Id']), req3.headers['X-Correlation-Id']);
eq('oas3: Content-Type comes from the declared media type', req3.headers['Content-Type'], 'application/json');
eq('oas3: sample is JSON', req3.kind, 'json');

const sample3 = JSON.parse(req3.sample);
eq('oas3: $ref resolved into the body', typeof sample3.orderId, 'number');
eq('oas3: an example in the spec wins over a guess', sample3.reference, 'REF-9000');
eq('oas3: an enum uses its first value', sample3.status, 'NEW');
ok('oas3: date-time format produces a date-time', /^\d{4}-\d{2}-\d{2}T/.test(sample3.placedAt), sample3.placedAt);
ok('oas3: email format produces an email', /@/.test(sample3.customer.email), sample3.customer.email);
// The load-bearing one: Customer.parent points at Customer. A naive walk hangs
// the tab; the guard has to stop and emit null.
eq('oas3: a circular $ref terminates instead of hanging', sample3.customer.parent, null);
eq('oas3: allOf merges both branches', typeof sample3.lines[0].sku + '/' + typeof sample3.lines[0].qty, 'string/number');
eq('oas3: an array sample carries two elements', sample3.lines.length, 2);

// A declared enumeration must become an Enum generator holding exactly the
// allowed values — a Mendix enumeration attribute 400s on anything else, and a
// run against the error path looks fast and means nothing.
ok('oas3: enum values are collected as a hint',
  req3.bodyHints.status && req3.bodyHints.status.enumValues.join(',') === 'NEW,SHIPPED',
  JSON.stringify(req3.bodyHints.status));
eq('oas3: a nested field keeps its declared type',
  req3.bodyHints['customer.email'].family, 'text');
eq('oas3: an array element path uses the [] form',
  !!req3.bodyHints['lines[].qty'], true);

// The two waves have to meet: an imported sample must feed the Message Factory.
const bridged = global.plmAnalyze(req3.sample, req3.url, { url: req3.paramFamilies, body: req3.bodyHints });
const bridgedByPath = {};
bridged.fields.forEach(function (f) { bridgedByPath[f.path] = f; });
eq('import: an enum field becomes an Enum generator', bridgedByPath.status.gen, 'Enum');
eq('import: holding exactly the declared values', (bridgedByPath.status.params.values || []).join(','), 'NEW,SHIPPED');
eq('import: a declared boolean query parameter is not read as a date',
  bridgedByPath['url:validate'].family, 'bool');
ok('import feeds the Message Factory', bridged.fields.length > 0 && !bridged.error, bridged.error);
ok('the imported URL placeholders become fields',
  bridged.fields.some(function (f) { return f.path === 'url:orderId'; }) &&
  bridged.fields.some(function (f) { return f.path === 'url:validate'; }),
  bridged.fields.map(function (f) { return f.path; }).join(', '));

const SWAGGER2 = {
  swagger: '2.0',
  info: { title: 'Legacy' },
  host: 'legacy.example.com',
  basePath: '/api',
  schemes: ['https'],
  consumes: ['application/json'],
  paths: {
    '/customers': {
      post: {
        summary: 'Create',
        parameters: [{ name: 'body', in: 'body', schema: { $ref: '#/definitions/Customer' } }]
      }
    }
  },
  definitions: { Customer: { type: 'object', properties: { name: { type: 'string' }, active: { type: 'boolean' } } } }
};

const p2 = global.ploParseSpec(SWAGGER2, '');
ok('swagger2: parsed', p2.ok, p2.error);
eq('swagger2: version detected', p2.version, '2');
eq('swagger2: base url built from scheme, host and basePath', p2.baseUrl, 'https://legacy.example.com/api');
const req2 = global.ploOperationRequest(p2, p2.operations[0]);
eq('swagger2: the body parameter becomes the sample', JSON.parse(req2.sample).active, true);
eq('swagger2: definitions are resolved', typeof JSON.parse(req2.sample).name, 'string');
eq('swagger2: Content-Type comes from consumes', req2.headers['Content-Type'], 'application/json');

// Failure modes: say what is wrong, in terms the user can act on.
ok('yaml input is named as yaml, not "invalid json"',
  /YAML/.test(global.ploParseSpec('openapi: 3.0.0\npaths: {}\n', '').error), global.ploParseSpec('openapi: 3.0.0\n', '').error);
ok('an unrelated JSON document is refused', /not an OpenAPI/.test(global.ploParseSpec('{"hello":"world"}', '').error));
ok('a spec without operations says so', /no operations/.test(global.ploParseSpec('{"openapi":"3.0.0","paths":{}}', '').error));
ok('empty input is refused', !global.ploParseSpec('', '').ok);

// =========================================================================
// MESSAGE FACTORY — sample message → varied traffic
// =========================================================================
console.log('\nMessage Factory');
require('../public/js/tools/perf-lab-messages.js');

const PLM_JSON = JSON.stringify({
  orderId: 1000,
  reference: "REF-1",
  customer: { customerId: 77, email: "a@b.com", vip: true },
  currency: "EUR",
  lines: [{ sku: "SKU-1", qty: 2 }, { sku: "SKU-2", qty: 5 }]
}, null, 2);

function plmFieldsByPath(fields) {
  const m = {};
  fields.forEach(function (f) { m[f.path] = f; });
  return m;
}
function plmSetGen(fields, path, gen, params) {
  const f = plmFieldsByPath(fields)[path];
  if (f) { f.gen = gen; f.params = params || global.dfgDefaults(gen); }
  return f;
}
function plmAllConstant(fields) {
  fields.forEach(function (f) { f.constant = true; });
  return fields;
}

// ── analysis ────────────────────────────────────────────────────────────────
const aJson = global.plmAnalyze(PLM_JSON, '');
eq('json: detected as JSON', aJson.kind, 'json');
ok('json: leaf paths collected', !!plmFieldsByPath(aJson.fields)['customer.email']);
// One config row drives every element of an array — otherwise a 30-line order
// would demand 30 identical rows in the UI.
ok('json: array elements collapse to one row', !!plmFieldsByPath(aJson.fields)['lines[].sku']);
eq('json: that row reports both occurrences', plmFieldsByPath(aJson.fields)['lines[].sku'].occurrences, 2);
eq('json: a number sample is a number family', plmFieldsByPath(aJson.fields)['orderId'].family, 'number');
eq('json: a boolean sample is a bool family', plmFieldsByPath(aJson.fields)['customer.vip'].family, 'bool');
eq('json: the name drives the generator', plmFieldsByPath(aJson.fields)['customer.email'].gen, 'Email');

// ── JSON rendering ──────────────────────────────────────────────────────────
const cJson = global.plmCompile({ kind: 'json', source: PLM_JSON, fields: aJson.fields, seed: 42 });
const m0 = JSON.parse(global.plmRender(cJson, 0).body);
const m1 = JSON.parse(global.plmRender(cJson, 1).body);
ok('json: two requests get two different messages', JSON.stringify(m0) !== JSON.stringify(m1));
ok('json: emails look like emails', /@/.test(m0.customer.email));
// Decision 2: the sample's type is the contract. "REF-1" was a string, so its
// replacement is a string even when a numeric generator produced it.
eq('json: a number stays a number', typeof m0.orderId, 'number');
eq('json: a string stays a string', typeof m0.reference, 'string');
eq('json: a boolean stays a boolean', typeof m0.customer.vip, 'boolean');
plmSetGen(aJson.fields, 'reference', 'Number');
const cCoerce = global.plmCompile({ kind: 'json', source: PLM_JSON, fields: aJson.fields, seed: 42 });
eq('json: a Number generator on a string field still writes a string',
  typeof JSON.parse(global.plmRender(cCoerce, 0).body).reference, 'string');

// Decision 3: config per path, values per slot.
const rendered = JSON.parse(global.plmRender(cJson, 5).body);
ok('json: repeated array elements get different values',
  rendered.lines[0].sku !== rendered.lines[1].sku, JSON.stringify(rendered.lines));

// Constants survive untouched — keys and type discriminators must not drift.
const constFields = JSON.parse(JSON.stringify(aJson.fields));
plmFieldsByPath(constFields)['currency'].constant = true;
const cConst = global.plmCompile({ kind: 'json', source: PLM_JSON, fields: constFields, seed: 7 });
eq('json: a constant field keeps the sample value', JSON.parse(global.plmRender(cConst, 3).body).currency, 'EUR');

// Seeded reproducibility, and independence from neighbouring requests.
const cSeedA = global.plmCompile({ kind: 'json', source: PLM_JSON, fields: aJson.fields, seed: 99 });
const cSeedB = global.plmCompile({ kind: 'json', source: PLM_JSON, fields: aJson.fields, seed: 99 });
eq('json: same seed and index produce the same bytes',
  global.plmRender(cSeedA, 12).body, global.plmRender(cSeedB, 12).body);
ok('json: a different seed produces different bytes',
  global.plmRender(cSeedA, 12).body !== global.plmRender(global.plmCompile({ kind: 'json', source: PLM_JSON, fields: aJson.fields, seed: 100 }), 12).body);

// ── correlation ─────────────────────────────────────────────────────────────
const corrSource = JSON.stringify({ header: { customerId: 1 }, lines: [{ customerId: 9 }, { customerId: 9 }] });
const corr = global.plmAnalyze(corrSource, '');
plmSetGen(corr.fields, 'header.customerId', 'Sequence', { start: 500, step: 1 });
plmSetGen(corr.fields, 'lines[].customerId', global.PLM_SAME_AS, { ref: 'header.customerId' });
const cCorr = global.plmCompile({ kind: 'json', source: corrSource, fields: corr.fields, seed: 3 });
const corrMsg = JSON.parse(global.plmRender(cCorr, 0).body);
eq('correlation: a line copies the header value', corrMsg.lines[0].customerId, corrMsg.header.customerId);
eq('correlation: every occurrence copies it', corrMsg.lines[1].customerId, corrMsg.header.customerId);

// A reference pointing at a field that comes later must still resolve — the
// user should not have to think about document order.
const fwdSource = JSON.stringify({ a: 1, b: 2 });
const fwd = global.plmAnalyze(fwdSource, '');
plmSetGen(fwd.fields, 'a', global.PLM_SAME_AS, { ref: 'b' });
plmSetGen(fwd.fields, 'b', 'Sequence', { start: 10, step: 1 });
const fwdMsg = JSON.parse(global.plmRender(global.plmCompile({ kind: 'json', source: fwdSource, fields: fwd.fields, seed: 1 }), 0).body);
eq('correlation: a forward reference resolves too', fwdMsg.a, fwdMsg.b);

// ── XML ─────────────────────────────────────────────────────────────────────
const PLM_XML = '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">\n' +
  '  <!-- keep me -->\n' +
  '  <soap:Body>\n' +
  '    <Order id="A-1" priority="high">\n' +
  '      <Customer><Email>a@b.com</Email><City>Warsaw</City></Customer>\n' +
  '      <Note><![CDATA[ raw <not> parsed ]]></Note>\n' +
  '      <Line sku="S-1"/>\n' +
  '      <Line sku="S-2"/>\n' +
  '    </Order>\n' +
  '  </soap:Body>\n' +
  '</soap:Envelope>';

const aXml = global.plmAnalyze(PLM_XML, '');
eq('xml: detected as XML', aXml.kind, 'xml');
const xf = plmFieldsByPath(aXml.fields);
ok('xml: element text becomes a field', !!xf['/soap:Envelope/soap:Body/Order/Customer/Email']);
ok('xml: attributes become fields', !!xf['/soap:Envelope/soap:Body/Order/@id']);
ok('xml: a self-closing element\'s attribute is found', !!xf['/soap:Envelope/soap:Body/Order/Line/@sku']);
eq('xml: repeated elements share one config row', xf['/soap:Envelope/soap:Body/Order/Line/@sku'].occurrences, 2);
ok('xml: the name still drives the generator', xf['/soap:Envelope/soap:Body/Order/Customer/Email'].gen === 'Email');

// The load-bearing guarantee: with nothing varying, the output is the input.
// If this ever fails, the tool is corrupting messages that used to work.
const cXmlConst = global.plmCompile({ kind: 'xml', source: PLM_XML, fields: plmAllConstant(JSON.parse(JSON.stringify(aXml.fields))), seed: 1 });
eq('xml: all-constant render is byte-identical to the sample', global.plmRender(cXmlConst, 0).body, PLM_XML);

const cXml = global.plmCompile({ kind: 'xml', source: PLM_XML, fields: aXml.fields, seed: 5 });
const xOut = global.plmRender(cXml, 0).body;
ok('xml: the prologue survives', xOut.indexOf('<?xml version="1.0" encoding="UTF-8"?>') === 0);
ok('xml: comments survive', xOut.indexOf('<!-- keep me -->') !== -1);
ok('xml: CDATA is left alone', xOut.indexOf('<![CDATA[ raw <not> parsed ]]>') !== -1);
ok('xml: namespace prefixes survive', xOut.indexOf('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">') !== -1);
ok('xml: the self-closing form survives', /<Line sku="[^"]*"\/>/.test(xOut));
ok('xml: values actually changed', xOut.indexOf('a@b.com') === -1);
const skus = xOut.match(/<Line sku="([^"]*)"\/>/g);
ok('xml: two Line elements get two different values', skus && skus[0] !== skus[1], String(skus));

// A generated value carrying markup must not be able to break the document.
const ampFields = JSON.parse(JSON.stringify(aXml.fields));
plmSetGen(ampFields, '/soap:Envelope/soap:Body/Order/Customer/City', 'Constant', { value: 'Ben & <Jerry>' });
const ampOut = global.plmRender(global.plmCompile({ kind: 'xml', source: PLM_XML, fields: ampFields, seed: 1 }), 0).body;
ok('xml: generated markup is escaped, not injected', ampOut.indexOf('Ben &amp; &lt;Jerry&gt;') !== -1);

// ── URL templating ──────────────────────────────────────────────────────────
const aUrl = global.plmAnalyze('', '/rest/orders/{orderId}?since={fromDate}');
const uf = plmFieldsByPath(aUrl.fields);
ok('url: placeholders become fields', !!uf['url:orderId'] && !!uf['url:fromDate']);
eq('url: an id placeholder is treated as numeric', uf['url:orderId'].family, 'number');
// Whole words, not substrings: `validate` ends in the letters "date" and is
// usually a flag; `paid` ends in "id" and is not a key. Matching on substrings
// put a timestamp into a boolean query parameter and 400'd every request.
eq('url: "validate" is not a date', global.plmAnalyze('', '/x?v={validate}').fields[0].family, 'text');
eq('url: "paid" is not an id', global.plmAnalyze('', '/x?p={paid}').fields[0].family, 'text');
eq('url: "orderDate" still is a date', global.plmAnalyze('', '/x?d={orderDate}').fields[0].family, 'date');
eq('url: "customer_id" still is a number', global.plmAnalyze('', '/x?c={customer_id}').fields[0].family, 'number');
// A declared type from an API spec always wins over any name rule.
eq('url: a spec-declared type beats the name',
  global.plmAnalyze('', '/x?d={orderDate}', { url: { orderDate: 'number' } }).fields[0].family, 'number');
eq('url: a date placeholder is treated as a date', uf['url:fromDate'].family, 'date');
// Left on the inferred defaults on purpose: a numeric-looking path parameter
// has to produce a number without the user touching anything, or every request
// 404s on a path segment full of words.
const cUrl = global.plmCompile({ kind: 'text', source: '', fields: aUrl.fields, seed: 1, urlTemplate: '/rest/orders/{orderId}?since={fromDate}' });
const u0 = global.plmRender(cUrl, 0).url;
const u1 = global.plmRender(cUrl, 1).url;
ok('url: the placeholder is substituted with a number by default', u0.indexOf('{orderId}') === -1 && /\/rest\/orders\/\d+\?/.test(u0), u0);
ok('url: consecutive requests hit different resources', u0 !== u1, u0 + ' vs ' + u1);
const cUrlEnc = global.plmCompile({ kind: 'text', source: '', fields: [{ path: 'url:q', name: 'q', gen: 'Constant', params: { value: 'a b&c' }, origin: 'url' }], seed: 1, urlTemplate: '/search?q={q}' });
eq('url: values are percent-encoded', global.plmRender(cUrlEnc, 0).url, '/search?q=a%20b%26c');

// A placeholder and a body field routinely share a name. They must stay two
// independent rows, or configuring one silently retunes the other.
const clashSource = JSON.stringify({ orderId: 1 });
const clash = global.plmAnalyze(clashSource, '/orders/{orderId}');
eq('url: a placeholder sharing a body field name stays separate', clash.fields.length, 2);
plmSetGen(clash.fields, 'url:orderId', 'Constant', { value: '777' });
plmSetGen(clash.fields, 'orderId', 'Constant', { value: '42' });
const clashOut = global.plmRender(global.plmCompile({ kind: 'json', source: clashSource, fields: clash.fields, seed: 1, urlTemplate: '/orders/{orderId}' }), 0);
eq('url: the placeholder uses its own generator', clashOut.url, '/orders/777');
// 42 and not "42": the body sample was a number, and the sample's type wins.
eq('url: the body field keeps its own', JSON.parse(clashOut.body).orderId, 42);

// ── failure modes ───────────────────────────────────────────────────────────
const bad = global.plmAnalyze('{ not json', '');
ok('broken JSON is reported, not thrown', bad.error.indexOf('Not valid JSON') === 0, bad.error);
const cBad = global.plmCompile({ kind: 'json', source: '{ not json', fields: [], seed: 1 });
eq('a sample that cannot be parsed is still sent as pasted', global.plmRender(cBad, 0).body, '{ not json');
eq('content type follows the sample kind', global.plmContentType('xml'), 'application/xml');

// =========================================================================
// PERF LAB — load test session engine (histogram + target gate)
// =========================================================================
console.log('\nPerf Lab — session engine');
const perfSession = require('../server/perf-session.js');

// The histogram is what makes an unbounded run possible, so its bin math has to
// be exact: a value must land in the bin whose range contains it, at every
// resolution change.
function inBin(ms) {
  const r = perfSession.histRange(perfSession.histIndex(ms));
  return ms >= r[0] && ms < r[1];
}
ok('hist: 0 ms lands in its own bin', inBin(0));
ok('hist: 42 ms lands in a 1 ms bin', inBin(42));
ok('hist: 99 ms is still 1 ms resolution', inBin(99));
ok('hist: 100 ms crosses into the 5 ms bins', inBin(100) && perfSession.histRange(perfSession.histIndex(100))[1] === 105);
ok('hist: 999 ms is the last 5 ms bin', inBin(999));
ok('hist: 1000 ms crosses into the 50 ms bins', inBin(1000) && perfSession.histRange(perfSession.histIndex(1000))[1] === 1050);
ok('hist: 9999 ms is the last 50 ms bin', inBin(9999));
eq('hist: 10 s and beyond share the overflow bin', perfSession.histIndex(10000), perfSession.histIndex(120000));

// A percentile must fall inside the bin the measurement fell in — that is the
// accuracy the UI promises ("± one bin width"), not a vaguer claim.
const h = new Array(461).fill(0);
for (let i = 1; i <= 100; i++) h[perfSession.histIndex(i)]++;   // 1..100 ms, one each
ok('hist: p50 of 1..100 ms sits within a bin of 50 ms', Math.abs(perfSession.histPercentile(h, 100, 50) - 50) <= 1);
ok('hist: p95 of 1..100 ms sits within a bin of 95 ms', Math.abs(perfSession.histPercentile(h, 100, 95) - 95) <= 1);
ok('hist: p99 of 1..100 ms sits within a bin of 99 ms', Math.abs(perfSession.histPercentile(h, 100, 99) - 99) <= 1);
eq('hist: percentile of an empty run is 0, not NaN', perfSession.histPercentile(new Array(461).fill(0), 0, 95), 0);

// The gate deciding whether a target needs explicit authorization. A false
// "private" verdict here silently lifts the external thread cap.
ok('target gate: localhost is local', perfSession.isPrivateOrLocalHost('localhost'));
ok('target gate: 127.0.0.1 is local', perfSession.isPrivateOrLocalHost('127.0.0.1'));
ok('target gate: ::1 is local', perfSession.isPrivateOrLocalHost('::1'));
ok('target gate: 10.x is private', perfSession.isPrivateOrLocalHost('10.20.30.40'));
ok('target gate: 192.168.x is private', perfSession.isPrivateOrLocalHost('192.168.1.50'));
ok('target gate: 172.16.x is private', perfSession.isPrivateOrLocalHost('172.16.0.9'));
ok('target gate: 172.32.x is NOT private (outside the /12)', !perfSession.isPrivateOrLocalHost('172.32.0.9'));
ok('target gate: a Mendix Cloud host is external', !perfSession.isPrivateOrLocalHost('myapp.mendixcloud.com'));
ok('target gate: 10.evil.com is external, not private (prefix match would be wrong)', !perfSession.isPrivateOrLocalHost('10.evil.com'));
ok('target gate: 172.320.0.1 is not a valid address, so not private', !perfSession.isPrivateOrLocalHost('172.320.0.1'));
ok('target gate: a single-label intranet host counts as local', perfSession.isPrivateOrLocalHost('mxapp-test'));
ok('target gate: a .local host counts as local', perfSession.isPrivateOrLocalHost('mendix-dev.local'));

// =========================================================================
// REST LOAD TESTER — AUTHENTICATION (wave 4)
// =========================================================================
// A published Mendix REST service is protected by a user role, so nearly every
// real run needs credentials. The header is built in ONE pure place and handed
// to whichever engine runs — the browser and the Bridge must send the same
// bytes, or "works in the browser, 401 on the Bridge" becomes a bug hunt.
console.log('\nREST Load Tester — auth header');

eq('auth: none produces no header', global.plAuthHeader({ type: 'none' }).value, null);
eq('auth: no config at all produces no header', global.plAuthHeader(null).value, null);

const basic = global.plAuthHeader({ type: 'basic', username: 'MxAdmin', password: 'secret' });
eq('auth: basic is RFC 7617 base64 of user:pass', basic.value, 'Basic TXhBZG1pbjpzZWNyZXQ=');
eq('auth: a valid basic header reports no error', basic.error, '');

// btoa() throws on anything outside Latin-1, so a Polish password would break
// the run in the browser engine while working on the Bridge. Encoding UTF-8
// bytes first is the fix — and Mendix hashes the UTF-8 bytes too.
eq('auth: a non-ASCII password is encoded as UTF-8, not rejected',
  global.plAuthHeader({ type: 'basic', username: 'jan', password: 'zażółć' }).value,
  'Basic amFuOnphxbzDs8WCxIc=');
eq('auth: a non-ASCII username survives the same way',
  global.plAuthHeader({ type: 'basic', username: 'żółw', password: 'x' }).value,
  'Basic xbzDs8WCdzp4');

// Base64 padding depends on the byte count, so all three residues have to be
// right — a wrong pad character is an invalid header the target rejects.
eq('auth: 3-byte credentials need no padding', global.plAuthHeader({ type: 'basic', username: 'a', password: 'b' }).value, 'Basic YTpi');
eq('auth: 4-byte credentials pad with ==', global.plAuthHeader({ type: 'basic', username: 'ab', password: 'c' }).value, 'Basic YWI6Yw==');
eq('auth: 5-byte credentials pad with =', global.plAuthHeader({ type: 'basic', username: 'abc', password: 'd' }).value, 'Basic YWJjOmQ=');

// An API key is routinely used as the username with an empty password, so only
// a completely empty pair is an error.
ok('auth: a username with an empty password is allowed', !!global.plAuthHeader({ type: 'basic', username: 'apikey', password: '' }).value);
ok('auth: an empty basic pair is refused instead of sending "Basic Og=="', !global.plAuthHeader({ type: 'basic', username: '', password: '' }).value);
ok('auth: the empty pair says what is missing', /username/i.test(global.plAuthHeader({ type: 'basic', username: '', password: '' }).error));
// RFC 7617 splits on the FIRST colon, so a colon in the username silently
// hands part of it to the password field.
ok('auth: a colon in the username is refused, not silently mangled', /colon/i.test(global.plAuthHeader({ type: 'basic', username: 'a:b', password: 'c' }).error));

eq('auth: bearer prefixes the token', global.plAuthHeader({ type: 'bearer', token: 'eyJhbG' }).value, 'Bearer eyJhbG');
// Copying "Bearer eyJ…" straight out of Postman or the docs is the norm.
eq('auth: a token pasted with its prefix is not doubled', global.plAuthHeader({ type: 'bearer', token: 'Bearer eyJhbG' }).value, 'Bearer eyJhbG');
eq('auth: the prefix check is case-insensitive', global.plAuthHeader({ type: 'bearer', token: 'bearer eyJhbG' }).value, 'Bearer eyJhbG');
eq('auth: surrounding whitespace is trimmed', global.plAuthHeader({ type: 'bearer', token: '  eyJhbG \n' }).value, 'Bearer eyJhbG');
ok('auth: an empty bearer token is refused', /token/i.test(global.plAuthHeader({ type: 'bearer', token: '   ' }).error));
// A JWT copied out of a wrapped terminal carries newlines; a header value with
// a CR/LF in it is header injection, and fetch() throws on it anyway.
ok('auth: a token containing a line break is refused', /line break|newline/i.test(global.plAuthHeader({ type: 'bearer', token: 'eyJ\r\nabc' }).error));
ok('auth: a password containing a line break is refused', /line break|newline/i.test(global.plAuthHeader({ type: 'basic', username: 'a', password: 'b\nc' }).error));

// The Authorization header the auth control builds has to win over one typed
// into the Headers box — including a differently-cased key, which would
// otherwise travel as a second, contradictory header.
const merged = global.plApplyAuth({ 'Content-Type': 'application/json', 'authorization': 'Basic old' }, 'Basic new');
eq('auth: merging replaces a differently-cased Authorization key', Object.keys(merged.headers).filter(k => /^authorization$/i.test(k)).length, 1);
eq('auth: the merged value is the one the auth control built', merged.headers.Authorization || merged.headers.authorization, 'Basic new');
ok('auth: merging reports that it replaced a typed header', merged.replaced);
eq('auth: unrelated headers survive the merge', merged.headers['Content-Type'], 'application/json');
ok('auth: nothing to apply leaves the headers untouched', !global.plApplyAuth({ 'X-A': '1' }, null).replaced);

// =========================================================================
// REST LOAD TESTER — RUN SUMMARY (wave 4)
// =========================================================================
// The charts show what happened; the summary says it in words you can paste
// into a ticket. Everything it states has to come from the run — a summary
// that rounds a bad run into a good sentence is worse than no summary.
console.log('\nREST Load Tester — run summary');

function plBucket(sec, n, errs, avg, max, threads) {
  return { sec, n, errs, avg, max, threads };
}

const vmClean = {
  sent: 300, completed: 300, errors: 0, min: 10, max: 90, avg: 42.5,
  p50: 40, p95: 80, p99: 88, rps: 60, elapsedMs: 5000, exact: true,
  statusCounts: { '200': 300 },
  buckets: [plBucket(0, 60, 0, 42, 90, 5), plBucket(1, 60, 0, 42, 88, 5), plBucket(2, 60, 0, 43, 85, 5), plBucket(3, 60, 0, 42, 80, 5), plBucket(4, 60, 0, 43, 82, 5)]
};
const sClean = global.plSummarize(vmClean, { method: 'GET', url: 'http://localhost:8080/rest/orders', mode: 'count', engine: 'server', running: false });

ok('summary: the headline counts the requests', /300 requests/.test(sClean.headline), sClean.headline);
ok('summary: the headline carries the duration', /5\.0 s/.test(sClean.headline), sClean.headline);
ok('summary: the headline carries throughput', /60(\.0)? req\/s/.test(sClean.headline), sClean.headline);
ok('summary: a clean run says so instead of "0.0% errors"', /no errors/i.test(sClean.headline), sClean.headline);
eq('summary: one status is one row', sClean.statuses.length, 1);
eq('summary: the status row carries its share', sClean.statuses[0].pct, 100);
ok('summary: a 200 is not marked as a failure', !sClean.statuses[0].failed);
// Data-driven: one thread level is not a comparison, so there is no table.
eq('summary: a constant-thread run produces no thread-level table', sClean.levels.length, 0);
ok('summary: an exact-percentile run carries no approximation note', !sClean.notes.some(n => /bin width/.test(n)));

// A run whose responses were all rejections measured the rejection path. The
// latency numbers are real but they are not the endpoint's work — with auth
// now one click away, this is the most common way to misread a green-looking run.
const vm401 = {
  sent: 100, completed: 100, errors: 100, min: 2, max: 9, avg: 4, p50: 4, p95: 8, p99: 9,
  rps: 200, elapsedMs: 500, exact: false, statusCounts: { '401': 100 },
  buckets: [plBucket(0, 100, 100, 4, 9, 5)]
};
const s401 = global.plSummarize(vm401, { method: 'GET', url: 'https://app.mendixcloud.com/rest/x', mode: 'count', engine: 'server', running: false });
ok('summary: a 401 status is counted as a failure', s401.statuses[0].failed);
ok('summary: an all-rejected run says the run measured the rejection',
  s401.notes.some(n => /401/.test(n) && /not the endpoint|rejection/i.test(n)), JSON.stringify(s401.notes));
ok('summary: the histogram engine discloses the percentile bin width', s401.notes.some(n => /bin width/.test(n)));

// The payoff of the live thread slider: buckets already carry the thread count,
// so throughput and latency per level fall out of them.
const vmRamp = {
  sent: 900, completed: 900, errors: 0, min: 10, max: 400, avg: 100,
  p50: 80, p95: 300, p99: 390, rps: 90, elapsedMs: 10000, exact: false,
  statusCounts: { '200': 900 },
  buckets: [
    plBucket(0, 50, 0, 40, 60, 5), plBucket(1, 50, 0, 40, 62, 5), plBucket(2, 50, 0, 41, 61, 5),
    plBucket(3, 80, 0, 90, 200, 20),                        // transition second: both levels
    plBucket(4, 100, 0, 160, 380, 20), plBucket(5, 100, 0, 165, 400, 20), plBucket(6, 100, 0, 158, 390, 20)
  ]
};
const sRamp = global.plSummarize(vmRamp, { method: 'POST', url: 'http://localhost:8080/rest/orders', mode: 'continuous', engine: 'server', running: false });
eq('summary: two thread levels produce two rows', sRamp.levels.length, 2);
eq('summary: levels are ordered by thread count', sRamp.levels[0].threads, 5);
// The second the slider moved carries traffic from both levels, so counting it
// in either one invents throughput that never happened at that level.
eq('summary: the transition second is excluded from the level below', sRamp.levels[0].seconds, 3);
eq('summary: the transition second is excluded from the level above', sRamp.levels[1].seconds, 3);
eq('summary: level throughput is requests per counted second', sRamp.levels[0].rps, 50);
eq('summary: level latency is weighted by the requests in each second', sRamp.levels[1].avgMs, 161);
eq('summary: level max latency is the worst second in the level', sRamp.levels[1].maxMs, 400);
// Four times the threads bought twice the throughput at four times the latency:
// that is the knee, and it is a fact about the buckets, not advice.
ok('summary: a knee is reported when threads stopped buying throughput',
  sRamp.notes.some(n => /req\/s/.test(n) && /threads/.test(n) && /latency/i.test(n)), JSON.stringify(sRamp.notes));

// A level with a single counted second is a sample of one — reporting it as a
// throughput measurement would put a number next to noise.
const vmBlip = {
  sent: 200, completed: 200, errors: 0, min: 10, max: 100, avg: 50, p50: 50, p95: 90, p99: 99,
  rps: 50, elapsedMs: 4000, exact: false, statusCounts: { '200': 200 },
  buckets: [plBucket(0, 50, 0, 50, 90, 5), plBucket(1, 50, 0, 50, 90, 5), plBucket(2, 50, 0, 55, 95, 9), plBucket(3, 50, 0, 55, 95, 5)]
};
eq('summary: a level with one usable second is not reported as a level', global.plSummarize(vmBlip, { method: 'GET', url: 'http://x/y', mode: 'count', engine: 'server', running: false }).levels.length, 0);

// Zero completed requests: every derived number would be 0/0. The summary has
// to say "nothing came back" rather than print a wall of zeroes.
const sEmpty = global.plSummarize(
  { sent: 10, completed: 0, errors: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0, rps: 0, elapsedMs: 800, exact: false, statusCounts: {}, buckets: [] },
  { method: 'GET', url: 'http://localhost:1/y', mode: 'count', engine: 'browser', running: false });
ok('summary: a run with no responses says so', /no responses|nothing came back/i.test(sEmpty.headline), sEmpty.headline);
eq('summary: no responses means no status rows', sEmpty.statuses.length, 0);

// A live run must not be described in the past tense — the numbers are still moving.
const sLive = global.plSummarize(vmClean, { method: 'GET', url: 'http://localhost:8080/x', mode: 'continuous', engine: 'server', running: true });
ok('summary: a running test is described as still running', /running/i.test(sLive.headline), sLive.headline);

// The copyable form is the point of the panel: it has to carry the target and
// the numbers, so a pasted summary stands on its own in a ticket.
const plMd = global.plSummaryMarkdown(sClean);
ok('markdown: carries the target URL', plMd.indexOf('http://localhost:8080/rest/orders') !== -1);
ok('markdown: carries the method', /GET/.test(plMd));
ok('markdown: carries the percentiles', /p95/.test(plMd));
ok('markdown: carries the status breakdown', /200/.test(plMd));
ok('markdown: a thread-level run tabulates the levels', /\| *5 *\|/.test(global.plSummaryMarkdown(sRamp)), global.plSummaryMarkdown(sRamp));

// =========================================================================
// SETTINGS BACKUP — export/import of the keys this app owns (D3)
// =========================================================================
// The app is handed around as a ZIP and stores everything in localStorage, so
// clearing the profile or moving machine used to lose favourites, presets and
// theme with no recovery path. These two functions are that path; the risk to
// guard against is an import trusting whatever a file happens to contain.
console.log('\nSettings backup');
(function () {
  const store = new Map();
  global.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  };
  // tool-state.js is an ES module (it carries `export function init`), same as
  // log-viewer.js — strip the keyword and compile it in a CommonJS wrapper.
  const tsPath = path.join(__dirname, '..', 'public', 'js', 'components', 'tool-state.js');
  const tsSrc = fs.readFileSync(tsPath, 'utf8').replace(/^export\s+/gm, '');
  const NodeMod = require('module');
  const tsMod = new NodeMod(tsPath, module);
  tsMod.filename = tsPath;
  tsMod.paths = NodeMod._nodeModulePaths(path.dirname(tsPath));
  tsMod._compile(tsSrc, tsPath);

  const exportSettings = global.mtExportSettings;
  const importSettings = global.mtImportSettings;

  store.set('mt-favorites', '["json","jwt"]');
  store.set('mt-theme', 'light');
  store.set('unrelated-app-key', 'must not travel');

  const dump = exportSettings();
  eq('export: stamped with the app id', dump.app, 'mxdev-swiss-tool');
  eq('export: carries a format version for future migrations', dump.format, 1);
  eq('export: picks up a set key', dump.data['mt-favorites'], '["json","jwt"]');
  ok('export: skips keys that were never set', !('perfLabPreset' in dump.data));
  // A shared origin may hold other apps' keys; an export must never scoop them up.
  ok('export: ignores keys this app does not own', !('unrelated-app-key' in dump.data));

  store.clear();
  const res = importSettings(JSON.stringify(dump));
  ok('import: round-trips', res.ok && res.imported === 2, JSON.stringify(res));
  eq('import: restores the value verbatim', store.get('mt-favorites'), '["json","jwt"]');

  eq('import: rejects non-JSON', importSettings('not json').ok, false);
  eq('import: rejects a file from another app',
    importSettings(JSON.stringify({ app: 'something-else', data: {} })).ok, false);
  eq('import: rejects a newer format rather than guessing',
    importSettings(JSON.stringify({ app: 'mxdev-swiss-tool', format: 99, data: {} })).ok, false);

  // The file is user-supplied: unknown keys are skipped, not written.
  const mixed = importSettings(JSON.stringify({
    app: 'mxdev-swiss-tool', format: 1,
    data: { 'mt-theme': 'dark', 'evil-key': 'x', 'mt-favorites': { not: 'a string' } }
  }));
  eq('import: writes only owned string values', mixed.imported, 1);
  eq('import: counts what it refused', mixed.skipped, 2);
  ok('import: an unowned key never reaches storage', !store.has('evil-key'));

  delete global.localStorage;
})();

// ── Summary ─────────────────────────────────────────────────────────────────
runXlsxAsyncTests().then(runApiEconAsyncTests).then(runNginxAsyncTests).then(function () {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}, function (err) {
  console.log('  ✗ async suite crashed — ' + (err && err.stack || err));
  console.log('\n' + passed + ' passed, ' + (failed + 1) + ' failed');
  process.exit(1);
});
