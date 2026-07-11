const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const rx = /on[a-z]+="[^"]*?\b([a-zA-Z0-9_]+)\s*\(/g;
let m;
const events = new Set();
while ((m = rx.exec(html)) !== null) {
  if (m[1] !== 'if') events.add(m[1]);
}
console.log('Found events:', [...events]);

const jsFiles = fs.readdirSync('js/tools').filter(f => f.endsWith('.js')).map(f => 'js/tools/' + f);
jsFiles.push('js/core.js', 'js/tools-help.js', 'js/components/command-palette.js', 'js/components/virtual-viewer.js');

const missing = [];
for (let ev of events) {
  let found = false;
  for (let file of jsFiles) {
    if (!fs.existsSync(file)) continue;
    const code = fs.readFileSync(file, 'utf8');
    if (code.includes('window.' + ev + ' =') || code.includes('window.' + ev + '=')) {
      found = true;
      break;
    }
  }
  if (!found) missing.push(ev);
}
console.log('Missing from window:', missing);
