// BROWSER SMOKE TEST
// ============================================================
// The unit tests cover the pure layer well (1 384 assertions) and cannot see the
// half of this application that only exists in a browser: 355 inline onclick
// handlers, every render path, 440 innerHTML assignments and every init().
// Wave 13's A1 was exactly that class of defect — a cross-tool jump threw a
// TypeError while the pure layer was spotless, and it shipped.
//
// So: open every tool, assert its panel actually rendered and that nothing threw,
// then exercise the cross-tool jumps, which are where the wiring between two
// green modules goes wrong.
//
// Serves `public/` from a throwaway static server on an ephemeral port — the
// same files the release ships, no build step in between.
//
// Skips (exit 0) when a browser cannot be launched, so a machine without a
// downloaded Chromium does not turn `npm test` red for the wrong reason.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  — ' + detail : '')); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, JSON.stringify(actual) + ' != ' + JSON.stringify(expected));
}

function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
      // Never serve outside public/ — this is a test server, but it is still a server.
      if (path.relative(ROOT, file).startsWith('..')) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server: server, port: server.address().port }));
  });
}

// The bridge is not running during this test and the page polls it on startup;
// its refusals are browser resource errors, not application errors.
function isNoise(text) {
  return /ERR_CONNECTION_REFUSED|Failed to load resource|localhost:9999|Could not fetch bridge token/.test(text);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// One synthetic log that feeds four tools, so the cross-links have something to
// jump with: a microflow execution, the SQL inside it, a REST call, and an ERROR
// the decoder recognizes — all sharing one correlation ID.
const P = '[runtime-container/x]';
const TR = '  TRACE - ';
const CORR = '3769f9ea-dd81-4306-8f0e-121a8af66755';
const LOG = [
  '2026-07-20T10:00:00.000000 ' + P + '   DEBUG - MicroflowEngine: [' + CORR + '] Starting execution of microflow \'Mod.SendShipment\'',
  '2026-07-20T10:00:00.005000 ' + P + TR + 'MicroflowEngine: [' + CORR + '] Executing activity: {"current_activity":{"caption":"Call REST (POST)","type":"CallRest"},"name":"Mod.SendShipment","type":"Microflow"}',
  '2026-07-20T10:00:00.010000 ' + P + TR + 'REST Consume: Request content for POST request to https://api.example.com/rest/ship/v1/shipment HTTP/1.1',
  'Content-Type: application/json',
  '{"shipment":1}',
  '2026-07-20T10:00:00.510000 ' + P + TR + 'REST Consume: Response content for POST request to https://api.example.com/rest/ship/v1/shipment',
  'HTTP/1.1 200 OK',
  '{"ok":true}',
  '2026-07-20T10:00:01.000000 ' + P + TR + 'ConnectionBus_Retrieve: SQL@a1(T1-C1): SELECT "sales$order"."id" FROM "sales$order" WHERE "id" = 1',
  '2026-07-20T10:00:02.000000 ' + P + '   ERROR - Connector: [' + CORR + '] com.mendix.systemwideinterfaces.core.UserException: An error has occurred',
  'Caused by: org.postgresql.util.PSQLException: ERROR: duplicate key value violates unique constraint "account_email_key"',
  // The DEBUG record ends at the microflow name — the tracer takes the duration
  // from the Starting→Finished timestamp delta, not from text on the line.
  '2026-07-20T10:00:03.000000 ' + P + '   DEBUG - MicroflowEngine: [' + CORR + '] Finished execution of microflow \'Mod.SendShipment\''
].join('\n');

// A second execution under a client-request ID (`<epochMs>-<counter>`), appended
// only for the Correlation Flow block: it needs more than one ID in the list.
const LOG_SECOND_CORR = [
  '2026-07-20T10:00:10.000000 ' + P + '   DEBUG - MicroflowEngine: [1784273164806-115] Starting execution of microflow \'Mod.RefreshList\'',
  '2026-07-20T10:00:11.000000 ' + P + '   DEBUG - MicroflowEngine: [1784273164806-115] Finished execution of microflow \'Mod.RefreshList\''
].join('\n');

const NGINX_LOG = [
  '10.0.0.1 - - [20/Jul/2026:10:00:01 +0000] "GET /xas/ HTTP/1.1" 200 512 "-" "Mozilla/5.0" 0.412',
  '10.0.0.2 - - [20/Jul/2026:10:00:02 +0000] "POST /xas/ HTTP/1.1" 500 128 "-" "Mozilla/5.0" 1.900'
].join('\n');

async function run() {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (e) {
    console.log('  – puppeteer not installed, browser smoke skipped');
    process.exit(0);
  }

  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  } catch (e) {
    console.log('  – no browser available (' + e.message.split('\n')[0] + '), browser smoke skipped');
    process.exit(0);
  }

  const { server, port } = await startServer();
  const errors = [];
  let currentTool = 'startup';

  try {
    const page = await browser.newPage();
    // The welcome tour overlays the UI on a fresh profile and would swallow every
    // click below; the sidebar collapses under 900 px and hides the nav items.
    await page.setViewport({ width: 1600, height: 950 });
    await page.evaluateOnNewDocument(() => {
      try { localStorage.setItem('mt-welcome-seen', '1'); } catch (e) {}
    });
    page.on('pageerror', e => errors.push('[' + currentTool + '] ' + e.message));
    page.on('console', m => {
      if (m.type() === 'error' && !isNoise(m.text())) errors.push('[' + currentTool + '] console: ' + m.text());
    });

    await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => typeof window.navigate === 'function', { timeout: 30000 });
    await sleep(500);

    // ── Startup payload (wave 17): the two heavy vendors must NOT be loaded ──
    console.log('\nStartup payload');
    eq('mermaid is not loaded at startup', await page.evaluate(() => typeof window.mermaid), 'undefined');
    eq('chart.js is not loaded at startup', await page.evaluate(() => typeof window.Chart), 'undefined');
    ok('no vendor <script> tag in the shipped page',
      await page.evaluate(() => !document.querySelector('head > script[src*="vendor"]')));

    // ── Every tool opens, renders and throws nothing ─────────────────────────
    console.log('\nEvery tool opens');
    const tools = await page.$$eval('.nav-item[data-tool]', els => els.map(e => e.getAttribute('data-tool')));
    ok('the sidebar lists the full tool set (' + tools.length + ')', tools.length >= 30, tools.length);

    const emptyPanels = [];
    for (const id of tools) {
      currentTool = id;
      await page.evaluate(t => {
        const el = document.querySelector('.nav-item[data-tool="' + t + '"]');
        if (el) el.click(); else window.navigate(t, null);
      }, id);
      await sleep(220);
      const state = await page.evaluate(t => {
        const panel = document.getElementById('panel-' + t) ||
                      (t === 'home' ? document.getElementById('home-view') : null);
        if (!panel) return { missing: true };
        return {
          visible: getComputedStyle(panel).display !== 'none',
          // A panel that rendered has real content, not just a wrapper element.
          text: (panel.textContent || '').trim().length
        };
      }, id);
      if (state.missing || !state.visible || state.text < 20) emptyPanels.push(id + ' ' + JSON.stringify(state));
    }
    currentTool = 'after tool sweep';
    ok('every tool renders a non-empty panel', emptyPanels.length === 0, emptyPanels.join(' · '));

    // ── The heavy vendors arrive only when a tool that needs them is opened ──
    console.log('\nVendors load on demand');
    await page.evaluate(() => window.navigate('architecture', null));
    await page.evaluate(() => {
      const input = document.getElementById('arch-input');
      if (input) input.value = 'Sales.Order\n  - Number : String';
      if (window.archGenerate) window.archGenerate();
    });
    await page.waitForFunction(() => typeof window.mermaid !== 'undefined', { timeout: 30000 });
    ok('mermaid is fetched when a diagram is actually drawn', true);
    await sleep(600);
    ok('the diagram rendered as SVG, not as raw syntax',
      await page.evaluate(() => !!document.querySelector('#arch-output svg')));

    currentTool = 'telemetry-monitor';
    await page.evaluate(() => window.navigate('telemetry-monitor', null));
    await page.waitForFunction(() => typeof window.Chart !== 'undefined', { timeout: 30000 });
    ok('chart.js is fetched when the telemetry tool is opened', true);

    // ── Cross-tool jumps: two green modules, one broken hand-off ─────────────
    console.log('\nCross-tool jumps');
    currentTool = 'cross-links';
    // Each load is awaited on the rendered result rather than on a timer: these
    // parsers hand off to a worker above 2 MB and finish whenever they finish.
    await page.evaluate(t => { window.navigate('log-viewer', null); window.logLoadText(t, 'smoke.log'); }, LOG);
    await page.waitForFunction(() => document.querySelectorAll('#log-container .log-row').length > 0, { timeout: 20000 });

    await page.evaluate(t => { window.navigate('microflow-tracer', null); window.mftLoadText(t); }, LOG);
    await page.waitForFunction(() => document.querySelectorAll('#mft-list .mft-list-item').length > 0, { timeout: 20000 });

    await page.evaluate(t => { window.navigate('ws-rest-extractor', null); window.wsreLoadText(t); }, LOG);
    await page.waitForFunction(() => document.querySelectorAll('#wsre-call-list .wsre-list-item').length > 0, { timeout: 20000 });

    // Tracer → Query Extractor (time window) and Tracer → Log Viewer (corr ID)
    await page.evaluate(() => {
      window.navigate('microflow-tracer', null);
      document.querySelector('#mft-list .mft-list-item').click();
    });
    await page.waitForFunction(() => !!window._mftSelectedExec, { timeout: 10000 });
    await page.evaluate(() => window.mftShowInLqe());
    await sleep(600);
    ok('mftShowInLqe lands on the Query Extractor with a window chip',
      await page.evaluate(() => getComputedStyle(document.getElementById('panel-log-query-extractor')).display !== 'none' &&
        getComputedStyle(document.getElementById('lqe-timewindow')).display !== 'none'));

    await page.evaluate(() => { window.navigate('microflow-tracer', null); window.mftShowInLogViewer(); });
    await sleep(600);
    eq('mftShowInLogViewer filters the stream to the correlation ID',
      await page.$eval('#log-search', e => e.value), CORR);

    // REST call → Tracer, by correlation ID
    await page.evaluate(() => {
      window.navigate('ws-rest-extractor', null);
      document.querySelector('#wsre-call-list .wsre-list-item').click();
    });
    await page.waitForFunction(() => !!window._wsreSelectedCall, { timeout: 10000 });
    await page.evaluate(() => window.wsreShowInMft());
    await sleep(600);
    ok('wsreShowInMft lands on the Microflow Tracer',
      await page.evaluate(() => getComputedStyle(document.getElementById('panel-microflow-tracer')).display !== 'none'));

    // Nginx → Query Extractor: the jump that shipped broken (wave 13, A1)
    currentTool = 'nginx-log';
    await page.evaluate(t => {
      window.navigate('nginx-log', null);
      // This tool has no text entry point — go through the file input the user uses.
      const dt = new DataTransfer();
      dt.items.add(new File([t], 'access.log', { type: 'text/plain' }));
      window.nginxLoadFilesFromInput(dt.files, 'access');
    }, NGINX_LOG);
    await page.waitForFunction(() => {
      const r = document.getElementById('nginx-results');
      return r && getComputedStyle(r).display !== 'none';
    }, { timeout: 20000 });
    // The per-row jump lives in the Streams tab.
    await page.evaluate(() => {
      const tab = document.querySelector('#panel-nginx-log [onclick*="nginxSwitchTab"][onclick*="stream"]');
      if (tab) tab.click();
    });
    await sleep(800);
    const nginxJumped = await page.evaluate(() => {
      const row = document.querySelector('[onclick*="nginxShowInLqe"]');
      if (!row) return 'no-link';
      row.click();
      return 'clicked';
    });
    if (nginxJumped === 'clicked') {
      await sleep(600);
      ok('nginxShowInLqe jumps without throwing (regression guard for A1)',
        await page.evaluate(() => getComputedStyle(document.getElementById('panel-log-query-extractor')).display !== 'none'));
    } else {
      ok('nginxShowInLqe link present in the rendered table', false, 'no row exposed the jump');
    }

    // Log Viewer → Error Decoder, carrying the row's context (wave 16, B2)
    currentTool = 'error-decoder';
    await page.evaluate(() => {
      window.navigate('log-viewer', null);
      const chip = document.querySelector('#log-container .log-explain-chip');
      if (chip) chip.click();
    });
    await sleep(700);
    ok('logExplainError decodes the error it was given',
      await page.evaluate(() => /constraint/i.test(document.getElementById('edx-results').textContent)));
    ok('...and carries the log row it came from',
      await page.evaluate(() => getComputedStyle(document.getElementById('edx-context')).display !== 'none'));

    // Correlation Flow: the list has to be discoverable, and picking a row has to
    // render the flow (wave 20, C5). Help promised this list for a year before it
    // existed, so it is worth a browser assertion rather than a pure-layer one.
    console.log('\nCorrelation Flow');
    currentTool = 'log-viewer';
    // Reload with a second execution under its own ID, so "picking one must not
    // hide the others" is actually testable. This is the last block before
    // teardown, so the extra records cannot disturb the assertions above.
    await page.evaluate((t, extra) => {
      window.navigate('log-viewer', null);
      window.logClear();
      window.logLoadText(t + '\n' + extra, 'smoke.log');
    }, LOG, LOG_SECOND_CORR);
    await page.waitForFunction(() => document.querySelectorAll('#log-container .log-row').length > 0, { timeout: 20000 });
    await page.evaluate(() => {
      const tab = document.querySelector('#panel-log-viewer .tab[data-help-key="log-viewer-correlation"]');
      if (tab) tab.click();
    });
    await page.waitForFunction(() => document.querySelectorAll('#log-correlation-list .log-corr-row').length > 0, { timeout: 10000 });
    ok('the correlation list names the microflow behind the ID',
      await page.evaluate(() => /Mod\.SendShipment/.test(document.getElementById('log-correlation-list').textContent)));

    await page.evaluate(() => document.querySelector('#log-correlation-list .log-corr-row').click());
    await sleep(400);
    eq('clicking a row fills the box with that ID',
      await page.$eval('#log-correlation-id', e => e.value), CORR);
    ok('...and renders its flow, headed by the ID and what happened under it',
      await page.evaluate(c => {
        const t = document.getElementById('log-correlation-output').textContent;
        return t.indexOf(c) !== -1 && /log entries/.test(t) && /1 error/.test(t) && /Mod\.SendShipment/.test(t);
      }, CORR));
    ok('...and offers the hand-off to the Log Stream',
      await page.evaluate(() => getComputedStyle(document.getElementById('log-corr-stream-btn')).display !== 'none'));
    // Picking a row writes its ID into the box, which also drives the filter —
    // the list must not collapse to the row just clicked and strand the user.
    ok('...while the list still shows the other IDs to pick next',
      await page.evaluate(() => document.querySelectorAll('#log-correlation-list .log-corr-row').length > 1));
    ok('...with the picked row highlighted',
      await page.evaluate(() => !!document.querySelector('#log-correlation-list .log-corr-row.selected')));

    // Typing a partial ID must narrow the list, not scan the log as free text.
    await page.evaluate(() => {
      const box = document.getElementById('log-correlation-id');
      box.value = 'no-such-id';
      box.dispatchEvent(new Event('input'));
    });
    await sleep(300);
    ok('a filter that matches nothing says so instead of rendering an empty list',
      await page.evaluate(() => /No correlation ID matches/.test(document.getElementById('log-correlation-list').textContent)));

    currentTool = 'teardown';
    await page.close();
  } finally {
    await browser.close();
    server.close();
  }

  console.log('');
  if (errors.length) {
    console.log('Unexpected page/console errors (' + errors.length + '):');
    errors.slice(0, 15).forEach(e => console.log('  ! ' + e));
    failed += errors.length;
  } else {
    console.log('No unexpected console errors across the whole sweep.');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch(e => { console.error('Browser smoke crashed:', e); process.exit(1); });
