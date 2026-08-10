// KEYBOARD & SCREEN-READER SUPPORT
// ============================================================
// The application drives almost everything from inline onclick on <span>/<div>
// (355 handlers), which mouse users never notice and keyboard users cannot reach
// at all. Rather than editing ~60 markup sites — and depending on every future
// one remembering — this works by observation:
//
//   * decorate: the two families that are genuinely controls (sortable column
//     headers carrying data-sort-key, and the level/status filter chips) get
//     role + tabindex + aria-pressed, in the DOM and again whenever new ones
//     are rendered;
//   * activate: one delegated keydown turns Enter/Space into a click for
//     anything carrying role="button", so the decoration is all it takes;
//   * modals: a MutationObserver watches `.active` on every .modal-overlay, so
//     focus trapping, focus restoration and Escape work for all eight dialogs
//     including the three built at runtime, without touching their open/close
//     functions.
//
// The one thing observation cannot fix is that a closed .modal-overlay stays in
// the tab order — it is `opacity:0` with layout intact. That is fixed in CSS
// (visibility), because it must hold before this module ever runs.

const A11Y_FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Element focus is restored to whatever had it when a dialog opened, keyed by
// the overlay, so stacked dialogs unwind in the right order.
const a11yReturnFocus = new WeakMap();

// Rendered at all — this is a layout test, which catches `display:none` (how the
// tool panels and tab panes are hidden). Whether the containing dialog is open is
// answered by its `active` class, not by measuring, so this deliberately does not
// consult computed visibility: it is read while a dialog is opening, and the
// inherited `visibility` on descendants lags the class change by a frame.
function a11yVisible(el) {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function a11yFocusable(root) {
  return Array.prototype.filter.call(root.querySelectorAll(A11Y_FOCUSABLE), a11yVisible);
}

function a11yOpenModals() {
  return Array.prototype.slice.call(document.querySelectorAll('.modal-overlay.active'));
}

// Topmost = last opened. The overlays are siblings at the end of <body> and the
// runtime-built ones are appended, so document order is open order.
function a11yTopModal() {
  const open = a11yOpenModals();
  return open.length ? open[open.length - 1] : null;
}

// Decorates the control families that are <span>/<div> rather than <button>.
// Idempotent, so it can run again after any render.
function mtA11yDecorate(root) {
  const scope = root || document;

  scope.querySelectorAll('[data-sort-key]').forEach(function (el) {
    if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') return;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    // The visible label is the column name; the title says what clicking does.
    if (!el.getAttribute('aria-label')) {
      el.setAttribute('aria-label', 'Sort by ' + (el.textContent || '').trim());
    }
  });

  scope.querySelectorAll('.level-filter-btn').forEach(function (el) {
    if (el.tagName === 'BUTTON') return;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-pressed', el.classList.contains('active') ? 'true' : 'false');
  });

  // The remaining single controls written as <span>/<div> with an inline handler
  // (scroll-to-top, expand-all, the "slowest call" shortcuts, card toggles).
  // Two are excluded deliberately: a dialog backdrop, whose handler starts with
  // `if (event.target === this)` and is a click convenience rather than a
  // control, and any wrapper that already contains something focusable — putting
  // both in the tab order would make Tab stop twice for one action.
  scope.querySelectorAll('span[onclick], div[onclick]').forEach(function (el) {
    if (el.getAttribute('role')) return;
    if (/^\s*if\s*\(/.test(el.getAttribute('onclick') || '')) return;
    if (el.querySelector(A11Y_FOCUSABLE)) return;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
  });
}

// Enter/Space on anything we marked as a button. Space is prevented so the page
// does not scroll underneath the control the user just activated.
function a11yKeyActivate(e) {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  const el = e.target;
  if (!el || !el.getAttribute || el.getAttribute('role') !== 'button') return;
  if (el.tagName === 'BUTTON' || el.tagName === 'A') return; // native already does this
  e.preventDefault();
  el.click();
}

// Escape closes the topmost dialog by clicking its own close control, so each
// modal's cleanup runs instead of the class merely being stripped. Two dialogs
// (command palette, help) handle Escape themselves and are left alone.
function a11yKeyEscape(e) {
  if (e.key !== 'Escape') return;
  const modal = a11yTopModal();
  if (!modal) return;
  if (modal.id === 'cmd-palette-modal' || modal.id === 'help-modal') return;
  const close = modal.querySelector('.modal-close');
  if (close) { e.preventDefault(); close.click(); }
}

// Tab cycles inside the open dialog instead of walking off into the page behind
// it. Without this, tabbing out of a dialog lands on the tool underneath with no
// way back and no visible focus.
function a11yKeyTrap(e) {
  if (e.key !== 'Tab') return;
  const modal = a11yTopModal();
  if (!modal) return;
  const items = a11yFocusable(modal);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault(); first.focus();
  }
}

function a11yModalOpened(overlay) {
  a11yReturnFocus.set(overlay, document.activeElement);
  if (!overlay.getAttribute('role')) overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  // Focus cannot be moved in this tick. Dialogs are hidden with `visibility` so
  // that closed ones leave the tab order, and although the overlay computes
  // visible the moment `active` lands, the value inherited by its descendants
  // only catches up after a paint — and a browser silently refuses to focus an
  // element that computes hidden.
  //
  // Rather than betting on a fixed number of frames, try and verify: if focus
  // did not take, the dialog was not ready yet, so try again next frame. Bounded
  // so a dialog with nothing focusable cannot spin.
  let attempts = 8;
  (function focusIn() {
    if (!overlay.classList.contains('active')) return; // opened and closed again meanwhile
    // The first control that is not the close button, so a dialog opens on its
    // content rather than on the way out of it; the close button is the fallback
    // when the dialog has nothing else to focus.
    const items = a11yFocusable(overlay);
    const target = items.filter(function (el) { return !el.classList.contains('modal-close'); })[0] || items[0];
    if (target) {
      target.focus();
      if (document.activeElement === target) return;
    }
    if (--attempts > 0) requestAnimationFrame(focusIn);
  })();
}

function a11yModalClosed(overlay) {
  overlay.removeAttribute('aria-modal');
  const back = a11yReturnFocus.get(overlay);
  a11yReturnFocus.delete(overlay);
  // Only restore if that element is still in the document and still focusable —
  // a dialog opened from a row that has since been re-rendered has nothing to
  // go back to, and focusing a detached node silently drops focus to <body>.
  if (back && back.isConnected && a11yVisible(back)) back.focus();
}

export function initA11y() {
  mtA11yDecorate(document);
  window.mtA11yDecorate = mtA11yDecorate;

  document.addEventListener('keydown', a11yKeyActivate);
  document.addEventListener('keydown', a11yKeyEscape);
  document.addEventListener('keydown', a11yKeyTrap);

  // One observer covers the dialogs (open/close) and the filter chips
  // (pressed state), because both are expressed the same way: a class change.
  const obs = new MutationObserver(function (records) {
    records.forEach(function (rec) {
      const el = rec.target;
      if (el.classList.contains('modal-overlay')) {
        const open = el.classList.contains('active');
        const was = el.getAttribute('aria-modal') === 'true';
        if (open && !was) a11yModalOpened(el);
        else if (!open && was) a11yModalClosed(el);
      } else if (el.classList.contains('level-filter-btn')) {
        el.setAttribute('aria-pressed', el.classList.contains('active') ? 'true' : 'false');
      }
    });
  });
  obs.observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });

  // Dialogs built at runtime are appended already carrying `.active`, which is
  // an added node rather than a changed attribute — the observer above never
  // sees it. Watch for those separately.
  const added = new MutationObserver(function (records) {
    records.forEach(function (rec) {
      Array.prototype.forEach.call(rec.addedNodes, function (n) {
        if (n.nodeType === 1 && n.classList && n.classList.contains('modal-overlay') &&
            n.classList.contains('active')) a11yModalOpened(n);
      });
    });
  });
  added.observe(document.body, { childList: true });
}
