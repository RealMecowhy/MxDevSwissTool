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

// Pure — testable from scripts/parser-test.js without touching the DOM.
function regexReplacePreview(pattern, flags, test, replacement) {
  if (!pattern || replacement === '' || replacement === undefined || replacement === null) return null;
  try {
    const gFlags = flags.includes('g') ? flags : flags + 'g';
    const re = new RegExp(pattern, gFlags);
    return { result: test.replace(re, replacement), error: null };
  } catch (e) {
    return { result: null, error: e.message };
  }
}

function regexApplyPreset(id) {
  const preset = REGEX_PRESETS.find(p => p.id === id);
  if (!preset) return;
  document.getElementById('regex-input').value = preset.pattern;
  document.getElementById('regex-flags').value = preset.flags;
  regexTestMendixMode();
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

  if (!pat) {
    mEl.innerHTML = '<span style="color:var(--text-muted)">No pattern entered</span>';
    sEl.innerHTML = '';
    hEl.innerHTML = escHtml(test);
    if (replResultEl) replResultEl.innerHTML = '';
    return;
  }

  try {
    let evalPat = pat;
    if (isMatchMode) {
      evalPat = '^(?:' + pat + ')$';
    }

    const gFlags = flags.includes('g') ? flags : flags + 'g';
    const reHigh = new RegExp(evalPat, gFlags);

    let matchArr;
    let lastIdx = 0;
    let hl = '';
    let matchesCount = 0;

    while ((matchArr = reHigh.exec(test)) !== null) {
      if (matchArr[0].length === 0) {
        reHigh.lastIndex++;
        continue;
      }
      hl += escHtml(test.substring(lastIdx, matchArr.index));
      hl += '<mark style="background:#f8c555;color:#111;border-radius:2px">' + escHtml(matchArr[0]) + '</mark>';
      lastIdx = matchArr.index + matchArr[0].length;
      matchesCount++;
    }
    hl += escHtml(test.substring(lastIdx));
    hEl.innerHTML = hl + '<br/>';

    sEl.innerHTML = `<span class="badge ${matchesCount>0?'badge-success':'badge-danger'}">${matchesCount} match${matchesCount!==1?'es':''}</span>`;

    if (matchesCount === 0) {
      mEl.innerHTML = '<span style="color:var(--text-muted)">No matches found</span>';
    } else {
      const matches = [...test.matchAll(new RegExp(evalPat, gFlags))];
      let mHtml = '';
      matches.forEach((m, i) => {
        mHtml += `<div style="margin-bottom:var(--sp-2);padding-bottom:var(--sp-2);border-bottom:1px solid var(--border)">`;
        mHtml += `<div style="color:var(--accent);font-weight:600;margin-bottom:4px">Match ${i+1} <span style="color:var(--text-muted);font-weight:normal;font-size:0.7rem">(Index: ${m.index})</span></div>`;
        mHtml += `<div style="padding-left:var(--sp-2);border-left:2px solid var(--accent)">${escHtml(m[0])}</div>`;
        if (m.length > 1) {
          mHtml += `<div style="margin-top:4px;font-size:0.75rem;color:var(--text-secondary)">Groups:</div>`;
          for (let g = 1; g < m.length; g++) {
            if (m[g] !== undefined) mHtml += `<div style="padding-left:var(--sp-3)"><span style="color:var(--info)">$${g}:</span> ${escHtml(m[g])}</div>`;
          }
        }
        if (m.groups) {
          const names = Object.keys(m.groups).filter(n => m.groups[n] !== undefined);
          if (names.length) {
            mHtml += `<div style="margin-top:4px;font-size:0.75rem;color:var(--text-secondary)">Named groups:</div>`;
            names.forEach(n => { mHtml += `<div style="padding-left:var(--sp-3)"><span style="color:var(--info)">${escHtml(n)}:</span> ${escHtml(m.groups[n])}</div>`; });
          }
        }
        mHtml += `</div>`;
      });
      mEl.innerHTML = mHtml;
    }

  } catch (e) {
    mEl.innerHTML = '<span style="color:var(--danger)">Invalid regex: ' + escHtml(e.message) + '</span>';
    sEl.innerHTML = '';
    hEl.innerHTML = escHtml(test) + '<br/>';
  }

  if (replResultEl) {
    const replacement = replEl ? replEl.value : '';
    if (!replacement) {
      replResultEl.innerHTML = '';
    } else {
      const r = regexReplacePreview(pat, flags, test, replacement);
      replResultEl.innerHTML = r.error
        ? '<span style="color:var(--danger)">Invalid regex: ' + escHtml(r.error) + '</span>'
        : escHtml(r.result);
    }
  }
}

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.initRegexLibrary = initRegexLibrary;
window.regexTestMendixMode = regexTestMendixMode;
window.regexApplyPreset = regexApplyPreset;
window.REGEX_PRESETS = REGEX_PRESETS;
window.regexReplacePreview = regexReplacePreview;

export function init() {}
