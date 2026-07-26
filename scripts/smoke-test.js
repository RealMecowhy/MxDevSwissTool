const { spawn } = require('child_process');
const http = require('http');

console.log('Starting bridge server for smoke test...');
const server = spawn('node', ['server/mendix-observability-bridge.js']);

let serverOutput = '';
server.stdout.on('data', (data) => {
  serverOutput += data.toString();
});

server.stderr.on('data', (data) => {
  const text = data.toString();
  console.error('SERVER ERROR:', text);
  // Without this the checks below silently interrogate whatever bridge is
  // already on 9999 — including a stale one running pre-fix code, which turns
  // a passing build into a mystery failure (and the reverse).
  if (text.indexOf('EADDRINUSE') !== -1) {
    console.error('Smoke test failed: port 9999 is already in use. Stop the running bridge and retry.');
    server.kill();
    process.exit(1);
  }
});

function fail(message, detail) {
  console.error('Smoke test failed: ' + message + (detail ? ' — ' + detail : ''));
  server.kill();
  process.exit(1);
}

// Plain Node request: no browser, so nothing injects the X-Bridge-Token header.
// That is the point — this is how the Mendix runtime reaches the bridge.
function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(Object.assign({ host: '127.0.0.1', port: 9999 }, options), (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Wait 2 seconds for server to start
setTimeout(async () => {
  try {
    console.log('Sending request to /status...');
    const status = await request({ path: '/status' });
    let parsed;
    try {
      parsed = JSON.parse(status.body);
    } catch (e) {
      return fail('Could not parse /status response', status.body);
    }
    if (parsed.status !== 'online') return fail('Unexpected status response', status.body);

    // The Mock Server exists to be called by a Mendix Call REST action, which
    // cannot know a token that is regenerated on every bridge restart. If this
    // ever answers 401 again, the mock is broken for its only real use.
    console.log('Checking /mock is reachable without a token...');
    const mock = await request(
      { path: '/mock', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ from: 'a Mendix Call REST action' })
    );
    if (mock.status !== 200) return fail('/mock must answer an unauthenticated caller', 'status=' + mock.status + ' body=' + mock.body);
    if (mock.body.indexOf('status') === -1) return fail('/mock did not return the configured payload', mock.body);

    const mockPath = await request({ path: '/mock/orders' });
    if (mockPath.status !== 200) return fail('/mock sub-paths must answer too', 'status=' + mockPath.status);

    // Reconfiguring the mock is a write and must stay behind the token.
    console.log('Checking /mock-config still requires a token...');
    const cfg = await request(
      { path: '/mock-config', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ delay: 0 })
    );
    if (cfg.status !== 401) return fail('/mock-config must reject an unauthenticated caller', 'status=' + cfg.status);

    console.log('Smoke test passed successfully.');
    server.kill();
    process.exit(0);
  } catch (e) {
    fail('Request error', e.message);
  }
}, 2000);

// Timeout test after 10 seconds
setTimeout(() => {
  console.error('Smoke test timed out.');
  server.kill();
  process.exit(1);
}, 10000);
