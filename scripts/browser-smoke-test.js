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

// A slow-query warning interrupted by two foreign log lines — the shape that used to
// leave `ORDER BY … ASC [JettyServer-14065] INFO org.opensaml…` in the runnable SQL.
const FOREIGN_LOG = [
  '2026-08-11T02:06:59.500000 ' + P + '   WARNING - ConnectionBus_Queries: Query executed in 10 seconds and 259 milliseconds: SELECT "t"."id" FROM "t" ORDER BY "t"."id" ASC',
  '[JettyServer-13962] INFO org.opensaml.xmlsec.algorithm.AlgorithmSupport - Mapping from algorithm URI http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p to key length not available',
  'WARNING: Supplied DOM uses namespaces, but is not created as namespace-aware',
  '2026-08-11T02:06:59.600000 ' + P + '   ERROR - Connector: 404 - file not found for file: odm.example.sql'
].join('\n');

// Carries all three 404 populations the analyzer must tell apart: a scanner
// sweep (four probes from one IP, so the behavioural pass engages), a browser
// convention, and one genuinely broken reference in the app itself.
const NGINX_LOG = [
  '10.0.0.1 - - [20/Jul/2026:10:00:01 +0000] "GET /xas/ HTTP/1.1" 200 512 "-" "Mozilla/5.0" 0.412',
  '10.0.0.2 - - [20/Jul/2026:10:00:02 +0000] "POST /xas/ HTTP/1.1" 500 128 "-" "Mozilla/5.0" 1.900',
  '9.9.9.9 - - [20/Jul/2026:10:00:03 +0000] "GET /wp-login.php HTTP/1.1" 404 64 "-" "Mozilla/5.0" 0.001',
  '9.9.9.9 - - [20/Jul/2026:10:00:04 +0000] "GET /cgi-bin/index.php HTTP/1.1" 404 64 "-" "Mozilla/5.0" 0.001',
  '9.9.9.9 - - [20/Jul/2026:10:00:05 +0000] "GET /admin/index.php HTTP/1.1" 404 64 "-" "Mozilla/5.0" 0.001',
  '9.9.9.9 - - [20/Jul/2026:10:00:06 +0000] "GET /qZk3xT.htm HTTP/1.1" 404 64 "-" "Mozilla/5.0" 0.001',
  '10.0.0.3 - - [20/Jul/2026:10:00:07 +0000] "GET /apple-touch-icon.png HTTP/1.1" 404 64 "-" "Mozilla/5.0" 0.001',
  '10.0.0.4 - - [20/Jul/2026:10:00:08 +0000] "GET /ui/theme/images/logo.png HTTP/1.1" 404 64 "-" "Mozilla/5.0" 0.001'
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

    // 404 classification must reach the DOM, not just pass in Node: the summary
    // row, the "yours" tag on the app-owned path, and the scanner source table.
    // Read while the Dashboard tab is still showing — the Streams tab below
    // replaces what is on screen.
    const nx404Html = await page.evaluate(() =>
      document.getElementById('nx-404-table').querySelector('tbody').innerHTML);
    ok('nginx 404 table summarises the three populations', /from your own app/.test(nx404Html), nx404Html.slice(0, 200));
    ok('nginx 404 table tags the app-owned reference first',
      nx404Html.indexOf('yours') !== -1 && nx404Html.indexOf('/ui/theme/images/logo.png') !== -1, nx404Html.slice(0, 400));
    ok('nginx 404 table keeps the browser-convention 404 out of the app bucket',
      nx404Html.indexOf('/apple-touch-icon.png') === -1, nx404Html.slice(0, 400));
    const nxBotsHtml = await page.evaluate(() =>
      document.getElementById('nx-bots-table').querySelector('tbody').innerHTML);
    ok('nginx scanner-source table names the sweeping IP', /9\.9\.9\.9/.test(nxBotsHtml), nxBotsHtml.slice(0, 200));
    ok('nginx scanner-source table reports how many distinct paths it swept', /distinct path/.test(nxBotsHtml));

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

    // Foreign log lines: a bundled library (opensaml, the AWS SDK, Xerces) logging
    // through its own framework straight to stdout. The Log Viewer has its own parser,
    // so the shared parser's unit tests cannot see this branch — and it is the branch
    // that used to glue such a line onto whatever record came before it.
    console.log('\nForeign log lines');
    currentTool = 'log-viewer';
    await page.evaluate(t => {
      window.navigate('log-viewer', null);
      window.logClear();
      window.logLoadText(t, 'foreign.log');
    }, FOREIGN_LOG);
    await page.waitForFunction(() => document.querySelectorAll('#log-container .log-row').length > 0, { timeout: 20000 });
    const foreignRows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#log-container .log-row')).map(r => r.innerText.replace(/\s+/g, ' ').trim()));
    eq('each foreign line becomes its own row', foreignRows.length, 4);
    ok('the slow-query SQL stops at the statement',
      !/JettyServer|opensaml/.test(foreignRows[0]), foreignRows[0]);
    ok('the slf4j line is filed under its logger, keeping the thread name',
      /org\.opensaml\.xmlsec\.algorithm\.AlgorithmSupport/.test(foreignRows[1]) && /\[JettyServer-13962\]/.test(foreignRows[1]),
      foreignRows[1]);
    ok('a foreign line inherits the timestamp of the record it interrupted',
      foreignRows[1].indexOf('2026-08-11T02:06:59.500000') !== -1, foreignRows[1]);
    ok('the java.util.logging line lands under External as a WARN',
      /External/.test(foreignRows[2]) && /WARN/.test(foreignRows[2]), foreignRows[2]);

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

    // Keyboard and screen-reader support (wave 21, D5). All of it is either
    // central CSS or one observer module, so a handful of assertions covers the
    // whole surface — and every one of them failed before this release.
    console.log('\nAccessibility');
    currentTool = 'a11y';
    await page.evaluate(() => window.navigate('home', null));
    await sleep(300);

    // `visibility: hidden` keeps layout, so measuring boxes proves nothing here.
    // What matters is that the browser refuses to focus them — which is exactly
    // what being out of the tab order means.
    ok('closed dialogs are out of the tab order and the a11y tree',
      await page.evaluate(() => {
        const sel = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
        return Array.from(document.querySelectorAll('.modal-overlay:not(.active)')).every(m =>
          getComputedStyle(m).visibility === 'hidden' &&
          Array.from(m.querySelectorAll(sel)).every(el => {
            el.focus();
            return document.activeElement !== el;
          }));
      }));

    eq('--text-muted meets WCAG AA against the surface it sits on (dark)',
      await page.evaluate(() => {
        const L = h => {
          const m = h.match(/\d+/g).slice(0, 3).map(v => v / 255)
            .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
          return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
        };
        const cs = getComputedStyle(document.documentElement);
        const fg = L(cs.getPropertyValue('--text-muted').trim().replace(/^#(..)(..)(..)$/,
          (_, r, g, b) => 'rgb(' + parseInt(r, 16) + ',' + parseInt(g, 16) + ',' + parseInt(b, 16) + ')'));
        // --bg-elevated is the lightest surface muted text sits on in dark mode.
        const bg = L(cs.getPropertyValue('--bg-elevated').trim().replace(/^#(..)(..)(..)$/,
          (_, r, g, b) => 'rgb(' + parseInt(r, 16) + ',' + parseInt(g, 16) + ',' + parseInt(b, 16) + ')'));
        return ((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)) >= 4.5;
      }), true);

    ok('sortable column headers are reachable by keyboard',
      await page.evaluate(() => {
        const h = document.querySelectorAll('[data-sort-key]');
        return h.length > 0 && Array.from(h).every(el =>
          el.tagName === 'BUTTON' || (el.getAttribute('role') === 'button' && el.getAttribute('tabindex') === '0'));
      }));

    ok('level filter chips expose their pressed state',
      await page.evaluate(() => {
        const c = document.querySelectorAll('.level-filter-btn');
        return c.length > 0 && Array.from(c).every(el => el.hasAttribute('aria-pressed'));
      }));

    // Enter on a chip must toggle it exactly like a click, and the exposed
    // state must follow — the class is toggled by code this module never calls.
    ok('Enter activates a chip and aria-pressed follows',
      await page.evaluate(async () => {
        window.navigate('log-viewer', null);
        const chip = document.querySelector('#panel-log-viewer .level-filter-btn');
        const before = chip.getAttribute('aria-pressed');
        chip.focus();
        chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise(r => setTimeout(r, 100));
        return chip.getAttribute('aria-pressed') !== before &&
          chip.getAttribute('aria-pressed') === String(chip.classList.contains('active'));
      }));

    // Focus has to move into the dialog, stay there, and come back on close.
    ok('opening a dialog moves focus into it, closing restores it',
      await page.evaluate(async () => {
        window.navigate('http-status', null);
        await new Promise(r => setTimeout(r, 200));
        const opener = document.querySelector('#panel-http-status .btn');
        if (!opener) return false;
        opener.focus();
        const before = document.activeElement;
        window.showHttpModal(404);
        await new Promise(r => setTimeout(r, 200));
        const modal = document.getElementById('http-modal');
        const inside = modal.contains(document.activeElement);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
        const closed = !modal.classList.contains('active');
        return inside && closed && document.activeElement === before;
      }));

    eq('--text-muted meets WCAG AA in the light theme too',
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'light');
        const L = hex => {
          const m = [1, 3, 5].map(i => parseInt(hex.substr(i, 2), 16) / 255)
            .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
          return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
        };
        const cs = getComputedStyle(document.documentElement);
        const fg = L(cs.getPropertyValue('--text-muted').trim());
        // --bg-base is the darkest surface muted text sits on in the light theme.
        const bg = L(cs.getPropertyValue('--bg-base').trim());
        const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        document.documentElement.setAttribute('data-theme', 'dark');
        return ratio >= 4.5;
      }), true);

    // Tab must cycle inside the open dialog. The paste dialog is used because it
    // has several controls — a one-control dialog would wrap to itself and pass
    // whether or not the trap exists.
    ok('Tab cycles inside an open dialog instead of leaving it',
      await page.evaluate(async () => {
        window.navigate('log-viewer', null);
        window.logOpenPasteModal();
        await new Promise(r => setTimeout(r, 300));
        const modal = document.getElementById('log-paste-modal');
        const sel = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
        const items = Array.from(modal.querySelectorAll(sel)).filter(el => el.offsetWidth || el.offsetHeight);
        if (items.length < 2) return false;
        items[items.length - 1].focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 100));
        const wrapped = document.activeElement === items[0];
        window.logClosePasteModal();
        return wrapped;
      }));

    // A fresh profile with no stored choice must follow the OS preference.
    const themePage = await browser.newPage();
    await themePage.setViewport({ width: 1600, height: 950 });
    await themePage.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await themePage.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await themePage.waitForFunction(() => typeof window.navigate === 'function', { timeout: 30000 });
    eq('with no saved choice the OS colour-scheme preference decides the theme',
      await themePage.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light');

    // Measured on a page that has only ever rendered index.html, so this counts
    // the shipped markup and not the rows tools render later. Two kinds are
    // excluded, matching the decorator: dialog backdrops, whose handler is a
    // click convenience rather than a control, and wrappers that already contain
    // something focusable — the collapsible card headers hold a real Collapse
    // button doing the same thing, and Tab must not stop twice for one action.
    const unreachable = await themePage.evaluate(() => {
      const sel = 'a[href], button:not([disabled]), input:not([disabled]), ' +
        'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      return Array.from(document.querySelectorAll('span[onclick], div[onclick]'))
        .filter(el => !/^\s*if\s*\(/.test(el.getAttribute('onclick') || ''))
        .filter(el => !el.querySelector(sel))
        .filter(el => el.getAttribute('tabindex') !== '0')
        .map(el => el.getAttribute('onclick'));
    });
    ok('no clickable span/div in the shipped markup is left unreachable',
      unreachable.length === 0, unreachable.slice(0, 5).join(' | '));
    await themePage.close();

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
