const fs = require('fs');

const path = 'c:/Users/mikol/Documents/Antigravity_Projects/MendixTools/js/tools-help.js';
let content = fs.readFileSync(path, 'utf8');

// The new TOOLS_HELP in English
const newToolsHelp = `const TOOLS_HELP = {
  'log-viewer-stream': {
    title: 'Mendix Log Viewer - Log Stream',
    description: 'Tool for rapid analysis, searching, and filtering of Mendix application logs. Instead of opening giant text files in a traditional notepad, you can load them here, filter loggers and error levels, and automatically group (aggregate) identical errors.',
    howToGet: \`
      <ul>
        <li><strong>Mendix Cloud:</strong> Log in to the Mendix Portal, go to <em>Environments</em> → select an environment (e.g., Production) → <em>Details</em> → <em>Logs</em> → click <em>Download Log File</em> or download archive logs.</li>
        <li><strong>Local Environment:</strong> In your Mendix project folder, logs are located at <code>[project_directory]/deployment/log/log.txt</code>.</li>
        <li><strong>Hybrid Environments (Docker):</strong> Download container logs using the command: <code>docker logs [container_name] > app_log.txt</code>.</li>
      </ul>
    \`,
    howToUse: \`
      <ol>
        <li>Drag and drop the log file (e.g., <code>.txt</code>, <code>.log</code>) directly into the browser window or paste raw log text into the input field.</li>
        <li>Use the filters in the sidebar: enter a phrase (e.g., Microflow name), select log level (DEBUG, INFO, WARNING, ERROR, CRITICAL) or filter by a specific logger name (e.g., <code>ConnectionBus</code>).</li>
        <li>Search for specific time intervals by moving the time slider or entering the time.</li>
        <li>Click <strong>Aggregate Errors</strong> in the top right corner of the module bar to open a modal with a summary of unique errors and their occurrence statistics (useful for locating error loops).</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>ConnectionBus errors:</strong> Usually indicate database problems, query timeouts, or attempts to write incomplete objects.</li>
        <li><strong>ActionManager errors:</strong> Indicate a failure in Microflow / Activity execution. Check the Microflow name provided in the log and navigate to it in Mendix Studio Pro.</li>
        <li><strong>Jetty / Connector errors:</strong> Suggest network issues, dropped client HTTP connections, or server response timeouts to a user request.</li>
      </ul>
    \`
  },
  'log-viewer-correlation': {
    title: 'Mendix Log Viewer - Correlation Flow',
    description: 'Visualizes the flow of requests and microflow executions based on correlation IDs in the logs, allowing you to trace a complete transaction across multiple log entries.',
    howToGet: 'Ensure your Mendix logs contain Correlation IDs. You can enable them by setting the <code>CorrelationId</code> logger to <code>TRACE</code> or <code>DEBUG</code> in your environment settings.',
    howToUse: \`
      <ol>
        <li>Switch to the <strong>Correlation Flow</strong> tab.</li>
        <li>Select a specific Correlation ID from the list to see all log entries related to that specific transaction.</li>
        <li>Follow the chronological flow to identify where a process failed or took too long.</li>
      </ol>
    \`,
    interpretation: 'Helps in debugging complex transactions that span multiple microflows and integrations by isolating only the logs relevant to a single user action.'
  },
  'log-viewer-sequence': {
    title: 'Mendix Log Viewer - Sequence Diagram',
    description: 'Generates a UML sequence diagram based on Mendix log entries, showing the interactions between different components (e.g., ActionManager, ConnectionBus, REST services).',
    howToGet: 'You need logs with sufficient detail, preferably <code>DEBUG</code> or <code>TRACE</code> for relevant loggers like <code>ActionManager</code> or <code>REST_Consume</code>.',
    howToUse: \`
      <ol>
        <li>Switch to the <strong>Sequence Diagram</strong> tab.</li>
        <li>Analyze the chronological sequence of events and calls between different system components.</li>
      </ol>
    \`,
    interpretation: 'Useful for understanding the architecture of an execution path and spotting unexpected loops or missing calls.'
  },
  'log-viewer-gantt': {
    title: 'Mendix Log Viewer - Gantt Chart',
    description: 'Provides a timeline view of long-running operations in your logs, helping you identify performance bottlenecks and parallel execution issues.',
    howToGet: 'Logs containing timestamps for start and end of operations, typically found in <code>TRACE</code> level logs for microflows or database queries.',
    howToUse: \`
      <ol>
        <li>Switch to the <strong>Gantt Chart</strong> tab.</li>
        <li>Look for long horizontal bars that represent slow operations.</li>
      </ol>
    \`,
    interpretation: 'A long bar indicates a slow operation. If multiple operations are executed sequentially but could run in parallel, the Gantt chart will clearly highlight this inefficiency.'
  },
  'nginx-log': {
    title: 'Nginx Log Analyzer',
    description: 'Module for parsing Nginx access logs. Helps to instantly check the most popular IP addresses, frequently accessed URLs, HTTP status code breakdown, and geographical location of visitors.',
    howToGet: \`
      <ul>
        <li>The standard location for Nginx access logs on Linux systems is <code>/var/log/nginx/access.log</code>.</li>
        <li>You can download this file directly from the VPS / virtual machine where the Mendix app proxy is hosted.</li>
      </ul>
    \`,
    howToUse: \`
      <ol>
        <li>Paste the content of Nginx logs (<em>combined</em> format) or drag and drop the log file into the tool window.</li>
        <li>Check the <strong>Enable IP Geolocation</strong> option to automatically query a free external API for the country of origin of IPs sending the most requests (runs asynchronously, doesn't block the browser).</li>
        <li>Click <strong>Analyze Logs</strong>. Results will be presented as interactive tables and pie charts.</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>4xx Status Codes:</strong> Frequent 404 (Not Found) or 403 (Forbidden) codes might indicate scanning of your server by bots/malware looking for vulnerabilities.</li>
        <li><strong>5xx Status Codes:</strong> Indicate a failure in the Mendix backend application (e.g., Mendix server is down or dropped the connection).</li>
        <li><strong>High traffic from a single IP:</strong> If one IP sends thousands of requests per minute, it could be a DoS attack attempt or a looped client script. Consider blocking such IPs at the firewall level.</li>
      </ul>
    \`
  },
  'telemetry-monitor': {
    title: 'Metrics & Telemetry',
    description: 'Advanced console for monitoring performance metrics (Prometheus) and logs/traces (OpenTelemetry) generated by the Mendix application engine. Enables bottleneck diagnostics on Waterfall charts.',
    howToGet: \`
      <p>To have the Mendix app generate this data, it needs proper configuration:</p>
      <ol>
        <li><strong>Local Diagnostics (Agent Mode):</strong> Run the utility script <code>node mendix-observability-bridge.js</code> in the terminal at the project root. This script proxies logs from the local Mendix and connects to the PostgreSQL database.</li>
        <li><strong>Enable OpenTelemetry (Mendix 11.12+):</strong> In Mendix Studio Pro, go to <em>Settings</em> → <em>Configurations</em> → <em>Edit</em>. In the <strong>OpenTelemetry</strong> tab, select:
          <ul>
            <li><strong>Enable OpenTelemetry:</strong> Yes</li>
            <li><strong>Endpoint:</strong> <code>http://127.0.0.1:4318</code> (resolves local DNS issues on Windows)</li>
            <li><strong>Service Name:</strong> e.g., <code>MendixApp</code></li>
            <li><strong>Enable Traces & Logs:</strong> Yes / Yes</li>
          </ul>
          No Extra JVM parameters are required! (The Agent natively supports both binary Protobuf and JSON OTLP formats).
        </li>
        <li><strong>Enable Metrics in Mendix (Prometheus):</strong> In Mendix Studio Pro, go to <em>Settings</em> → <em>Configurations</em> → add Custom Setting:
          <br>Key: <code>Metrics.Registries</code>, Value: <code>[{"type": "prometheus", "settings": {"step": "10s"}}]</code>.
        </li>
      </ol>
    \`,
    howToUse: \`
      <ol>
        <li>Select the operating mode in the toolbar: <em>Local Agent Mode</em> (NodeJS bridge) or <em>Direct Prometheus Mode</em> (provide Cloud URL and API Key).</li>
        <li>Click <strong>Connect Agent</strong> / <strong>Start Scraping</strong>. Charts for JVM memory usage, database connection pool, and request counts will start updating live.</li>
        <li>Go to the <strong>Traces & Logs</strong> tab to see waterfall charts of Microflow / SQL executions. Click on individual chart bars to see details.</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>JVM Heap Memory:</strong> If memory usage constantly increases (staircase chart upwards) and does not drop after Garbage Collection, the application might have a memory leak.</li>
        <li><strong>Database Connection Pool:</strong> If the number of used connections approaches the limit (e.g., 50), subsequent user requests will be blocked waiting for a free connection, drastically slowing down the system.</li>
        <li><strong>Waterfall (Traces):</strong> A long horizontal bar means the longest running activity. If you see dozens of small SQL query bars to the same table underneath, you've detected an <strong>N+1 queries</strong> problem, which should be optimized (e.g., by fetching data at once using an association or modifying a loop).</li>
      </ul>
    \`
  },
  'http-status': {
    title: 'HTTP Status Codes',
    description: 'Handy, fully local knowledge base of all HTTP response codes. Each code includes a detailed explanation of its meaning and practical developer tips in the context of system integrations implemented in Mendix (REST, SOAP, OData).',
    howToGet: 'This tool is for reference. It does not require uploading any external data.',
    howToUse: \`
      <ol>
        <li>Select a group of codes (e.g., 4xx for client errors, 5xx for server errors).</li>
        <li>Click on the code you are interested in (e.g., <code>401 Unauthorized</code> or <code>504 Gateway Timeout</code>).</li>
        <li>Read the description and developer advice regarding the configuration of the <em>Call REST</em> action in Mendix Studio Pro.</li>
      </ol>
    \`
  },
  'thread-dump': {
    title: 'Thread Dump & GC Analyzer',
    description: 'Used to analyze Java Virtual Machine (JVM) Thread Dumps of a Mendix application and Garbage Collector logs. Helps in diagnosing application hang issues (Deadlock / Thread Starvation) and high CPU usage.',
    howToGet: \`
      <ul>
        <li><strong>Mendix Cloud:</strong> Go to Mendix Portal → *Environments* → select environment → *Details* tab → *Logs* → click *Download Thread Dump*.</li>
        <li><strong>Local (Studio Pro):</strong> In the bottom Mendix console, click <em>Advanced</em> → <em>Create thread dump</em>.</li>
        <li><strong>Custom Linux Server:</strong> Log in to the server and execute a dump using the JDK tool: <code>jstack [PID_java_process] > thread_dump.txt</code>.</li>
      </ul>
    \`,
    howToUse: \`
      <ol>
        <li>Copy and paste the entire text of the generated thread dump into the text field.</li>
        <li>Click the <strong>Analyze Thread Dump</strong> button.</li>
        <li>Analyze the list of threads grouped by states (RUNNABLE, WAITING, TIMED_WAITING, BLOCKED) and detected blocking threads (monitors).</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>Number of BLOCKED threads > 0:</strong> Alarm situation. This means threads are waiting for a lock to be released by another thread. The tool will point out which thread is holding the lock (look for keywords related to database transactions or HTTP requests).</li>
        <li><strong>Threads in RUNNABLE state:</strong> Threads actively executing Java code. If there are very many of them and CPU usage is 100%, check if there is an infinite loop in the code (e.g., faulty recursion in a Microflow or a while loop in a Java Action).</li>
        <li><strong>Garbage Collection (GC) Pauses:</strong> Long pause times (Stop-the-world) visible in GC logs mean the JVM spends too much time cleaning up memory, causing the entire Mendix application to freeze momentarily.</li>
      </ul>
    \`
  },
  'json-formatter': {
    title: 'JSON Formatter & Validator',
    description: 'Used for formatting, fixing, syntax validation, and convenient interactive exploration of data structures in JSON format.',
    howToGet: 'JSON data is mostly obtained from request/response headers and bodies of REST services logged in Mendix (after setting the <code>REST_Consume</code> or <code>REST_Publish</code> log level to <code>TRACE</code>).',
    howToUse: \`
      <ol>
        <li>Paste unformatted or minified JSON text into the left text field.</li>
        <li>Formatting happens automatically upon data entry (you can also click the <em>Format</em> button). In case of syntax errors, the parser will indicate the exact line and cause of the problem.</li>
        <li>Use the interactive tree view on the right side to collapse and expand deeply nested objects or search for keys.</li>
      </ol>
    \`
  },
  'xml-formatter': {
    title: 'XML Formatter & Validator',
    description: 'Tool for structural validation and formatting of XML documents, most commonly used in SOAP (Web Services) integrations or data import/export in standard enterprise formats.',
    howToGet: 'XML text can be copied from the Mendix console (SOAP service logs after setting the <code>WebServices_Consume</code> log level to <code>TRACE</code>).',
    howToUse: \`
      <ol>
        <li>Paste raw XML code into the input field.</li>
        <li>Click <strong>Format XML</strong>. The tool will arrange tags with proper indentation and check if the document is well-formed.</li>
        <li>You can explore the tag tree and copy the formatted XML code with one click.</li>
      </ol>
    \`
  },
  'char-sanitizer': {
    title: 'XML & Text Sanitizer',
    description: 'Tool for analyzing and cleaning texts and XML messages from invisible characters, faulty spaces, control codes, and encoding errors (Mojibake), which often cause integration errors in external systems.',
    howToGet: \`
      <ul>
        <li>Copy the content of an XML message that bounces off an external system (e.g., from error logs in the Mendix console).</li>
        <li>Copy text (e.g., address, contact details) entered by a user that you suspect contains invisible characters.</li>
        <li>You can also drag and drop a text or XML file directly into the input area.</li>
      </ul>
    \`,
    howToUse: \`
      <ol>
        <li>Paste text or XML into the left text field or drop a file.</li>
        <li>Select detection filters in the bottom panel (e.g., Invisible Spaces, Control Characters, Mojibake).</li>
        <li>In the <strong>Visual Inspector</strong> tab, you will see problematic characters highlighted. Hovering over them will display the character name and its Unicode code (e.g., <code>U+200B ZERO WIDTH SPACE</code>).</li>
        <li>In the <strong>Statistics & Issues</strong> tab, you will find a table with a summary and count of specific anomalies.</li>
        <li>Go to the <strong>Sanitized Output</strong> tab, adjust cleaning rules (e.g., replace NBSP with a regular space, fix specific characters), and copy the cleaned text or download it as a file.</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>Invisible spaces (e.g., ZWSP, BOM):</strong> Very often pasted accidentally when copying text from a PDF or website. They block XML parsers even if the field looks empty.</li>
        <li><strong>Mojibake (e.g., Ã„â€¦, Ã…â€š):</strong> Occurs when systems exchange data using different encodings (e.g., database in Windows-1250, and interface in UTF-8).</li>
        <li><strong>C0 Control Characters (e.g., NUL, BEL, SUB):</strong> Older type control characters. They are not allowed in the XML 1.0 standard and cause immediate rejection of the file by the standard XML parser in Mendix.</li>
      </ul>
    \`
  },
  'sql-formatter': {
    title: 'SQL Formatter',
    description: 'Allows for quick beautification and formatting of SQL queries generated automatically by the Mendix Connection Bus. This makes it easier to analyze queries sent to PostgreSQL, Oracle, or SQL Server databases.',
    howToGet: \`
      <p>To get SQL queries from a Mendix application:</p>
      <ul>
        <li>Set the log level of the <code>ConnectionBus</code> logger to <code>DEBUG</code> or <code>TRACE</code> in the Mendix console.</li>
        <li>Execute an action in the application and copy the generated SQL query from the console.</li>
      </ul>
    \`,
    howToUse: \`
      <ol>
        <li>Paste a raw, one-line compressed SQL query into the text field.</li>
        <li>Click the <strong>Format SQL</strong> button. Keywords such as SELECT, FROM, JOIN, WHERE will be moved to new lines and bolded.</li>
      </ol>
    \`
  },
  'text-diff': {
    title: 'Text Diff Utility',
    description: 'Local tool for comparing two pieces of text. Instantly locates and highlights differences (added lines, deleted lines, and changed characters). Useful for comparing configurations, JSON payloads from different environments, or generated files.',
    howToGet: 'Prepare two versions of a text file or code that you want to compare.',
    howToUse: \`
      <ol>
        <li>Paste the original version of the text into the <strong>Original Text (Left)</strong> field.</li>
        <li>Paste the new (modified) version of the text into the <strong>Modified Text (Right)</strong> field.</li>
        <li>Differences will be generated automatically and marked with colors: red (deleted) and green (added).</li>
      </ol>
    \`
  },
  'encoder': {
    title: 'Base64 / URL Encoder & Decoder',
    description: 'On-the-fly text encoding converter. Supports Base64 (useful for Basic Authentication and file transfers), URL encoding (needed for building query parameters in GET requests), and HTML entity decoding.',
    howToGet: 'Any text that requires encoding, or an encoded string obtained e.g., from an HTTP header <code>Authorization: Basic [Base64]</code>.',
    howToUse: \`
      <ol>
        <li>Type or paste text into a chosen input field (Plain Text, Base64, or URL Encoded).</li>
        <li>The tool will automatically recalculate values in all other fields in real-time.</li>
      </ol>
    \`
  },
  'md-preview': {
    title: 'Markdown Editor & Table Generator',
    description: 'Interactive Markdown technical documentation editor with live HTML preview. Also includes a Markdown table generator, making it easy to create readable tables without manually typing vertical bars (pipes).',
    howToGet: 'Manually created developer project documentation (e.g., Readme files, release notes descriptions).',
    howToUse: \`
      <ol>
        <li>Type text in Markdown format in the left editor panel. On the right side, you will instantly see the rendered preview of the document.</li>
        <li><strong>Table Generator:</strong> Enter the number of rows and columns in the helper form, fill in headers and cells, and the tool will output ready Markdown table code that you can paste into your <code>.md</code> file.</li>
        <li>You can copy the resulting HTML code of the rendered document using the <em>Copy HTML</em> button.</li>
      </ol>
    \`
  },
  'xpath-builder': {
    title: 'XPath Formatter',
    description: 'Tool assisting in writing, formatting, and validating XPath queries in the Mendix standard. Includes a handy cheat sheet with the most popular system tokens (e.g., current user, date operations) and query templates.',
    howToGet: 'Get the XPath query directly from the properties of a <em>Retrieve</em> action from the database in Mendix Studio Pro or from entity Access Rules.',
    howToUse: \`
      <ol>
        <li>Paste your XPath query into the editor window.</li>
        <li>Click <strong>Format</strong>. A complex, multi-line query with multiple logical operators will be formatted into a readable indentation tree.</li>
        <li>Use the <strong>XPath Cheat Sheet</strong> section at the bottom of the screen to quickly copy special Mendix platform variables like <code>[%CurrentUser%]</code> or <code>[reversed()]</code> operators for associations.</li>
      </ol>
    \`
  },
  'query-intelligence': {
    title: 'Query Intelligence Suite',
    description: 'Powerful suite of tools for optimizing the database layer in Mendix. Includes an OQL query formatter, OQL to raw SQL (PostgreSQL) translator, visual query execution plan generator (Explain Plan), and an Index Advisor that automatically detects performance issues.',
    howToGet: \`
      <ul>
        <li><strong>OQL:</strong> You can get OQL queries from report module specifications or Mendix logs by setting the <code>OQL</code> logger to <code>DEBUG</code>.</li>
        <li><strong>SQL Explain Plan:</strong> Connect to the PostgreSQL database of your Mendix application (e.g., via DBeaver or pgAdmin). Run an SQL query prefixed with the keyword: <code>EXPLAIN (ANALYZE, COSTS, VERBOSE, BUFFERS, FORMAT TEXT) [Your_SQL_Query];</code>. Copy the generated text of the execution plan.</li>
      </ul>
    \`,
    howToUse: \`
      <ol>
        <li><strong>OQL Formatter / Translator:</strong> Paste an OQL query in the appropriate tab. The tool will format it or translate it into an SQL query compatible with Mendix table schemas.</li>
        <li><strong>SQL Explain:</strong> Paste the text PostgreSQL query plan into the text field and click <strong>Visualize Query Plan</strong>. The tool will generate a clear, interactive tree of the query execution steps.</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>Sequential Scan (Seq Scan) / Table Scan:</strong> The database must search the entire table row by row. If the table has thousands of records, this will drastically slow down the system. The tool will mark this step in red.</li>
        <li><strong>Index Scan / Index Only Scan:</strong> Optimal situation. The database uses an index to find records instantly.</li>
        <li><strong>Index Advisor:</strong> Based on the plan analysis, the tool will display an index recommendation (e.g., <em>"Recommended index on table 'customer' for column 'status'"</em>). Add this index in Mendix Studio Pro in the properties of the given entity in the <em>Indexes</em> section.</li>
      </ul>
    \`
  },
  'naming-convention': {
    title: 'Naming Convention Checker',
    description: 'Automatic validator for checking if project element naming complies with Mendix platform standards and Best Practices. Helps maintain Clean Code in team projects.',
    howToGet: \`
      <p>To export element names from Mendix Studio Pro:</p>
      <ol>
        <li>Open Mendix Studio Pro and press <strong>Ctrl + F</strong> (Advanced Search).</li>
        <li>Search for documents in the project (e.g., all Microflows, Pages, Enumerations).</li>
        <li>Select all search results in the list at the bottom of the screen and press <strong>Ctrl + C</strong>.</li>
        <li>Mendix will copy the list of elements as tabular data to the clipboard.</li>
      </ol>
    \`,
    howToUse: \`
      <ol>
        <li>Paste the list copied from the clipboard directly into the tool's text field.</li>
        <li>The tool will automatically analyze each row on the fly.</li>
        <li>Review the list of remarks. Elements not meeting standards will be marked in yellow/red along with a suggested fix (e.g., changing microflow prefix from <code>CheckUser</code> to <code>ACT_CheckUser</code> or <code>SUB_CheckUser</code>).</li>
      </ol>
    \`
  },
  'odata-builder': {
    title: 'OData Query Builder',
    description: 'Convenient OData query generator (v3/v4 standard) for communicating with Mendix Published OData Services. Helps graphically select filters, sorting, and pagination, eliminating syntax errors in URLs.',
    howToGet: 'Get the base URL of the OData service published in your Mendix application (e.g., <code>https://myapp.mendixcloud.com/odata/v1/</code>) and familiarize yourself with the entity names in the service.',
    howToUse: `
      <ol>
        <li>Enter the service base URL and the resource name (Entity Set).</li>
        <li>Add filters in the builder (e.g., <code>Age gt 18</code>, <code>Status eq 'Active'</code>), select fields to retrieve ($select) and sort order ($orderby).</li>
        <li>The tool will generate a full, correctly encoded query URL that you can paste into a browser, Postman, or integration configuration in Mendix.</li>
      </ol>
    `
  },
  'architecture': {
    title: 'Domain Model & Architecture Diagrammer',
    description: 'Tool for rapid visualization of architecture and database relationships using text code and Mermaid diagrams. Allows you to instantly draw a Domain Model without using heavy graphic tools.',
    howToGet: 'Define relationships in text format, e.g., <code>Customer [1] -- [*] Order</code> or describe entities verbally.',
    howToUse: \`
      <ol>
        <li>Use the text editor on the left, typing classes and their connections according to simple Mermaid syntax (or use built-in templates from helper buttons).</li>
        <li>A dynamic, interactive class diagram will render on the right side.</li>
        <li>You can download the diagram as a PNG / SVG code or copy the Mermaid code to paste, for example, in project documentation.</li>
      </ol>
    \`
  },
  'dev-studio': {
    title: 'Mendix Developer Studio Connector',
    description: 'Local integration tool communicating directly with a running Mendix Studio Pro instance on your computer via local API (Mendix Development Port). Enables quick preview and synchronization of project information.',
    howToGet: \`
      <ul>
        <li>Run your project locally in Mendix Studio Pro.</li>
        <li>Ensure the developer port (usually 8080 or diagnostic console port) is active and accessible locally.</li>
      </ul>
    \`,
    howToUse: \`
      <ol>
        <li>Enter the local address (e.g., <code>http://localhost:8080</code>) into the text field.</li>
        <li>Click <strong>Connect</strong>.</li>
        <li>The tool will fetch basic information about the project run status, Runtime version, and loaded modules.</li>
      </ol>
    \`
  },
  'perf-lab': {
    title: 'Performance Lab (Load Tester)',
    description: 'Lightweight tool for conducting load tests (Load Testing) and performance analysis of selected endpoints (REST API, SOAP, HTML pages) directly from the browser. Measures response times and generates latency statistics.',
    howToGet: 'The URL address of the web service (e.g., Published REST Service in Mendix) and optional authorization data (Basic Auth, API tokens).',
    howToUse: \`
      <ol>
        <li>Enter the tested URL and select the request method (GET, POST, etc.).</li>
        <li>Specify test parameters: number of concurrent connections (Concurrency), total number of requests, and request headers (e.g., <code>Content-Type: application/json</code>).</li>
        <li>Click <strong>Start Test</strong>. The tool will begin sending requests in the background and draw a latency chart in real-time.</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>p50 Response Time (Median):</strong> Average response time for half of the users. Should oscillate below 200 ms.</li>
        <li><strong>p99 Response Time:</strong> Metric for the 1% slowest requests. If p99 is drastically higher than p50 (e.g., 5 seconds vs 100 ms), the Mendix application might have issues with occasional thread blocking, database locking, or long Garbage Collector pauses.</li>
        <li><strong>Error Rate:</strong> Appearance of network errors or 5xx statuses under higher load suggests the application has reached its performance limit (e.g., CPU overload or database connection pool exhaustion).</li>
      </ul>
    \`
  },
  'traffic-inspector': {
    title: 'Traffic Inspector (HAR Analyzer)',
    description: 'Tool for analyzing HTTP Archive (HAR) files and cURL commands. Helps developers trace exactly what network requests the Mendix Client sent to the server (e.g., when diagnosing slow widgets or login issues).',
    howToGet: \`
      <p>To get a HAR file:</p>
      <ol>
        <li>Open the Mendix application in a browser and press <strong>F12</strong> (Developer Tools).</li>
        <li>Go to the <strong>Network</strong> tab.</li>
        <li>Refresh the page and perform the action you want to diagnose.</li>
        <li>Click the download icon (down arrow) or right-click on the requests list and select <strong>Save all as HAR with content</strong>.</li>
      </ol>
    \`,
    howToUse: \`
      <ol>
        <li>Drag and drop the <code>.har</code> file into the tool's workspace or paste a cURL command into the second tab.</li>
        <li>Analyze the request timeline, response codes, transfer sizes, and headers sent in queries.</li>
      </ol>
    \`
  },
  'mock-server': {
    title: 'Mock Server & Chaos Engineering',
    description: 'Allows creating simulations of external REST API services (Mocking) along with simulating network failures, high latencies, and HTTP errors (Chaos Engineering). Used to check how stably your Mendix application behaves when external systems it integrates with fail.',
    howToGet: 'Configure <em>Call REST</em> actions in Mendix Studio Pro to send requests to the URL address of this Mock Server (provided after starting the service).',
    howToUse: \`
      <ol>
        <li>Define the API path, method (e.g., GET), and response body (JSON / XML) to be returned.</li>
        <li>In the <strong>Chaos Settings</strong> section, set the probability of an error occurring (e.g., 20% chance for a 500 code) and additional random network latency (e.g., from 500 ms to 3000 ms).</li>
        <li>Start the server and execute integration tests from your Mendix application.</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li>The test allows verifying if the Mendix application properly handles network integration errors (Error Handling on REST actions) and if user sessions don't hang due to waiting too long for a response without a timeout set.</li>
      </ul>
    \`
  },
  'data-factory': {
    title: 'Data Factory (Mock Data Generator)',
    description: 'Generator of large sets of random, realistic test data (e.g., names, surnames, email addresses, phone numbers, dates). Facilitates the preparation of CSV / JSON files for import into the Mendix application database for performance testing.',
    howToGet: 'The tool generates data randomly based on selected templates. It does not require uploading files.',
    howToUse: \`
      <ol>
        <li>Define the columns/fields you want to generate (e.g., <code>First Name</code>, <code>Last Name</code>, <code>Email</code>, <code>Company</code>).</li>
        <li>Select the desired output format (JSON, CSV, or XML).</li>
        <li>Specify the number of records (e.g., 1000 or 10000 rows).</li>
        <li>Click <strong>Generate Data</strong> and download the generated file to disk. Then import it into Mendix using, for example, the <em>Excel Importer</em> module or a dedicated import action.</li>
      </ol>
    \`
  },
  'api-economics': {
    title: 'API Economics Optimizer',
    description: 'Tool analyzing JSON data structures sent over REST APIs. Locates unnecessary data transfer overhead: empty properties (null), repeating key names, excessive whitespace, and suggests specific optimizations to save network transfer.',
    howToGet: 'Copy the JSON response body from a tool like Postman or from Mendix logs (at REST log level TRACE).',
    howToUse: \`
      <ol>
        <li>Paste the JSON payload into the text field.</li>
        <li>Click the <strong>Analyze API Payload</strong> button.</li>
        <li>Analyze the results: size reduction rate after minification and a list of fields with default/null values that can be excluded in Mendix Export Mapping in Studio Pro to reduce data size.</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>Redundancy Rate:</strong> If it exceeds 30%, it means your API transmits a lot of repeating information or empty fields. Optimizing export mappings (Export Mapping) in Mendix by unchecking empty attributes will bring immediate improvement in loading times on mobile devices.</li>
      </ul>
    \`
  },
  'memory-inspector': {
    title: 'Memory Inspector (JVM Heap Analyzer)',
    description: 'Module for analyzing JVM memory statistics and Garbage Collector logs. Facilitates interpreting RAM usage data and finding potential memory leaks in Mendix applications.',
    howToGet: \`
      <ul>
        <li>Garbage Collector logs (GC logs) can be downloaded from the Mendix Cloud administration console (Logs → GC Logs tab).</li>
        <li>Heap dump statistics can be obtained through a JVM diagnostic tool (e.g., <code>jmap -histo [PID]</code>).</li>
      </ul>
    \`,
    howToUse: \`
      <ol>
        <li>Paste generated memory usage statistics or an excerpt from GC logs into the text field.</li>
        <li>Click <strong>Analyze Memory Data</strong>.</li>
        <li>Browse charts showing the distribution of object types in memory (e.g., strings, Mendix entity objects) and GC pause duration statistics.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>High number of <code>com.mendix.basis.objectmanagement.MendixObjectImpl</code> objects:</strong> Indicates a very large number of objects held in the application's RAM. If this number constantly grows and doesn't fall after a full GC cycle, ensure that in long-running background processes (Scheduled Events) objects are properly cleared from memory or processed in batches (Batching).</li>
      </ul>
    `
  },
  'wasm-profiler': {
    title: 'WASM Profiler',
    description: 'Specialized analyzer for modules compiled to WebAssembly (WASM) format used in advanced Mendix client widgets (e.g., graphic editors, analytical tools in the browser). Measures execution times of low-level functions.',
    howToGet: `There are two main ways to extract WASM traces from your browser:
      <ul style="margin-top:var(--sp-2); padding-left:var(--sp-4)">
        <li style="margin-bottom:var(--sp-2)"><strong>Method 1 (Error Stack Traces):</strong> Open Chrome/Firefox DevTools (F12) and go to the <strong>Console</strong>. If a WebAssembly module crashes, it prints a stack trace. Right-click the error text and select "Save as..." or simply copy the stack trace text (look for lines with <code>wasm-function[...]</code>).</li>
        <li><strong>Method 2 (Performance Profiler):</strong> Open DevTools and go to the <strong>Performance</strong> tab. Click the <strong>Record</strong> button, perform the action in your Mendix app, and click Stop. Select the recorded timeline, go to the <strong>Bottom-Up</strong> or <strong>Call Tree</strong> tab, right-click any row and select <strong>"Copy all"</strong>.</li>
      </ul>`,
    howToUse: `
      <ol>
        <li>Paste the copied stack trace or Call Tree text into the text area.</li>
        <li>The tool will parse the text, extracting WebAssembly function calls.</li>
        <li>Review the "Hot Paths" table to see which functions were called most frequently.</li>
      </ol>
    `,
    interpretation: `
      <ul style="margin-top:var(--sp-2); padding-left:var(--sp-4)">
        <li style="margin-bottom:var(--sp-2)"><strong>Noise Reduction (JS vs WASM):</strong> Chrome DevTools flame graphs contain thousands of React and framework calls. This tool filters out the JavaScript noise and aggregates ONLY the WebAssembly function calls, allowing you to quickly focus on the performance of low-level modules.</li>
        <li style="margin-bottom:var(--sp-2)"><strong>Crash Dump Analysis:</strong> If a Mendix app crashes throwing a text stack trace (e.g., <code>RuntimeError: memory access out of bounds</code>), you can't load plain text into Chrome's Profiler. By pasting the text here, you instantly see which WASM function caused the loop or crash.</li>
        <li><strong>JS-to-WASM Bridge Overhead:</strong> A very high call count for functions like <code>convert_js_to_rust</code> indicates that you are passing data between JavaScript and WebAssembly byte-by-byte rather than using efficient memory buffers (serialization bottleneck).</li>
      </ul>
    `
  },
  'jwt-decoder': {
    title: 'JWT Token Decoder',
    description: 'Local tool for decoding and inspecting JWT (JSON Web Tokens). Since decoding happens 100% in your browser using JavaScript, confidential data (access tokens) is not sent anywhere. Allows checking token contents, expiration date, and permissions (scopes/roles).',
    howToGet: 'Copy the JWT token from an HTTP header <code>Authorization: Bearer [token_JWT]</code> logged in Mendix or from a user session in the browser.',
    howToUse: \`
      <ol>
        <li>Paste the entire JWT token (three parts separated by dots) into the text field.</li>
        <li>The tool will instantly decode the token and show:
          <br>– <strong>Header:</strong> encryption algorithm and token type.
          <br>– <strong>Payload (Claims):</strong> encoded information about the user, their roles, and permissions.
          <br>– <strong>Expiration Status:</strong> information whether the token is active or expired, along with exact date &amp; time.
        </li>
      </ol>
    \`
  },
  'hash-gen': {
    title: 'Hash Generator',
    description: 'Local generator of checksums and cryptographic hashes. Supports popular algorithms: MD5, SHA-1, SHA-256, and SHA-512. Useful for verifying file integrity, generating unique object keys, or testing authorization mechanisms in Mendix.',
    howToGet: 'Any text string you want to hash.',
    howToUse: \`
      <ol>
        <li>Enter text in the input field.</li>
        <li>Hashes for all available cryptographic algorithms will be generated and displayed automatically below.</li>
      </ol>
    \`
  },
  'password-generator': {
    title: 'Password Generator',
    description: 'Generator of strong, secure, and random passwords. Facilitates creating passwords for system accounts, database administrators, or technical accounts in Mendix Cloud.',
    howToGet: 'The generator works fully locally and randomly. It does not require input data.',
    howToUse: \`
      <ol>
        <li>Set the password length using the slider.</li>
        <li>Check options defining what characters the password should contain (uppercase, lowercase, numbers, special characters).</li>
        <li>Click the <strong>Generate Password</strong> button and copy the generated secure string.</li>
      </ol>
    \`
  },
  'regex-tester': {
    title: 'Java Regex Tester (Mendix)',
    description: 'Dedicated tool for testing Regular Expressions (Regex). It works based on Java regular expression engine rules (which is directly used by Mendix Runtime e.g., in attribute validation functions and in the <code>isMatch()</code> function in Microflows).',
    howToGet: 'Prepare a regular expression you want to test (e.g., zip code validator, tax ID) and test text.',
    howToUse: \`
      <ol>
        <li>Enter the Regex pattern in the top field (e.g., <code>^\\d{2}-\\d{3}$</code> for Polish zip codes).</li>
        <li>Enter test text in the bottom field.</li>
        <li>The tool will instantly highlight matching text fragments and inform about potential syntax errors in the Java regular expression engine.</li>
      </ol>
    \`
  },
  'timestamp': {
    title: 'Timestamp & Date Converter',
    description: 'Used for quick conversion of timestamps (Unix Timestamp in seconds or milliseconds) to readable calendar dates in various time zones (UTC, user local zone) and vice-versa. Useful for analyzing raw data in the Mendix database, where dates and times are often stored as numbers (Epoch).',
    howToGet: 'Get the numeric timestamp value from the database (e.g., <code>1719878400000</code>) or copy from a system log.',
    howToUse: `
      <ol>
        <li><strong>Convert to Date:</strong> Enter the timestamp value (seconds or milliseconds). The tool will instantly calculate and display the calendar date.</li>
        <li><strong>Convert to Timestamp:</strong> Select a date and time from the calendar to generate the corresponding Unix Epoch timestamp.</li>
      </ol>
    \`
  }
};\`

const startIdx = content.indexOf('const TOOLS_HELP = {');
const endIdx = content.indexOf('};', startIdx) + 2;

if (startIdx !== -1 && endIdx !== -1) {
    const originalText = content.substring(startIdx, endIdx);
    content = content.replace(originalText, newToolsHelp);
    fs.writeFileSync(path, content, 'utf8');
    console.log("Translation applied successfully!");
} else {
    console.error("Could not find TOOLS_HELP definition.");
}
