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
  await page.evaluate(() => {
    const wowLog = `2026-07-10 14:50:01.123  INFO - Core: Mendix Runtime started successfully on port 8080
2026-07-10 14:50:02.450  INFO - ModuleManager: Module 'System' loaded successfully.
2026-07-10 14:50:03.110  INFO - ModuleManager: Module 'Administration' loaded successfully.
2026-07-10 14:50:05.800  INFO - Connector: Connecting to database jdbc:postgresql://localhost:5432/mendix
2026-07-10 14:50:06.120  INFO - Connector: Database connection established.
2026-07-10 14:50:06.200  DEBUG - ActionManager: Executing Microflow 'System.Startup'
2026-07-10 14:50:08.500  INFO - ModuleManager: Module 'OrderManagement' loaded successfully.
2026-07-10 14:50:09.150  WARN - Core: Deprecated java action 'StringSplit' is used in Microflow 'OrderManagement.ACT_FormatString'. This action will be removed in a future Mendix version.
2026-07-10 14:50:11.900  INFO - Core: Application is ready for requests.
2026-07-10 14:51:00.001  DEBUG - REST: Incoming GET request to /rest/api/v1/customers
2026-07-10 14:51:00.045  DEBUG - REST: Successfully processed request in 44ms (Status 200)
2026-07-10 14:51:12.105  DEBUG - REST: Incoming POST request to /rest/api/v1/orders
2026-07-10 14:51:12.150  INFO - OrderManagement: Processing new order ORD-2026-9941
2026-07-10 14:51:13.000  WARN - ExternalAPI: Payment gateway responded with high latency (850ms)
2026-07-10 14:51:13.050  INFO - OrderManagement: Order ORD-2026-9941 processed successfully
2026-07-10 14:52:15.999  ERROR - Connector: Connection to database timed out after 30000ms. Attempting retry.
  at com.mendix.connectionbus.ConnectionBusImpl.getConnection(ConnectionBusImpl.java:123)
  at com.mendix.modules.MyModule.MyAction(MyAction.java:45)
  at java.base/java.util.concurrent.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1136)
2026-07-10 14:52:16.500  INFO - Connector: Re-established database connection.
2026-07-10 14:52:45.100  DEBUG - REST: Incoming PUT request to /rest/api/v1/inventory/update
2026-07-10 14:52:46.200  WARN - Inventory: Stock level for item 'Laptop-X1' is below threshold (Current: 4, Threshold: 10)
2026-07-10 14:53:11.100  ERROR - ActionManager: Error in execution of microflow 'OrderManagement.ACT_ProcessOrder'
  at com.mendix.core.actionmanagement.ActionManager.executeSync(ActionManager.java:178)
Caused by: com.mendix.core.CoreRuntimeException: Exception occurred in action '{"type":"RetrieveByXPath","entity":"Sales.Order"}', all database connections are exhausted.
  at com.mendix.modules.microflowengine.MicroflowObject.execute(MicroflowObject.java:82)
2026-07-10 14:53:12.000  ERROR - ConnectionBus: Could not retrieve connection from pool. Pool size: 50, Active: 50, Idle: 0
2026-07-10 14:53:15.000  CRITICAL - Core: Application state corrupted due to massive database latency. Entering safe mode.
2026-07-10 14:53:15.005  INFO - Core: Safe mode activated. Rejecting all incoming requests.`;
    if (window.logParseContent) window.logParseContent(wowLog, "production_outage.log");
    
    document.getElementById('log-search').value = '';
    if(window.logRenderFiltered) window.logRenderFiltered();
  });
  await sleep(1000);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-log-viewer.png') });
  console.log('Saved screenshot-log-viewer.png');

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
    if (window.tmToggleMock) window.tmToggleMock();
  });
  await sleep(2500);
  await page.evaluate(() => {
    if (typeof Chart !== 'undefined' && Chart.instances) {
      Object.values(Chart.instances).forEach(chart => {
        chart.data.datasets.forEach(ds => {
          if (!ds.data) return;
          for(let i = ds.data.length - 8; i < ds.data.length - 2; i++) {
            if (i >= 0 && ds.data[i] !== undefined) {
               if (typeof ds.data[i] === 'number') ds.data[i] = ds.data[i] * 12 + 80;
               else if (ds.data[i].y) ds.data[i].y = ds.data[i].y * 12 + 80;
            }
          }
        });
        chart.update();
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
  await page.evaluate(() => {
    const data = {
      "user": {
        "id": "USR-9941",
        "name": "Jane Doe",
        "roles": ["Administrator", "Developer"],
        "isActive": true,
        "preferences": {
          "theme": "dark",
          "notifications": {"email": true, "sms": false}
        },
        "lastLogin": "2026-07-09T08:30:00Z",
        "history": [
           {"action": "login", "ip": "192.168.1.100", "status": "success"},
           {"action": "update_profile", "ip": "192.168.1.100", "status": "success"},
           {"action": "failed_login", "ip": "10.0.0.5", "status": "failed"}
        ]
      },
      "api_response": {
        "status": 200,
        "message": "Data retrieved successfully",
        "timestamp": "2026-07-10T12:00:00Z",
        "metadata": {
          "page": 1,
          "totalRecords": 15420,
          "executionTimeMs": 42
        }
      }
    };
    document.getElementById('json-input').value = JSON.stringify(data);
    if (window.jsonFormat) window.jsonFormat();
  });
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
      
      await page.evaluate(() => {
        const firstRow = document.querySelector('#lqe-query-list .lqe-list-item');
        if (firstRow) firstRow.click();
        
        // Mock a complex query plan for WOW effect
        const planBtn = document.querySelector('div[onclick*="lqe-tab-plan"]');
        if (planBtn) planBtn.click();
        
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
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-log-query-extractor.png') });
  console.log('Saved screenshot-log-query-extractor.png');

  // 10. NGINX LOG ANALYZER
  await switchTool('nginx-log');
  await page.evaluate(() => {
    // Generate some fake realistic Nginx logs
    let nginxLogs = '';
    const methods = ['GET', 'GET', 'GET', 'POST', 'POST', 'PUT'];
    const urls = ['/index.html', '/api/users', '/api/orders', '/login', '/api/inventory', '/images/logo.png'];
    const codes = [200, 200, 200, 201, 404, 500, 502];
    for (let i = 0; i < 200; i++) {
      const ip = `192.168.1.${Math.floor(Math.random() * 255)}`;
      const method = methods[Math.floor(Math.random() * methods.length)];
      const url = urls[Math.floor(Math.random() * urls.length)];
      const code = codes[Math.floor(Math.random() * codes.length)];
      const size = Math.floor(Math.random() * 5000) + 500;
      nginxLogs += `${ip} - - [10/Jul/2026:14:5${Math.floor(i/30)}:${(i%60).toString().padStart(2,'0')} +0000] "${method} ${url} HTTP/1.1" ${code} ${size} "-" "Mozilla/5.0"\n`;
    }
    if (window.nginxLoadedText !== undefined) {
      window.nginxLoadedText = nginxLogs;
      document.getElementById('nginx-log-input').value = '[File loaded: mock.log]';
      if (window.nginxAnalyzeLogs) window.nginxAnalyzeLogs();
    }
  });
  await sleep(1500);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-nginx-analyzer.png') });
  console.log('Saved screenshot-nginx-analyzer.png');

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

  console.log('All WOW screenshots taken successfully!');
  await browser.close();
}

run().catch(console.error);
