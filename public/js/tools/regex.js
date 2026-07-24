// JAVA REGEX TESTER (Mendix mode)
// ============================================================
// regexTestMendixMode moved in from misc-mendix.js (Fala 7.4) — this file was
// already the registered module for panel-regex-tester, just with its real
// logic living elsewhere. Purely mechanical, no behavior change.
function initRegexLibrary() {
  // Regex library removed
}

function regexTestMendixMode() {
  const pat = document.getElementById('regex-input').value;
  const flags = document.getElementById('regex-flags').value;
  const test = document.getElementById('regex-test-str').value;
  const isMatchMode = document.getElementById('regex-ismatch-mode').checked;
  const mEl = document.getElementById('regex-matches');
  const sEl = document.getElementById('regex-stats');
  const hEl = document.getElementById('regex-highlight');

  if (!pat) {
    mEl.innerHTML = '<span style="color:var(--text-muted)">No pattern entered</span>';
    sEl.innerHTML = '';
    hEl.innerHTML = escHtml(test);
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
      return;
    }

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
      mHtml += `</div>`;
    });
    mEl.innerHTML = mHtml;

  } catch (e) {
    mEl.innerHTML = '<span style="color:var(--danger)">Invalid regex: ' + escHtml(e.message) + '</span>';
    sEl.innerHTML = '';
    hEl.innerHTML = escHtml(test) + '<br/>';
  }
}

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.initRegexLibrary = initRegexLibrary;
window.regexTestMendixMode = regexTestMendixMode;

export function init() {}
