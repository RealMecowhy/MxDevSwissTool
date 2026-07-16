#!/usr/bin/env node
// One-shot release: tag the current package.json version (if not tagged yet) and
// push main + the tag together. The pushed tag triggers .github/workflows/release.yml,
// which builds MxDevSwissTool-Release-vX.Y.Z.zip and publishes the GitHub Release.
//
// Usage:  npm run release
// After it runs, enrich the release notes (see memory: mendixtools-versioning).

const { execSync } = require('child_process');
const pkg = require('../package.json');
const tag = 'v' + pkg.version;

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: opts.inherit ? 'inherit' : 'pipe' });
}
function tryQuiet(cmd) {
  try { sh(cmd); return true; } catch (e) { return false; }
}

// 1. Refuse to tag a dirty tree — the tag must point at the committed version bump.
const status = sh('git status --porcelain').trim();
if (status) {
  console.error('[release] Working tree is not clean — commit the version bump first:\n');
  console.error(status + '\n');
  process.exit(1);
}

// 2. Create the tag if it doesn't exist yet (idempotent).
const tagExists = tryQuiet(`git rev-parse -q --verify refs/tags/${tag}`);
if (tagExists) {
  console.log(`[release] tag ${tag} already exists — skipping tag creation.`);
} else {
  // Annotated tag (-a), not lightweight: `git push --follow-tags` only pushes
  // annotated tags, so a lightweight tag would silently never reach the remote
  // and the release build would not trigger.
  sh(`git tag -a ${tag} -m "Release ${tag}"`);
  console.log(`[release] created annotated tag ${tag}.`);
}

// 3. Push the current branch and the tag together.
console.log('[release] pushing main + tag...');
sh('git push --follow-tags', { inherit: true });

console.log(`\n[release] done. Watch the build:  gh run list --workflow=release.yml`);
console.log(`[release] then enrich notes:      gh release edit ${tag} --notes-file <notes.md>`);
