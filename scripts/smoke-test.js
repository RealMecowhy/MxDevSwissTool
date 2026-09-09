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

    // Security matrix (wave 28): a write-shaped route that spawns mx.exe — it
    // must stay behind the token, and reject a bad projectRoot before doing
    // any work.
    console.log('Checking /model/security requires a token...');
    const secNoToken = await request(
      { path: '/model/security', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ projectRoot: 'C:\\nope' })
    );
    if (secNoToken.status !== 401) return fail('/model/security must reject an unauthenticated caller', 'status=' + secNoToken.status);

    const secBadPath = await request(
      { path: '/model/security', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': parsed.token } },
      JSON.stringify({ projectRoot: 'not-absolute' })
    );
    if (secBadPath.status !== 400) return fail('/model/security must reject a non-absolute projectRoot', 'status=' + secBadPath.status + ' body=' + secBadPath.body);

    const secStatusNoJob = await request(
      { path: '/model/security?jobId=nope', headers: { 'X-Bridge-Token': parsed.token } }
    );
    if (secStatusNoJob.status !== 404) return fail('/model/security status for an unknown job must be 404', 'status=' + secStatusNoJob.status);

    // The offline .mpr reader (plan 006): a read-only route, but it opens a
    // caller-supplied path, so it must stay behind the token and reject a
    // non-absolute or missing path before touching the filesystem.
    console.log('Checking /model/mpr requires a token and validates its path...');
    const mprNoToken = await request(
      { path: '/model/mpr', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ mprPath: 'C:\\nope\\App.mpr' })
    );
    if (mprNoToken.status !== 401) return fail('/model/mpr must reject an unauthenticated caller', 'status=' + mprNoToken.status);

    const mprGet = await request({ path: '/model/mpr', headers: { 'X-Bridge-Token': parsed.token } });
    if (mprGet.status !== 405) return fail('/model/mpr must answer 405 to GET', 'status=' + mprGet.status);

    const mprNoPath = await request(
      { path: '/model/mpr', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': parsed.token } },
      JSON.stringify({})
    );
    if (mprNoPath.status !== 400) return fail('/model/mpr must reject a missing path', 'status=' + mprNoPath.status + ' body=' + mprNoPath.body);

    const mprRelative = await request(
      { path: '/model/mpr', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': parsed.token } },
      JSON.stringify({ mprPath: 'relative/App.mpr' })
    );
    if (mprRelative.status !== 400) return fail('/model/mpr must reject a non-absolute path', 'status=' + mprRelative.status + ' body=' + mprRelative.body);

    const mprMissing = await request(
      { path: '/model/mpr', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': parsed.token } },
      JSON.stringify({ mprPath: 'C:\\does\\not\\exist.mpr' })
    );
    if (mprMissing.status !== 400) return fail('/model/mpr must reject a path that does not exist', 'status=' + mprMissing.status + ' body=' + mprMissing.body);

    // The three model-analysis routes built on the .mpr reader (dead-code, i18n,
    // integrations) share /model/mpr's validation — same token gate, 405 on GET,
    // 400 on a non-absolute path.
    for (const route of ['/model/dead-code', '/model/i18n', '/model/integrations']) {
      console.log('Checking ' + route + ' requires a token and validates its path...');
      const noTok = await request(
        { path: route, method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ mprPath: 'C:\\nope\\App.mpr' })
      );
      if (noTok.status !== 401) return fail(route + ' must reject an unauthenticated caller', 'status=' + noTok.status);

      const getReq = await request({ path: route, headers: { 'X-Bridge-Token': parsed.token } });
      if (getReq.status !== 405) return fail(route + ' must answer 405 to GET', 'status=' + getReq.status);

      const relative = await request(
        { path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': parsed.token } },
        JSON.stringify({ mprPath: 'relative/App.mpr' })
      );
      if (relative.status !== 400) return fail(route + ' must reject a non-absolute path', 'status=' + relative.status + ' body=' + relative.body);
    }

    console.log('Checking /prometheus rejects a non-numeric port...');
    const badPort = await request({ path: '/prometheus?port=80@evil.com', headers: { 'X-Bridge-Token': parsed.token } });
    if (badPort.status !== 400) return fail('/prometheus must reject a non-numeric port', 'status=' + badPort.status + ' body=' + badPort.body);

    console.log('Checking /prometheus accepts a valid port (upstream may be absent)...');
    const okPort = await request({ path: '/prometheus?port=8090', headers: { 'X-Bridge-Token': parsed.token } });
    // No Mendix app is running in the smoke test, so a clean connection-refused
    // error (status 200, error:true) is the expected success signal — what must
    // NOT happen is a hang or a 400.
    if (okPort.status !== 200) return fail('/prometheus with a valid port should answer 200 (even if it is a proxy error)', 'status=' + okPort.status);

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
