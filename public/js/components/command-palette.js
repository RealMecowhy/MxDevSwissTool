export function initCommandPalette(toolsList, navigateFn) {
  // Create modal HTML
  const modalHTML = `
    <div class="modal-overlay" id="cmd-palette-modal" style="align-items:flex-start; padding-top:10vh; backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);">
      <div class="modal" style="max-width:600px; width:90%; background:var(--bg-elevated); backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px); border:1px solid var(--border); border-radius:var(--r-xl); box-shadow:var(--shadow-lg);">
        <div style="display:flex; align-items:center; padding:var(--sp-3); border-bottom:1px solid var(--border);">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--text-secondary)" stroke-width="2" style="margin-right:var(--sp-2)"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" id="cmd-palette-input" placeholder="Search tools... (e.g. JSON, XML, Log)" style="flex:1; background:transparent; border:none; color:var(--text-primary); font-size:1.1rem; outline:none;" autocomplete="off">
          <div style="font-size:0.7rem; color:var(--text-secondary); background:var(--bg-base); padding:2px 6px; border-radius:var(--r-sm); border:1px solid var(--border);">ESC</div>
        </div>
        <div id="cmd-palette-results" style="max-height:400px; overflow-y:auto; padding:var(--sp-2);">
          <!-- Results populated here -->
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHTML);

  const modal = document.getElementById('cmd-palette-modal');
  const input = document.getElementById('cmd-palette-input');
  const resultsContainer = document.getElementById('cmd-palette-results');
  let selectedIndex = 0;
  let currentResults = [];

  const globalActions = [
    {
      id: 'action-export',
      label: 'Export current view...',
      desc: 'Export data or results from the currently active tool',
      color: 'var(--success)',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
      section: 'Actions',
      isAction: true,
      execute: () => {
        const activePanel = document.querySelector('.tool-panel.active');
        if (!activePanel) {
          alert('No active tool.');
          return;
        }
        const exportSelectors = [
          'button[id*="export" i]',
          'button[title*="export" i]',
          'button[class*="export" i]',
          '.export-btn'
        ];
        const exportBtn = activePanel.querySelector(exportSelectors.join(', '));
        if (exportBtn) {
          exportBtn.click();
        } else {
          alert('No export action found for the current tool.');
        }
      }
    },
    {
      id: 'action-load',
      label: 'Load file into...',
      desc: 'Load a file into the currently active tool',
      color: 'var(--info)',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
      section: 'Actions',
      isAction: true,
      execute: () => {
        const activePanel = document.querySelector('.tool-panel.active');
        if (!activePanel) {
          alert('No active tool.');
          return;
        }
        const loadSelectors = [
          'input[type="file"]',
          'button[id*="load" i]',
          'button[title*="load" i]',
          '.load-btn'
        ];
        const loadBtn = activePanel.querySelector(loadSelectors.join(', '));
        if (loadBtn) {
          loadBtn.click();
        } else {
          alert('No file load action found for the current tool.');
        }
      }
    }
  ];

  function isOpen() {
    return modal.classList.contains('active');
  }

  function openPalette() {
    modal.classList.add('active');
    input.value = '';
    renderResults('');
    setTimeout(() => input.focus(), 50);
  }

  function closePalette() {
    modal.classList.remove('active');
  }

  function renderResults(query) {
    const lowerQuery = query.toLowerCase();
    const allItems = [...toolsList, ...globalActions];
    
    currentResults = allItems.filter(t => 
      t.id !== 'home' && (
      t.label.toLowerCase().includes(lowerQuery) || 
      t.desc.toLowerCase().includes(lowerQuery) ||
      t.section.toLowerCase().includes(lowerQuery))
    );

    selectedIndex = 0;
    
    if (currentResults.length === 0) {
      resultsContainer.innerHTML = '<div style="padding:var(--sp-3); color:var(--text-secondary); text-align:center;">No tools found.</div>';
      return;
    }

    resultsContainer.innerHTML = currentResults.map((t, idx) => `
      <div class="cmd-result-item ${idx === 0 ? 'active' : ''}" data-idx="${idx}" style="display:flex; align-items:center; padding:var(--sp-2) var(--sp-3); cursor:pointer; border-radius:var(--r-md); margin-bottom:2px;">
        <span style="font-size:1.2rem; color:${t.color}; margin-right:var(--sp-3); width:24px; text-align:center;">${t.icon}</span>
        <div style="flex:1;">
          <div style="font-weight:600; color:var(--text);">${t.label}</div>
          <div style="font-size:0.75rem; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${t.desc}</div>
        </div>
        <div style="font-size:0.7rem; color:var(--text-secondary);">${t.section}</div>
      </div>
    `).join('');

    // Add click events
    resultsContainer.querySelectorAll('.cmd-result-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.getAttribute('data-idx'));
        executeResult(idx);
      });
      el.addEventListener('mouseenter', () => {
        updateSelection(parseInt(el.getAttribute('data-idx')));
      });
    });
    
    updateSelection(0);
  }

  function updateSelection(idx) {
    if (currentResults.length === 0) return;
    selectedIndex = Math.max(0, Math.min(idx, currentResults.length - 1));
    resultsContainer.querySelectorAll('.cmd-result-item').forEach((el, i) => {
      if (i === selectedIndex) {
        el.style.background = 'var(--bg-active)';
        el.scrollIntoView({ block: 'nearest' });
      } else {
        el.style.background = 'transparent';
      }
    });
  }

  function executeResult(idx) {
    if (currentResults[idx]) {
      closePalette();
      if (currentResults[idx].isAction) {
        currentResults[idx].execute();
      } else {
        navigateFn(currentResults[idx].id, null);
      }
    }
  }

  // Allow opening from UI elements (e.g. topbar Search button)
  window.openCommandPalette = openPalette;

  // Event Listeners
  input.addEventListener('input', (e) => renderResults(e.target.value));
  
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      updateSelection(selectedIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      updateSelection(selectedIndex - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      executeResult(selectedIndex);
    }
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closePalette();
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (isOpen()) closePalette();
      else openPalette();
    }
    if (e.key === 'Escape' && isOpen()) {
      closePalette();
    }
  });
}
