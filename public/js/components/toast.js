// Shared transient notification. Until now the app had exactly one toast
// implementation — tools/telemetry/alerts.js — and it is a different animal:
// a threshold alert stays on screen for as long as the threshold is breached,
// keyed by metric, dismissed when the value recovers. This one is the opposite:
// fire-and-forget, auto-expiring, for "that worked" / "that did not".
//
// Everything else in the app used alert(), which blocks the page, ignores the
// theme, and cannot be stacked. Worse, a failure with no alert() at all — a tool
// whose init() threw — produced no user-visible signal whatsoever.
//
// Positioned top-right under the 56px topbar, deliberately NOT bottom-right,
// which is where the telemetry threshold alerts live. The two can be on screen
// at once and must not overlap.

const MT_TOAST_LIFETIME = { error: 8000, warning: 6000, success: 3500, info: 4500 };
const MT_TOAST_MAX = 4;

const MT_TOAST_ICON = {
  error: '<path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="9"/>',
  warning: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  success: '<path d="M20 6 9 17l-5-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'
};

let mtToastHost = null;

function mtToastContainer() {
  if (mtToastHost && document.body.contains(mtToastHost)) return mtToastHost;
  mtToastHost = document.createElement('div');
  mtToastHost.id = 'mt-toast-container';
  // aria-live so a screen reader announces the message; the app has no other
  // live region, which is why a failed action was previously silent for anyone
  // not watching that corner of the screen.
  mtToastHost.setAttribute('role', 'status');
  mtToastHost.setAttribute('aria-live', 'polite');
  document.body.appendChild(mtToastHost);
  return mtToastHost;
}

// msg may be long (a stack-trace message, a parser complaint) — it is inserted as
// text, never HTML, because most callers pass strings built from file contents.
function mtToast(msg, type) {
  const kind = MT_TOAST_ICON[type] ? type : 'info';
  const text = String(msg == null ? '' : msg);
  if (!text) return;

  const host = mtToastContainer();

  // Collapse a repeat of the identical message into a counter instead of
  // stacking five copies — a loop that fails per row would otherwise bury the UI.
  const existing = Array.prototype.find.call(host.children, el => el.dataset.msg === text);
  if (existing) {
    const n = (parseInt(existing.dataset.count, 10) || 1) + 1;
    existing.dataset.count = String(n);
    const badge = existing.querySelector('.mt-toast-count');
    badge.textContent = '×' + n;
    badge.style.display = '';
    clearTimeout(Number(existing.dataset.timer));
    existing.dataset.timer = String(setTimeout(() => mtToastDismiss(existing), MT_TOAST_LIFETIME[kind]));
    return;
  }

  const el = document.createElement('div');
  el.className = 'mt-toast mt-toast-' + kind;
  el.dataset.msg = text;
  el.dataset.count = '1';
  el.innerHTML =
    '<svg class="mt-toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + MT_TOAST_ICON[kind] + '</svg>' +
    '<span class="mt-toast-msg"></span>' +
    '<span class="mt-toast-count" style="display:none"></span>' +
    '<button class="mt-toast-close" type="button" aria-label="Dismiss">&times;</button>';
  el.querySelector('.mt-toast-msg').textContent = text;
  el.querySelector('.mt-toast-close').onclick = () => mtToastDismiss(el);

  host.appendChild(el);
  while (host.children.length > MT_TOAST_MAX) mtToastDismiss(host.firstElementChild, true);

  el.dataset.timer = String(setTimeout(() => mtToastDismiss(el), MT_TOAST_LIFETIME[kind]));
  // Returns nothing on purpose: several call sites are written as
  // `return alert(msg);` to bail out of a function, and a void return keeps that
  // substitution behaviour-identical.
}

function mtToastDismiss(el, immediate) {
  if (!el || el.dataset.closing) return;
  clearTimeout(Number(el.dataset.timer));
  if (immediate) { el.remove(); return; }
  el.dataset.closing = '1';
  el.classList.add('mt-toast-out');
  setTimeout(() => el.remove(), 200);
}

if (typeof window !== 'undefined') {
  window.mtToast = mtToast;
  window.mtToastDismiss = mtToastDismiss;
}
