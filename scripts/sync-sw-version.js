const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const swPath = path.join(__dirname, '..', 'public', 'service-worker.js');

const sw = fs.readFileSync(swPath, 'utf8');
const updated = sw.replace(
  /const CACHE_NAME = '[^']*';/,
  `const CACHE_NAME = 'mxdev-swiss-tool-v${pkg.version}';`
);

if (updated !== sw) {
  fs.writeFileSync(swPath, updated);
  console.log(`[sync-sw-version] CACHE_NAME set to mxdev-swiss-tool-v${pkg.version}`);
} else {
  console.log(`[sync-sw-version] CACHE_NAME already up to date (v${pkg.version})`);
}
