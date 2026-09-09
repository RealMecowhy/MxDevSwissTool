'use strict';

// Version comparison for the self-update check (server/mendix-observability-bridge.js).
// Pure and dependency-free so scripts/parser-test.js can pin its behaviour without
// a network call to the GitHub API — which is the only way this code runs otherwise.
//
// Deliberately permissive: it compares GitHub release tags ("v1.58.0") against
// package.json versions ("1.58.0"). server/mx-tool.js has its OWN, stricter parser
// for Studio Pro install directories and .mpr product versions — the two are not
// the same problem and are not shared.
//
//   compareVersions('1.10.0', '1.9.0')  ->  > 0
//   compareVersions('v1.2',   '1.2.0')  ->  0
//   compareVersions('1.2.0',  '1.2.1')  ->  < 0
function compareVersions(a, b) {
  const parse = (s) => String(s).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

module.exports = { compareVersions };
