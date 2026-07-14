const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'public', 'js', 'vendor');
const destDir = path.join(__dirname, '..', 'dist', 'js', 'vendor');

fs.mkdirSync(destDir, { recursive: true });
for (const file of fs.readdirSync(srcDir)) {
  fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
}

console.log(`[copy-vendor] Copied ${fs.readdirSync(srcDir).length} file(s) from public/js/vendor to dist/js/vendor`);
