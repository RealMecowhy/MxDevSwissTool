// JAVA REGEX TESTER (Mendix mode)
// ============================================================
// regexTestMendixMode moved in from misc-mendix.js (Fala 7.4) — this file was
// already the registered module for panel-regex-tester, just with its real
// logic living elsewhere. Purely mechanical, no behavior change.
function initRegexLibrary() {
  // Regex library removed
}

// Common Mendix/NL patterns for the preset dropdown (10.3). Each is a
// practical pattern, not a claim of full legal validity — BSN in particular
// says so explicitly, since a real BSN also needs the 11-proef checksum,
// which a regex alone cannot compute.
const REGEX_PRESETS = [
  { id: 'email', label: 'Email (practical)', pattern: "^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$", flags: '', note: 'Practical email shape, not full RFC 5322.' },
  { id: 'nl-phone', label: 'Dutch phone (mobile & landline)', pattern: '^(?:\\+31|0)[1-9][0-9]{8}$', flags: '', note: 'Accepts 06XXXXXXXX / +316XXXXXXXX and area-code landlines.' },
  { id: 'nl-bsn', label: 'Dutch BSN (format only)', pattern: '^[0-9]{9}$', flags: '', note: '9 digits only — a real BSN also needs the 11-proef checksum, which a regex cannot compute.' },
  { id: 'nl-iban', label: 'IBAN (Dutch, NL##BANK##########)', pattern: '^NL[0-9]{2}[A-Z]{4}[0-9]{10}$', flags: '', note: 'Dutch IBAN structure: NL + 2 check digits + 4-letter bank code + 10 digits.' },
  { id: 'mx-entity-path', label: 'Mendix entity/association path', pattern: '^([A-Za-z_]\\w*\\.[A-Za-z_]\\w*\\/)*[A-Za-z_]\\w*\\.[A-Za-z_]\\w*$', flags: '', note: 'Module.Entity, or an association chain like Module.Assoc1/Module.Assoc2/Module.Entity.' },
];

function regexApplyPreset(id) {
  const preset = REGEX_PRESETS.find(p => p.id === id);
  if (!preset) return;
  document.getElementById('regex-input').value = preset.pattern;
  document.getElementById('regex-flags').value = preset.flags;
  regexTestMendixMode();
}

// Pure and self-contained: it is stringified into the Worker below and called
// directly from scripts/parser-test.js. One matchAll pass yields everything
// the panel shows; `replacement` null means "no replace preview".
function regexRun(job) {
  try {
    const gFlags = job.flags.includes('g') ? job.flags : job.flags + 'g';
    const evalPat = job.isMatchMode ? '^(?:' + job.pattern + ')$' : job.pattern;
    const matches = [];
    for (const m of job.test.matchAll(new RegExp(evalPat, gFlags))) {
      matches.push({ index: m.index, text: m[0], groups: Array.prototype.slice.call(m, 1), named: m.groups ? Object.assign({}, m.groups) : null });
    }
    const replaced = (job.replacement === null || job.replacement === undefined) ? null
      : job.test.replace(new RegExp(job.pattern, gFlags), job.replacement);
    return { matches: matches, replaced: replaced, error: null };
  } catch (e) {
    return { matches: [], replaced: null, error: e.message };
  }
}

// A pattern like (a+)+$ can backtrack for minutes and JavaScript cannot
// interrupt a running match, so matching happens in a Worker that is
// terminated after REGEX_TIMEOUT_MS. A new keystroke also terminates a run
// that is still going: only the latest input is worth finishing.
const REGEX_TIMEOUT_MS = 2000;
let regexWorker = null;
let regexWorkerBusy = false;
let regexTimer = null;
let regexRunId = 0;

function regexStopWorker() {
  clearTimeout(regexTimer);
  if (regexWorker) { regexWorker.terminate(); regexWorker = null; }
  regexWorkerBusy = false;
}

function regexTestMendixMode() {
  const pat = document.getElementById('regex-input').value;
  const flags = document.getElementById('regex-flags').value;
  const test = document.getElementById('regex-test-str').value;
  const isMatchMode = document.getElementById('regex-ismatch-mode').checked;
  const mEl = document.getElementById('regex-matches');
  const sEl = document.getElementById('regex-stats');
  const hEl = document.getElementById('regex-highlight');
  const replEl = document.getElementById('regex-replacement');
  const replResultEl = document.getElementById('regex-replace-result');
  // An empty replacement is a real one (it removes every match), so the
  // preview is switched by its own checkbox, not by the field being filled.
  const replaceOn = document.getElementById('regex-replace-on').checked;
  document.getElementById('regex-replace-block').style.display = replaceOn ? '' : 'none';

  if (!pat) {
    regexStopWorker();
    mEl.innerHTML = '<span style="color:var(--text-muted)">No pattern entered</span>';
    sEl.innerHTML = '';
    hEl.innerHTML = escHtml(test);
    if (replResultEl) replResultEl.innerHTML = '';
    return;
  }

  if (regexWorkerBusy) regexStopWorker();
  if (!regexWorker) {
    const code = 'var regexRun = ' + regexRun.toString() + ';\n' +
      'self.onmessage = function(e) { var r = regexRun(e.data.job); r.id = e.data.id; self.postMessage(r); };';
    regexWorker = new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
  }
  const id = ++regexRunId;
  regexWorkerBusy = true;
  regexWorker.onmessage = function(e) {
    if (e.data.id !== id) return;
    clearTimeout(regexTimer);
    regexWorkerBusy = false;
    regexRender(e.data, test);
  };
  clearTimeout(regexTimer);
  regexTimer = setTimeout(function() {
    regexStopWorker();
    mEl.innerHTML = '<span style="color:var(--danger)">Pattern took longer than ' + (REGEX_TIMEOUT_MS / 1000) + ' s and was stopped — likely catastrophic backtracking (a repeated group inside another repetition, such as <code>(a+)+</code>).</span>';
    sEl.innerHTML = '<span class="badge badge-danger">stopped</span>';
    hEl.innerHTML = escHtml(test) + '<br/>';
    if (replResultEl) replResultEl.innerHTML = '';
  }, REGEX_TIMEOUT_MS);
  regexWorker.postMessage({ id: id, job: { pattern: pat, flags: flags, test: test, isMatchMode: isMatchMode, replacement: replaceOn ? replEl.value : null } });
}

function regexRender(res, test) {
  const mEl = document.getElementById('regex-matches');
  const sEl = document.getElementById('regex-stats');
  const hEl = document.getElementById('regex-highlight');
  const replResultEl = document.getElementById('regex-replace-result');

  if (res.error) {
    mEl.innerHTML = '<span style="color:var(--danger)">Invalid regex: ' + escHtml(res.error) + '</span>';
    sEl.innerHTML = '';
    hEl.innerHTML = escHtml(test) + '<br/>';
    if (replResultEl) replResultEl.innerHTML = '';
    return;
  }

  let lastIdx = 0;
  let hl = '';
  let matchesCount = 0;
  res.matches.forEach(m => {
    if (m.text.length === 0) return;
    hl += escHtml(test.substring(lastIdx, m.index));
    // The mark sits under the textarea's own text, so it only tints: a solid
    // fill made the light text of the dark theme unreadable.
    hl += '<mark style="background:rgba(248,197,85,.3);color:transparent;border-radius:2px;box-shadow:0 0 0 1px rgba(248,197,85,.85)">' + escHtml(m.text) + '</mark>';
    lastIdx = m.index + m.text.length;
    matchesCount++;
  });
  hl += escHtml(test.substring(lastIdx));
  hEl.innerHTML = hl + '<br/>';

  sEl.innerHTML = `<span class="badge ${matchesCount>0?'badge-success':'badge-danger'}">${matchesCount} match${matchesCount!==1?'es':''}</span>`;

  if (matchesCount === 0) {
    mEl.innerHTML = '<span style="color:var(--text-muted)">No matches found</span>';
  } else {
    let mHtml = '';
    res.matches.forEach((m, i) => {
      mHtml += `<div style="margin-bottom:var(--sp-2);padding-bottom:var(--sp-2);border-bottom:1px solid var(--border)">`;
      mHtml += `<div style="color:var(--accent);font-weight:600;margin-bottom:4px">Match ${i+1} <span style="color:var(--text-muted);font-weight:normal;font-size:0.7rem">(Index: ${m.index})</span></div>`;
      mHtml += `<div style="padding-left:var(--sp-2);border-left:2px solid var(--accent)">${escHtml(m.text)}</div>`;
      if (m.groups.length) {
        mHtml += `<div style="margin-top:4px;font-size:0.75rem;color:var(--text-secondary)">Groups:</div>`;
        m.groups.forEach((g, gi) => {
          if (g !== undefined) mHtml += `<div style="padding-left:var(--sp-3)"><span style="color:var(--info)">$${gi+1}:</span> ${escHtml(g)}</div>`;
        });
      }
      if (m.named) {
        const names = Object.keys(m.named).filter(n => m.named[n] !== undefined);
        if (names.length) {
          mHtml += `<div style="margin-top:4px;font-size:0.75rem;color:var(--text-secondary)">Named groups:</div>`;
          names.forEach(n => { mHtml += `<div style="padding-left:var(--sp-3)"><span style="color:var(--info)">${escHtml(n)}:</span> ${escHtml(m.named[n])}</div>`; });
        }
      }
      mHtml += `</div>`;
    });
    mEl.innerHTML = mHtml;
  }

  if (replResultEl) replResultEl.innerHTML = res.replaced === null ? '' : escHtml(res.replaced);
}

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.initRegexLibrary = initRegexLibrary;
window.regexTestMendixMode = regexTestMendixMode;
window.regexApplyPreset = regexApplyPreset;
window.REGEX_PRESETS = REGEX_PRESETS;
window.regexRun = regexRun;

export function init() {}
