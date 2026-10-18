// TEXT DIFF
// ============================================================
// Normalizes a line for comparison only — the original raw text (with its
// real whitespace) is always what gets rendered, "ignore whitespace" just
// changes which lines are considered equal.
function diffNormalizeLine(line, ignoreWs) {
  return ignoreWs ? line.trim().replace(/\s+/g, ' ') : line;
}

function diffCompare() {
  const a=document.getElementById('diff-a').value, b=document.getElementById('diff-b').value;
  const statsEl=document.getElementById('diff-stats');
  if (!a&&!b) { document.getElementById('diff-out-a').innerHTML=''; document.getElementById('diff-out-b').innerHTML=''; if(statsEl) statsEl.innerHTML=''; return; }
  const ignoreWs = document.getElementById('diff-ignore-ws') ? document.getElementById('diff-ignore-ws').checked : false;
  const keyFn = line => diffNormalizeLine(line, ignoreWs);
  const lA=a.split('\n'), lB=b.split('\n'), diffs=computeDiff(lA,lB,keyFn);
  if (diffs.tooLarge) {
    document.getElementById('diff-out-a').innerHTML=''; document.getElementById('diff-out-b').innerHTML='';
    if (statsEl) statsEl.textContent=diffTooLargeMessage(diffs);
    return;
  }
  const col = [];
  let bA=[], bB=[], pairBudget=DIFF_PAIR_MAX_CELLS;
  const flush = () => {
    const m = bA.length, n = bB.length;
    // Pairing changed lines costs a character-level comparison per cell (about
    // 0.3 ms for two 150-character lines), so one comparison has a budget of
    // cells; a block that does not fit is shown as removed-then-added.
    if (m * n <= pairBudget) pairBudget -= m * n;
    else {
      bA.forEach(l => col.push(['removed', l]));
      bB.forEach(l => col.push(['added', l]));
      bA=[]; bB=[];
      return;
    }
    const dp = Array.from({length: m + 1}, () => new Array(n + 1).fill(0));
    const sim = Array.from({length: m}, () => new Array(n).fill(0));
    
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < n; j++) {
        const s1 = bA[i].substring(0, 150), s2 = bB[j].substring(0, 150);
        let simScore = 0;
        if (s1 === s2) {
          simScore = bA[i] === bB[j] ? 1 : 0.9;
        } else {
          const l1 = s1.length, l2 = s2.length;
          if (l1 === 0 && l2 === 0) simScore = 1;
          else if (l1 > 0 && l2 > 0) {
            let prev = new Array(l2 + 1).fill(0);
            let curr = new Array(l2 + 1).fill(0);
            for (let x = 1; x <= l1; x++) {
              for (let y = 1; y <= l2; y++) {
                if (s1[x - 1] === s2[y - 1]) curr[y] = prev[y - 1] + 1;
                else curr[y] = Math.max(prev[y], curr[y - 1]);
              }
              let t = prev; prev = curr; curr = t;
            }
            simScore = prev[l2] / Math.max(l1, l2);
          }
        }
        sim[i][j] = simScore;
      }
    }

    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (sim[i][j] >= 0.4) {
          dp[i][j] = dp[i + 1][j + 1] + sim[i][j];
        } else {
          dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }

    let i = 0, j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && sim[i][j] >= 0.4 && Math.abs(dp[i][j] - (dp[i + 1][j + 1] + sim[i][j])) < 1e-6) {
        col.push(['mod', bA[i], bB[j]]);
        i++; j++;
      } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
        col.push(['added', bB[j]]);
        j++;
      } else {
        col.push(['removed', bA[i]]);
        i++;
      }
    }
    bA=[]; bB=[];
  };
  
  for(let i=0;i<diffs.length;i++) {
    if(diffs[i][0]==='removed') bA.push(diffs[i][1]);
    else if(diffs[i][0]==='added') bB.push(diffs[i][1]);
    else { flush(); col.push(diffs[i]); }
  }
  flush();

  let hA='',hB='',nA=1,nB=1;
  col.forEach(it=>{
    const t=it[0];
    if(t==='equal'){ const e=escHtml(it[1]); hA+='<div class="diff-line diff-equal"><span class="diff-line-num">'+nA+'</span>'+e+'</div>'; hB+='<div class="diff-line diff-equal"><span class="diff-line-num">'+nB+'</span>'+e+'</div>'; nA++;nB++; }
    else if(t==='removed'){ const e=escHtml(it[1]); hA+='<div class="diff-line diff-removed"><span class="diff-line-num">'+nA+'</span>'+e+'</div>'; hB+='<div class="diff-line"><span class="diff-line-num" style="opacity:0">-</span>&nbsp;</div>'; nA++; }
    else if(t==='added'){ const e=escHtml(it[1]); hA+='<div class="diff-line"><span class="diff-line-num" style="opacity:0">-</span>&nbsp;</div>'; hB+='<div class="diff-line diff-added"><span class="diff-line-num">'+nB+'</span>'+e+'</div>'; nB++; }
    else if(t==='mod'){
      let pr=0; while(pr<it[1].length && pr<it[2].length && it[1][pr]===it[2][pr]) pr++;
      let sf=0; while(sf<it[1].length-pr && sf<it[2].length-pr && it[1][it[1].length-1-sf]===it[2][it[2].length-1-sf]) sf++;
      const m1=it[1].substring(pr,it[1].length-sf), m2=it[2].substring(pr,it[2].length-sf);
      const eA=escHtml(it[1].substring(0,pr)) + (m1?'<span class="diff-word-rm">'+escHtml(m1)+'</span>':'') + escHtml(it[1].substring(it[1].length-sf));
      const eB=escHtml(it[2].substring(0,pr)) + (m2?'<span class="diff-word-add">'+escHtml(m2)+'</span>':'') + escHtml(it[2].substring(it[2].length-sf));
      hA+='<div class="diff-line diff-removed"><span class="diff-line-num">'+nA+'</span>'+eA+'</div>';
      hB+='<div class="diff-line diff-added"><span class="diff-line-num">'+nB+'</span>'+eB+'</div>';
      nA++;nB++;
    }
  });
  document.getElementById('diff-out-a').innerHTML=hA; document.getElementById('diff-out-b').innerHTML=hB;

  if (statsEl) {
    const stats=diffStats(col);
    statsEl.innerHTML='<span class="badge">Added: '+stats.added+'</span> <span class="badge">Removed: '+stats.removed+'</span> <span class="badge">Modified: '+stats.modified+'</span>';
  }
}

// Pure — testable from scripts/parser-test.js. `col` is the post-alignment
// array diffCompare builds (equal/added/removed/mod), so counts match what's
// actually rendered, not a separate re-derivation that could drift from it.
function diffStats(col) {
  const s={added:0,removed:0,modified:0};
  col.forEach(it=>{ if(it[0]==='added') s.added++; else if(it[0]==='removed') s.removed++; else if(it[0]==='mod') s.modified++; });
  return s;
}

// The LCS table is (changed lines of A) x (changed lines of B), so the lines
// the two texts share at the start and at the end are set aside first: two
// 20,000-line files that differ in five lines need a table of a few cells.
// When what is left is still over DIFF_MAX_CELLS, no table is allocated and
// the result is {tooLarge:true, linesA, linesB} instead of the usual array.
const DIFF_MAX_CELLS = 25000000;
const DIFF_PAIR_MAX_CELLS = 2500;

function computeDiff(a,b,keyFn) {
  keyFn = keyFn || (x=>x);
  const ka=a.map(keyFn), kb=b.map(keyFn);
  const short=Math.min(a.length,b.length);
  let pre=0; while(pre<short&&ka[pre]===kb[pre]) pre++;
  let suf=0; while(suf<short-pre&&ka[a.length-1-suf]===kb[b.length-1-suf]) suf++;
  const m=a.length-pre-suf,n=b.length-pre-suf;
  if(m*n>DIFF_MAX_CELLS) return {tooLarge:true,linesA:m,linesB:n};
  const dp=Array.from({length:m+1},()=>new Array(n+1).fill(0));
  for(let i=m-1;i>=0;i--) for(let j=n-1;j>=0;j--) dp[i][j]=ka[pre+i]===kb[pre+j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
  const res=[];let i=0,j=0;
  for(let k=0;k<pre;k++) res.push(['equal',a[k]]);
  while(i<m||j<n){if(i<m&&j<n&&ka[pre+i]===kb[pre+j]){res.push(['equal',a[pre+i]]);i++;j++;}else if(j<n&&(i>=m||dp[i][j+1]>=dp[i+1][j])){res.push(['added',b[pre+j]]);j++;}else{res.push(['removed',a[pre+i]]);i++;}}
  for(let k=a.length-suf;k<a.length;k++) res.push(['equal',a[k]]);
  return res;
}

function diffTooLargeMessage(r) {
  return 'Too many changed lines to compare: '+window.mtFmtInt(r.linesA)+' on the left and '+window.mtFmtInt(r.linesB)+' on the right, after skipping the lines both texts start and end with. Compare a smaller section.';
}

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.diffCompare = diffCompare;
window.computeDiff = computeDiff;
window.diffTooLargeMessage = diffTooLargeMessage;
window.diffStats = diffStats;
window.diffNormalizeLine = diffNormalizeLine;

// core.js calls init() on every visit to the tool; the listeners go on once.
let diffInited = false;

export function init() {
  if (diffInited) return;
  diffInited = true;
  const ignoreWs = document.getElementById('diff-ignore-ws');
  if (ignoreWs) ignoreWs.addEventListener('change', diffCompare);

  const outA = document.getElementById('diff-out-a');
  const outB = document.getElementById('diff-out-b');
  if (outA && outB) {
    let isSyncingLeftScroll = false;
    let isSyncingRightScroll = false;
    outA.addEventListener('scroll', function() {
      if (!isSyncingLeftScroll) {
        isSyncingRightScroll = true;
        outB.scrollTop = this.scrollTop;
        outB.scrollLeft = this.scrollLeft;
      }
      isSyncingLeftScroll = false;
    });
    outB.addEventListener('scroll', function() {
      if (!isSyncingRightScroll) {
        isSyncingLeftScroll = true;
        outA.scrollTop = this.scrollTop;
        outA.scrollLeft = this.scrollLeft;
      }
      isSyncingRightScroll = false;
    });
  }
}
