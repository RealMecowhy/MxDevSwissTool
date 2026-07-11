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
      window.dfSchema = [
        { name: 'TransactionID', type: 'UUID' },
        { name: 'CustomerName', type: 'FullName' },
        { name: 'EmailAddress', type: 'Email' },
        { name: 'PhoneNumber', type: 'Phone' },
        { name: 'CompanyName', type: 'Company' },
        { name: 'ShippingAddress', type: 'Address' },
        { name: 'City', type: 'City' },
        { name: 'Country', type: 'Country' },
        { name: 'OrderAmount', type: 'Decimal' },
        { name: 'DiscountCode', type: 'String' },
        { name: 'IsActive', type: 'Boolean' },
        { name: 'RegistrationDate', type: 'Date' },
        { name: 'LastLoginIP', type: 'IP Address' }
      ];
      if (window.dfRenderSchema) window.dfRenderSchema();
    }
    const countInput = document.getElementById('df-count');
    if (countInput) countInput.value = '250000';
    if (window.dfGenerate) window.dfGenerate();
    else {
       const btn = document.getElementById('df-generate-btn') || document.querySelector('#panel-data-factory button.btn-primary');
       if (btn) btn.click();
    }
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
    const wowLog = `2026-07-10 14:51:09.591  INFO - Core: Mendix Runtime started successfully on port 8080
2026-07-10 14:51:12.000  INFO - Connector: Connecting to database jdbc:postgresql://localhost:5432/mendix
2026-07-10 14:52:15.999  ERROR - Connector: Connection to database timed out after 30000ms. Attempting retry.
  at com.mendix.connectionbus.ConnectionBusImpl.getConnection(ConnectionBusImpl.java:123)
  at com.mendix.modules.MyModule.MyAction(MyAction.java:45)
  at java.base/java.util.concurrent.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1136)
2026-07-10 14:53:11.100  ERROR - ActionManager: Error in execution of microflow 'OrderManagement.ACT_ProcessOrder'
  at com.mendix.core.actionmanagement.ActionManager.executeSync(ActionManager.java:178)
Caused by: com.mendix.core.CoreRuntimeException: Exception occurred in action '{"type":"RetrieveByXPath","entity":"Sales.Order"}', all database connections are exhausted.
  at com.mendix.modules.microflowengine.MicroflowObject.execute(MicroflowObject.java:82)
2026-07-10 14:53:15.000  CRITICAL - Core: Application state corrupted due to massive database latency. Entering safe mode.`;
    if (window.logParseContent) window.logParseContent(wowLog, "production_outage.log");
    
    document.getElementById('log-search').value = 'Caused by';
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

  console.log('All WOW screenshots taken successfully!');
  await browser.close();
}

run().catch(console.error);
