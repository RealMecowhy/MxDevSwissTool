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
  '2026-07-17T10:00:02.010000 ' + P + TR + 'DataStorage_QueryPlan: Query Plan: [{"Plan":{"Node Type":"Index Scan","Total Cost":3.1},"Execution Time":1.1}]'
].join('\n');

const lqeRecs = parser.parse(lqeLog).records;
eq('LQE fixture parsed as live', parser.parse(lqeLog).format, 'live');
const qs = lqeExtract(lqeRecs);
eq('five queries extracted', qs.length, 5);
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

// Unlinked plan (no xpathId) assigned FIFO to the first eligible query; slow warnings never consume one
ok('unlinked plan assigned to first plan-less query', qD.duration === '1.100 ms' && qD.cost === 3.1, qD.duration + '/' + qD.cost);
ok('duplicate B without its own plan stays unlinked', qB.queryPlan === '' && qB.duration === null);

// Slow-query warning ingestion
ok('slow-query warning ingested', !!qSlow && qSlow.duration === '3100 ms', qSlow && qSlow.duration);
ok('slow-query warning did not swallow a plan', qSlow.queryPlan === '');

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

// A single-line message with no stack still decodes and reports no stack trace.
ok('errdec: single-line message → no stack flag', !edxDecode('java.lang.OutOfMemoryError: Java heap space').input.hasStackTrace);

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
eq('incident: notes become the subtitle', model.subtitle, 'prod, morning');
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

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
