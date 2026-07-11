const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  console.log('Starting Puppeteer...');
  const browser = await puppeteer.launch({ headless: "new", defaultViewport: { width: 1440, height: 900 } });
  const page = await browser.newPage();
  
  const targetUrl = 'http://127.0.0.1:8080/';
  console.log(`Navigating to ${targetUrl}...`);
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(2000); // wait for potential SW reload
  } catch (err) {
    console.error('Failed to connect to the server. Please ensure `npm start` is running in another terminal.', err);
    await browser.close();
    process.exit(1);
  }

  const assetsDir = path.join(__dirname, '..', '_local_assets');
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir);
  }

  // Helper function to switch tools
  async function switchTool(toolId) {
    console.log(`Switching to ${toolId}...`);
    await page.click(`[data-tool="${toolId}"]`);
    await sleep(500); // wait for animation
  }

  // 1. JSON Formatter
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
    if (typeof window.jsonFormat === 'function') window.jsonFormat();
  });
  await sleep(500);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-json-formatter.png') });
  console.log('Screenshot saved: screenshot-json-formatter.png');

  // 2. JWT Decoder
  await switchTool('jwt-decoder');
  await page.evaluate(() => {
    // A dummy JWT token (header.payload.signature)
    // Header: {"alg":"HS256","typ":"JWT"} -> eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9
    // Payload: {"sub":"1234567890","name":"Mendix Developer","iat":1516239022,"roles":["admin"]} -> eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6Ik1lbmRpeCBEZXZlbG9wZXIiLCJpYXQiOjE1MTYyMzkwMjIsInJvbGVzIjpbImFkbWluIl19
    const dummyJwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6Ik1lbmRpeCBEZXZlbG9wZXIiLCJpYXQiOjE1MTYyMzkwMjIsInJvbGVzIjpbImFkbWluIl19.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    document.getElementById('jwt-input').value = dummyJwt;
    if (typeof window.jwtDecode === 'function') window.jwtDecode();
  });
  await sleep(500);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-jwt-decoder.png') });
  console.log('Screenshot saved: screenshot-jwt-decoder.png');

  // 3. XPath Builder
  await switchTool('xpath-builder');
  await page.evaluate(() => {
    document.getElementById('xpath-input').value = "//Sales.Order[Status = 'Shipped' and TotalPrice > 1000.00 and starts-with(OrderNumber, 'ORD-2026')]/Sales.Order_Customer/CRM.Customer[City = 'Rotterdam' or City = 'Amsterdam']";
    if (typeof window.xpathAnalyze === 'function') window.xpathAnalyze();
    if (typeof window.formatXPathClick === 'function') window.formatXPathClick();
  });
  await sleep(500);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-xpath-builder.png') });
  console.log('Screenshot saved: screenshot-xpath-builder.png');

  // 4. Data Factory
  await switchTool('data-factory');
  await page.evaluate(() => {
    if (typeof window.dfSchema !== 'undefined') {
      window.dfSchema = [
        { name: 'EmployeeID', type: 'UUID' },
        { name: 'FullName', type: 'Name' },
        { name: 'EmailAddress', type: 'Email' },
        { name: 'Department', type: 'Company' },
        { name: 'StartDate', type: 'Date' }
      ];
      if (typeof window.dfRenderSchema === 'function') window.dfRenderSchema();
    }
    const countInput = document.getElementById('df-count');
    if (countInput) countInput.value = '500';
    if (typeof window.dfGenerate === 'function') window.dfGenerate();
    else {
       const btn = document.getElementById('df-generate-btn') || document.querySelector('#panel-data-factory button.btn-primary');
       if (btn) btn.click();
    }
  });
  await sleep(1500);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-data-factory.png') });
  console.log('Screenshot saved: screenshot-data-factory.png');

  // 5. Diff / Text Compare
  await switchTool('text-diff');
  await page.evaluate(() => {
    try {
      const left = document.getElementById('diff-a');
      const right = document.getElementById('diff-b');
      if (left && right) {
        left.value = "{\n  \"api_endpoint\": \"/v1/users\",\n  \"timeout\": 3000,\n  \"retry\": false,\n  \"cache\": false\n}";
        right.value = "{\n  \"api_endpoint\": \"/v2/users\",\n  \"timeout\": 5000,\n  \"retry\": true,\n  \"cache\": true,\n  \"max_retries\": 3\n}";
      }
      if (typeof window.diffCompare === 'function') window.diffCompare();
    } catch (e) { console.error(e); }
  });
  await sleep(500);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-text-diff.png') });
  console.log('Screenshot saved: screenshot-text-diff.png');

  // 6. Memory Inspector
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
    if (typeof window.miAnalyze === 'function') window.miAnalyze();
  });
  await sleep(1000);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-memory-inspector.png') });
  console.log('Screenshot saved: screenshot-memory-inspector.png');

  // 7. Telemetry Monitor
  await switchTool('telemetry-monitor');
  await sleep(1000); // Wait a bit for charts to initialize
  await page.evaluate(() => {
    // Switch to Dashboard tab
    const tabs = document.querySelectorAll('#panel-telemetry-monitor .tab');
    for (let t of tabs) {
      if (t.textContent.includes('Dashboard') || t.getAttribute('onclick')?.includes('dashboard')) {
        t.click();
      }
    }
    if (typeof window.tmToggleMock === 'function') {
      window.tmToggleMock();
    }
  });
  await sleep(3500); // Give charts time to animate
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-telemetry.png') });
  console.log('Screenshot saved: screenshot-telemetry.png');

  // 8. Log Viewer
  await switchTool('log-viewer');
  await page.evaluate(() => {
    const dummyLog = `2026-07-10 14:51:09.591  INFO - Core: Mendix Runtime started successfully on port 8080
2026-07-10 14:51:10.123  WARN - Core: Deprecated custom java action used in MyModule.Action_VerifyToken
2026-07-10 14:51:12.000  INFO - Connector: Connecting to database jdbc:postgresql://localhost:5432/mendix
2026-07-10 14:51:12.050  INFO - Connector: Connection pool initialized with 50 active connections
2026-07-10 14:51:15.500  DEBUG - REST: Incoming POST request to /rest/api/v1/users
2026-07-10 14:52:15.999  ERROR - Connector: Connection to database timed out after 30000ms. Attempting retry.
  at com.mendix.connectionbus.ConnectionBusImpl.getConnection(ConnectionBusImpl.java:123)
  at com.mendix.modules.MyModule.MyAction(MyAction.java:45)
  at java.base/java.util.concurrent.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1136)
2026-07-10 14:52:16.050  CRITICAL - Core: Application state corrupted due to massive database latency. Entering safe mode.`;
    if (typeof window.logParseContent === 'function') {
      window.logParseContent(dummyLog, "production.log");
    }
    // Set level filter to ERROR & CRITICAL to showcase UI filtering
    document.getElementById('log-search').value = '';
  });
  await sleep(1000);
  await page.screenshot({ path: path.join(assetsDir, 'screenshot-log-viewer.png') });
  console.log('Screenshot saved: screenshot-log-viewer.png');

  console.log('All screenshots taken successfully!');
  await browser.close();
}

run().catch(console.error);
