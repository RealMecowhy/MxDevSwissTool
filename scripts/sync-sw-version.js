// Keeps public/service-worker.js in step with the actual build. Two jobs:
//
//   1. CACHE_NAME — must change every release, because `activate` deletes every
//      cache whose name differs. A stale name means the purge never runs and
//      offline users keep the previous version's assets forever.
//
//   2. The PRECACHE list — regenerated from the filesystem. It used to be eight
//      hand-written entries, so tools-help.js and all ~74 tool modules were only
//      cached opportunistically, after a successful online visit to each tool.
//      A tool you had never opened simply did not work offline, which the README
//      ("offline-first") promised it would. Generating the list means a tool
//      added later is covered without anyone remembering to add it here.
//
// Run from `prestart`, `prebuild` and the pre-push hook — see the note in the
// hook about why prebuild alone was not enough.
const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const root = path.join(__dirname, '..', 'public');
const swPath = path.join(root, 'service-worker.js');

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function urlsUnder(rel, filter) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return [];
  return walk(abs, [])
    .filter(filter)
    .map(f => '/' + path.relative(root, f).split(path.sep).join('/'))
    .sort();
}

const isJs = f => f.endsWith('.js');
const precache = [
  '/',
  '/index.html',
  '/manifest.json',
  '/logo.png',
  ...urlsUnder('styles', f => f.endsWith('.css')),
  ...urlsUnder('js', isJs)
];

const listSrc = precache.map(u => "  '" + u + "'").join(',\n');

let sw = fs.readFileSync(swPath, 'utf8');
const before = sw;

sw = sw.replace(
  /const CACHE_NAME = '[^']*';/,
  `const CACHE_NAME = 'mxdev-swiss-tool-v${pkg.version}';`
);

const marked = /(\/\/ PRECACHE_START[^\n]*\n)[\s\S]*?(\/\/ PRECACHE_END)/;
if (!marked.test(sw)) {
  console.error('[sync-sw-version] PRECACHE_START/END markers missing in service-worker.js — refusing to guess.');
  process.exit(1);
}
sw = sw.replace(marked, `$1const PRECACHE = [\n${listSrc}\n];\n$2`);

if (sw !== before) {
  fs.writeFileSync(swPath, sw);
  console.log(`[sync-sw-version] CACHE_NAME v${pkg.version}, precache ${precache.length} entries`);
} else {
  console.log(`[sync-sw-version] already up to date (v${pkg.version}, ${precache.length} entries)`);
}
