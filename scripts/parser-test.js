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

// ── Summary ─────────────────────────────────────────────────────────────────
runXlsxAsyncTests().then(function () {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}, function (err) {
  console.log('  ✗ async suite crashed — ' + (err && err.stack || err));
  console.log('\n' + passed + ' passed, ' + (failed + 1) + ' failed');
  process.exit(1);
});
