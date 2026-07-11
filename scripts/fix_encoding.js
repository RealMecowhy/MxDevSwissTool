const fs = require('fs');

const path = 'c:/Users/mikol/Documents/Antigravity_Projects/MendixTools/js/tools-help.js';
let content = fs.readFileSync(path, 'utf8');

const functionStart = 'function showActiveToolHelp() {';
const startIdx = content.indexOf(functionStart);

if (startIdx !== -1) {
    // Keep everything before the function
    const beforeFunction = content.substring(0, startIdx);
    
    const newFunction = `function showActiveToolHelp() {
  let toolId = typeof currentTool !== 'undefined' ? currentTool : 'home';
  if (toolId === 'home') return;

  if (toolId === 'log-viewer') {
    const activeTab = document.querySelector('#panel-log-viewer .tabs .tab.active');
    if (activeTab) {
      if (activeTab.innerText.includes('Stream')) toolId = 'log-viewer-stream';
      else if (activeTab.innerText.includes('Correlation')) toolId = 'log-viewer-correlation';
      else if (activeTab.innerText.includes('Sequence')) toolId = 'log-viewer-sequence';
      else if (activeTab.innerText.includes('Gantt')) toolId = 'log-viewer-gantt';
      else toolId = 'log-viewer-stream';
    } else {
      toolId = 'log-viewer-stream';
    }
  }

  const helpData = TOOLS_HELP[toolId];
  if (!helpData) {
    alert('Help for this module is currently under construction.');
    return;
  }

  // Populate title
  document.getElementById('help-modal-title').textContent = 'Help: ' + helpData.title;

  // Build body HTML dynamically using premium styled blocks
  let html = '';

  // 1. Description
  html += \`
    <div class="help-section">
      <div style="display:flex; align-items:center; gap:var(--sp-2); margin-bottom:var(--sp-2); font-weight:600; color:var(--accent);">
        <span style="font-size:1.1rem;">⚙️</span> About this module and its purpose
      </div>
      <p style="color:var(--text-secondary); margin:0; font-size:0.85rem; line-height:1.6;">\${helpData.description}</p>
    </div>
  \`;

  // 2. How to get/prepare data
  if (helpData.howToGet) {
    html += \`
      <div class="help-section" style="background:var(--bg-elevated); padding:var(--sp-4); border-radius:var(--r-md); border:1px solid var(--border);">
        <div style="display:flex; align-items:center; gap:var(--sp-2); margin-bottom:var(--sp-2); font-weight:600; color:var(--info);">
          <span style="font-size:1.1rem;">📂</span> How to obtain / prepare input data
        </div>
        <div style="color:var(--text-secondary); margin:0; font-size:0.85rem; line-height:1.6;">\${helpData.howToGet}</div>
      </div>
    \`;
  }

  // 3. How to use
  if (helpData.howToUse) {
    html += \`
      <div class="help-section">
        <div style="display:flex; align-items:center; gap:var(--sp-2); margin-bottom:var(--sp-2); font-weight:600; color:var(--success);">
          <span style="font-size:1.1rem;">🚀</span> Step-by-step instructions
        </div>
        <div style="color:var(--text-secondary); margin:0; font-size:0.85rem; line-height:1.6;">\${helpData.howToUse}</div>
      </div>
    \`;
  }

  // 4. Interpretation (if exists)
  if (helpData.interpretation) {
    html += \`
      <div class="help-section" style="background:color-mix(in srgb, var(--warning) 8%, transparent); padding:var(--sp-4); border-radius:var(--r-md); border:1px solid color-mix(in srgb, var(--warning) 30%, transparent);">
        <div style="display:flex; align-items:center; gap:var(--sp-2); margin-bottom:var(--sp-2); font-weight:600; color:var(--warning);">
          <span style="font-size:1.1rem;">📊</span> Result interpretation and developer tips
        </div>
        <div style="color:var(--text-secondary); margin:0; font-size:0.85rem; line-height:1.6;">\${helpData.interpretation}</div>
      </div>
    \`;
  }

  document.getElementById('help-modal-body').innerHTML = html;

  // Open modal
  const overlay = document.getElementById('help-modal');
  if (overlay) overlay.classList.add('active');
}

function closeHelpModal() {
  const overlay = document.getElementById('help-modal');
  if (overlay) overlay.classList.remove('active');
}

// Add Escape key handler
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeHelpModal();
  }
});
`;

    content = beforeFunction + newFunction;
    fs.writeFileSync(path, content, 'utf8');
    console.log("Fixed showActiveToolHelp");
} else {
    console.log("Function not found");
}
