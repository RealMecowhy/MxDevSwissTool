// In-app yes/no question, replacing the browser's confirm() (review UX-05).
// confirm() blocks the whole page, ignores the theme and cannot say what the
// buttons do — "OK" to replace a loaded log reads the same as "OK" to cancel.
//
// Resolves true or false; never rejects. Built as a .modal-overlay so a11y.js
// gives it focus on open, a Tab trap, Escape (which clicks .modal-close, i.e.
// "no") and focus return — none of that is re-implemented here.
//
// One dialog at a time: a second call while one is open answers the first "no",
// so a stale question can never be answered by a later click.

let mtConfirmPending = null;

function mtConfirm(message, opts) {
  opts = opts || {};
  if (mtConfirmPending) mtConfirmPending(false);

  let overlay = document.getElementById('mt-confirm');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'mt-confirm';
    overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-labelledby', 'mt-confirm-title');
    overlay.setAttribute('aria-describedby', 'mt-confirm-msg');
    overlay.innerHTML =
      '<div class="modal" style="max-width:460px">' +
        '<div class="modal-header">' +
          '<span id="mt-confirm-title" style="font-weight:600"></span>' +
          '<button class="modal-close" type="button" aria-label="Cancel" data-mt-confirm="close">&times;</button>' +
        '</div>' +
        '<div class="modal-body" style="font-size:0.85rem; line-height:1.55;">' +
          '<p id="mt-confirm-msg" style="margin-top:0"></p>' +
          '<div style="display:flex; gap:var(--sp-2); justify-content:flex-end; margin-top:var(--sp-4);">' +
            '<button class="btn btn-ghost btn-sm" type="button" data-mt-confirm="cancel"></button>' +
            '<button class="btn btn-primary btn-sm" type="button" data-mt-confirm="ok"></button>' +
          '</div>' +
        '</div>' +
      '</div>';
    overlay.addEventListener('click', function (e) {
      const role = e.target.getAttribute && e.target.getAttribute('data-mt-confirm');
      if (role === 'ok') mtConfirmAnswer(true);
      else if (role === 'cancel' || role === 'close' || e.target === overlay) mtConfirmAnswer(false);
    });
    document.body.appendChild(overlay);
  }

  overlay.querySelector('#mt-confirm-title').textContent = opts.title || 'Are you sure?';
  overlay.querySelector('#mt-confirm-msg').textContent = String(message || '');
  overlay.querySelector('[data-mt-confirm="ok"]').textContent = opts.confirmLabel || 'Continue';
  overlay.querySelector('[data-mt-confirm="cancel"]').textContent = opts.cancelLabel || 'Cancel';

  return new Promise(function (resolve) {
    mtConfirmPending = function (answer) {
      mtConfirmPending = null;
      overlay.classList.remove('active');
      resolve(answer);
    };
    overlay.classList.add('active');
  });
}

function mtConfirmAnswer(answer) {
  if (mtConfirmPending) mtConfirmPending(answer);
}

if (typeof window !== 'undefined') {
  window.mtConfirm = mtConfirm;
}
