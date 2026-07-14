// Syncs the app version displayed in the UI with package.json.
// Patches version strings in-place so the version is correct even when
// the bridge server is started directly (node server/...) without npm scripts.
const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const version = pkg.version;

const targets = [
  {
    file: path.join(__dirname, '..', 'public', 'index.html'),
    replacements: [
      [/MxDev Swiss Tool v\d+\.\d+(?:\.\d+)?/g, `MxDev Swiss Tool v${version}`],
      [/Developer Toolkit v\d+\.\d+(?:\.\d+)?/g, `Developer Toolkit v${version}`],
    ],
  },
  {
    file: path.join(__dirname, '..', 'public', 'js', 'core.js'),
    replacements: [
      [/MxDev Swiss Tool v\d+\.\d+(?:\.\d+)?/g, `MxDev Swiss Tool v${version}`],
    ],
  },
];

let changed = 0;
targets.forEach(({ file, replacements }) => {
  const original = fs.readFileSync(file, 'utf8');
  let updated = original;
  replacements.forEach(([re, replacement]) => {
    updated = updated.replace(re, replacement);
  });
  if (updated !== original) {
    fs.writeFileSync(file, updated);
    changed++;
    console.log(`[sync-app-version] ${path.basename(file)} -> v${version}`);
  }
});

if (changed === 0) {
  console.log(`[sync-app-version] All files already at v${version}`);
}
