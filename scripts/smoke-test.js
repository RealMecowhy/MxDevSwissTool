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

// Route contract (review BUG-05): every bridge path the frontend calls must be
// served by the bridge. The OData "Test" button called /api/perf-test for months
// after the route was removed, through four green test suites — each side was
// tested, the seam between them was not. Static: read both sides as text.
function checkRouteContract() {
  const fs = require('fs');
  const bridgeSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'mendix-observability-bridge.js'), 'utf8');
  const exact = new Set(), prefixes = [];
  bridgeSrc.replace(/(?:pathname|pathOnly) === '([^']+)'/g, (_, p) => exact.add(p));
  bridgeSrc.replace(/(?:pathname|pathOnly)\.startsWith\('([^']+)'\)/g, (_, p) => prefixes.push(p));

  const files = [path.join(__dirname, '..', 'public', 'index.html')];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor') walk(f); } else if (e.name.endsWith('.js')) files.push(f);
    }
  })(path.join(__dirname, '..', 'public', 'js'));

  // The four ways the frontend addresses the bridge: an absolute URL, a URL
  // constant joined to a literal, a URL variable in a template, a relative fetch.
  const forms = [
    /localhost:9999(\/[A-Za-z][\w\/.-]*)/g,
    /_URL\s*\+\s*['"`](\/[A-Za-z][\w\/.-]*)/g,
    /\$\{\s*\w*(?:URL|Url)\s*\}(\/[A-Za-z][\w\/.-]*)/g,
    /fetch\(\s*['"`](\/[A-Za-z][\w\/.-]*)/g
  ];
  const called = new Map();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const re of forms) src.replace(re, (_, p) => { if (!called.has(p)) called.set(p, path.relative(path.join(__dirname, '..'), f)); });
  }
  const missing = [...called].filter(([p]) => !exact.has(p) && !prefixes.some(x => p.startsWith(x)));
  if (called.size < 20) return 'found only ' + called.size + ' bridge calls in public/ — the extractor has gone blind';
  return missing.length ? missing.map(([p, f]) => p + ' (' + f + ')').join(', ') : null;
}

// Review UX-03: nothing is set below 0.7rem (11.2px). The smallest size is the
// --fs-xs token; a literal under it in CSS, the page or a render template is how
// 9px eyebrows crept in, one "just this badge" at a time.
function checkMinFontSize() {
  const fs = require('fs');
  const root = path.join(__dirname, '..', 'public');
  const files = [path.join(root, 'index.html'), path.join(root, 'styles', 'main.css')];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor') walk(f); } else if (e.name.endsWith('.js')) files.push(f);
    }
  })(path.join(root, 'js'));
  const small = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const re = /font-size:\s*(\d*\.?\d+)(rem|px)/g;
      let m;
      while ((m = re.exec(line))) {
        const px = m[2] === 'px' ? parseFloat(m[1]) : parseFloat(m[1]) * 16;
        if (px < 11.2) small.push(path.relative(root, f) + ':' + (i + 1) + ' ' + m[0]);
      }
    });
  }
  return small.length ? small.join(', ') : null;
}

// Review UX-02 / decision Q5: numbers read the same for every user — "48,499",
// never "48 499" on one screen and "48,499" on the next. toLocaleString() on a
// number follows the machine's locale, so it is left to dates; counts go through
// mtFmtInt (utilities.js), which pins en-US. A module that must also run under
// Node without utilities.js (data-hub.js) pins 'en-US' itself.
function checkNumberFormat() {
  const fs = require('fs');
  const root = path.join(__dirname, '..', 'public', 'js');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor') walk(f); } else if (e.name.endsWith('.js')) files.push(f);
    }
  })(root);
  const bad = [];
  for (const f of files) {
    if (path.basename(f) === 'utilities.js') continue; // home of mtFmtInt
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/\.toLocaleString\((?!'en-US')/.test(line) && !/Date/.test(line)) bad.push(path.relative(root, f) + ':' + (i + 1));
    });
  }
  return bad.length ? bad.join(', ') : null;
}

// Review UX-05: the browser's confirm()/alert()/prompt() block the page and ignore
// the theme; the app has mtConfirm and mtToast instead. Comment lines are skipped
// — they name confirm() when explaining why it is gone.
function checkNativeDialogs() {
  const fs = require('fs');
  const root = path.join(__dirname, '..', 'public');
  const files = [path.join(root, 'index.html')];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor') walk(f); } else if (e.name.endsWith('.js')) files.push(f);
    }
  })(path.join(root, 'js'));
  const bad = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/(^|[^.\w'"])(confirm|alert|prompt)\(|\b(window|root|self)\.(confirm|alert|prompt)\(/.test(line)) {
        bad.push(path.relative(root, f) + ':' + (i + 1));
      }
    });
  }
  return bad.length ? bad.join(', ') : null;
}

// Wait 2 seconds for server to start
setTimeout(async () => {
  try {
    console.log('Checking every bridge route the frontend calls exists...');
    const contract = checkRouteContract();
    if (contract) return fail('frontend calls routes the bridge does not serve', contract);

    console.log('Checking no text is set below the --fs-xs minimum...');
    const tiny = checkMinFontSize();
    if (tiny) return fail('font sizes below 0.7rem (use var(--fs-xs))', tiny);

    console.log('Checking numbers are formatted through mtFmtInt...');
    const localeNums = checkNumberFormat();
    if (localeNums) return fail('number formatted with the machine locale (use window.mtFmtInt)', localeNums);

    console.log('Checking no native confirm/alert/prompt is used...');
    const dialogs = checkNativeDialogs();
    if (dialogs) return fail('native browser dialog (use window.mtConfirm / window.mtToast)', dialogs);

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

    // ── Wave 33: error statuses (review BUG-16) ──────────────────────────────
    // A failure is not a 200: `pg` missing is 503, an unreachable database 502.
    console.log('Checking a failed database call is an error status...');
    const deadDb = await request({ path: '/postgres', method: 'POST', headers: tokenJson },
      JSON.stringify({ host: '127.0.0.1', port: 1, database: 'x', user: 'x', password: 'x' }));
    if (deadDb.status !== 502 && deadDb.status !== 503) return fail('/postgres on a dead database must be 502 (or 503 without pg)', 'status=' + deadDb.status + ' body=' + deadDb.body);
    if (!JSON.parse(deadDb.body).message) return fail('the error status must still carry a message', deadDb.body);

    // An oversized body used to destroy the socket before the 413 was written.
    console.log('Checking an oversized body gets a 413 answer...');
    const tooBig = await request({ path: '/livedb/ping', method: 'POST', headers: tokenJson }, 'x'.repeat(1024 * 1024 + 10))
      .catch(e => ({ status: 'connection error: ' + e.message }));
    if (tooBig.status !== 413) return fail('an oversized body must be answered with 413', 'status=' + tooBig.status);

    // Live tail of a named file (review BUG-07): the Telemetry path field used
    // to be ignored, so the tail only ever looked in the bridge's own folder.
    console.log('Checking /logs/watch tails the file it is given...');
    const relLog = await request({ path: '/logs/watch', method: 'POST', headers: tokenJson }, JSON.stringify({ path: 'app.log' }));
    if (relLog.status !== 400) return fail('/logs/watch must reject a relative path', 'status=' + relLog.status);
    const exeLog = await request({ path: '/logs/watch', method: 'POST', headers: tokenJson }, JSON.stringify({ path: path.join(os.tmpdir(), 'x.exe') }));
    if (exeLog.status !== 400) return fail('/logs/watch must reject a non-log file', 'status=' + exeLog.status);
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxdev-smoke-log-'));
    const logFile = path.join(logDir, 'app.log');
    fs.writeFileSync(logFile, '2026-09-22 10:00:00.000 INFO - Core: started\n');
    const watch = await request({ path: '/logs/watch', method: 'POST', headers: tokenJson }, JSON.stringify({ path: logFile }));
    if (watch.status !== 200) return fail('/logs/watch must accept an existing .log file', 'status=' + watch.status + ' body=' + watch.body);
    const since = Date.now() - 1;
    fs.appendFileSync(logFile, '2026-09-22 10:00:01.000 ERROR - Core: smoke-tail-marker\n');
    let tailed = false;
    for (let i = 0; i < 20 && !tailed; i++) {
      await new Promise(r => setTimeout(r, 250));
      const lines = await request({ path: '/logs?since=' + since, headers: { 'X-Bridge-Token': parsed.token } });
      tailed = lines.body.indexOf('smoke-tail-marker') !== -1;
    }
    const statusAfter = JSON.parse((await request({ path: '/status' })).body);
    try { fs.rmSync(logDir, { recursive: true, force: true }); } catch (e) { /* still watched on Windows — tmp is cleaned later */ }
    if (!tailed) return fail('/logs did not deliver a line appended to the watched file');
    if (path.resolve(statusAfter.logFile) !== path.resolve(logFile)) return fail('/status must report the watched file', statusAfter.logFile);

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
