// TEXT DIFF
// ============================================================
function diffCompare() {
  const a=document.getElementById('diff-a').value, b=document.getElementById('diff-b').value;
  if (!a&&!b) { document.getElementById('diff-out-a').innerHTML=''; document.getElementById('diff-out-b').innerHTML=''; return; }
  const lA=a.split('\n'), lB=b.split('\n'), diffs=computeDiff(lA,lB);
  const col = [];
  let bA=[], bB=[];
  const flush = () => {
    const m = bA.length, n = bB.length;
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
}

function computeDiff(a,b) {
  const m=a.length,n=b.length,dp=Array.from({length:m+1},()=>new Array(n+1).fill(0));
  for(let i=m-1;i>=0;i--) for(let j=n-1;j>=0;j--) dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
  const res=[];let i=0,j=0;
  while(i<m||j<n){if(i<m&&j<n&&a[i]===b[j]){res.push(['equal',a[i]]);i++;j++;}else if(j<n&&(i>=m||dp[i][j+1]>=dp[i+1][j])){res.push(['added',b[j]]);j++;}else{res.push(['removed',a[i]]);i++;}}
  return res;
}

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.diffCompare = diffCompare;
window.computeDiff = computeDiff;

export function init() {
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
