const fs = require('fs');

const indexHtml = fs.readFileSync('index.html', 'utf-8');
const coreJs = fs.readFileSync('js/core.js', 'utf-8');

// Extract all tools and their SVGs from index.html
const toolRegex = /<div class="nav-item"\s+data-tool="([^"]+)"[^>]*>[\s\S]*?<span class="nav-icon">(<svg[^>]*>[\s\S]*?<\/svg>)<\/span>/g;
const icons = {};
let match;
while ((match = toolRegex.exec(indexHtml)) !== null) {
  icons[match[1]] = match[2].replace(/\n/g, '').replace(/\s+/g, ' ');
}

// Ensure Home icon is present
icons['home'] = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';

// Replace icons in core.js TOOLS array
const toolsArrayRegex = /const TOOLS = \[([\s\S]*?)\];/;
const toolsMatch = coreJs.match(toolsArrayRegex);

if (toolsMatch) {
  let toolsContent = toolsMatch[1];
  
  // Replace the icon field in each tool
  // {id:'log-viewer', ..., icon:'\uD83D\uDCCB', ...}
  toolsContent = toolsContent.replace(/({id:'([^']+)',.*?icon:)'[^']+'(,.*})/g, (fullMatch, prefix, id, suffix) => {
    const newIcon = icons[id];
    if (newIcon) {
      // Escape single quotes if any
      const escapedIcon = newIcon.replace(/'/g, "\\'");
      return `${prefix}'${escapedIcon}'${suffix}`;
    }
    return fullMatch;
  });

  const newCoreJs = coreJs.replace(toolsArrayRegex, `const TOOLS = [\n${toolsContent}\n];`);
  fs.writeFileSync('js/core.js', newCoreJs);
  console.log("Successfully updated core.js with modern SVGs.");
} else {
  console.log("Could not find TOOLS array in core.js");
}
