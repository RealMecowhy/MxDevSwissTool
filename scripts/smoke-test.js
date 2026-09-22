const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');

// An absolute path that does not exist — absolute on the OS running the test
// (a `C:\...` literal is a RELATIVE path on the Linux CI runner).
const MISSING_MPR = path.join(os.tmpdir(), 'mxdev-smoke-does-not-exist', 'App.mpr');

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
      JSON.stringify({ mprPath: MISSING_MPR })
    );
    if (mprMissing.status !== 400) return fail('/model/mpr must reject a path that does not exist', 'status=' + mprMissing.status + ' body=' + mprMissing.body);

    // Explorer's "Copy as path" wraps the path in double quotes — accepted, so
    // this reaches the "no such path" check instead of "must be absolute".
    const mprQuoted = await request(
      { path: '/model/mpr', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': parsed.token } },
      JSON.stringify({ mprPath: '"' + MISSING_MPR + '"' })
    );
    if (mprQuoted.status !== 400 || !/No such path/.test(mprQuoted.body)) {
      return fail('/model/mpr must accept a quoted absolute path', 'status=' + mprQuoted.status + ' body=' + mprQuoted.body);
    }

    // The model-analysis routes built on the .mpr reader (dead-code,
    // integrations, modules) share /model/mpr's validation — same token gate,
    // 405 on GET, 400 on a non-absolute path.
    for (const route of ['/model/dead-code', '/model/integrations', '/model/modules', '/model/refs']) {
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

    // ── Wave 32: security hardening ──────────────────────────────────────────
    // DNS rebinding: a foreign page reaches loopback under its own name, so the
    // request carries a foreign Host. Refused on both ports, /status included —
    // /status is what hands out the token.
    console.log('Checking a foreign Host header is refused...');
    const evil = await request({ path: '/status', headers: { Host: 'evil.example:9999' } });
    if (evil.status !== 403) return fail('/status must refuse a foreign Host', 'status=' + evil.status);
    if (evil.body.indexOf(parsed.token) !== -1) return fail('the 403 must not carry the token');
    const evilTok = await request({ path: '/logs', headers: { Host: 'evil.example:9999', 'X-Bridge-Token': parsed.token } });
    if (evilTok.status !== 403) return fail('a token does not make a foreign Host acceptable', 'status=' + evilTok.status);
    const localName = await request({ path: '/status', headers: { Host: 'localhost:9999' } });
    if (localName.status !== 200) return fail('Host localhost:9999 must be accepted', 'status=' + localName.status);
    const otlpEvil = await request({ port: 4318, path: '/v1/traces', method: 'POST', headers: { Host: 'evil.example:4318', 'Content-Type': 'application/json' } }, '{}');
    if (otlpEvil.status !== 403) return fail('the OTLP port must refuse a foreign Host', 'status=' + otlpEvil.status);
    const otlpLocal = await request({ port: 4318, path: '/v1/traces', method: 'POST', headers: { 'Content-Type': 'application/json' } }, '{}');
    if (otlpLocal.status === 403) return fail('the OTLP port must accept 127.0.0.1');

    // A bad mock-config value used to be stored and crash the Bridge on the
    // next /mock call (status: null → null.toString()).
    console.log('Checking /mock-config validates its input...');
    const tokenJson = { 'Content-Type': 'application/json', 'X-Bridge-Token': parsed.token };
    const nullStatus = await request({ path: '/mock-config', method: 'POST', headers: tokenJson }, JSON.stringify({ status: null }));
    if (nullStatus.status !== 400) return fail('/mock-config must reject status:null', 'status=' + nullStatus.status);
    const hugeDelay = await request({ path: '/mock-config', method: 'POST', headers: tokenJson }, JSON.stringify({ delay: 600000 }));
    if (hugeDelay.status !== 400) return fail('/mock-config must reject a delay over 60 s', 'status=' + hugeDelay.status);
    const stillMocking = await request({ path: '/mock' });
    if (stillMocking.status !== 200) return fail('/mock must keep answering after a rejected config', 'status=' + stillMocking.status);

    // /openapi/fetch makes the Bridge fetch a URL it is handed. A local server
    // plays the target: a real spec, an HTML page, and a redirect to another host.
    console.log('Checking /openapi/fetch refuses what is not a spec...');
    const target = http.createServer((q, r) => {
      const port = target.address().port;
      if (q.url === '/spec') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end('{"openapi":"3.0.0","paths":{}}'); }
      if (q.url === '/page') { r.writeHead(200, { 'Content-Type': 'text/html' }); return r.end('<html>internal admin page</html>'); }
      if (q.url === '/away') { r.writeHead(302, { Location: 'http://localhost:' + port + '/spec' }); return r.end(); }
      r.writeHead(404); r.end();
    });
    await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + target.address().port;
    const openapi = (u) => request({ path: '/openapi/fetch?url=' + encodeURIComponent(u), headers: { 'X-Bridge-Token': parsed.token } });
    const spec = await openapi(base + '/spec');
    if (spec.status !== 200 || JSON.parse(spec.body).body.indexOf('openapi') === -1) return fail('/openapi/fetch must return a real spec', 'status=' + spec.status + ' body=' + spec.body);
    const page = await openapi(base + '/page');
    if (page.status !== 502) return fail('/openapi/fetch must refuse a non-spec page', 'status=' + page.status);
    if (page.body.indexOf('internal admin page') !== -1) return fail('/openapi/fetch must not hand back a non-spec body', page.body);
    const away = await openapi(base + '/away');
    if (away.status !== 502) return fail('/openapi/fetch must not follow a redirect to another host', 'status=' + away.status + ' body=' + away.body);
    const metadata = await openapi('http://169.254.169.254/latest/meta-data/');
    if (metadata.status !== 400) return fail('/openapi/fetch must refuse a link-local address', 'status=' + metadata.status);
    target.close();

    // config.json holds the database password in plain text; the browser gets it masked.
    console.log('Checking /detect-project never returns the database password...');
    const fs = require('fs');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mxdev-smoke-project-'));
    fs.mkdirSync(path.join(projectRoot, 'deployment', 'model'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'deployment', 'model', 'config.json'),
      JSON.stringify({ Configuration: { DatabaseType: 'POSTGRESQL', DatabaseUserName: 'mendix', DatabasePassword: 'smoke-secret-pw' } }));
    const detected = await request({ path: '/detect-project', method: 'POST', headers: tokenJson }, JSON.stringify({ projectRoot: projectRoot }));
    fs.rmSync(projectRoot, { recursive: true, force: true });
    if (detected.status !== 200) return fail('/detect-project POST must answer 200', 'status=' + detected.status + ' body=' + detected.body);
    if (detected.body.indexOf('smoke-secret-pw') !== -1) return fail('/detect-project leaked the database password');
    if (JSON.parse(detected.body).config.Configuration.DatabaseUserName !== 'mendix') return fail('/detect-project must still return the rest of config.json');

    console.log('Smoke test passed successfully.');
    server.kill();
    process.exit(0);
  } catch (e) {
    fail('Request error', e.message);
  }
}, 2000);

// Timeout test after 20 seconds
setTimeout(() => {
  console.error('Smoke test timed out.');
  server.kill();
  process.exit(1);
}, 20000);
