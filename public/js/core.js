
// ============================================================
// TOOL REGISTRY
// ============================================================
function showLoader(text, percentage) {
  const el = document.getElementById('global-loader');
  if(el) {
    document.getElementById('global-loader-text').textContent = text || 'Processing...';
    el.style.display = 'flex';
    const track = el.querySelector('.universal-progress-track');
    const bar = document.getElementById('global-loader-bar');
    if (percentage !== undefined && track && bar) {
      track.style.display = 'block';
      bar.style.width = percentage + '%';
      if (percentage >= 100) setTimeout(() => track.style.display = 'none', 500);
    } else if (track) {
      track.style.display = 'none';
      if (bar) bar.style.width = '0%';
    }
  }
}
function hideLoader() {
  const el = document.getElementById('global-loader');
  if(el) el.style.display = 'none';
}

const TOOLS = [

  {id:'home',         label:'Home',                       desc:'All tools overview',                                                              color:'var(--accent)',   icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>', section:''},
  {id:'log-viewer',   label:'Mendix Log Viewer',           desc:'Browse, filter and search Mendix log files with time-range filtering',            color:'var(--info)',     icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>', section:'Diagnostics & Logs'},
  {id:'log-query-extractor', label:'Log Query Extractor',  desc:'Extract, parse and correlate executed SQL queries and XPath from Mendix TRACE logs', color:'#3498db', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12h18"/><path d="M3 19h18"/></svg>', section:'Diagnostics & Logs'},
  {id:'microflow-tracer', label:'Microflow Tracer',  desc:'Rebuild microflow executions, activity timelines and call trees from MicroflowEngine DEBUG/TRACE logs', color:'#9b59b6', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>', section:'Diagnostics & Logs'},
  {id:'ws-rest-extractor', label:'REST & WS Extractor',  desc:'Pair REST and SOAP requests with their responses from TRACE logs — headers, payloads, timings and the calling microflow', color:'#16a085', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>', section:'Diagnostics & Logs'},
  {id:'error-decoder', label:'Mendix Error Decoder',  desc:'Decode the mechanism behind a Mendix, Java or PostgreSQL error — what happened, typical causes and how to check which one applies', color:'#e84118', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="11.5"/><line x1="11" y1="14" x2="11.01" y2="14"/></svg>', section:'Diagnostics & Logs'},
  {id:'log-anonymizer', label:'Log & Text Anonymizer',             desc:'Anonymize sensitive data (emails, IPs, UUIDs, custom keywords) from arbitrary text and logs', color:'#e74c3c', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>', section:'Diagnostics & Logs'},
  {id:'nginx-log',    label:'Nginx Log Analyzer',          desc:'Analyze Nginx access logs to find top IPs, URLs, errors, and fetch GeoIP',       color:'#2ea043',         icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>', section:'Diagnostics & Logs'},
  {id:'telemetry-monitor', label:'Metrics & Telemetry',     desc:'Visualize Mendix Prometheus metrics and explore OpenTelemetry traces/logs locally or from cloud endpoints', color:'#ff9f43', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>', section:'Diagnostics & Logs'},
  {id:'har-analyzer', label:'Client Traffic (HAR)',         desc:'Decode a browser HAR into named Mendix operations to spot client-side N+1 and chatty microflows', color:'#3498db', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="5" width="3" height="13"/></svg>', section:'Diagnostics & Logs'},
  {id:'http-status',  label:'HTTP Status Codes',           desc:'Reference for HTTP status codes with Mendix context',                            color:'var(--info)',     icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>', section:'Diagnostics & Logs'},
  {id:'thread-dump',  label:'JVM Health Analyzer',   desc:'Thread dumps, GC logs and heap histograms — find blocked threads and memory leaks',         color:'var(--danger)',   icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>', section:'Diagnostics & Logs'},
  {id:'incident-report', label:'Incident Report',   desc:'Combine the data loaded across the diagnostics tools into one self-contained HTML report for a time window', color:'#6c5ce7', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>', section:'Diagnostics & Logs'},
  {id:'json-formatter',label:'JSON Formatter',             desc:'Format, validate and explore JSON with interactive tree view',                    color:'var(--success)',  icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',          section:'Data & Format'},
  {id:'xml-formatter', label:'XML Formatter',              desc:'Format, validate and explore XML with interactive tree view',                     color:'var(--info)',     icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13l3 3-3 3M16 19h-4"/></svg>',    section:'Data & Format'},
  {id:'char-sanitizer',label:'XML & Text Sanitizer',       desc:'Detect and fix hidden control characters, zero-width spaces, invalid XML tokens, and Mojibake', color:'#e67e22', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>', section:'Data & Format'},
  {id:'sql-formatter', label:'SQL Formatter',              desc:'Format and syntax-highlight SQL queries from Mendix ORM',                        color:'#7c85f3',         icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>', section:'Data & Format'},
  {id:'text-diff',     label:'Text Diff',                  desc:'Compare two text blocks with highlighted differences',                           color:'var(--success)',  icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',        section:'Data & Format'},
  {id:'encoder',       label:'Base64 / URL Encoder',       desc:'Encode and decode Base64, URL, and HTML entities',                              color:'#2ecc71',         icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',        section:'Data & Format'},
  {id:'md-preview',    label:'Markdown & Table Generator', desc:'Write and preview Markdown documentation and generate markdown tables',          color:'#95a5a6',            icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',            section:'Data & Format'},
  {id:'xpath-builder', label:'XPath Formatter',  desc:'Format and lint XPath queries, flagging index-blocking patterns',                color:'var(--accent)',   icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>',        section:'Data & Format'},
  {id:'query-intelligence', label:'Query Intelligence Suite', desc:'Consolidated OQL/SQL Analyzer, Visualizer, Index Advisor & N+1 Detector',        color:'#3498db',         icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3"/></svg>', section:'Mendix Platform'},
  {id:'odata-builder', label:'OData Builder',              desc:'Build OData queries for Published OData Services',                              color:'#2ecc71',         icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',        section:'Mendix Platform'},

  {id:'architecture',  label:'Domain Model & Architecture',desc:'Generate Class Diagrams (Mermaid) from JSON or pseudocode',                     color:'#5cb85c',         icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>', section:'Mendix Platform'},
  {id:'dev-studio',    label:'Developer Studio',           desc:'Connect and sync with local Mendix Studio Pro',                                 color:'#7f8c8d',         icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>', section:'Mendix Platform'},
  
  {id:'perf-lab',      label:'Performance Lab',            desc:'Simulate concurrent load on endpoints with latency tracking',                   color:'#e84393',         icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>',        section:'Performance & Testing'},

  {id:'mock-server',   label:'Mock Server & Chaos',         desc:'Simulate API endpoints with custom latency and chaos engineering',              color:'#e67e22',         icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>', section:'Performance & Testing'},

  {id:'data-factory',  label:'Data Factory',               desc:'High-Volume Mock Data Generator for performance testing and mock servers',      color:'#f39c12',         icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>', section:'Data & Format'},

  {id:'api-economics', label:'API Economics',              desc:'Analyze JSON payloads to optimize size and identify redundant fields',          color:'#2ecc71',         icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>', section:'Analytics & Estimation'},
  // WASM Profiler is a niche tool: hidden from sidebar/home, still reachable via Ctrl+K search
  {id:'wasm-profiler', label:'WASM Profiler',              desc:'Analyze WebAssembly traces and memory usage in Mendix Client',                  color:'#f1c40f',         icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 16 16 12 12 8"></polyline><line x1="8" y1="12" x2="16" y2="12"></line></svg>', section:'Analytics & Estimation', hidden:true},

  {id:'jwt-decoder',   label:'JWT Decoder',                desc:'Decode JWT tokens locally \u2013 private, nothing sent externally',             color:'#c792ea',         icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>', section:'Security & Tokens'},
  {id:'saml-debugger', label:'SAML / OIDC Debugger',       desc:'Decode SAML responses and OIDC id_tokens \u2013 inspect assertions, claims and validity locally', color:'#9b59b6', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><path d="M12 3l7 4v5c0 4.5-3 8-7 9-4-1-7-4.5-7-9V7z"/></svg>', section:'Security & Tokens'},
  {id:'hash-gen',      label:'Hash Generator',             desc:'Generate SHA-256, SHA-512, SHA-1 hashes in-browser',                           color:'#a29bfe',         icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>',             section:'Security & Tokens'},
  {id:'password-generator',label:'Password Generator',    desc:'Generate strong random passwords with customizable parameters',                  color:'#e17055',         icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>', section:'Security & Tokens'},
  {id:'regex-tester',  label:'Java Regex Tester (Mendix)', desc:'Test regular expressions behaving like Java Engine in Mendix',                 color:'var(--warning)',  icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',            section:'Utilities'},
  {id:'timestamp',     label:'Timestamp Converter',        desc:'Convert epoch, ISO 8601 and dates across timezones',                            color:'var(--accent)',   icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',        section:'Utilities'},

];

let currentTool = 'home';
window.currentTool = currentTool;

// ============================================================
// FAVORITES STATE & HELPERS
// ============================================================
let favoriteTools = [];
try {
  const stored = localStorage.getItem('mt-favorites');
  if (stored) favoriteTools = JSON.parse(stored);
} catch (e) {
  console.error("Error loading favorites", e);
}

function isFavorite(toolId) {
  return favoriteTools.includes(toolId);
}

function toggleFavorite(toolId) {
  const idx = favoriteTools.indexOf(toolId);
  if (idx > -1) {
    favoriteTools.splice(idx, 1);
  } else {
    favoriteTools.push(toolId);
  }
  try {
    localStorage.setItem('mt-favorites', JSON.stringify(favoriteTools));
  } catch (e) {}
  
  updateFavoritesUI(toolId);
}

function updateSidebarFavorites() {
  document.querySelectorAll('.nav-item').forEach(item => {
    const toolId = item.getAttribute('data-tool');
    if (!toolId || toolId === 'home') return;
    
    let star = item.querySelector('.sidebar-fav-star');
    const active = isFavorite(toolId);
    
    if (active) {
      if (!star) {
        star = document.createElement('span');
        star.className = 'sidebar-fav-star';
        star.innerHTML = '★';
        star.title = 'Favorite';
        star.setAttribute('aria-hidden', 'true');
        const badge = item.querySelector('.nav-badge');
        if (badge) {
          item.insertBefore(star, badge);
        } else {
          item.appendChild(star);
        }
      }
    } else {
      if (star) {
        star.remove();
      }
    }
  });
}

function updateFavoritesUI(toolId) {
  // Update header star button if active
  if (currentTool === toolId) {
    const btn = document.getElementById('header-fav-btn');
    if (btn) {
      const active = isFavorite(toolId);
      btn.classList.toggle('active', active);
      btn.innerHTML = active ? '★' : '☆';
      btn.title = active ? 'Remove from favorites' : 'Add to favorites';
      btn.setAttribute('aria-label', btn.title);
    }
  }

  // Update sidebar
  updateSidebarFavorites();

  // Update home grid
  buildHomeGrid();
}

// ============================================================
// NAVIGATION
// ============================================================
async function navigate(toolId, navEl) {
  // Guard: a stale mt-last-tool may reference a removed/merged panel
  if (toolId !== 'home' && !document.getElementById('panel-' + toolId)) {
    toolId = 'home';
    navEl = null;
  }
  // Any manual navigation invalidates a pending cross-tool "← Back" chip;
  // navigateWithReturn() suppresses this for the jump it initiates itself.
  if (!returnChipKeep) hideReturnChip();
  document.querySelectorAll('.tool-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById('panel-' + toolId);
  if (panel) panel.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => { n.classList.remove('active'); n.removeAttribute('aria-current'); });
  if (navEl) { navEl.classList.add('active'); navEl.setAttribute('aria-current', 'page'); }
  else { const el = document.querySelector('.nav-item[data-tool="'+toolId+'"]'); if (el) { el.classList.add('active'); el.setAttribute('aria-current', 'page'); } }
  const tool = TOOLS.find(t => t.id === toolId) || {label: toolId, section: ''};
  // The topbar is the single source of tool identity: icon, name and description all come
  // from the registry, so panels carry no header of their own.
  const iconEl = document.getElementById('topbar-icon');
  if (iconEl) {
    iconEl.innerHTML = tool.icon || '';
    iconEl.style.color = tool.color || 'var(--accent)';
  }
  document.getElementById('topbar-title').textContent = tool.label;
  document.getElementById('topbar-subtitle').textContent = (toolId === 'home') ? 'MxDev Swiss Tool v1.17.0' : (tool.desc || '');
  const previousTool = currentTool;
  currentTool = toolId;
  window.currentTool = currentTool;
  
  // Cleanup previous tool (e.g. stop polling intervals)
  if (previousTool && previousTool !== 'home' && toolModules[previousTool] && toolModules[previousTool].cleanup) {
    try { toolModules[previousTool].cleanup(); } catch(e) { console.warn('Cleanup error:', e); }
  }
  
  // Lazy load the tool script if not home
  if (toolId !== 'home') {
    try {
      showLoader(`Loading ${tool.label}...`);
      const module = toolModules[toolId];
      if (module && module.init) {
        module.init();
      }
    } catch (e) {
      console.error(`Failed to load module for tool: ${toolId}`, e);
    } finally {
      hideLoader();
    }
  }
  
  // Toggle help button
  const helpBtn = document.getElementById('topbar-help-btn');
  if (helpBtn) helpBtn.style.display = (toolId === 'home') ? 'none' : 'flex';
  
  // Single star button, owned by the topbar and re-pointed at whatever tool is active.
  const titleBar = document.getElementById('topbar-titlebar');
  if (titleBar) {
    let favBtn = document.getElementById('header-fav-btn');
    if (!favBtn) {
      favBtn = document.createElement('button');
      favBtn.type = 'button';
      favBtn.className = 'header-fav-btn';
      favBtn.id = 'header-fav-btn';
      titleBar.appendChild(favBtn);
    }
    favBtn.onclick = () => toggleFavorite(toolId);
    favBtn.style.display = (toolId === 'home') ? 'none' : '';
    const active = isFavorite(toolId);
    favBtn.classList.toggle('active', active);
    favBtn.innerHTML = active ? '★' : '☆';
    favBtn.title = active ? 'Remove from favorites' : 'Add to favorites';
    favBtn.setAttribute('aria-label', favBtn.title);
  }

  try { localStorage.setItem('mt-last-tool', toolId); } catch(e){}
}

// ============================================================
// CROSS-TOOL RETURN CHIP
// ============================================================
// Programmatic jumps between tools (LQE "Visualize Plan" → Query Intelligence,
// HAR → XPath Formatter, Log Viewer → Anonymizer) used to strand the user in the
// target tool. navigateWithReturn() shows a floating "← Back to X" pill that
// restores the previous tool; any manual navigation dismisses it.
let returnChipKeep = false;

function navigateWithReturn(toolId) {
  const fromId = currentTool;
  if (fromId === toolId || fromId === 'home') { navigate(toolId, null); return; }
  const fromTool = TOOLS.find(t => t.id === fromId);
  returnChipKeep = true;
  navigate(toolId, null);
  returnChipKeep = false;
  showReturnChip(fromId, fromTool ? fromTool.label : fromId);
}

function showReturnChip(toolId, label) {
  let chip = document.getElementById('return-chip');
  if (!chip) {
    chip = document.createElement('button');
    chip.type = 'button';
    chip.id = 'return-chip';
    chip.className = 'return-chip';
    document.body.appendChild(chip);
  }
  chip.textContent = '← Back to ' + label;
  chip.title = 'Return to ' + label + ' where you came from';
  chip.onclick = () => navigate(toolId, null);
  chip.style.display = '';
}

function hideReturnChip() {
  const chip = document.getElementById('return-chip');
  if (chip) chip.style.display = 'none';
}

// Expose core functions to window for inline HTML handlers
window.navigate = navigate;
window.navigateWithReturn = navigateWithReturn;
window.toggleSidebar = toggleSidebar;
window.toggleTheme = toggleTheme;
window.toggleFavorite = toggleFavorite;
window.showLoader = showLoader;
window.hideLoader = hideLoader;


function toggleSidebar() {
  document.getElementById('app').classList.toggle('collapsed');
  try { localStorage.setItem('mt-sb', document.getElementById('app').classList.contains('collapsed')); } catch(e){}
}

function toggleTheme() {
  const html = document.documentElement;
  const dark = html.getAttribute('data-theme') === 'dark';
  html.setAttribute('data-theme', dark ? 'light' : 'dark');
  document.getElementById('theme-label').textContent = dark ? 'Dark Mode' : 'Light Mode';
  try { localStorage.setItem('mt-theme', dark ? 'light' : 'dark'); } catch(e){}
  // Keep Mermaid diagrams in sync with the active theme (applies to new renders)
  if (window.mermaid) {
    window.mermaid.initialize({ startOnLoad: false, theme: dark ? 'default' : 'dark' });
  }
}

function createHomeCard(tool) {
  const card = document.createElement('div');
  card.className = 'home-tool-card';
  card.onclick = () => navigate(tool.id, null);
  
  const active = isFavorite(tool.id);
  
  card.innerHTML =
    '<button type="button" class="card-fav-btn' + (active ? ' active' : '') + '" title="' + (active ? 'Remove from favorites' : 'Add to favorites') + '" aria-label="' + (active ? 'Remove from favorites' : 'Add to favorites') + '" style="position:absolute;top:16px;right:16px;background:none;border:none;color:var(--text-muted);font-size:1.2rem;cursor:pointer;z-index:2;">' +
      (active ? '<span style="color:var(--accent)">★</span>' : '☆') +
    '</button>' +
    '<div class="home-tool-icon" style="background:var(--bg-elevated); width:50px;height:50px;border-radius:12px;display:flex;align-items:center;justify-content:center;margin-bottom:16px;border:1px solid ' + tool.color + '33">' +
      '<span style="font-size:1.5rem;color:'+tool.color+'">'+tool.icon+'</span>' +
    '</div>' +
    '<div class="home-tool-name">'+tool.label+'</div>' +
    '<div class="home-tool-desc">'+tool.desc+'</div>' +
    '<div style="margin-top:auto;padding-top:16px;font-size:0.8rem;color:var(--accent);font-weight:600;font-family:var(--font-mono)">Launch Module &#8594;</div>';
    
  const starBtn = card.querySelector('.card-fav-btn');
  starBtn.onclick = (e) => {
    e.stopPropagation();
    toggleFavorite(tool.id);
  };
  
  return card;
}

function buildHomeGrid() {
  const container = document.getElementById('home-tools-grid');
  if (!container) return;
  container.innerHTML = '';

  // Render favorites at the very top if any
  const starredTools = TOOLS.filter(t => favoriteTools.includes(t.id));
  if (starredTools.length > 0) {
    const favHeader = document.createElement('div');
    favHeader.className = 'home-section-header';
    favHeader.innerHTML = '⭐ Favorites';
    container.appendChild(favHeader);

    const favGrid = document.createElement('div');
    favGrid.className = 'home-grid-group';
    starredTools.forEach(tool => {
      favGrid.appendChild(createHomeCard(tool));
    });
    container.appendChild(favGrid);
  }

  // Fixed section order — must match the sidebar so both build the same mental map
  const SECTION_ORDER = ['Diagnostics & Logs', 'Performance & Testing', 'Data & Format', 'Mendix Platform', 'Analytics & Estimation', 'Security & Tokens', 'Utilities'];
  const sections = [];
  const bySection = {};
  TOOLS.filter(t => t.id !== 'home' && !t.hidden).forEach(tool => {
    const sec = tool.section || 'Other';
    if (!bySection[sec]) { bySection[sec] = []; sections.push(sec); }
    bySection[sec].push(tool);
  });
  sections.sort((a, b) => {
    const ia = SECTION_ORDER.indexOf(a), ib = SECTION_ORDER.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  sections.forEach(sec => {
    // Section header
    const header = document.createElement('div');
    header.className = 'home-section-header';
    header.textContent = sec;
    container.appendChild(header);

    // Grid row for this section
    const grid = document.createElement('div');
    grid.className = 'home-grid-group';
    bySection[sec].forEach(tool => {
      grid.appendChild(createHomeCard(tool));
    });
    container.appendChild(grid);
  });
}

import * as apiEconomics from './tools/api-economics.js';
import * as architecture from './tools/architecture.js';
import * as charSanitizer from './tools/char-sanitizer.js';
import * as dataFactory from './tools/data-factory.js';
import * as devStudio from './tools/dev-studio.js';
import * as diff from './tools/diff.js';
import * as encoder from './tools/encoder.js';
import * as harAnalyzer from './tools/har-analyzer.js';
import * as hash from './tools/hash.js';
import * as httpCodes from './tools/http-codes.js';
import * as json from './tools/json.js';
import * as jwt from './tools/jwt.js';
import * as logAnonymizer from './tools/log-anonymizer.js';
import * as logViewer from './tools/log-viewer.js';
// Side-effect import: attaches window.createMendixLogParser, shared by the Log Query
// Extractor (main thread + Web Worker) and future log-based tools.
import './tools/mendix-log-parser.js';
import * as logQueryExtractor from './tools/log-query-extractor.js';
import * as microflowTracer from './tools/microflow-tracer.js';
import * as wsRestExtractor from './tools/ws-rest-extractor.js';
import * as incidentReport from './tools/incident-report.js';
// Side-effect import: the Mendix Error Decoder attaches its pure edxDecode plus
// the paste-and-render UI handlers to window (no init(), like the log parser).
import './tools/error-decoder.js';
import * as markdown from './tools/markdown.js';
import * as memoryInspector from './tools/memory-inspector.js';
import * as miscMendix from './tools/misc-mendix.js';
import * as mockServer from './tools/mock-server.js';
import * as nginx from './tools/nginx.js';
import * as odata from './tools/odata.js';
import * as perfLab from './tools/perf-lab.js';
import * as regex from './tools/regex.js';
import * as samlDebugger from './tools/saml-debugger.js';
import * as sql from './tools/sql.js';
import * as telemetryMonitor from './tools/telemetry-monitor.js';
import * as timestamp from './tools/timestamp.js';

import * as wasmProfiler from './tools/wasm-profiler.js';
import * as xml from './tools/xml.js';
import * as xpath from './tools/xpath.js';

const toolModules = {
  'api-economics': apiEconomics,
  'architecture': architecture,
  'char-sanitizer': charSanitizer,
  'data-factory': dataFactory,
  'dev-studio': devStudio,
  'diff': diff,
  'text-diff': diff,
  'encoder': encoder,
  'har-analyzer': harAnalyzer,
  'hash': hash,
  'hash-gen': hash,
  'http-codes': httpCodes,
  'http-status': httpCodes,
  'json': json,
  'json-formatter': json,
  'jwt': jwt,
  'jwt-decoder': jwt,
  'log-anonymizer': logAnonymizer,
  'log-viewer': logViewer,
  'log-query-extractor': logQueryExtractor,
  'microflow-tracer': microflowTracer,
  'ws-rest-extractor': wsRestExtractor,
  'incident-report': incidentReport,
  'markdown': markdown,
  'md-preview': markdown,
  'memory-inspector': memoryInspector,
  'misc-mendix': miscMendix,
  'thread-dump': miscMendix,
  'query-intelligence': miscMendix,
  'password-generator': miscMendix,
  'mock-server': mockServer,
  'nginx': nginx,
  'nginx-log': nginx,
  'odata': odata,
  'odata-builder': odata,
  'perf-lab': perfLab,
  'regex': regex,
  'regex-tester': regex,
  'saml-debugger': samlDebugger,
  'sql': sql,
  'sql-formatter': sql,
  'telemetry-monitor': telemetryMonitor,
  'timestamp': timestamp,

  'wasm-profiler': wasmProfiler,
  'xml': xml,
  'xml-formatter': xml,
  'xpath': xpath,
  'xpath-builder': xpath,
};

import { initCommandPalette } from './components/command-palette.js';
import { initUpdateChecker } from './components/update-checker.js';
import { initWelcome } from './components/welcome.js';
import { initDbConnection } from './components/db-connection.js';
import './tools/utilities.js';
import './tools-help.js';
import './components/virtual-viewer.js';
// Side-effect import: attaches window.createVirtualList, the reusable fixed-height
// virtual row list used by the Log Query Extractor (and future row-heavy tools).
import './components/virtual-list.js';
// Side-effect import: attaches window.mtExport + the pure mtExportTo* builders —
// the shared CSV / Markdown / self-contained-HTML export helpers.
import './components/exporters.js';

function initCore() {
  // Reflect restored theme (set in index.html head) in the toggle label
  const themeLabel = document.getElementById('theme-label');
  if (themeLabel && document.documentElement.getAttribute('data-theme') === 'light') {
    themeLabel.textContent = 'Dark Mode';
  }
  updateSidebarFavorites();
  buildHomeGrid();
  initCommandPalette(TOOLS, navigate);
  initDbConnection();
  setupResponsiveSidebar();

  // Start global bridge status monitor
  checkBridgeStatus();
  setInterval(checkBridgeStatus, 5000);

  // First-run welcome tour; resolves immediately when already seen. The
  // update check waits for it so the two modals never stack on first launch.
  initWelcome().then(() => {
    // Check for a newer release once the UI has settled; stays silent when
    // offline, snoozed or already up to date.
    setTimeout(initUpdateChecker, 4000);
  });
}

// Auto-collapse the sidebar on narrow viewports, reusing the existing
// manual toggleSidebar()/.collapsed mechanism instead of a separate layout.
function setupResponsiveSidebar() {
  const mq = window.matchMedia('(max-width: 900px)');
  const applyState = (e) => {
    document.getElementById('app').classList.toggle('collapsed', e.matches);
  };
  mq.addEventListener('change', applyState);
  applyState(mq);
}

async function checkBridgeStatus() {
  const dot = document.getElementById('global-bridge-dot');
  const txt = document.getElementById('global-bridge-text');
  if (!dot || !txt) return;
  
  try {
    // Attempting to fetch from the Mendix Observability Bridge
    const res = await fetch('http://localhost:9999/detect-project', { 
      method: 'GET', 
      cache: 'no-store' 
    });
    if (res.ok) {
      dot.style.background = 'var(--success)';
      dot.style.boxShadow = '0 0 5px var(--success)';
      txt.textContent = 'Bridge Online';
      const dsBridgeInstruction = document.getElementById('ds-troubleshoot-bridge');
      if (dsBridgeInstruction) dsBridgeInstruction.style.display = 'none';
    } else {
      throw new Error('Not OK');
    }
  } catch (e) {
    dot.style.background = 'var(--danger)';
    dot.style.boxShadow = '0 0 5px var(--danger)';
    txt.textContent = 'Bridge Offline';
    const dsBridgeInstruction = document.getElementById('ds-troubleshoot-bridge');
    if (dsBridgeInstruction) dsBridgeInstruction.style.display = 'list-item';
  }
}

// Startup initialization
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCore);
} else {
  initCore();
}

// ============================================================
// UI Split View Manager
// ============================================================
window.uiSetView = function(splitId, viewMode, btn) {
  const container = document.getElementById(splitId);
  if (!container) return;

  if (btn) {
    const group = btn.closest('.btn-group');
    if (group) {
      group.querySelectorAll('.btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
    }
  }

  let leftPane, rightPane;
  if (splitId === 'anonymizer-split') {
      leftPane = container.querySelector('.anonymizer-grid-col-raw');
      rightPane = container.querySelector('.anonymizer-grid-col-output');
  } else {
      leftPane = container.children[0];
      rightPane = container.children[1];
  }

  if (!container.dataset.origGrid) {
      container.dataset.origGrid = window.getComputedStyle(container).gridTemplateColumns || '1fr 1fr';
  }

  if (viewMode === 'split') {
    container.style.gridTemplateColumns = container.dataset.origGrid !== 'none' ? container.dataset.origGrid : '1fr 1fr';
    container.style.gridTemplateRows = '';
    if (leftPane) leftPane.style.display = '';
    if (rightPane) rightPane.style.display = '';
  } else if (viewMode === 'raw') {
    if (splitId === 'anonymizer-split') {
      const isSettingsCollapsed = container.classList.contains('settings-collapsed');
      container.style.gridTemplateColumns = isSettingsCollapsed ? '0px 1fr' : '320px 1fr';
      container.style.gridTemplateRows = '1fr';
    } else {
      container.style.gridTemplateColumns = '1fr';
      container.style.gridTemplateRows = '1fr';
    }
    if (leftPane) leftPane.style.display = '';
    if (rightPane) rightPane.style.display = 'none';
  } else if (viewMode === 'result') {
    if (splitId === 'anonymizer-split') {
      const isSettingsCollapsed = container.classList.contains('settings-collapsed');
      container.style.gridTemplateColumns = isSettingsCollapsed ? '0px 1fr' : '320px 1fr';
      container.style.gridTemplateRows = '1fr';
    } else {
      container.style.gridTemplateColumns = '1fr';
      container.style.gridTemplateRows = '1fr';
    }
    if (leftPane) leftPane.style.display = 'none';
    if (rightPane) rightPane.style.display = '';
  }
};

// ============================================================
