#!/usr/bin/env node
// One-time: generate the Ed25519 keypair that signs release packages.
//   1. Run:  node scripts/gen-release-key.js
//   2. Paste the printed PUBLIC key into RELEASE_PUBLIC_KEY_PEM in
//      server/lib/update-verify.js and commit it.
//   3. Add the printed PRIVATE key as the GitHub Actions secret
//      MXDEV_RELEASE_PRIVATE_KEY (Settings -> Secrets and variables -> Actions).
//   4. Keep no other copy of the private key.
const crypto = require('crypto');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
console.log('--- PUBLIC KEY (commit into server/lib/update-verify.js) ---\n');
console.log(publicKey.export({ type: 'spki', format: 'pem' }));
console.log('--- PRIVATE KEY (GitHub Actions secret MXDEV_RELEASE_PRIVATE_KEY) ---\n');
console.log(privateKey.export({ type: 'pkcs8', format: 'pem' }));
