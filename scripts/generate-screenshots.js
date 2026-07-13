const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  console.log('Starting Puppeteer...');
  const browser = await puppeteer.launch({ headless: "new", defaultViewport: { width: 1440, height: 900 } });
  const page = await browser.newPage();
  
  const targetUrl = 'http://localhost:5173/';
  console.log(`Navigating to ${targetUrl}...`);
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
  } catch (err) {
    console.log('Caught goto error, retrying:', err.message);
    await sleep(2000);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(e => console.log('Retry failed too:', e.message));
  }
  
  await sleep(4000);

  const assetsDir = path.join(__dirname, '..', '_local_assets');
  if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir);

  async function switchTool(toolId) {
    console.log(`Switching to ${toolId}...`);
    await page.click(`[data-tool="${toolId}"]`);
    await sleep(800);
  }

  // 0. HOME SCREEN (Header image)
  await switchTool('home');
  await page.evaluate(() => {
    window.toggleFavorite('log-viewer');
    window.toggleFavorite('xpath-builder');
    window.toggleFavorite('json-formatter');
    window.toggleFavorite('text-diff');
  });
  await sleep(500);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-home.png') });
  console.log('Saved screenshot-home.png');

  // 1. DATA FACTORY
  await switchTool('data-factory');
  await page.evaluate(() => {
    if (window.dfSchema) {
      window.dfSchema.length = 0;
      window.dfSchema.push(
        { name: 'TransactionID', type: 'UUID' },
        { name: 'CustomerName', type: 'FullName' },
        { name: 'EmailAddress', type: 'Email' },
        { name: 'ShippingAddress', type: 'Address' },
        { name: 'OrderAmount', type: 'Decimal' },
        { name: 'IsActive', type: 'Boolean' },
        { name: 'RegistrationDate', type: 'Date' }
      );
      if (window.dfRenderSchema) window.dfRenderSchema();
      if (window.dfPreview) window.dfPreview();
    }
    const countInput = document.getElementById('df-count');
    if (countInput) countInput.value = '250000';
  });
  await sleep(2000);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-data-factory.png') });
  console.log('Saved screenshot-data-factory.png');

  // 2. TEXT DIFF
  await switchTool('text-diff');
  await page.evaluate(() => {
    const left = document.getElementById('diff-a');
    const right = document.getElementById('diff-b');
    if (left && right) {
      left.value = JSON.stringify({
        order: {
          id: "ORD-123",
          status: "pending",
          items: [
            { productId: "PROD-1", qty: 2, price: 19.99 },
            { productId: "PROD-2", qty: 1, price: 49.99 }
          ],
          customer: { name: "John Doe", email: "john@example.com" }
        }
      }, null, 2);
      right.value = JSON.stringify({
        order: {
          id: "ORD-123",
          status: "shipped",
          items: [
            { productId: "PROD-1", qty: 2, price: 19.99 },
            { productId: "PROD-3", qty: 5, price: 9.99 }
          ],
          customer: { name: "John Doe", email: "john.doe@newdomain.com", phone: "+1-555-0198" },
          trackingInfo: { carrier: "FedEx", number: "FX-9921-331" }
        }
      }, null, 2);
      if (window.diffCompare) window.diffCompare();
    }
  });
  await sleep(500);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-text-diff.png') });
  console.log('Saved screenshot-text-diff.png');

  // 3. LOG VIEWER
  await switchTool('log-viewer');
  const mendixLogContent = fs.readFileSync(path.join(assetsDir, 'Mendix Log Viewer', 'mendix_production_incident_LogsTab.log'), 'utf8');
  await page.evaluate((wowLog) => {
    if (window.logParseContent) window.logParseContent(wowLog, "mendix_production_incident_LogsTab.log");
    document.getElementById('log-search').value = '';
    if(window.logRenderFiltered) window.logRenderFiltered();
  }, mendixLogContent);
  await sleep(1000);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-log-viewer-stream.png') });
  console.log('Saved screenshot-log-viewer-stream.png');

  // Log Viewer: Sequence Tab
  await page.evaluate(() => {
    if(window.logSetTab) window.logSetTab('sequence', document.querySelector('.tabs .tab:nth-child(3)'));
    if(window.logGenerateSequence) window.logGenerateSequence();
  });
  await sleep(1000);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-log-viewer-sequence.png') });
  console.log('Saved screenshot-log-viewer-sequence.png');

  // Log Viewer: Gantt Tab
  await page.evaluate(() => {
    if(window.logSetTab) window.logSetTab('gantt', document.querySelector('.tabs .tab:nth-child(4)'));
    if(window.logGenerateGantt) window.logGenerateGantt();
  });
  await sleep(1000);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-log-viewer-gantt.png') });
  console.log('Saved screenshot-log-viewer-gantt.png');

  // 4. TELEMETRY MONITOR
  await switchTool('telemetry-monitor');
  await sleep(1000);
  await page.evaluate(() => {
    const tabs = document.querySelectorAll('#panel-telemetry-monitor .tab');
    for (let t of tabs) {
      if (t.textContent.includes('Dashboard') || t.getAttribute('onclick')?.includes('dashboard')) {
        t.click();
      }
    }
  });
  await sleep(500);
  await page.evaluate(() => {
    if (typeof Chart !== 'undefined' && Chart.instances) {
      let chartIndex = 0;
      Object.values(Chart.instances).forEach(chart => {
        chart.data.labels = Array.from({length: 60}, (_, i) => {
          const d = new Date();
          d.setSeconds(d.getSeconds() - (60 - i));
          return d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
        });
        
        chart.data.datasets.forEach((ds, dsIndex) => {
          let baseVal = 50;
          let amplitude = 20;
          if (chartIndex === 0) { // Memory
            baseVal = 600; amplitude = 150;
          } else if (chartIndex === 1) { // CPU/Threads
            baseVal = dsIndex === 0 ? 30 : 150;
            amplitude = dsIndex === 0 ? 15 : 20;
          } else if (chartIndex === 2) { // Requests
            baseVal = 800; amplitude = 400;
          }
          
          ds.data = Array.from({length: 60}, (_, i) => {
            // Create a nice dynamic wave with some random noise and a spike near the end
            let val = baseVal + Math.sin(i / 5.0) * amplitude + (Math.random() * amplitude * 0.5);
            if (i > 45 && i < 52) val += amplitude * 1.5; // Add a dramatic spike
            return Math.max(0, Math.floor(val));
          });
        });
        chart.update();
        chartIndex++;
      });
    }
    const kpis = document.querySelectorAll('.tm-kpi-value');
    if(kpis.length >= 4) {
      kpis[0].innerHTML = '892 MB <span style="font-size:1rem;color:var(--text-muted)">/ 1024 MB</span>';
      kpis[1].innerHTML = '198 <span style="font-size:1rem;color:var(--text-muted)">/ 200</span>';
      kpis[2].innerHTML = '1254.3 req/s';
      kpis[3].innerHTML = '482.1 / s';
    }
  });
  await sleep(500);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-telemetry.png') });
  console.log('Saved screenshot-telemetry.png');

  // 5. Memory Inspector
  await switchTool('memory-inspector');
  await page.evaluate(() => {
    const jmapData = ` num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:         15420      125000000  com.mendix.core.objectmanagement.MendixObjectImpl
   2:           830       85000000  java.lang.String
   3:         42000       65000000  [C
   4:          1250       15000000  com.mendix.connectionbus.ConnectionBusImpl
   5:           420        5000000  [Ljava.lang.Object;`;
    const input = document.getElementById('mi-input');
    if (input) input.value = jmapData;
    if (window.miAnalyze) window.miAnalyze();
  });
  await sleep(1000);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-memory-inspector.png') });
  console.log('Saved screenshot-memory-inspector.png');

  // 6. JSON Formatter
  await switchTool('json-formatter');
  const complexJson = fs.readFileSync(path.join(assetsDir, 'JSON Formatter', 'complex_payload_FormatterTab.json'), 'utf8');
  await page.evaluate((jsonStr) => {
    document.getElementById('json-input').value = jsonStr;
    if (window.jsonFormat) window.jsonFormat();
  }, complexJson);
  await sleep(500);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-json-formatter.png') });
  console.log('Saved screenshot-json-formatter.png');

  // 7. JWT Decoder
  await switchTool('jwt-decoder');
  await page.evaluate(() => {
    const dummyJwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6Ik1lbmRpeCBEZXZlbG9wZXIiLCJpYXQiOjE1MTYyMzkwMjIsInJvbGVzIjpbImFkbWluIl19.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    document.getElementById('jwt-input').value = dummyJwt;
    if (window.jwtDecode) window.jwtDecode();
  });
  await sleep(500);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-jwt-decoder.png') });
  console.log('Saved screenshot-jwt-decoder.png');

  // 8. XPath Builder
  await switchTool('xpath-builder');
  await page.evaluate(() => {
    document.getElementById('xpath-input').value = "//Sales.Order[Status = 'Shipped' and TotalPrice > 1000.00 and starts-with(OrderNumber, 'ORD-2026')]/Sales.Order_Customer/CRM.Customer[City = 'Rotterdam' or City = 'Amsterdam']";
    if (window.xpathAnalyze) window.xpathAnalyze();
    if (window.formatXPathClick) window.formatXPathClick();
  });
  await sleep(500);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-xpath-builder.png') });
  console.log('Saved screenshot-xpath-builder.png');

  // 9. LOG QUERY EXTRACTOR
  await switchTool('log-query-extractor');
  try {
    const csvPath = path.join(assetsDir, 'Console export 2026-07-11_21-30-52.csv');
    if (fs.existsSync(csvPath)) {
      const csvContent = fs.readFileSync(csvPath, 'utf8');
      await page.evaluate((csv) => {
        const file = new File([csv], "Console_export.csv", { type: "text/csv" });
        const dt = new DataTransfer();
        dt.items.add(file);
        if (window.lqeLoadFile) window.lqeLoadFile(dt.files);
      }, csvContent);
      await sleep(1500); // Give it time to parse
      await page.screenshot({ path: path.join(assetsDir, 'screenshot-log-query-extractor-list.png') });
      console.log('Saved screenshot-log-query-extractor-list.png');
      
      await page.evaluate(() => {
        const firstRow = document.querySelector('#lqe-query-list .lqe-list-item');
        if (firstRow) firstRow.click();
        
        // Mock a complex query plan for WOW effect
        const planBtn = document.querySelector('div[data-target="lqe-tab-plan"]');
        if (planBtn) {
            window.lqeSetTab('lqe-tab-plan', planBtn);
        }
        
        const planContent = document.getElementById('lqe-plan-content');
        if (planContent) {
            planContent.innerHTML = `Nested Loop Left Join  (cost=12.50..345.80 rows=10 width=145) (actual time=0.045..0.048 rows=2 loops=1)
  Join Filter: (o.id = l.order_id)
  ->  Index Scan using idx_order_status on sales_order o  (cost=0.42..8.44 rows=1 width=75) (actual time=0.015..0.018 rows=1 loops=1)
        Index Cond: ((status)::text = 'PENDING'::text)
  ->  Bitmap Heap Scan on sales_orderline l  (cost=12.08..337.26 rows=10 width=70) (actual time=0.025..0.026 rows=2 loops=1)
        Recheck Cond: (order_id = o.id)
        Heap Blocks: exact=1
        ->  Bitmap Index Scan on idx_orderline_order_id  (cost=0.00..12.08 rows=10 width=0) (actual time=0.012..0.012 rows=2 loops=1)
              Index Cond: (order_id = o.id)
Planning Time: 0.150 ms
Execution Time: 0.085 ms`;
            planContent.style.color = '#e6db74';
        }
      });
      await sleep(500);
    }
  } catch(e) { console.error('Failed to generate log query extractor mock', e); }
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-log-query-extractor-plan.png') });
  console.log('Saved screenshot-log-query-extractor-plan.png');

  // 10. NGINX LOG ANALYZER
  await switchTool('nginx-log');
  const nginxLogs = fs.readFileSync(path.join(assetsDir, 'Nginx Log Analyzer', 'nginx_traffic_spike_GanttChartTab.log'), 'utf8');
  await page.evaluate((logs) => {
    if (window.nginxLoadedText !== undefined) {
      window.nginxLoadedText = logs;
      document.getElementById('nginx-log-input').value = '[File loaded: nginx_traffic_spike.log]';
      if (window.nginxAnalyzeLogs) window.nginxAnalyzeLogs();
    }
  }, nginxLogs);
  await sleep(1500);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-nginx-analyzer-logs.png') });
  console.log('Saved screenshot-nginx-analyzer-logs.png');

  // Nginx Log Analyzer: Gantt Tab
  await page.evaluate(() => {
    const tabs = document.querySelectorAll('#panel-nginx-log .tabs .tab');
    for (let t of tabs) {
      if (t.textContent.includes('Gantt') || t.getAttribute('onclick')?.includes('gantt')) {
        t.click();
      }
    }
    if (window.nginxGenerateGantt) window.nginxGenerateGantt();
  });
  await sleep(1000);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-nginx-analyzer-gantt.png') });
  console.log('Saved screenshot-nginx-analyzer-gantt.png');

  // 11. MOCK SERVER & CHAOS
  await switchTool('mock-server');
  await page.evaluate(() => {
    // Mock the UI directly to avoid needing the node backend bridge running
    document.getElementById('ms-code').value = JSON.stringify({
      status: "success",
      data: {
        id: "USR-9941",
        role: "ADMIN",
        permissions: ["read", "write", "delete"]
      }
    }, null, 2);
    document.getElementById('ms-status').value = "200";
    document.getElementById('ms-delay').value = "1500";
    document.getElementById('ms-chaos').checked = true;
    
    // Simulate the active state and response
    const out = document.getElementById('ms-output');
    out.innerHTML = '<div style="color:var(--success)">Mock Server activated on <b>http://localhost:9999/mock</b><br><br>Configure your Mendix Call REST action to use this URL.</div>' +
    '<div style="font-size:0.8rem;color:var(--text-muted);margin-top:var(--sp-4)">14:52:10 - Response received after 1520ms (Chaos Enabled: +1500ms delay)</div>' +
    '<div style="margin-top:var(--sp-2)">' +
      '<span class="badge badge-success">HTTP 200 OK</span>' +
      '<span class="badge badge-warning" style="margin-left:var(--sp-2)">Chaos Injected</span>' +
    '</div>' +
    '<pre style="margin-top:var(--sp-2);background:var(--bg-card);padding:var(--sp-3);border-radius:var(--r-md);font-size:0.85rem">{\n  "status": "success",\n  "data": {\n    "id": "USR-9941",\n    "role": "ADMIN",\n    "permissions": [\n      "read",\n      "write",\n      "delete"\n    ]\n  }\n}</pre>';
  });
  await sleep(1000);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-mock-server.png') });
  console.log('Saved screenshot-mock-server.png');

  // 12. THREAD DUMP ANALYZER
  await switchTool('thread-dump');
  const threadDump = fs.readFileSync(path.join(assetsDir, 'Thread Dump & GC Analyzer', 'jvm_thread_dump_deadlock_ThreadsTab.txt'), 'utf8');
  await page.evaluate((dump) => {
    if (window.tdParseContent) window.tdParseContent(dump, "jvm_thread_dump_deadlock_ThreadsTab.txt");
  }, threadDump);
  await sleep(1000);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-thread-dump.png') });
  console.log('Saved screenshot-thread-dump.png');

  // 13. LOG ANONYMIZER
  await switchTool('log-anonymizer');
  const anonymizerLog = fs.readFileSync(path.join(assetsDir, 'Log & Text Anonymizer', 'log_with_pii_for_anonymizer_AnonymizeTab.txt'), 'utf8');
  await page.evaluate((log) => {
    document.getElementById('anonymizer-input').value = log;
    if (window.anonymizeText) window.anonymizeText();
  }, anonymizerLog);
  await sleep(500);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-log-anonymizer.png') });
  console.log('Saved screenshot-log-anonymizer.png');

  // 14. SQL FORMATTER
  await switchTool('sql-formatter');
  const sqlContent = fs.readFileSync(path.join(assetsDir, 'SQL Formatter', 'enterprise_query_FormatterTab.sql'), 'utf8');
  await page.evaluate((sql) => {
    document.getElementById('sql-input').value = sql;
    if (window.sqlFormat) window.sqlFormat();
  }, sqlContent);
  await sleep(500);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-sql-formatter.png') });
  console.log('Saved screenshot-sql-formatter.png');


  // 16. HTTP STATUS CODES
  await switchTool('http-status');
  const statusSearch = fs.readFileSync(path.join(assetsDir, 'HTTP Status Codes', 'sample_query_SearchTab.txt'), 'utf8');
  await page.evaluate((val) => {
    const input = document.getElementById('http-search');
    if (input) {
        input.value = val;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const firstStatus = document.querySelector('.http-status-card');
    if (firstStatus) firstStatus.click();
  }, statusSearch);
  await sleep(500);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-http-status.png') });
  console.log('Saved screenshot-http-status.png');

  // 17. PERFORMANCE LAB
  await switchTool('perf-lab');
  const perfCode = fs.readFileSync(path.join(assetsDir, 'Performance Lab', 'mendix_list_processing_PerformanceTab.js'), 'utf8');
  await page.evaluate((code) => {
    const input = document.getElementById('perf-code');
    if (input) input.value = code;
    const iterations = document.getElementById('perf-iterations');
    if (iterations) iterations.value = '50';
    if(window.perfRunTest) window.perfRunTest();
  }, perfCode);
  await sleep(3500); // Wait for the chart to draw
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-perf-lab.png') });
  console.log('Saved screenshot-perf-lab.png');

  // 18. XML FORMATTER
  await switchTool('xml-formatter');
  const xmlContent = fs.readFileSync(path.join(assetsDir, 'XML Formatter', 'sap_invoice_response_FormatterTab.xml'), 'utf8');
  await page.evaluate((xml) => {
    const input = document.getElementById('xml-input');
    if (input) input.value = xml;
    if (window.xmlFormat) window.xmlFormat();
  }, xmlContent);
  await sleep(500);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-xml-formatter.png') });
  console.log('Saved screenshot-xml-formatter.png');

  // 19. XML & TEXT SANITIZER
  await switchTool('char-sanitizer');
  const dirtyXml = fs.readFileSync(path.join(assetsDir, 'XML & Text Sanitizer', 'dirty_mendix_export_SanitizeTab.xml'), 'utf8');
  await page.evaluate((text) => {
    const input = document.getElementById('sanitizer-input');
    if (input) input.value = text;
    if (window.sanitizeText) window.sanitizeText();
  }, dirtyXml);
  await sleep(500);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-char-sanitizer.png') });
  console.log('Saved screenshot-char-sanitizer.png');

  // 20. BASE64 / URL ENCODER
  await switchTool('encoder');
  const b64Data = fs.readFileSync(path.join(assetsDir, 'Base64 - URL Encoder', 'jwt_token_payload_EncoderTab.txt'), 'utf8');
  await page.evaluate((data) => {
    const input = document.getElementById('encoder-input');
    if (input) input.value = data;
    const encodeBtn = document.querySelector('button[onclick*="encodeBase64"]');
    if (encodeBtn) encodeBtn.click();
  }, b64Data);
  await sleep(500);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-encoder.png') });
  console.log('Saved screenshot-encoder.png');

  // 21. MARKDOWN & TABLE GENERATOR
  await switchTool('md-preview');
  const csvData = fs.readFileSync(path.join(assetsDir, 'Markdown & Table Generator', 'entities_export_GeneratorTab.csv'), 'utf8');
  await page.evaluate((csv) => {
    const input = document.getElementById('md-input');
    if (input) {
       input.value = "## CSV Export from Mendix\\n\\n" + csv;
       if (window.mdRender) window.mdRender();
    }
  }, csvData);
  await sleep(500);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-md-preview.png') });
  console.log('Saved screenshot-md-preview.png');

  console.log('All WOW screenshots taken successfully!');
  await browser.close();
}

run().catch(console.error);
