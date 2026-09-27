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

// Visible text fields whose accessible name is missing or comes only from the
// placeholder. Each is looked up through a marker attribute because the CDP
// session is not the page's own, so element handles cannot be passed across.
async function fieldsWithoutName(page, cdp) {
  const bad = [];
  const handles = await page.$$('input:not([type=hidden]):not([type=checkbox]):not([type=radio])' +
    ':not([type=file]):not([type=range]):not([type=button]), select, textarea');
  for (const h of handles) {
    const info = await h.evaluate(e => ({ id: e.id, tag: e.tagName.toLowerCase(),
      visible: e.checkVisibility({ visibilityProperty: true }) }));
    if (!info.visible) continue;
    await h.evaluate(e => e.setAttribute('data-ax-probe', ''));
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-ax-probe]' });
    const ax = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
    await h.evaluate(e => e.removeAttribute('data-ax-probe'));
    const name = (ax.nodes[0] || {}).name;
    const src = name && name.sources ? name.sources.find(s => s.value && s.value.value && !s.superseded) : null;
    if (!name || !name.value || (src && src.attribute === 'placeholder')) bad.push(info.tag + '#' + (info.id || '?'));
  }
  return bad;
}

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
  '10.0.0.4 - - [20/Jul/2026:10:00:08 +0000] "GET /ui/theme/images/logo.png HTTP/1.1" 404 64 "-" "Mozilla/5.0" 0.001',
  // Attacker-controlled fields (review BUG-06). `img onerror`, not `svg onload`:
  // an <svg onload> inserted through innerHTML never fires, so a fixture built on
  // it passes before the fix too.
  '10.0.0.5 - - [20/Jul/2026:10:00:09 +0000] "GET /xas/ HTTP/1.1" 200 64 "https://ref.example/<img src=x onerror=window.__xssRef=1>" "Mozilla/5.0" 0.010',
  '10.0.0.6 - - [20/Jul/2026:10:00:10 +0000] "GET /a<img/src/onerror=window.__xssUrl=1> HTTP/1.1" 200 64 "-" "Mozilla/5.0" 0.010'
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
    // A native confirm()/alert() would block the page; recorded and dismissed so
    // the run continues and the assertion below can name it.
    const nativeDialogs = [];
    page.on('dialog', d => { nativeDialogs.push(d.type() + ': ' + d.message()); d.dismiss(); });
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
    const unnamedFields = [];
    const axSession = await page.target().createCDPSession();
    await axSession.send('DOM.enable'); await axSession.send('Accessibility.enable');
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
      (await fieldsWithoutName(page, axSession)).forEach(f => unnamedFields.push(id + ' ' + f));
    }
    currentTool = 'after tool sweep';
    ok('every tool renders a non-empty panel', emptyPanels.length === 0, emptyPanels.join(' · '));
    // Review UX-01: a field named only by its placeholder loses that name the
    // moment something is typed, and one with no name at all is read as "edit
    // text". The name is taken from Chromium's accessibility tree, not guessed.
    ok('every visible form field has an accessible name that is not just its placeholder',
      unnamedFields.length === 0, unnamedFields.length + ': ' + unnamedFields.slice(0, 40).join(' · '));

    // Review UX-06: the tool name is the page's one heading and the tab title, so
    // a switch of tool is announced and heading navigation has somewhere to land.
    await page.evaluate(() => window.navigate('log-viewer', null));
    await sleep(200);
    const heading = await page.evaluate(() => {
      const h = document.querySelectorAll('h1');
      return { count: h.length, text: h[0] ? h[0].textContent.trim() : '', title: document.title };
    });
    eq('exactly one <h1> on a tool page', heading.count, 1);
    eq('the <h1> is the tool name', heading.text, 'Mendix Log Viewer');
    ok('the browser tab title names the tool', /^Mendix Log Viewer — /.test(heading.title), heading.title);
    // Every tab strip is exposed as tabs, and the selected one follows the click
    // even in tools that never set aria-selected themselves.
    const tabsA11y = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('.tabs').forEach(list => {
        const tabs = list.querySelectorAll(':scope > .tab');
        if (!tabs.length) return;
        if (list.getAttribute('role') !== 'tablist') bad.push('tablist ' + (list.id || list.parentElement.id || '?'));
        tabs.forEach(t => {
          if (t.getAttribute('role') !== 'tab') bad.push('tab ' + t.textContent.trim());
          if (t.getAttribute('aria-selected') !== String(t.classList.contains('active'))) bad.push('selected ' + t.textContent.trim());
        });
      });
      return bad;
    });
    ok('every tab strip is a tablist with role=tab and aria-selected', tabsA11y.length === 0, tabsA11y.slice(0, 15).join(' · '));
    const csSelected = await page.evaluate(async () => {
      window.navigate('char-sanitizer', null);
      document.getElementById('cs-tab-stats').click();
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
      return document.getElementById('cs-tab-stats').getAttribute('aria-selected') + '/' +
             document.getElementById('cs-tab-inspector').getAttribute('aria-selected');
    });
    eq('aria-selected follows a tab click', csSelected, 'true/false');
    // Review UX-02 / Q5: counts read en-US whatever the machine's locale.
    eq('mtFmtInt groups digits the en-US way', await page.evaluate(() => window.mtFmtInt(48499)), '48,499');

    // Duplicate ids (review BUG-08): getElementById returns the first, so the
    // second panel's controls silently drive the first — the SQL Formatter's
    // Split/Raw/Result toggled the OQL Translator's panes instead of its own.
    const dupIds = await page.evaluate(() => {
      const seen = {}, dup = [];
      document.querySelectorAll('[id]').forEach(el => { if (seen[el.id]) dup.push(el.id); seen[el.id] = true; });
      return [...new Set(dup)];
    });
    ok('no element id is used twice', dupIds.length === 0, dupIds.join(', '));
    const sqlfRaw = await page.evaluate(() => {
      window.navigate('sql-formatter', null);
      const btn = [...document.querySelectorAll('#panel-sql-formatter .btn-group .btn')].find(b => b.textContent.trim() === 'Raw');
      btn.click();
      const panes = document.getElementById('sqlf-split').children;
      const shown = [...panes].filter(p => getComputedStyle(p).display !== 'none').length;
      [...document.querySelectorAll('#panel-sql-formatter .btn-group .btn')].find(b => b.textContent.trim() === 'Split').click();
      return shown;
    });
    eq('SQL Formatter Raw view shows one pane of its own split', sqlfRaw, 1);

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

    // Review UX-07: the time range is a native time field, so "9:00" can no longer
    // be typed and silently filter everything out; and an "HH:MM" bound (what the
    // field reports when the seconds are zero) still includes that minute's first
    // second rather than cutting it off as a plain text comparison would.
    const lvTime = await page.evaluate(async () => {
      const from = document.getElementById('log-time-from'), to = document.getElementById('log-time-to');
      const rowsUpTo = async v => {
        to.value = v; to.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 50));
        return document.querySelectorAll('#log-container .log-row').length;
      };
      const full = await rowsUpTo('10:00:00'), short = await rowsUpTo('10:00');
      await rowsUpTo('');
      return { type: from.type + '/' + to.type, step: from.step, full: full, short: short };
    });
    eq('Log Viewer time bounds are native time fields with seconds', lvTime.type + ' ' + lvTime.step, 'time/time 1');
    ok('an HH:MM upper bound means HH:MM:00, not "before the minute"', lvTime.full > 0 && lvTime.short === lvTime.full,
      '10:00 → ' + lvTime.short + ' rows, 10:00:00 → ' + lvTime.full);

    // Incident Report: a malformed window is flagged on the field when the user
    // leaves it, with the expected format under it — not only by a toast at
    // Generate — and not while it is still being typed.
    const irCheck = await page.evaluate(async () => {
      window.navigate('incident-report', null);
      const from = document.getElementById('ir-from'), to = document.getElementById('ir-to');
      const hint = document.getElementById('ir-window-hint');
      const shown = () => !!hint && getComputedStyle(hint).display !== 'none' && hint.textContent.trim().length > 0;
      const typing = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      const type = (el, v) => { typing(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); };
      type(to, ''); typing(from, '2026-0');
      const midway = from.classList.contains('is-invalid') || shown();
      type(from, '2026-09-20 9:00');
      const bad = { invalid: from.classList.contains('is-invalid'), aria: from.getAttribute('aria-invalid'), hint: shown() };
      // Trailing junk used to pass: the pattern only anchored the start.
      type(from, '2026-09-20 10:00:002026-09-20 9:00');
      bad.trailing = from.classList.contains('is-invalid');
      type(from, '2026-09-20 11:00:00'); type(to, '2026-09-20 10:00:00');
      const reversed = { invalid: to.classList.contains('is-invalid'), hint: shown() };
      typing(from, '2026-09-20 09:00:00'); // fixed by a keystroke, before leaving the field
      const good = { invalid: from.classList.contains('is-invalid') || to.classList.contains('is-invalid'), hint: shown() };
      type(from, ''); type(to, '');
      return { midway: midway, bad: bad, reversed: reversed, good: good };
    });
    eq('no error while the value is still being typed', irCheck.midway, false);
    eq('Incident Report marks a malformed start on leaving the field', JSON.stringify(irCheck.bad), '{"invalid":true,"aria":"true","hint":true,"trailing":true}');
    eq('Incident Report marks an end before the start', JSON.stringify(irCheck.reversed), '{"invalid":true,"hint":true}');
    eq('a corrected window clears the mark and the hint', JSON.stringify(irCheck.good), '{"invalid":false,"hint":false}');
    await page.evaluate(() => window.navigate('log-viewer', null));

    // Review UX-05: no native confirm() anywhere — it blocks the page and ignores
    // the theme. The Data Hub asks before replacing data only in a tool that has
    // no Undo; the Log Viewer offers Undo itself, so it is not asked twice.
    await page.evaluate(t => { window.navigate('log-query-extractor', null); window.lqeLoadText(t); }, LOG);
    await page.waitForFunction(() => window.lqeHasData(), { timeout: 20000 });
    await page.evaluate(() => window.navigate('microflow-tracer', null));
    const hubCheck = await page.evaluate(async t => {
      const dialogOpen = () => !!document.querySelector('#mt-confirm.modal-overlay.active');
      window.mtHub.setSource({ name: 'other.log', size: t.length, text: t, origin: 'microflow-tracer' });
      const r = { lqeHasData: window.lqeHasData() };
      window.mtHub.openIn('log-viewer');
      await new Promise(res => setTimeout(res, 50));
      r.askedForLogViewer = dialogOpen();
      const pending = window.mtHub.openIn('log-query-extractor');
      await new Promise(res => setTimeout(res, 50));
      r.askedForLqe = dialogOpen();
      const cancel = document.querySelector('#mt-confirm [data-mt-confirm="cancel"]');
      if (cancel) cancel.click();
      r.result = await pending;
      r.stayed = window.currentTool;
      return r;
    }, LOG);
    eq('Data Hub: the query extractor has data to protect', hubCheck.lqeHasData, true);
    eq('Data Hub: no question before loading into the Log Viewer (it offers Undo)', hubCheck.askedForLogViewer, false);
    eq('Data Hub: an in-app question before replacing data in a tool without Undo', hubCheck.askedForLqe, true);
    eq('Data Hub: Cancel keeps the user where they were', hubCheck.result + ' ' + hubCheck.stayed, 'false log-viewer');
    const escResult = await page.evaluate(async () => {
      const p = window.mtConfirm('Proceed?', { confirmLabel: 'Go' });
      await new Promise(r => setTimeout(r, 50));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return [await p, !!document.querySelector('#mt-confirm.modal-overlay.active')];
    });
    eq('mtConfirm: Escape answers no and closes the dialog', JSON.stringify(escResult), '[false,false]');

    // Review PROC-01: the Data Hub carries the parsed records, not only the text, so
    // the next tool builds its view without parsing the file again — and the Incident
    // Report fills a source it would have skipped straight from the Hub.
    const proc01 = await page.evaluate(async t => {
      const tick = ms => new Promise(r => setTimeout(r, ms));
      window.mftClear(); window.wsreClear();
      window.navigate('log-viewer', null);
      window.logLoadFiles([new File([t], 'hub.log', { type: 'text/plain' })]);
      for (let i = 0; i < 100 && !(window.mtHub.getSource() && window.mtHub.getSource().name === 'hub.log'); i++) await tick(20);
      const src = window.mtHub.getSource();
      const r = { hubRecords: src.records, parsedRecords: src.parsed && src.parsed.records.length };
      const factory = window.createMendixLogParser;
      let parses = 0;
      window.createMendixLogParser = function () { const p = factory(); const parse = p.parse; p.parse = function () { parses++; return parse.apply(p, arguments); }; return p; };
      try {
        window.navigate('incident-report', null);
        const btn = id => [...document.querySelectorAll('#ir-sources .ir-source-off')]
          .filter(el => el.querySelector('button[onclick*="' + id + '"]'))
          .map(el => el.querySelector('button').textContent)[0] || null;
        r.offered = btn('microflow-tracer') + ' / ' + btn('ws-rest-extractor');
        await window.irLoadFromHub('microflow-tracer');
        r.mftSection = !!window.mftReportSection(null, null);
        r.stayed = window.currentTool;
        r.mftRowOn = !!document.querySelector('#ir-sources input.ir-source-cb[value="microflow-tracer"]');
        r.wsreStillOffered = btn('ws-rest-extractor');
        // A pre-filled window is widened by a new source; one the user typed is kept.
        const from = document.getElementById('ir-from'), to = document.getElementById('ir-to');
        from.value = '2026-07-20 10:00:00'; to.value = '2026-07-20 10:00:01';
        await window.irLoadFromHub('ws-rest-extractor');
        r.typedWindowKept = from.value + ' / ' + to.value;
        from.value = ''; to.value = '';
      } finally {
        window.createMendixLogParser = factory;
      }
      r.parses = parses;
      return r;
    }, LOG);
    ok('PROC-01: the Hub holds the records the Log Viewer parsed', proc01.parsedRecords > 0 && proc01.parsedRecords === proc01.hubRecords,
      proc01.parsedRecords + ' parsed vs ' + proc01.hubRecords + ' reported');
    eq('PROC-01: Incident Report offers the Hub file for the empty log tools', proc01.offered, 'Load from Data Hub / Load from Data Hub');
    eq('PROC-01: loading from the Hub fills the Microflow Tracer section', proc01.mftSection + ' ' + proc01.mftRowOn, 'true true');
    eq('PROC-01: ...without leaving the report', proc01.stayed, 'incident-report');
    eq('PROC-01: ...and without parsing the file again', proc01.parses, 0);
    eq('PROC-01: the other empty tool is still offered', proc01.wsreStillOffered, 'Load from Data Hub');
    eq('PROC-01: a window the user typed survives loading a source', proc01.typedWindowKept, '2026-07-20 10:00:00 / 2026-07-20 10:00:01');

    // Wave 38: Developer Studio finds running apps when it opens and on "Scan again"
    // — never on a timer — and "Analyze project" runs the model views behind one
    // progress bar, then opens the project with the runtime-only cards hidden.
    // No bridge runs here, so its answers are stubbed.
    const ds38 = await page.evaluate(async () => {
      const tick = ms => new Promise(r => setTimeout(r, ms));
      const realFetch = window.fetch;
      let detects = 0;
      const json = o => Promise.resolve(new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } }));
      window.fetch = function (url) {
        const u = String(url);
        if (u.indexOf('/detect-project') !== -1) { detects++; return json({ success: true, projects: [{ projectRoot: 'C:\\Apps\\Demo', metadata: { ProjectName: 'Demo' } }] }); }
        if (u.indexOf('/model/mpr') !== -1) return json({ ok: true, projectName: 'Demo', productVersion: '10.24.0', formatVersion: 2, counts: { modules: 1 } });
        if (u.indexOf('/model/') !== -1) return json({ ok: false, reason: 'stubbed' });
        // /status is left alone: answering it would flip the app-wide bridge
        // indicator to online for the tests after this one.
        return realFetch.apply(this, arguments);
      };
      const r = {};
      try {
        window.navigate('dev-studio', null);
        await tick(3500);
        r.detectsAfterOpen = detects;
        r.listed = document.getElementById('ds-detected-projects').options.length;
        const scan = [...document.querySelectorAll('#ds-offline-view button')].find(b => b.textContent === 'Scan again');
        await window.dsScanAgain(scan);
        r.detectsAfterScan = detects;
        document.getElementById('ds-file-path').value = '"C:\\Apps\\Demo\\Demo.mpr"';
        await window.dsAnalyzeProject(document.getElementById('ds-analyze-btn'));
        const panel = document.getElementById('panel-dev-studio');
        r.fileMode = panel.classList.contains('ds-file-mode');
        r.tab = document.getElementById('ds-tab-dashboard').textContent;
        r.close = document.getElementById('ds-disconnect-btn').textContent;
        r.visibleCards = [...document.querySelectorAll('#ds-dashboard-view .card')].filter(c => c.offsetParent).map(c => c.querySelector('h4').textContent).join(', ');
        r.warned = document.querySelectorAll('#ds-file-progress-list li.is-warn').length;
        r.endpoint = document.getElementById('ds-status-endpoint').textContent;
        window.dsDisconnect();
        r.closed = !panel.classList.contains('ds-file-mode') && document.getElementById('ds-offline-view').style.display === 'flex';
        await tick(3500);
        r.detectsAtEnd = detects;
      } finally {
        window.fetch = realFetch;
        window.dsDisconnect();
      }
      return r;
    });
    eq('Dev Studio: one scan when the tool opens, none on a timer', ds38.detectsAfterOpen + ' ' + ds38.listed, '1 1');
    eq('Dev Studio: Scan again scans once more', ds38.detectsAfterScan, 2);
    eq('Dev Studio: Analyze project opens the file as a project', [ds38.fileMode, ds38.tab, ds38.close].join(' / '), 'true / Project / Close project');
    eq('Dev Studio: only the model card shows for a project file', ds38.visibleCards, 'Project File (.mpr)');
    eq('Dev Studio: a view that failed is listed with its reason, not hidden', ds38.warned, 4);
    ok('Dev Studio: the header says there is no app running', /no app running/.test(ds38.endpoint), ds38.endpoint);
    eq('Dev Studio: Close project returns to the start screen', ds38.closed, true);
    eq('Dev Studio: still no background scan after closing', ds38.detectsAtEnd, 2);
    await page.evaluate(() => window.navigate('log-viewer', null));
    await page.evaluate(() => window.navigate('log-viewer', null));
    eq('no native browser dialog was opened', nativeDialogs.join(' | '), '');

    // Review UX-08: the bridge indicator is a control. Offline it says what the
    // bridge is for and how to start it; online, what it is doing.
    const bridgePop = await page.evaluate(async () => {
      const btn = document.getElementById('global-bridge-status');
      const pop = () => document.getElementById('bridge-popover');
      const open = () => !!pop() && getComputedStyle(pop()).display !== 'none';
      const tick = () => new Promise(r => setTimeout(r, 30));
      const r = { tag: btn.tagName, expanded0: btn.getAttribute('aria-expanded'), controls: btn.getAttribute('aria-controls') };
      btn.click(); await tick();
      r.opened = open(); r.expanded1 = btn.getAttribute('aria-expanded');
      r.offlineText = open() ? pop().textContent : '';
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick();
      r.escClosed = !open(); r.focusBack = document.activeElement === btn;
      btn.click(); await tick();
      document.getElementById('main').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await tick();
      r.outsideClosed = !open();
      const base = { status: 'online', version: '9.9.9', logLinesCount: 12,
        otel: { port: 4318, tracesReceived: 1, logsReceived: 2, metricsReceived: 3 } };
      r.online = window.mtBridgePopoverHtml(Object.assign({ logFile: 'C:/logs/app.log' }, base));
      r.untailed = window.mtBridgePopoverHtml(Object.assign({ logFile: 'Not found' }, base));
      r.hostile = window.mtBridgePopoverHtml(Object.assign({ logFile: 'C:/x/<img src=x onerror=alert(1)>.log' }, base));
      return r;
    });
    eq('bridge indicator is a disclosure button', [bridgePop.tag, bridgePop.expanded0, bridgePop.controls].join(' '), 'BUTTON false bridge-popover');
    eq('clicking it opens the popover', bridgePop.opened + ' ' + bridgePop.expanded1, 'true true');
    ok('offline: says how to start the bridge and what needs it',
      /Start-MxDevSwissTool\.bat/.test(bridgePop.offlineText) && /Developer Studio/.test(bridgePop.offlineText) && /Check again/.test(bridgePop.offlineText),
      bridgePop.offlineText.slice(0, 200));
    eq('Escape closes it and returns focus to the indicator', bridgePop.escClosed + ' ' + bridgePop.focusBack, 'true true');
    eq('a click elsewhere closes it', bridgePop.outsideClosed, true);
    ok('online: version, port and the tailed file', /9\.9\.9/.test(bridgePop.online) && /4318/.test(bridgePop.online) && /app\.log/.test(bridgePop.online), bridgePop.online.slice(0, 300));
    ok('online, nothing tailed: points to where a file is set', /Metrics &amp; Telemetry|Metrics & Telemetry/.test(bridgePop.untailed), bridgePop.untailed.slice(0, 300));
    ok('the tailed path is escaped', !/<img/.test(bridgePop.hostile), bridgePop.hostile.slice(0, 300));

    // Review UX-09: one database connection for the whole app. Metrics & Telemetry
    // had its own five fields, so the same credentials were typed twice and the
    // tool never knew Live DB was already set up elsewhere.
    const dbShared = await page.evaluate(async () => {
      const r = {};
      window.navigate('log-query-extractor', null);
      const lqeHost = document.querySelector('#lqe-livedb-bar input[data-f="host"]');
      lqeHost.value = 'db.example.test'; lqeHost.dispatchEvent(new Event('input', { bubbles: true }));
      window.navigate('telemetry-monitor', null);
      await new Promise(res => setTimeout(res, 100));
      const panel = document.getElementById('panel-telemetry-monitor');
      r.ownFields = ['tm-pg-host', 'tm-pg-port', 'tm-pg-dbname', 'tm-pg-user', 'tm-pg-pass'].filter(id => document.getElementById(id)).length;
      const tmHost = panel.querySelector('[data-mt-db-connection] input[data-f="host"]');
      r.sharedBar = !!tmHost;
      r.tmHost = tmHost ? tmHost.value : null;
      // What the stats request actually sends.
      const realFetch = window.fetch;
      let sent = null;
      window.fetch = (url, opts) => { if (/\/postgres$/.test(url)) sent = JSON.parse(opts.body); return Promise.reject(new Error('stubbed')); };
      try { window.tmFetchAgentPostgres('http://localhost:9999', true); } finally { window.fetch = realFetch; }
      r.sentHost = sent && sent.host;
      lqeHost.value = 'localhost'; lqeHost.dispatchEvent(new Event('input', { bubbles: true }));
      return r;
    });
    eq('Telemetry has no connection fields of its own', dbShared.ownFields, 0);
    eq('Telemetry mounts the shared Live DB bar', dbShared.sharedBar, true);
    eq('a host typed in one Live DB bar shows in the others', dbShared.tmHost, 'db.example.test');
    eq('Telemetry\'s PostgreSQL stats use the shared connection', dbShared.sentHost, 'db.example.test');

    // Review UX-10 / decision Q9: WASM Profiler is gone, and API Economics sits in
    // Data & Format next to the JSON Formatter instead of a section of its own.
    const ia = await page.evaluate(async () => {
      const r = { wasmPanel: !!document.getElementById('panel-wasm-profiler') };
      window.navigate('wasm-profiler', null);
      await new Promise(res => setTimeout(res, 50));
      r.wasmFallsBackHome = window.currentTool;
      const api = document.querySelector('.nav-item[data-tool="api-economics"]');
      let label = api.previousElementSibling;
      while (label && !label.classList.contains('nav-section-label')) label = label.previousElementSibling;
      r.apiSection = label && label.textContent.trim();
      const prev = api.previousElementSibling;
      r.apiAfter = prev && prev.getAttribute('data-tool');
      r.sidebarLabels = Array.from(document.querySelectorAll('.nav-section-label')).map(e => e.textContent.trim());
      r.homeHeaders = Array.from(document.querySelectorAll('#home-view .home-section-header, #panel-home .home-section-header')).map(e => e.textContent.trim());
      return r;
    });
    eq('WASM Profiler has no panel', ia.wasmPanel, false);
    eq('a stale link to WASM Profiler lands on Home', ia.wasmFallsBackHome, 'home');
    eq('API Economics is in Data & Format', ia.apiSection, 'Data & Format');
    eq('API Economics follows the JSON Formatter', ia.apiAfter, 'json-formatter');
    ok('no one-tool "Analytics & Estimation" section in the sidebar or on Home',
      !ia.sidebarLabels.concat(ia.homeHeaders).some(t => /Analytics/.test(t)), ia.sidebarLabels.concat(ia.homeHeaders).join(' · '));

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

    // Log fields are text, never markup: the payloads must be on screen as text
    // and must not have run. Settled first — onerror fires asynchronously.
    await sleep(300);
    ok('nginx shows an attacker-controlled referrer as text',
      await page.evaluate(() => document.getElementById('nx-ref-table').textContent.includes('<img src=x onerror=')));
    // Compared in the page: undefined does not survive serialisation back to Node.
    const nxXss = await page.evaluate(() => ('__xssRef' in window) + ',' + ('__xssUrl' in window));
    eq('nginx does not execute markup from the Referer or the request path', nxXss, 'false,false');
    // The escaped onclick must still hand the exact value back to the filter.
    const nxFiltered = await page.evaluate(() => {
      const cell = [...document.querySelectorAll('#nx-url-table td[onclick]')].find(td => td.title.includes('onerror'));
      if (!cell) return 'no-cell';
      cell.click();
      const v = window.nginxFilter.url;
      window.nginxClearFilters();
      return v;
    });
    eq('nginx URL filter receives the raw path through the escaped onclick', nxFiltered, '/a<img/src/onerror=window.__xssUrl=1>');

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

    // Deployment-model attribution (wave 27). The index normally arrives from the
    // Bridge, which is not running here, so it is injected directly — what is
    // under test is the four consumers and the degradation contract, not the
    // fetch. The fixture's table is the one the synthetic log already queries.
    console.log('\nDeployment-model attribution');
    currentTool = 'log-query-extractor';
    const OPS_FIXTURE = {
      byEntity: {
        'Sales.Order': [
          { kind: 'retrieve', entity: 'Sales.Order', page: 'Sales.Overview', widget: 'Sales.Overview.list1' },
          { kind: 'retrieve', entity: 'Sales.Order', page: 'Sales.Overview', widget: 'Sales.Overview.search1' },
          { kind: 'retrieve', entity: 'Sales.Order', page: 'Sales.Detail', widget: 'Sales.Detail.dv1' },
          { kind: 'callMicroflow', entity: 'Sales.Order', microflow: 'Sales.ACT_Ship', page: null, widget: null }
        ]
      },
      byTable: { 'sales$order': 'Sales.Order' },
      byMicroflow: { 'Sales.ACT_Ship': [{ kind: 'callMicroflow', microflow: 'Sales.ACT_Ship' }] },
      counts: { operations: 4, entities: 1, microflows: 1, pages: 2 }
    };

    const attribution = await page.evaluate(idx => {
      window._mxOpsIndex = idx;
      const html = window.mxOpsAttributionHtml('sales$order');
      const quoted = window.mxOpsAttributionHtml('public."sales$order"');
      const byEntity = window.mxOpsAttributionHtml('Sales.Order');
      const unknown = window.mxOpsAttributionHtml('nope$nope');
      window._mxOpsIndex = null;
      const degraded = window.mxOpsAttributionHtml('sales$order');
      window._mxOpsIndex = idx;
      return { html: html, quoted: quoted, byEntity: byEntity, unknown: unknown, degraded: degraded };
    }, OPS_FIXTURE);

    ok('attribution names the entity behind the table', /Sales\.Order/.test(attribution.html));
    ok('...and every screen that queries it',
      /Sales\.Overview/.test(attribution.html) && /Sales\.Detail/.test(attribution.html));
    ok('...with the page prefix stripped from widget names',
      /list1, search1/.test(attribution.html), attribution.html);
    ok('...and says how many operations have no screen at all',
      /1 operation\(s\) recorded without a screen/.test(attribution.html));
    ok('a quoted, schema-qualified table resolves the same way',
      attribution.quoted === attribution.html);
    ok('an entity name works as well as a table name', attribution.byEntity === attribution.html);
    eq('an unknown table renders nothing', attribution.unknown, '');
    // The whole contract of this enrichment: with no model loaded every consumer
    // renders exactly what it rendered before wave 27.
    eq('with no index loaded it renders nothing', attribution.degraded, '');

    await page.evaluate(t => { window.navigate('log-query-extractor', null); window.lqeLoadText(t); }, LOG);
    await page.waitForFunction(() => document.querySelectorAll('#lqe-query-list .lqe-list-item').length > 0, { timeout: 20000 });
    await page.evaluate(() => document.querySelector('#lqe-query-list .lqe-list-item').click());
    await sleep(400);
    ok('the Query Extractor names the screens behind the selected query',
      await page.evaluate(() => /Sales\.Overview/.test(document.getElementById('lqe-source-attribution').innerHTML)));
    await page.evaluate(() => {
      window._mxOpsIndex = null;
      document.querySelector('#lqe-query-list .lqe-list-item').click();
    });
    await sleep(400);
    eq('...and drops back to the pane it had before when the index goes away',
      await page.evaluate(() => document.getElementById('lqe-source-attribution').innerHTML), '');

    // Query Intelligence → Explain. The table name is the regression guard: the
    // scan-table regex excluded `$`, so it captured `sales` out of `sales$order`
    // for every Mendix table there has ever been, and no lookup could resolve it.
    currentTool = 'query-intelligence';
    const qiSuggestion = await page.evaluate(async idx => {
      window._mxOpsIndex = idx;
      window.navigate('query-intelligence', null);
      document.getElementById('sql-explain-input').value =
        'Seq Scan on sales$order  (cost=0.00..1250.00 rows=12 width=64) (actual time=0.021..18.442 rows=9 loops=1)\n' +
        '  Filter: (status = \'Open\'::text)';
      window.visualizeSqlExplain();
      await new Promise(r => setTimeout(r, 300));
      return document.getElementById('sql-explain-result').innerText;
    }, OPS_FIXTURE);
    ok('the scan table keeps the $ that every Mendix table name contains',
      /sales\$order/.test(qiSuggestion), qiSuggestion.slice(0, 200));
    ok('...so the suggestion names the entity instead of telling you to go find it',
      /open entity/i.test(qiSuggestion) && /Sales\.Order/.test(qiSuggestion));
    ok('...and lists the screens that query it',
      /Screens that query/.test(qiSuggestion) && /Sales\.Overview/.test(qiSuggestion));

    // Error Decoder. The tables are searched in the decoded message, not in the
    // matched signature — `ERROR: duplicate key value` never carries a table.
    currentTool = 'error-decoder';
    const edxText = await page.evaluate(async idx => {
      window._mxOpsIndex = idx;
      window.navigate('error-decoder', null);
      document.getElementById('edx-input').value =
        'ERROR: duplicate key value violates unique constraint on "sales$order"';
      window.edxAnalyze();
      await new Promise(r => setTimeout(r, 300));
      return document.getElementById('edx-results').innerText;
    }, OPS_FIXTURE);
    ok('the decoder finds the table in the message, not just in the signature',
      /sales\$order/.test(edxText) && /Sales\.Order/.test(edxText), edxText.slice(0, 200));
    ok('...and names the screens behind it',
      /Screens that query/.test(edxText) && /Sales\.Overview/.test(edxText));

    await page.evaluate(() => { window._mxOpsIndex = null; });

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

    // A .gz that inflates past the cap stops with advice instead of taking the
    // tab down (review BUG-19). Built in the page; a small cap stands in for 512 MB.
    console.log('\nLog Viewer .gz cap');
    const gzCap = await page.evaluate(async () => {
      const gz = await new Response(new Blob([new Uint8Array(64 * 1024)]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
      const file = new File([gz], 'huge.log.gz');
      let refused = null, full = null;
      try { await window.logReadFileText(file, 1024); } catch (e) { refused = e.message; }
      full = (await window.logReadFileText(file, 1024 * 1024)).length;
      return { refused, full };
    });
    ok('a .gz that expands past the cap is refused with advice', /too large for one browser tab/.test(gzCap.refused || ''), gzCap.refused);
    eq('...and under the cap it reads in full', gzCap.full, 64 * 1024);
    // The same cap in the Excel Converter, checked in a browser because that is
    // where an error inside a stream pipe used to lose its message.
    const xlsCap = await page.evaluate(async () => {
      const raw = new Uint8Array(await new Response(new Blob([new Uint8Array(64 * 1024)]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
      try { await window.xlsInflateRaw(raw, 1024); return 'not refused'; } catch (e) { return e.message; }
    });
    ok('an .xlsx part that expands past the cap is refused with advice', /too large to open/.test(xlsCap), xlsCap);

    // REST Load Tester preset (review BUG-13): it is stored in localStorage and
    // exported by Backup Settings, so a credential typed into Headers must not be.
    console.log('\nLoad Tester preset');
    currentTool = 'perf-lab';
    const preset = await page.evaluate(() => {
      window.navigate('perf-lab', null);
      document.getElementById('pl-url').value = 'http://localhost:8080/rest/orders/v1';
      document.getElementById('pl-headers').value = '{"Authorization": "Bearer smoke-secret", "X-Api-Key": "k-smoke", "Content-Type": "application/json"}';
      window.plSavePreset();
      const stored = localStorage.getItem('perfLabPreset') || '';
      localStorage.removeItem('perfLabPreset');
      return { stored: stored, box: document.getElementById('pl-headers').value };
    });
    ok('a saved preset holds no header secret', preset.stored.indexOf('smoke-secret') === -1 && preset.stored.indexOf('k-smoke') === -1, preset.stored.slice(0, 200));
    ok('...keeps the header names and the harmless values', /Authorization/.test(preset.stored) && /application\/json/.test(preset.stored));
    ok('...and leaves the form itself untouched', preset.box.indexOf('smoke-secret') !== -1);

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

    // Level chips follow the Grafana legend: Enter (a click) shows only that level,
    // Shift+Enter (Shift+click) adds or removes one. The exposed state must follow
    // both — the class is toggled by code this module never calls.
    ok('Enter isolates a chip, Shift+Enter adds one, aria-pressed follows',
      await page.evaluate(async () => {
        window.navigate('log-viewer', null);
        const chips = Array.from(document.querySelectorAll('#panel-log-viewer .level-filter-btn[onclick^="logToggleLevel"]'));
        const trace = chips[0], debug = chips[1];
        const press = (el, shiftKey) => {
          el.focus();
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: shiftKey, bubbles: true }));
          return new Promise(r => setTimeout(r, 100));
        };
        const synced = () => chips.every(c => c.getAttribute('aria-pressed') === String(c.classList.contains('active')));
        await press(trace, false);
        const isolated = trace.getAttribute('aria-pressed') === 'true' && debug.getAttribute('aria-pressed') === 'false' && synced();
        await press(debug, true);
        const added = trace.getAttribute('aria-pressed') === 'true' && debug.getAttribute('aria-pressed') === 'true' && synced();
        window.logToggleAllLevels(true);
        return isolated && added;
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
