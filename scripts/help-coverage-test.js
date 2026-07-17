// Help coverage lint: every sidebar tool (data-tool) must open real help, and every
// per-tab help key (data-help-key) must resolve to an entry in tools-help.js.
//
// Mirrors the runtime resolver in public/js/tools-help.js → showActiveToolHelp():
// most tools look help up by their tool id directly; three multi-tab tools
// (log-viewer, query-intelligence, thread-dump) resolve it from the active tab's
// data-help-key instead. Keeping this in `npm test` means a new tool or tab can't
// ship a "Help under construction" dead end unnoticed (report §5, fala 3.9).
//
// Pure text parsing — no DOM, no module load (tools-help.js is an ES module that
// touches window at import time). Run in plain Node.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const helpJs = fs.readFileSync(path.join(root, 'public', 'js', 'tools-help.js'), 'utf8');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '  — ' + detail : '')); }
}

function matchAll(text, re) {
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

// Tools whose help is resolved from the active tab, not the tool id — these need no
// direct TOOLS_HELP entry (their tabs' data-help-key values are checked instead).
// Keep in sync with the special-cased branches in showActiveToolHelp().
const TAB_RESOLVED = new Set(['log-viewer', 'query-intelligence', 'thread-dump']);

// Top-level TOOLS_HELP keys are quoted and indented exactly two spaces; nested
// fields (title:, description:, …) are unquoted, so this can't false-match them.
const helpKeys = new Set(matchAll(helpJs, /^ {2}'([a-z0-9-]+)':/gm));
ok('tools-help.js exposes help entries', helpKeys.size > 0, 'found ' + helpKeys.size);

const dataTools = Array.from(new Set(matchAll(indexHtml, /data-tool="([^"]+)"/g)))
  .filter(t => t !== 'home');
const dataHelpKeys = Array.from(new Set(matchAll(indexHtml, /data-help-key="([^"]+)"/g)));

console.log('\nSidebar tools → direct help entry');
const missingDirect = dataTools.filter(t => !TAB_RESOLVED.has(t) && !helpKeys.has(t));
ok(dataTools.length + ' tools checked, all resolve to help',
  missingDirect.length === 0, 'missing: ' + missingDirect.join(', '));

console.log('\nPer-tab help keys → help entry');
const missingTabs = dataHelpKeys.filter(k => !helpKeys.has(k));
ok(dataHelpKeys.length + ' data-help-key values checked, all resolve to help',
  missingTabs.length === 0, 'missing: ' + missingTabs.join(', '));

// A tab-resolved tool that lost all its tabs would silently fall through; verify each
// still has at least one data-help-key so the special-casing stays meaningful.
console.log('\nTab-resolved tools still have tabs');
for (const t of TAB_RESOLVED) {
  const hasTabs = new RegExp('id="panel-' + t + '"').test(indexHtml) &&
    dataHelpKeys.some(k => k === t || k.indexOf(t + '-') === 0);
  ok(t + ' has per-tab help keys', hasTabs);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
