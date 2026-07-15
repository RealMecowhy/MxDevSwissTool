// ============================================================
// WELCOME TOUR
// ============================================================
// One-time onboarding modal shown on the very first visit. It is a visual
// "table of contents" for the features users otherwise discover by accident:
// per-tool Help, favorites, the Ctrl+K palette and the local-only privacy
// model. Closing it in any way (button, X, overlay click) marks it as seen;
// it can always be reopened via the "Welcome tour" button on the Home screen
// (exposed as window.showWelcomeTour).

const SEEN_KEY = 'mt-welcome-seen';

function markSeen() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) {}
}

function hasSeen() {
  try { return !!localStorage.getItem(SEEN_KEY); } catch (e) { return false; }
}

const CARDS = [
  {
    color: 'var(--info)',
    icon: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    title: 'Built-in help on every tool',
    text: 'Every tool has a <strong>Help</strong> button in the top bar. It explains what the tool does and — where it matters — how to extract the input data: a HAR from browser DevTools, TRACE logs from Mendix, thread dumps from the JVM, and so on.'
  },
  {
    color: 'var(--accent)',
    icon: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    title: 'Pin your favorites',
    text: 'Click the <strong>☆ star</strong> next to a tool’s name (or on its Home card) to pin it. Favorites appear at the top of the Home screen and are marked in the sidebar, so your daily tools are always one click away.'
  },
  {
    color: 'var(--success)',
    icon: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    title: 'Jump anywhere with Ctrl+K',
    text: 'Press <kbd>Ctrl</kbd>+<kbd>K</kbd> anywhere to open the command palette and jump straight to any of the 25+ tools by typing a few letters of its name.'
  },
  {
    color: 'var(--danger)',
    icon: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>',
    title: '100% local & private',
    text: 'Everything runs in your browser (plus an optional local bridge on your machine). Logs, HAR files and tokens you paste <strong>never leave your computer</strong> — safe to use on restricted enterprise laptops.'
  }
];

function buildModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'welcome-modal';

  const cardsHtml = CARDS.map(c => `
    <div class="welcome-card">
      <div class="welcome-card-icon" style="color:${c.color};border-color:${c.color}44;background:linear-gradient(160deg, transparent, ${c.color === 'var(--accent)' ? 'var(--accent-subtle)' : 'transparent'})">${c.icon}</div>
      <div class="welcome-card-title">${c.title}</div>
      <div class="welcome-card-text">${c.text}</div>
    </div>`).join('');

  overlay.innerHTML = `
  <div class="modal modal-md welcome-modal" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
    <button class="modal-close welcome-close" id="welcome-close" aria-label="Close dialog"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div class="welcome-hero">
      <div class="welcome-hero-glow" aria-hidden="true"></div>
      <div class="welcome-hero-icon"><img src="/logo.png" alt=""></div>
      <h2 id="welcome-title">Welcome to MxDev Swiss Tool</h2>
      <p>A private, browser-based toolkit for Mendix developers.<br>Here is a 30-second orientation before you dive in.</p>
    </div>
    <div class="modal-body welcome-body">
      <div class="welcome-grid">${cardsHtml}</div>
      <div class="welcome-footnote">
        Also on board: dark / light theme, a collapsible sidebar and automatic update checks.
        You can reopen this tour anytime via <strong>Welcome tour</strong> on the Home screen.
      </div>
      <div class="welcome-actions">
        <button class="btn btn-primary" id="welcome-start-btn">Get started — don’t show again</button>
      </div>
    </div>
  </div>`;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('active'));
  return overlay;
}

// Opens the tour and resolves once it is closed. Any way of closing counts
// as "seen" — the Home screen button is the deliberate way back in.
function openWelcome() {
  return new Promise((resolve) => {
    const existing = document.getElementById('welcome-modal');
    if (existing) { resolve(); return; }
    const overlay = buildModal();
    const close = () => {
      markSeen();
      overlay.classList.remove('active');
      setTimeout(() => overlay.remove(), 250);
      resolve();
    };
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    document.getElementById('welcome-close').onclick = close;
    document.getElementById('welcome-start-btn').onclick = close;
  });
}

export function initWelcome() {
  window.showWelcomeTour = openWelcome;
  if (hasSeen()) return Promise.resolve();
  return openWelcome();
}
