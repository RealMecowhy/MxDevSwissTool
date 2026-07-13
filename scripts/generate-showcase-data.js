const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '..', '_local_assets', 'showcase_data');

if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

// 1. Mendix Production Incident Log
const mendixLogContent = `2024-06-15 08:15:02.124 INFO - Core: Starting Mendix Runtime...
2024-06-15 08:15:10.501 INFO - ConnectionBus: Executing migration for module 'Sales'
2024-06-15 08:15:15.221 INFO - Core: Mendix Runtime successfully started.
2024-06-15 09:30:11.412 INFO - REST_Publish: Incoming request for '/odata/v2/Employees' from IP 10.0.1.45
2024-06-15 09:30:11.954 TRACE - ConnectionBus: SELECT * FROM "MyModule$Employee" WHERE "Department" = 'Sales'
2024-06-15 09:31:05.112 WARN - ConnectionBus_Retrieve: Query execution took 4105 ms. Query: SELECT * FROM "Sales$Orders" O INNER JOIN "Sales$OrderLines" OL ON O."ID" = OL."OrderID" WHERE O."Status" = 'Processing'
2024-06-15 09:32:00.001 DEBUG - MicroflowEngine: Executing microflow 'Sales.SUB_CalculateOrderTotals'
2024-06-15 09:32:01.050 ERROR - MicroflowEngine: Execution of microflow 'Sales.ACT_ApproveOrder' failed.
com.mendix.core.CoreException: An error occurred while executing action 'Change object 'Order' (Status)'.
	at com.mendix.basis.actionmanagement.ActionManager.executeSync(ActionManager.java:170)
	at com.mendix.basis.actionmanagement.MicroflowCallBuilderImpl.execute(MicroflowCallBuilderImpl.java:140)
	... 14 more
Caused by: com.mendix.modules.microflowengine.MicroflowException: Validation failed for attribute 'TotalAmount' on entity 'Sales.Order' (Value '150000.00' exceeds maximum allowed limit for role 'JuniorManager').
	at Sales.ACT_ApproveOrder (Change : 'Change 'Order' (Status)')
	... 21 more
2024-06-15 09:32:02.100 CRITICAL - Core: OutOfMemoryError detected! Generating heap dump...
2024-06-15 09:35:10.000 INFO - SAP_Integration: Successfully authenticated to SAP S/4HANA (User: B2B_Integration_Prod).
2024-06-15 09:35:11.450 INFO - SAP_Integration: Sending 1520 order records.
2024-06-15 09:35:45.100 WARN - SAP_Integration: Request to endpoint '/sap/opu/odata/sap/API_SALES_ORDER_SRV' timed out after 30000ms. Retrying (1/3)...
`;
fs.writeFileSync(path.join(outDir, 'mendix_production_incident.log'), mendixLogContent);

// 2. Nginx Traffic Spike Log
let nginxLogContent = "";
let currentTime = new Date("2024-06-15T09:00:00Z").getTime();
const statuses = [200, 200, 200, 200, 200, 201, 304, 400, 404, 500, 502, 504];
const paths = ["/p/home", "/xas/", "/p/sales", "/api/v1/orders/export", "/api/v1/sap/sync"];
const ips = ["192.168.1.100", "192.168.1.101", "10.0.5.200", "203.0.113.50", "8.8.8.8"];
const agents = ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "axios/1.6.0", "Java/11.0.12", "curl/7.68.0"];

for (let i = 0; i < 2000; i++) {
    const timeInSeconds = Math.floor(currentTime / 1000);
    const dateObj = new Date(currentTime);
    const day = String(dateObj.getUTCDate()).padStart(2, '0');
    const month = dateObj.toLocaleString('en-US', { month: 'short' });
    const year = dateObj.getUTCFullYear();
    const hours = String(dateObj.getUTCHours()).padStart(2, '0');
    const minutes = String(dateObj.getUTCMinutes()).padStart(2, '0');
    const seconds = String(dateObj.getUTCSeconds()).padStart(2, '0');
    const nginxTime = day + "/" + month + "/" + year + ":" + hours + ":" + minutes + ":" + seconds + " +0000";

    const ip = ips[Math.floor(Math.random() * ips.length)];
    const status = statuses[Math.floor(Math.random() * statuses.length)];
    const reqPath = paths[Math.floor(Math.random() * paths.length)];
    const bytes = Math.floor(Math.random() * 20000);
    const agent = agents[Math.floor(Math.random() * agents.length)];
    const method = reqPath === "/xas/" ? "POST" : "GET";

    nginxLogContent += ip + " - - [" + nginxTime + "] \"" + method + " " + reqPath + " HTTP/1.1\" " + status + " " + bytes + " \"-\" \"" + agent + "\"\n";
    
    // Increment time by a random amount from 10ms to 500ms
    currentTime += Math.floor(Math.random() * 490) + 10;
}
fs.writeFileSync(path.join(outDir, 'nginx_traffic_spike.log'), nginxLogContent);

// 3. JVM Thread Dump
const threadDumpContent = `2024-06-15 09:45:12
Full thread dump OpenJDK 64-Bit Server VM (11.0.20+8 mixed mode):

"m2ee-1" #20 prio=5 os_prio=0 cpu=150.45ms elapsed=1024.5s tid=0x00007f8a001a1800 nid=0x145a runnable  [0x00007f8a31bfa000]
   java.lang.Thread.State: RUNNABLE
	at java.net.SocketInputStream.socketRead0(java.base@11.0.20/Native Method)
	at java.net.SocketInputStream.socketRead(java.base@11.0.20/SocketInputStream.java:115)

"Jetty-Server-123" #123 prio=5 os_prio=0 cpu=5000.45ms elapsed=1024.5s tid=0x00007f8a001b1800 nid=0x145b waiting for monitor entry  [0x00007f8a31bfc000]
   java.lang.Thread.State: BLOCKED (on object monitor)
	at com.mendix.core.action.ActionDispatcher.dispatch(ActionDispatcher.java:45)
	- waiting to lock <0x00000000e0123450> (a java.lang.Object)
	at com.mendix.webui.requesthandling.RequestHandler.handle(RequestHandler.java:88)

"Jetty-Server-124" #124 prio=5 os_prio=0 cpu=4500.45ms elapsed=1024.5s tid=0x00007f8a001b2800 nid=0x145c waiting for monitor entry  [0x00007f8a31bfe000]
   java.lang.Thread.State: BLOCKED (on object monitor)
	at com.mendix.core.action.ActionDispatcher.dispatch(ActionDispatcher.java:45)
	- waiting to lock <0x00000000e0123450> (a java.lang.Object)
	at com.mendix.webui.requesthandling.RequestHandler.handle(RequestHandler.java:88)

"Jetty-Server-125" #125 prio=5 os_prio=0 cpu=6000.45ms elapsed=1024.5s tid=0x00007f8a001b3800 nid=0x145d runnable  [0x00007f8a31cfa000]
   java.lang.Thread.State: RUNNABLE
	at com.mendix.core.action.ActionDispatcher.dispatch(ActionDispatcher.java:45)
	- locked <0x00000000e0123450> (a java.lang.Object)
	at com.mendix.modules.microflowengine.MicroflowEngine.execute(MicroflowEngine.java:120)

"ConnectionBus-Worker-1" #150 daemon prio=5 os_prio=0 cpu=1200.45ms elapsed=1024.5s tid=0x00007f8a001b4800 nid=0x145e waiting on condition  [0x00007f8a31cfc000]
   java.lang.Thread.State: WAITING (parking)
	at jdk.internal.misc.Unsafe.park(java.base@11.0.20/Native Method)
	- parking to wait for  <0x00000000e0123460> (a java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject)
	at java.util.concurrent.locks.LockSupport.park(java.base@11.0.20/LockSupport.java:194)
	at java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject.await(java.base@11.0.20/AbstractQueuedSynchronizer.java:2081)
	at com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:190)

"HikariPool-1 housekeeper" #22 daemon prio=5 os_prio=0 cpu=100.2ms elapsed=1024.5s tid=0x00007f8a001b5800 nid=0x145f waiting on condition  [0x00007f8a31cfd000]
   java.lang.Thread.State: TIMED_WAITING (parking)
	at jdk.internal.misc.Unsafe.park(java.base@11.0.20/Native Method)
	- parking to wait for  <0x00000000e0123470> (a java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject)
	at java.util.concurrent.locks.LockSupport.parkNanos(java.base@11.0.20/LockSupport.java:234)
`;
fs.writeFileSync(path.join(outDir, 'jvm_thread_dump_deadlock.txt'), threadDumpContent);

// 4. Log with PII (for Log Anonymizer / Regex)
const piiLogContent = `2024-06-15T14:22:15.123 INFO - Auth: User jan.kowalski@enterprise.com logged in successfully. UUID: a1b2c3d4-e5f6-7890-1234-567890abcdef.
2024-06-15T14:22:16.541 WARN - EmailService: Failed to send email to anna.nowak@startup.io and tom.smith@corporate.org. Error: connection refused.
2024-06-15T14:22:17.002 ERROR - DataProcessor: Entity [Order] with Mendix ID 1234567890123456 could not be saved. Conflict with user ID: 9876543210987654 (m.baker@domain.net).
2024-06-15T14:23:05.112 INFO - Audit: Processed records for user d8e9f0a1-b2c3-4d5e-6f70-81920abcdef1.
2024-06-15T14:23:10.000 DEBUG - Request payload: {"email": "customer.service@globalcorp.com", "txId": "e987c6b5-a432-1098-7654-3210fedcba98", "mxId": 7654321098765432}
`;
fs.writeFileSync(path.join(outDir, 'log_with_pii_for_anonymizer.txt'), piiLogContent);

// 5. Complex JSON
const complexJson = {
  "id": "e987c6b5-a432-1098-7654-3210fedcba98",
  "timestamp": "2024-06-15T14:23:10Z",
  "status": "PROCESSING",
  "metadata": {
    "version": "1.4.2",
    "sourceSystem": "SAP_ECC_PRD",
    "correlationId": "txn-998877",
    "tags": ["finance", "batch", "nightly"]
  },
  "payload": {
    "customer": {
      "id": "CUST-88221",
      "name": "Global Tech Industries",
      "contacts": [
        { "type": "PRIMARY", "email": "admin@globaltech.com", "phone": "+1-555-0198" },
        { "type": "BILLING", "email": "billing@globaltech.com", "phone": "+1-555-0199" }
      ],
      "address": {
        "street": "100 Innovation Drive",
        "city": "San Francisco",
        "state": "CA",
        "zip": "94105",
        "country": "USA"
      }
    },
    "orders": [
      {
        "orderId": "ORD-2024-001",
        "date": "2024-06-14",
        "total": 15420.50,
        "currency": "USD",
        "items": [
          { "sku": "SRV-ENT-01", "name": "Enterprise Server Node", "quantity": 5, "price": 2000.00 },
          { "sku": "LIC-USR-100", "name": "User License Pack (100)", "quantity": 1, "price": 5420.50 }
        ]
      },
      {
        "orderId": "ORD-2024-002",
        "date": "2024-06-15",
        "total": 350.00,
        "currency": "USD",
        "items": [
          { "sku": "SUP-PREM", "name": "Premium Support Add-on", "quantity": 1, "price": 350.00 }
        ]
      }
    ]
  }
};
fs.writeFileSync(path.join(outDir, 'complex_payload.json'), JSON.stringify(complexJson, null, 2));

// 6. Enterprise SQL / OQL
const enterpriseSql = `-- Mendix OQL representation / Complex SQL
SELECT 
    Customer/Name AS CustomerName,
    SUM(OrderLine/Quantity * Product/UnitPrice) AS TotalSpent,
    COUNT(DISTINCT Order/ID) AS TotalOrders,
    MAX(Order/Date) AS LastOrderDate
FROM 
    Sales.Customer AS Customer
INNER JOIN 
    Customer/Sales.Order_Customer/Sales.Order AS Order
INNER JOIN 
    Order/Sales.OrderLine_Order/Sales.OrderLine AS OrderLine
INNER JOIN 
    OrderLine/Sales.Product_OrderLine/Sales.Product AS Product
WHERE 
    Customer/Status = 'Active'
    AND Order/Status IN ('Delivered', 'Invoiced')
    AND Order/Date >= '[%BeginOfCurrentYear%]'
GROUP BY 
    Customer/Name
HAVING 
    SUM(OrderLine/Quantity * Product/UnitPrice) > 50000
ORDER BY 
    TotalSpent DESC
LIMIT 100;`;
fs.writeFileSync(path.join(outDir, 'enterprise_query.sql'), enterpriseSql);



console.log("Showcase data generated in:", outDir);
