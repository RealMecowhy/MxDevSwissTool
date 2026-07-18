// ============================================================
// HELP DATABASE & CONTROLLER FOR MXDEV SWISS TOOL
// ============================================================

const TOOLS_HELP = {
  'log-viewer-stream': {
    title: 'Mendix Log Viewer - Log Stream',
    description: 'Tool for rapid analysis, searching, and filtering of Mendix application logs. Instead of opening giant text files in a traditional notepad, you can load them here, filter loggers and error levels, and automatically group (aggregate) identical errors.',
    howToGet: `
      <ul>
        <li><strong>Mendix Cloud:</strong> Log in to the Mendix Portal, go to <em>Environments</em> → select an environment (e.g., Production) → <em>Details</em> → <em>Logs</em> → click <em>Download Log File</em> or download archive logs.</li>
        <li><strong>Studio Pro Console:</strong> the Console log exported from Mendix Studio Pro as a <code>.csv</code> file (<code>Type, TimeStamp, LogNode, Message</code> columns) is also supported — the viewer detects the format automatically by the file extension.</li>
        <li><strong>Local Environment:</strong> In your Mendix project folder, logs are located at <code>[project_directory]/deployment/log/log.txt</code>.</li>
        <li><strong>Hybrid Environments (Docker):</strong> Download container logs using the command: <code>docker logs [container_name] > app_log.txt</code>.</li>
      </ul>
    `,
    howToUse: `
      <ol>
        <li>Drag and drop the log file (e.g., <code>.txt</code>, <code>.log</code>, <code>.csv</code>, or gzipped <code>.gz</code> archives from Mendix Cloud) directly into the browser window or paste raw log text into the input field. Multiple files are merged into one chronological timeline.</li>
        <li>Use the filters in the toolbar: enter a phrase (e.g., Microflow name), toggle log levels (TRACE, DEBUG, INFO, WARN, ERROR, CRITICAL) or filter by a specific logger name (e.g., <code>ConnectionBus</code>).</li>
        <li>Narrow down to a specific time window by entering a From / To time (e.g., <code>09:00:00</code> &rarr; <code>10:00:00</code>) and optionally selecting a date.</li>
        <li>Click <strong>Aggregate Errors</strong> in the top right corner of the module bar to open a modal with a summary of unique errors and their occurrence statistics (useful for locating error loops).</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>ConnectionBus errors:</strong> Usually indicate database problems, query timeouts, or attempts to write incomplete objects.</li>
        <li><strong>ActionManager errors:</strong> Indicate a failure in Microflow / Activity execution. Check the Microflow name provided in the log and navigate to it in Mendix Studio Pro.</li>
        <li><strong>Jetty / Connector errors:</strong> Suggest network issues, dropped client HTTP connections, or server response timeouts to a user request.</li>
      </ul>
    `
  },
  'log-viewer-insights': {
    title: 'Mendix Log Viewer - Insights',
    description: 'A triage overview that scans the loaded log for known Mendix problem patterns and shows one card per issue that actually occurs — never an empty report. It works on ordinary production logs (INFO level and above): permission violations, session-state bloat and TaskQueue failures all log at WARNING/ERROR, so no DEBUG/TRACE is required. Click any card (or a row in its breakdown) to jump to the Log Stream filtered to exactly those entries.',
    howToGet: `
      <p>Any Mendix log works — the same files you load in the Log Stream tab. Insights reads the records already parsed there, so nothing extra is needed.</p>
      <ul style="margin-top:var(--sp-2); margin-left:var(--sp-4); list-style-type:disc;">
        <li><strong>Standard production logs (INFO+):</strong> permission violations, request-state bloat, TaskQueue failures and per-node error hotspots are all captured — these events log at WARNING/ERROR.</li>
        <li><strong>Background-job run statistics:</strong> if you also need scheduled-event durations and microflow-level detail, raise the relevant log nodes to <code>DEBUG</code>/<code>TRACE</code> — but that is <em>not</em> required for the cards here.</li>
      </ul>
    `,
    howToUse: `
      <ol>
        <li>Load a log in the <strong>Log Stream</strong> tab, then switch to <strong>Insights</strong>.</li>
        <li>Read the summary line (entries scanned, error/warning totals, number of problem categories). Cards are sorted with errors first, then by frequency.</li>
        <li>Each card shows the count, a one-line summary and a sample message. Click <strong>Breakdown</strong> to expand the per-microflow / per-task / per-message drill-down.</li>
        <li>Click a card header or a breakdown row to open the Log Stream pre-filtered (log node + level + search) to just those entries.</li>
        <li>If no cards appear, the log is clean at WARNING level and above — that is itself a useful result.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>Access denied (WebUI):</strong> a user tried to run a microflow/page they lack rights for. A single microflow denied to many users usually means a missing or misconfigured entity/page access rule.</li>
        <li><strong>Request state bloat (RequestStatistics):</strong> a request kept far more objects in session state than the threshold — a common cause of memory pressure and slow pages. The card reports the peak object count observed.</li>
        <li><strong>TaskQueue failures:</strong> background tasks that threw. A single task failing many times is a <em>retry loop</em> (flagged in the card) — typically one poison record; use the breakdown to get the task name and queue, then trace it.</li>
        <li><strong>Per-node error hotspots:</strong> everything else, bucketed by log node (e.g. <code>SAML_SSO</code>, <code>Connector</code>, <code>WebServices</code>). High <code>Connector</code> 404 counts are often bots probing the public URL — noise, but worth confirming.</li>
      </ul>
    `
  },
  'log-viewer-correlation': {
    title: 'Mendix Log Viewer - Correlation Flow',
    description: 'Visualizes the flow of requests and microflow executions based on correlation IDs in the logs, allowing you to trace a complete transaction across multiple log entries.',
    howToGet: `
      <p>Ensure your logs contain Correlation IDs. There are a few ways to achieve this:</p>
      <ul style="margin-top:var(--sp-2); margin-left:var(--sp-4); list-style-type:disc;">
        <li style="margin-bottom:var(--sp-1)"><strong>Mendix 10+ (OpenTelemetry):</strong> When OpenTelemetry is enabled, Mendix automatically generates a <code>Trace ID</code> for each thread, which acts as a perfect Correlation ID across your entire application.</li>
        <li style="margin-bottom:var(--sp-1)"><strong>Mendix (Legacy/Modules):</strong> For older versions, use modules from the Marketplace that inject a unique key into logs (e.g., <code>[corr_id: xyz]</code>) for every REST/Microflow action.</li>
        <li><strong>NGINX:</strong> NGINX can generate a unique ID for every incoming HTTP request using the <code>$request_id</code> variable. Add it to your <code>log_format</code> in <code>nginx.conf</code>, and pass it to Mendix via the header <code>proxy_set_header X-Request-ID $request_id;</code> so both systems log the same ID.</li>
      </ul>
    `,
    howToUse: `
      <ol>
        <li>Switch to the <strong>Correlation Flow</strong> tab.</li>
        <li>Select a specific Correlation ID from the list to see all log entries related to that specific transaction.</li>
        <li>Follow the chronological flow to identify where a process failed or took too long.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>For beginners:</strong> If a user reports an error, ask them for the time it happened. Find the error in the Log Stream, copy its Correlation ID, and paste it here. You will see everything that happened during that exact button click!</li>
        <li><strong>Complex transactions:</strong> Helps in debugging transactions that span multiple microflows and integrations by isolating only the logs relevant to a single user action.</li>
      </ul>
    `
  },
  'log-viewer-sequence': {
    title: 'Mendix Log Viewer - Sequence Diagram',
    description: 'Generates a UML sequence diagram based on Mendix log entries, showing the interactions between different components (e.g., ActionManager, ConnectionBus, REST services).',
    howToGet: 'You need logs with sufficient detail, preferably <code>DEBUG</code> or <code>TRACE</code> for relevant loggers like <code>ActionManager</code> or <code>REST_Consume</code>.',
    howToUse: `
      <ol>
        <li>Switch to the <strong>Sequence Diagram</strong> tab.</li>
        <li>Analyze the chronological sequence of events and calls between different system components.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>For beginners:</strong> A visual way to see "what calls what". If your app hangs, check the sequence diagram to see where the last call stopped.</li>
        <li><strong>Architecture:</strong> Useful for spotting unexpected loops (e.g., a microflow calling itself recursively) or missing API calls.</li>
      </ul>
    `
  },
  'log-viewer-gantt': {
    title: 'Mendix Log Viewer - Gantt Chart',
    description: 'Provides a timeline view of long-running operations in your logs, helping you identify performance bottlenecks and parallel execution issues.',
    howToGet: 'Logs containing timestamps for start and end of operations, typically found in <code>TRACE</code> level logs for microflows or database queries.',
    howToUse: `
      <ol>
        <li>Switch to the <strong>Gantt Chart</strong> tab.</li>
        <li>Look for long horizontal bars that represent slow operations.</li>
        <li>Zoom in to inspect parallel vs sequential executions.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>For beginners:</strong> Think of this as a race track. The longest bar is the slowest runner (bottleneck). Fix that one first to speed up your app.</li>
        <li><strong>Parallelization:</strong> If you see many operations executed sequentially (stairs-like pattern), consider using parallel execution in your Mendix microflows or batching database queries.</li>
      </ul>
    `
  },
  'log-query-extractor': {
    title: 'Log Query Extractor',
    description: 'Extract, parse and correlate executed SQL queries and XPath/OQL from Mendix TRACE logs. This tool converts raw Mendix log outputs into readable, formatted, runnable SQL statements with parameters automatically injected.',
    howToGet: `
      <p>Ensure your application logs contain database trace information. Here is how to configure it:</p>
      <ul>
        <li><strong>Local Studio Pro:</strong> Go to <em>Console</em> → <em>Advanced</em> → <em>Set Log Levels</em>. Set <code>ConnectionBus</code>, <code>DataStorage</code>, and <code>QueryParser</code> to <strong>TRACE</strong>. Perform the actions you want to track, then export the Console log to a CSV or TXT file.</li>
        <li><strong>Mendix Cloud:</strong> Change log levels for <code>ConnectionBus</code>, <code>DataStorage</code>, and <code>QueryParser</code> to <strong>TRACE</strong> in the Environment Details page. Download the logs from the portal.</li>
        <li><strong>No TRACE? Production still works:</strong> at <em>default</em> log levels the Mendix runtime logs a <code>ConnectionBus_Queries</code> <strong>WARNING</strong> for every slow query (&ldquo;Query executed in N seconds&hellip;&rdquo;) with the full SQL. The tool ingests these from both the Studio Pro CSV export and the raw live log downloaded from Mendix Cloud (<code>.txt</code>/<code>.log</code>) — they appear in the list marked with a ⚠ badge and a filled Duration.</li>
      </ul>
    `,
    howToUse: `
      <ol>
        <li>Load the exported CSV or TXT log file into the tool &mdash; use <strong>Load TRACE Log</strong> or drag &amp; drop the file onto the query list. The format is detected automatically: both the Studio Pro CSV export and the raw Mendix Cloud live log (<code>.txt</code>/<code>.log</code>) are parsed into runnable SQL, query plans and slow-query warnings. Large files (100&nbsp;MB+) are parsed on a background thread with a progress bar, so the interface never freezes. If some CSV rows are malformed, a <strong>&ldquo;N lines skipped&rdquo;</strong> note appears next to the query counter.</li>
        <li>The tool will automatically group related log entries and extract all SQL queries. They will be listed on the left, displaying their type, transaction connection, execution duration, and estimated cost. Click the <strong>Time / Duration / Cost / Rows</strong> column headers to sort.</li>
        <li>The <strong>stats bar</strong> above the list shows the total and average execution time, the slowest query (click it to jump to that query) and the number of duplicated statements &mdash; all recalculated live for the current filters.</li>
        <li>Statements executed multiple times with different parameters get a <strong>&times;N</strong> badge &mdash; use the <strong>Duplicates only (N+1)</strong> filter to instantly spot N+1 query patterns. Enable <strong>Slow only &gt; X ms</strong> to hide everything below your duration threshold.</li>
        <li>Use <strong>Export CSV</strong>, <strong>Copy Markdown</strong> or <strong>Export HTML</strong> (a self-contained, shareable report) in the top bar to take the currently filtered list with you &mdash; e.g. into a ticket, a wiki page or a spreadsheet.</li>
        <li>Select a query from the list to see its details neatly grouped on the right:
          <ul>
            <li><strong>Runnable SQL:</strong> The final SQL statement with all <code>?</code> parameters substituted correctly.</li>
            <li><strong>Source XPath/OQL:</strong> The original Mendix queries that generated the SQL, including intermediate OQL translation.</li>
            <li><strong>Parameters:</strong> A table listing the raw values bound to the SQL query.</li>
            <li><strong>Result Data:</strong> The raw output rows returned by the database.</li>
            <li><strong>Query Plan:</strong> The PostgreSQL execution plan in JSON format. Click <strong>Visualize Plan</strong> to open it in the Query Intelligence Explain visualizer with index suggestions &mdash; a floating <strong>&larr; Back</strong> pill returns you straight to the extractor.</li>
          </ul>
        </li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>For beginners:</strong> This tool bridges the gap between what Mendix executes and the underlying database. It allows you to grab a query and immediately paste it into your database client to test it.</li>
        <li><strong>Performance Tuning:</strong> Focus on queries that return a large number of rows, have high cost, or long duration. The Query Plan tab reveals whether the database is using indexes (Index Scan) or performing slow table scans (Seq Scan).</li>
        <li><strong>Duration & Cost:</strong> By setting <code>DataStorage</code> to TRACE, Mendix logs the database query execution plan. This tool parses it to display the exact execution time (Duration) and estimated Cost calculated by PostgreSQL.</li>
        <li><strong>⚠ SLOW (warning) entries:</strong> these queries exceeded the runtime's slow-query threshold and were reported by <code>ConnectionBus_Queries</code> at default log levels. On production they are the cheapest performance signal available &mdash; start your investigation there.</li>
      </ul>
    `
  },
  'microflow-tracer': {
    title: 'Microflow Tracer',
    description: 'Rebuilds microflow executions from Mendix <code>MicroflowEngine</code> logs: execution times, activity-by-activity timelines, and the call tree of sub-microflows. Answers &ldquo;which microflows ran, how long did they take, and where inside them did the time go&rdquo; &mdash; straight from a log file, without instrumenting the app.',
    howToGet: `
      <p>The tool reads <code>MicroflowEngine</code> log records. Two levels unlock two layers of detail:</p>
      <ul>
        <li><strong>DEBUG</strong> &mdash; <em>Starting/Finished execution</em> records: gives the execution list with exact durations (microsecond timestamps). Cheap enough to enable widely.</li>
        <li><strong>TRACE</strong> &mdash; adds <em>Executing activity</em> records: gives the step-by-step timeline (activity type, caption, time per step) and the call tree. Verbose &mdash; enable for a reproduction window, then switch back.</li>
        <li><strong>Local Studio Pro:</strong> <em>Console</em> → <em>Advanced</em> → <em>Set Log Levels</em> → set <code>MicroflowEngine</code> to DEBUG or TRACE, reproduce the scenario, export the console log (CSV or TXT).</li>
        <li><strong>Mendix Cloud:</strong> set the <code>MicroflowEngine</code> log level in Environment Details, reproduce, then download the live log from the portal. Both formats are detected automatically.</li>
      </ul>
    `,
    howToUse: `
      <ol>
        <li>Load the log with <strong>Load Log</strong> or drag &amp; drop it onto the list. Large files parse on a background thread with a progress bar.</li>
        <li>The <strong>Executions</strong> view lists every microflow run with its duration, activity-step count and direct sub-microflow calls. Sub-flows are indented under their caller; the <strong>Top-level</strong> checkbox hides them. Click <strong>Time / Duration / Steps / Sub</strong> to sort, use the search box, or enable <strong>Slow only &gt; X ms</strong>.</li>
        <li>Switch to <strong>By microflow</strong> for the aggregate view: calls, total, average and max duration per microflow &mdash; the fastest way to find hot spots. Click a row to drill into its executions.</li>
        <li>Select an execution to open the details:
          <ul>
            <li><strong>Activity Timeline:</strong> each logged activity with its offset from the start, type, caption and the time until the next engine event &mdash; the longest bars are where the time went.</li>
            <li><strong>Call Tree:</strong> the full caller&rarr;callee tree for this correlation ID with durations; click any node to inspect it. Recursive calls are flagged with <strong>REC</strong>.</li>
            <li><strong>Raw:</strong> the reconstructed engine events for copy-paste.</li>
          </ul>
        </li>
        <li><strong>Queries in window</strong> jumps to the Log Query Extractor filtered to the SQL that executed during this execution's time window (engine records carry no transaction ID, so the correlation is temporal). If the extractor is empty, the same file is handed over automatically &mdash; one load powers both tools.</li>
        <li><strong>Export CSV</strong> / <strong>Copy Markdown</strong> take the currently filtered list with you.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>Hot paths:</strong> sort the aggregate view by <em>Total</em> &mdash; a microflow with moderate average but thousands of calls often costs more than one slow outlier. Then check its timeline for the dominant step.</li>
        <li><strong>Slow steps:</strong> long <em>RetrieveByXPath</em>/<em>AggregateUsingDatabase</em> steps point at database work &mdash; use <strong>Queries in window</strong> to see the exact SQL. Long <em>JavaAction</em> steps point at custom code, long <em>CallRest/CallWebservice</em> at external services.</li>
        <li><strong>REC badge:</strong> the same microflow was already on the call stack &mdash; intentional recursion is rare in Mendix; verify it terminates and isn't doing N&times; database work.</li>
        <li><strong>Unfinished (…):</strong> no Finished record in the log &mdash; usually the log window simply ends mid-execution, but combined with an ERROR nearby it can mean the microflow died with an exception.</li>
        <li><strong>Steps = 0:</strong> the log has DEBUG but not TRACE &mdash; durations are exact, only the per-activity breakdown is missing.</li>
      </ul>
    `
  },
  'ws-rest-extractor': {
    title: 'REST & WS Extractor',
    description: 'Rebuilds outgoing and incoming HTTP/SOAP integration calls from Mendix <code>REST Consume</code>, <code>REST Publish</code> and <code>WebServices</code> TRACE logs. Scattered request and response log entries are paired into complete calls &mdash; method, URL, status, headers, payloads and duration &mdash; and, when <code>MicroflowEngine</code> TRACE is present, each outgoing call is anchored to the microflow that made it, closing the <strong>microflow &rarr; REST &rarr; SQL</strong> chain via cross-links to the Microflow Tracer and Log Query Extractor.',
    howToGet: `
      <p>The tool reads integration log nodes at TRACE level:</p>
      <ul>
        <li><strong><code>REST Consume</code></strong> &mdash; outgoing REST calls made by <em>Call REST service</em> activities: request/response headers and bodies, plus the configured client timeout (&ldquo;Creating http client &hellip; with timeout&rdquo;).</li>
        <li><strong><code>REST Publish</code></strong> &mdash; incoming calls to your published REST services: client IP, headers, matched operation and the outgoing response (including 404s for unmatched paths).</li>
        <li><strong><code>WebServices</code></strong> &mdash; both directions of SOAP: consumed web services (with <code>SOAPAction</code>) and incoming requests to published services.</li>
        <li><strong><code>MicroflowEngine</code> at TRACE (optional but recommended)</strong> &mdash; the <em>CallRest / CallWebservice</em> activity logged just before each outgoing call gives the correlation ID and microflow name, enabling the cross-links.</li>
        <li><strong>Local Studio Pro:</strong> <em>Console</em> &rarr; <em>Advanced</em> &rarr; <em>Set Log Levels</em> &rarr; set the nodes above to TRACE, reproduce the scenario, export the console log (CSV or TXT). <strong>Mendix Cloud:</strong> set the log levels in Environment Details, reproduce, download the live log. Both formats are detected automatically.</li>
      </ul>
    `,
    howToUse: `
      <ol>
        <li>Load the log with <strong>Load TRACE Log</strong> or drag &amp; drop it onto the list. Large files parse on a background thread with a progress bar.</li>
        <li>The left list shows every paired call: time, node with direction (<strong>REST&nbsp;&rarr;</strong> outgoing / <strong>REST&nbsp;&larr;</strong> incoming / <strong>SOAP&nbsp;&rarr;</strong> / <strong>SOAP&nbsp;&larr;</strong>), method, status, duration and endpoint. Click <strong>Time / Status / Duration</strong> to sort; filter by direction, protocol, errors or uncertain pairing; use <strong>Slow only &gt; X ms</strong> for latency hunting.</li>
        <li>The <strong>stats bar</strong> tracks the visible set: call count, average and slowest duration (click to jump), errors, requests without a response, and uncertain pairings.</li>
        <li>Select a call to inspect it on the right:
          <ul>
            <li><strong>Overview:</strong> method, URL/service, status, duration (request&rarr;response timestamp delta), client timeout, client IP, and &mdash; with the anchor &mdash; the calling microflow and correlation ID.</li>
            <li><strong>Headers:</strong> request and response headers as clean tables.</li>
            <li><strong>Request / Response:</strong> payloads, automatically pretty-printed when they are JSON or XML.</li>
          </ul>
        </li>
        <li><strong>Trace microflow</strong> opens the calling microflow in the Microflow Tracer; <strong>SQL in window</strong> opens the Log Query Extractor filtered to this call's time window. If the target tool is empty, the same file is handed over automatically &mdash; one load powers all three tools.</li>
        <li><strong>Export CSV</strong> / <strong>Copy Markdown</strong> take the currently filtered list with you.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>Pairing model:</strong> Mendix logs carry no request IDs, so requests and responses are paired <em>FIFO per (log node + method + URL)</em>. When two calls to the same endpoint are in flight at once, both get the <strong>⇅ uncertain</strong> badge &mdash; the pairing is the most likely one, not a logged fact.</li>
        <li><strong>⏱ timeout suspects:</strong> a request with a configured client timeout and no logged response usually means the client gave up (timeout) or the log window ended mid-call. Correlate with errors around that timestamp.</li>
        <li><strong>Slow outgoing calls:</strong> the duration is pure wire time of the external service (delta between the logged request and response). A slow microflow whose time sits in a <em>CallRest</em> step is the external system's problem, not your app's &mdash; this view proves it.</li>
        <li><strong>404 on REST Publish:</strong> &ldquo;no operation matches&rdquo; entries reveal clients calling wrong paths &mdash; the full requested URL is kept in the response tab.</li>
        <li><strong>Security note:</strong> TRACE-level integration logs contain real payloads and headers. Treat exported files accordingly &mdash; the Log &amp; Text Anonymizer can scrub them before sharing.</li>
      </ul>
    `
  },
  'error-decoder': {
    title: 'Mendix Error Decoder',
    description: 'Decodes the <strong>mechanism</strong> behind a Mendix, Java or PostgreSQL error message or stack trace. For every known signature it matches, it shows three things: <strong>what happened technically</strong> (certain — it follows directly from the message), <strong>typical causes</strong> (an explicit list of hypotheses) and <strong>how to check which one applies</strong> (a diagnostic checklist that cross-links to the Log Query Extractor, JVM Health Analyzer, Microflow Tracer and others). It is deliberately a <em>decoder, not a fix advisor</em>: it never prescribes what to change, always shows you the pattern it matched so you can judge the fit, and — when it does not recognize a message — it says so rather than guessing.',
    howToGet: `
      <ul>
        <li><strong>From a log:</strong> copy an <code>ERROR</code>/<code>CRITICAL</code> line and everything indented under it (the stack trace) from the Mendix log. In the <strong>Mendix Log Viewer</strong>, ERROR rows carry an <strong>Explain</strong> chip that sends the full message here automatically.</li>
        <li><strong>Full stack trace matters:</strong> paste down to the deepest <code>Caused by:</code> line — Mendix wraps the real exception (database, integration, null…) inside a generic <code>MicroflowException</code>, and the decoder keys off that root cause.</li>
        <li><strong>Sources:</strong> the runtime log (Mendix Cloud <em>Environments → Logs</em>, or local <code>deployment/log/log.txt</code>), a support ticket, or an alert message all work — no special log level is required.</li>
      </ul>
    `,
    howToUse: `
      <ol>
        <li>Paste the error into the left panel (or arrive via the Log Viewer <strong>Explain</strong> chip) and click <strong>Decode</strong> — matching also runs automatically as you paste.</li>
        <li>Each recognized signature produces a card. Cards are ordered <strong>most specific first</strong>; when several match (a wrapped exception), the deepest/root match sits at the top — read them together.</li>
        <li>Every card shows the <strong>exact pattern it matched</strong> so you can confirm it fits your message before trusting the explanation.</li>
        <li>Work down the card: <strong>What happened technically</strong> is the certain part; <strong>Typical causes</strong> are hypotheses to weigh; <strong>How to check which</strong> is a checklist — use the inline links to jump to the tool that answers each check (e.g. the Log Query Extractor to see the SQL that ran).</li>
        <li>If nothing matches, that is an honest result: the decoder does not invent a cause. Try pasting more of the stack trace, or inspect the message in the Log Viewer.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>Decoder, not advisor:</strong> the cards explain <em>why</em> an error occurs and what to <em>check</em> — they never tell you what to change. The fix is your decision once you have confirmed which cause applies.</li>
        <li><strong>Wrapped exceptions:</strong> a <code>MicroflowException</code> card is only the outer layer. The specific card above it (e.g. a unique-constraint or socket-timeout match) is the mechanism that actually failed.</li>
        <li><strong>Matched pattern is evidence, not proof:</strong> the decoder matches on text signatures. Always sanity-check the matched snippet against your real message — a similar-looking message can key the same rule.</li>
        <li><strong>Coverage:</strong> the ruleset covers common database (constraints, deadlocks, timeouts, pool exhaustion), JVM/memory (heap, metaspace, GC, threads), integration (TLS, socket timeouts, connection refused, client disconnects), SAML/SSO and platform errors. Unrecognized ≠ unimportant — it just is not in the ruleset yet.</li>
      </ul>
    `
  },
  'incident-report': {
    title: 'Incident Report',
    description: 'Assembles the data currently loaded across the diagnostics tools into <strong>one self-contained HTML report</strong> for a chosen time window. It pulls the warnings &amp; errors from the Log Viewer, the SQL from the Log Query Extractor, microflow executions from the Microflow Tracer, integration calls from the REST &amp; WS Extractor, HTTP requests from the Nginx analyzer and the thread-dump summary from JVM Health &mdash; correlating them side by side so one file tells the whole story of an incident. Fully offline: no external resources, safe to attach to a ticket or email.',
    howToGet: `
      <p>The Incident Report does not read files itself &mdash; it reuses whatever you have already loaded in the other tools. Load your data there first:</p>
      <ul>
        <li><strong>Log Viewer</strong> &mdash; the application log (its WARNING/ERROR/CRITICAL entries become the incident backbone).</li>
        <li><strong>Log Query Extractor</strong> &mdash; a TRACE log or CSV export for the SQL that ran.</li>
        <li><strong>Microflow Tracer</strong> &mdash; a MicroflowEngine DEBUG/TRACE log for the executions.</li>
        <li><strong>REST &amp; WS Extractor</strong> &mdash; a TRACE log for the integration calls.</li>
        <li><strong>Nginx Log Analyzer</strong> &mdash; the access log for HTTP requests / error responses.</li>
        <li><strong>JVM Health Analyzer</strong> &mdash; paste and analyze a thread dump for the thread-state summary.</li>
      </ul>
      <p>Only sources that actually hold data are offered; the rest show an “Open &amp; load data” shortcut.</p>
    `,
    howToUse: `
      <ol>
        <li>Load data in the tools above, then open <strong>Incident Report</strong> (it re-scans every time you open it; use <strong>Refresh sources</strong> after loading more).</li>
        <li>Give the incident a <strong>title</strong> (used for the report heading and the file name).</li>
        <li>Set the <strong>time window</strong> (UTC). It is pre-filled from the span of the loaded data &mdash; narrow it to focus on the incident, or clear both fields to include everything. Leave one side blank for an open-ended bound.</li>
        <li>Tick which <strong>sources</strong> to include. Add optional <strong>notes</strong> that appear at the top of the report.</li>
        <li>Click <strong>Generate HTML report</strong>. The file downloads immediately and a summary shows exactly what went in. Open it in any browser &mdash; it is fully self-contained.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>One window, many angles:</strong> because every section is filtered to the same time window, a spike lines up across the Nginx 5xx responses, the slow SQL, the failing microflow and the blocked threads &mdash; that alignment is the point of the report.</li>
        <li><strong>Data-driven:</strong> a section only appears when its source produced rows for the window. An empty report for a window means those tools logged nothing there &mdash; widen the window or confirm the log levels.</li>
        <li><strong>Point-in-time JVM:</strong> a thread dump is a snapshot, so the JVM section is not time-filtered &mdash; it reflects the dump you last analyzed in JVM Health.</li>
        <li><strong>Sensitive data:</strong> the report carries real log content (SQL, payloads, IPs). Review it before sharing &mdash; the Log &amp; Text Anonymizer can scrub logs before you load them.</li>
      </ul>
    `
  },
  'nginx-log': {
    title: 'Nginx Log Analyzer',
    description: 'Module for parsing Nginx access and error logs. Helps to instantly check the most popular IP addresses, frequently accessed URLs, HTTP status code breakdown, error frequencies, and geographical location of visitors.',
    howToGet: `
      <ul>
        <li>The standard location for Nginx access logs on Linux systems is <code>/var/log/nginx/access.log</code>.</li>
        <li>You can download this file directly from the VPS / virtual machine where the Mendix app proxy is hosted.</li>
      </ul>
    `,
    howToUse: `
      <ol>
        <li>Paste the content of Nginx logs (<em>combined</em> format for access logs) or drag and drop the log file into the tool window (supports plain text and <code>.gz</code> archives). Use the respective "Access Log" or "Error Log" tab. The <strong>Error Log</strong> tab expects the Nginx <code>error.log</code> format (<code>YYYY/MM/DD HH:MM:SS [level] …</code>); if it detects an access log there instead, it shows a hint pointing you to the correct tab.</li>
        <li>Check the <strong>Enable IP Geolocation</strong> option to automatically query a free external API for the country of origin of IPs sending the most requests (runs asynchronously, doesn't block the browser).</li>
        <li>Click <strong>Analyze Logs</strong>. The tool provides two views: <strong>Analyzer</strong> (interactive statistical tables and charts) and <strong>Log Stream</strong> (raw log lines with syntax highlighting).</li>
        <li>Use the global filter toolbar to instantly narrow down results across both views by HTTP status code, specific time ranges, dates, or custom search queries (IP, URL, method).</li>
        <li>To load a different file or start over, use the <strong>Clear</strong> button to reset the tool's memory and inputs.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>4xx Status Codes:</strong> Frequent 404 (Not Found) or 403 (Forbidden) codes might indicate scanning of your server by bots/malware looking for vulnerabilities.</li>
        <li><strong>5xx Status Codes:</strong> Indicate a failure in the Mendix backend application (e.g., Mendix server is down or dropped the connection).</li>
        <li><strong>High traffic from a single IP:</strong> If one IP sends thousands of requests per minute, it could be a DoS attack attempt or a looped client script. Consider blocking such IPs at the firewall level.</li>
      </ul>
    `
  },
  'har-analyzer': {
    title: 'Mendix Client Traffic Analyzer (HAR)',
    description: 'Decodes a browser HAR capture into named Mendix operations. Chrome DevTools shows dozens of identical <code>POST /xas/</code> requests; this tool parses their bodies and groups them by the actual microflow name or XPath retrieve, so you can see <em>what</em> the client did, how many times, and how much it transferred. Ideal for diagnosing a slow or "chatty" page from a HAR a tester sent you — without sitting at their browser.',
    howToGet: `
      <ol>
        <li>Open the page in Chrome/Edge/Firefox and press <strong>F12</strong> to open DevTools, then go to the <strong>Network</strong> tab.</li>
        <li>Enable <strong>Preserve log</strong> and click the clear (🚫) button to start fresh.</li>
        <li>Reproduce the slow interaction (open the page, click the button, etc.).</li>
        <li>Right-click anywhere in the request list and choose <strong>Save all as HAR with content</strong> (or the download icon).</li>
      </ol>
      <p style="margin-top:var(--sp-2)"><strong>⚠ Privacy:</strong> a HAR contains cookies, auth headers and tokens. This tool parses it entirely in your browser and never uploads it — but if you need to share the HAR, scrub it in the Log &amp; Text Anonymizer first.</p>
    `,
    howToUse: `
      <ol>
        <li>Drag the <code>.har</code> file onto the tool or use <strong>Load HAR File</strong>.</li>
        <li>Review the summary cards (total requests vs. Mendix XAS operations, total XAS time and transfer).</li>
        <li>The <strong>Operations</strong> table groups every XAS call by microflow / XPath, slowest first, with call counts. The <strong>Detections</strong> panel flags client-side N+1 (the same retrieve repeated many times) and oversized responses.</li>
        <li>For a retrieve operation, click <strong>XPath</strong> to preview the full query in a popup without leaving the analysis &mdash; from there you can copy it or open it in the XPath Formatter for linting (a floating <strong>&larr; Back</strong> pill brings you straight back to the HAR view).</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>Client-side N+1:</strong> the same <code>retrieve_by_xpath</code> firing dozens of times usually means a data grid or list view is fetching row-by-row instead of over an association. Fix it in the page/widget configuration or by retrieving over an association.</li>
        <li><strong>Chatty microflows:</strong> a microflow invoked many times per page load often indicates an on-change or refresh loop. Consider debouncing or consolidating the calls.</li>
        <li><strong>Large responses:</strong> a single XAS response over 1&nbsp;MB points to an unbounded retrieve or a grid without paging — add a limit or amount.</li>
        <li><strong>Note:</strong> exact action names depend on the Mendix client version; when a request body cannot be decoded it is grouped under the generic <code>xas</code> action.</li>
      </ul>
    `
  },
  'telemetry-monitor': {
    title: 'Metrics & Telemetry',
    description: 'Advanced console for monitoring performance metrics (Prometheus) and logs/traces (OpenTelemetry) generated by the Mendix application engine. Enables bottleneck diagnostics on Waterfall charts.',
    howToGet: `
      <p>To have the Mendix app generate this data, it needs proper configuration:</p>
      <ol>
        <li><strong>Local Diagnostics (Agent Mode):</strong> Run the utility script <code>node mendix-observability-bridge.js</code> in the terminal at the project root. This script proxies logs from the local Mendix and connects to the PostgreSQL database (the database metrics part requires the optional <code>pg</code> module: run <code>npm install pg</code> once in the tool directory).</li>
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
    `,
    howToUse: `
      <ol>
        <li>Pick a <strong>Connection Profile</strong> in the Connection Settings card: <em>Local Agent Prometheus</em> or <em>Local Agent OpenTelemetry</em> (both via the NodeJS bridge), or <em>Direct Prometheus</em> (provide the Prometheus URL and optional API key).</li>
        <li>Click <strong>Connect Agent</strong> (agent profiles) or <strong>Fetch Metrics</strong> (direct mode). Charts for JVM memory usage, database connection pool, and request counts will start updating live.</li>
        <li>Go to the <strong>OTLP Traces (Waterfall)</strong> tab to see waterfall charts of Microflow / SQL executions. Click on individual spans to see details.</li>
        <li>No running Mendix app at hand? Click <strong>Start Sandbox</strong> to explore the dashboard with simulated data.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>JVM Heap Memory:</strong> If memory usage constantly increases (staircase chart upwards) and does not drop after Garbage Collection, the application might have a memory leak.</li>
        <li><strong>Database Connection Pool:</strong> If the number of used connections approaches the limit (e.g., 50), subsequent user requests will be blocked waiting for a free connection, drastically slowing down the system.</li>
        <li><strong>Waterfall (Traces):</strong> A long horizontal bar means the longest running activity. If you see dozens of small SQL query bars to the same table underneath, you've detected an <strong>N+1 queries</strong> problem, which should be optimized (e.g., by fetching data at once using an association or modifying a loop).</li>
      </ul>
    `
  },
  'http-status': {
    title: 'HTTP Status Codes',
    description: 'Handy, fully local knowledge base of all HTTP response codes. Each code includes a detailed explanation of its meaning and practical developer tips in the context of system integrations implemented in Mendix (REST, SOAP, OData).',
    howToGet: 'This tool is for reference. It does not require uploading any external data.',
    howToUse: `
      <ol>
        <li>Select a group of codes (e.g., 4xx for client errors, 5xx for server errors).</li>
        <li>Click on the code you are interested in (e.g., <code>401 Unauthorized</code> or <code>504 Gateway Timeout</code>).</li>
        <li>Read the description and developer advice regarding the configuration of the <em>Call REST</em> action in Mendix Studio Pro.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>For beginners:</strong> 4xx means YOU (your Mendix app) made a mistake in the request. 5xx means the TARGET SERVER crashed or failed.</li>
        <li><strong>Integration tip:</strong> Always add error handling for 5xx codes in Mendix to prevent the whole microflow from failing gracefully.</li>
      </ul>
    `
  },
  'thread-dump': {
    title: 'Thread Dump & GC Analyzer',
    description: 'Used to analyze Java Virtual Machine (JVM) Thread Dumps of a Mendix application and Garbage Collector logs. Helps in diagnosing application hang issues (Deadlock / Thread Starvation) and high CPU usage.',
    howToGet: `
      <ul>
        <li><strong>Local (Studio Pro):</strong> In the bottom Mendix console, click <em>Advanced</em> → <em>Create thread dump</em>.</li>
        <li><strong>Custom Linux Server:</strong> Log in to the server and execute a dump using the JDK tool: <code>jstack [PID_java_process] > thread_dump.txt</code>.</li>
      </ul>
    `,
    howToUse: `
      <ol>
        <li>Copy and paste the entire text of the generated thread dump into the text field, or drag and drop a thread dump file directly into the area.</li>
        <li>Click the <strong>Analyze Thread Dump</strong> button.</li>
        <li>Analyze the list of threads grouped by states (RUNNABLE, WAITING, TIMED_WAITING, BLOCKED) and detected blocking threads (monitors).</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>Number of BLOCKED threads > 0:</strong> Alarm situation. This means threads are waiting for a lock to be released by another thread. The tool will point out which thread is holding the lock (look for keywords related to database transactions or HTTP requests).</li>
        <li><strong>Threads in RUNNABLE state:</strong> Threads actively executing Java code. If there are very many of them and CPU usage is 100%, check if there is an infinite loop in the code (e.g., faulty recursion in a Microflow or a while loop in a Java Action).</li>
        <li><strong>Garbage Collection (GC) Pauses:</strong> Long pause times (Stop-the-world) visible in GC logs mean the JVM spends too much time cleaning up memory, causing the entire Mendix application to freeze momentarily.</li>
      </ul>
    `
  },
  'json-formatter': {
    title: 'JSON Formatter & Validator',
    description: 'Used for formatting, fixing, syntax validation, and convenient interactive exploration of data structures in JSON format.',
    howToGet: 'JSON data is mostly obtained from request/response headers and bodies of REST services logged in Mendix (after setting the <code>REST_Consume</code> or <code>REST_Publish</code> log level to <code>TRACE</code>).',
    howToUse: `
      <ol>
        <li>Paste unformatted or minified JSON text into the left text field.</li>
        <li>Formatting happens automatically upon data entry (you can also click the <em>Format</em> button). In case of syntax errors, the parser will indicate the exact line and cause of the problem.</li>
        <li>Use the interactive tree view on the right side to collapse and expand deeply nested objects or search for keys.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>For beginners:</strong> Use this to create JSON snippets for Mendix Import/Export mappings. It helps visualize complex data structures.</li>
        <li><strong>Troubleshooting:</strong> If a REST call fails with a parsing error, paste the payload here. The validator will point exactly to the missing comma or bracket.</li>
      </ul>
    `
  },
  'xml-formatter': {
    title: 'XML Formatter & Validator',
    description: 'Tool for structural validation and formatting of XML documents, most commonly used in SOAP (Web Services) integrations or data import/export in standard enterprise formats.',
    howToGet: 'XML text can be copied from the Mendix console (SOAP service logs after setting the <code>WebServices_Consume</code> log level to <code>TRACE</code>).',
    howToUse: `
      <ol>
        <li>Paste raw XML code into the input field.</li>
        <li>Click <strong>Format XML</strong>. The tool will arrange tags with proper indentation and check if the document is well-formed.</li>
        <li>You can explore the tag tree and copy the formatted XML code with one click.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>For beginners:</strong> XML is very strict. A missing closing tag breaks everything. Use this to find structural errors in SOAP responses.</li>
        <li><strong>Mendix Namespaces:</strong> Watch out for namespaces (e.g., <code>xmlns:xsi</code>). They often cause issues during Mendix XML import mappings if not defined correctly.</li>
      </ul>
    `
  },
  'char-sanitizer': {
    title: 'XML & Text Sanitizer',
    description: 'Tool for analyzing and cleaning texts and XML messages from invisible characters, faulty spaces, control codes, and encoding errors (Mojibake), which often cause integration errors in external systems.',
    howToGet: `
      <ul>
        <li>Copy the content of an XML message that bounces off an external system (e.g., from error logs in the Mendix console).</li>
        <li>Copy text (e.g., address, contact details) entered by a user that you suspect contains invisible characters.</li>
        <li>You can also drag and drop a text or XML file directly into the input area.</li>
      </ul>
    `,
    howToUse: `
      <ol>
        <li>Paste text or XML into the left text field or drop a file.</li>
        <li>Select detection filters in the bottom panel (e.g., Invisible Spaces, Control Characters, Mojibake).</li>
        <li>In the <strong>Visual Inspector</strong> tab, you will see problematic characters highlighted. Hovering over them will display the character name and its Unicode code (e.g., <code>U+200B ZERO WIDTH SPACE</code>).</li>
        <li>In the <strong>Statistics & Issues</strong> tab, you will find a table with a summary and count of specific anomalies.</li>
        <li>Go to the <strong>Sanitized Output</strong> tab, adjust cleaning rules (e.g., replace NBSP with a regular space, fix specific characters), and copy the cleaned text or download it as a file.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>Invisible spaces (e.g., ZWSP, BOM):</strong> Very often pasted accidentally when copying text from a PDF or website. They block XML parsers even if the field looks empty.</li>
        <li><strong>Mojibake (e.g., Ã„â€¦, Ã…â€š):</strong> Occurs when systems exchange data using different encodings (e.g., database in Windows-1250, and interface in UTF-8).</li>
        <li><strong>C0 Control Characters (e.g., NUL, BEL, SUB):</strong> Older type control characters. They are not allowed in the XML 1.0 standard and cause immediate rejection of the file by the standard XML parser in Mendix.</li>
        <li><strong>Escaped references (e.g., <code>&amp;#14;</code>, <code>&amp;#x0E;</code>):</strong> A file can be 100% clean at the byte level and still be invalid — an escaped numeric reference to a control character is rejected by every XML parser the moment it is expanded. This is a classic source of "works in the editor, fails in the integration" errors.</li>
        <li><strong>Private Use Area characters (e.g., <code>U+100000</code>):</strong> Codepoints with no defined glyph, invisible in most editors. Technically legal in XML, but almost always injected garbage from an upstream system (scanners, label printers, EDI converters).</li>
      </ul>
    `
  },
  'sql-formatter': {
    title: 'SQL Formatter',
    description: 'Allows for quick beautification and formatting of SQL queries generated automatically by the Mendix Connection Bus. This makes it easier to analyze queries sent to PostgreSQL, Oracle, or SQL Server databases.',
    howToGet: `
      <p>To get SQL queries from a Mendix application:</p>
      <ul>
        <li>Set the log level of the <code>ConnectionBus</code> logger to <code>DEBUG</code> or <code>TRACE</code> in the Mendix console.</li>
        <li>Execute an action in the application and copy the generated SQL query from the console.</li>
      </ul>
    `,
    howToUse: `
      <ol>
        <li>Paste a raw, one-line compressed SQL query into the text field.</li>
        <li>Click the <strong>Format SQL</strong> button. Keywords such as SELECT, FROM, JOIN, WHERE will be moved to new lines and bolded.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>For beginners:</strong> Mendix generates very long, unreadable SQL queries under the hood. Formatting them here helps you see exactly which database tables are being joined.</li>
        <li><strong>Debugging:</strong> If an OQL query fails or is slow, inspect the generated SQL to check if it's hitting the expected indexes.</li>
      </ul>
    `
  },
  'text-diff': {
    title: 'Text Diff Utility',
    description: 'Local tool for comparing two pieces of text. Instantly locates and highlights differences (added lines, deleted lines, and changed characters). Useful for comparing configurations, JSON payloads from different environments, or generated files.',
    howToGet: 'Copy the original payload/configuration and the new version you want to compare against.',
    howToUse: `
      <ol>
        <li>Paste the original version of the text into the <strong>Original Text (Left)</strong> field.</li>
        <li>Paste the new (modified) version of the text into the <strong>Modified Text (Right)</strong> field.</li>
        <li>Differences will be generated automatically and marked with colors: red (deleted) and green (added).</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>For beginners:</strong> If an integration worked yesterday but fails today, compare the JSON responses from both days to instantly spot what field changed.</li>
        <li><strong>Configuration sync:</strong> Use this to compare <code>yaml</code> configs between test and production environments to find missing variables.</li>
      </ul>
    `
  },
  'encoder': {
    title: 'Base64 / URL Encoder & Decoder',
    description: 'On-the-fly text encoding converter. Supports Base64 (useful for Basic Authentication and file transfers), URL encoding (needed for building query parameters in GET requests), and HTML entity decoding.',
    howToGet: 'Obtain Base64 strings from API headers (like Basic Auth) or URL parameters that need decoding.',
    howToUse: `
      <ol>
        <li>Select the encoding mode tab: <strong>Base64</strong>, <strong>URL Encode</strong>, <strong>HTML Entities</strong>, or <strong>Hexadecimal</strong>.</li>
        <li>Paste your text into the <strong>Input</strong> field and click <strong>Encode</strong> or <strong>Decode</strong>.</li>
        <li>Use <strong>Swap</strong> to move the output back to the input (handy for chained conversions), and <strong>Copy</strong> to grab the result.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>For beginners:</strong> URLs cannot contain spaces or special characters. If your REST API call fails because of a space in the query parameter, use URL Encoding.</li>
        <li><strong>Basic Authentication:</strong> It is just Base64 of <code>username:password</code>. You can easily generate or decode it here.</li>
      </ul>
    `
  },
  'md-preview': {
    title: 'Markdown Editor & Table Generator',
    description: 'Interactive Markdown technical documentation editor with live HTML preview. Also includes a Markdown table generator, making it easy to create readable tables without manually typing vertical bars (pipes).',
    howToGet: 'Drag a <code>.md</code> file straight onto the editor, paste existing documentation, or start writing from scratch.',
    howToUse: `
      <ol>
        <li>Type text in Markdown format in the left editor panel. On the right side, you will instantly see the rendered preview of the document.</li>
        <li><strong>Loading a file:</strong> Drop a <code>.md</code>, <code>.markdown</code>, <code>.mdx</code> or <code>.txt</code> file anywhere on the editor panel to load it. Other file types are rejected so a stray image cannot overwrite your text.</li>
        <li><strong>Table Generator:</strong> Build the table in the editable grid &mdash; <em>+ Add Row</em> / <em>+ Add Column</em> to grow it, <em>Reset 3x3</em> to start over. Click any header to rename it, and use its ⇤ / ↔ / ⇥ icon to switch the column between left, center and right alignment.</li>
        <li><strong>Import from Excel:</strong> Copy a range in Excel, Google Sheets or a CSV file and paste it into the grid. The table grows to fit the pasted data, starting from the cell you paste into.</li>
        <li>Copy the ready Markdown table with <em>Copy Markdown</em>, or export the rendered document with <em>Export HTML</em> / <em>Copy HTML</em>.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>For beginners:</strong> Markdown is the standard way developers write documentation. Use this to format text easily without needing Word.</li>
        <li><strong>Tables:</strong> Generating markdown tables manually is painful. Paste your data from a spreadsheet instead of typing pipes by hand &mdash; ideal for structured release notes.</li>
      </ul>
    `
  },
  'xpath-builder': {
    title: 'XPath Formatter',
    description: 'Tool assisting in writing, formatting, and validating XPath queries in the Mendix standard. Formats complex constraints into a readable tree and flags patterns that hurt database performance.',
    howToGet: 'Get the XPath query directly from the properties of a <em>Retrieve</em> action from the database in Mendix Studio Pro or from entity Access Rules.',
    howToUse: `
      <ol>
        <li>Paste your XPath query into the editor window.</li>
        <li>Click <strong>Format</strong>. A complex, multi-line query with multiple logical operators will be formatted into a readable indentation tree.</li>
        <li>Review the analysis and linter notices below the editor &mdash; they point out index-blocking functions, negations, and deep association hops before they reach production.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>For beginners:</strong> Avoid using <code>contains()</code> or <code>or</code> in your XPath if possible, as they usually cause database performance issues (table scans).</li>
        <li><strong>Deep paths:</strong> Be careful with long XPath associations (e.g. <code>/Module.Entity1/Module.Entity2/Module.Entity3</code>). They translate to multiple SQL JOINs and can slow down your app significantly.</li>
      </ul>
    `
  },
  'query-intelligence-formatter': {
    title: 'OQL Formatter',
    description: 'A tool to format complex Mendix OQL (Object Query Language) queries to improve their readability and structure.',
    howToGet: `
      <ul>
        <li>You can retrieve OQL queries from Mendix application logs by setting the <code>OQL</code> log node to <code>DEBUG</code> level.</li>
        <li>Alternatively, copy OQL queries from the dataset configurations in Report modules.</li>
      </ul>
    `,
    howToUse: `
      <ol>
        <li>Paste your raw OQL query into the input field.</li>
        <li>Click <strong>Format</strong> or type/edit the query. It will be formatted and syntax-highlighted automatically.</li>
        <li>Click <strong>Copy</strong> to copy the clean, formatted OQL query back to your clipboard.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>For beginners:</strong> OQL is Mendix\'s version of SQL. Formatting helps you understand what data is being fetched and joined.</li>
        <li><strong>Optimization:</strong> Formatting the query visually exposes missing WHERE clauses that could lead to large data retrievals.</li>
      </ul>
    `
  },
  'query-intelligence-translator': {
    title: 'OQL &rarr; SQL Translator',
    description: 'Translates Mendix OQL query syntax to raw PostgreSQL SQL query syntax, and vice versa. It maps entity paths to standard SQL syntax and replaces Mendix system tokens.',
    howToGet: `
      <ul>
        <li>Copy OQL queries from logs or Mendix Studio Pro microflows (OQL actions).</li>
        <li>Or, copy PostgreSQL queries from database profiling tools to translate back into OQL.</li>
      </ul>
    `,
    howToUse: `
      <ol>
        <li>Select the translation direction using the dropdown: <strong>OQL &rarr; SQL (Postgres)</strong> or <strong>SQL &rarr; OQL</strong>.</li>
        <li>Paste the source query into the input field. The translation will happen automatically.</li>
        <li>Copy the translated query from the output field.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>Approximate translation:</strong> This tool performs token-level substitution (entity paths <code>Module.Entity</code> &harr; <code>module$entity</code>, CAST type names, and system tokens like <code>[%CurrentDateTime%]</code>). It does <strong>not</strong> convert Mendix association traversals into SQL JOINs. Always review the output before running it against a real database.</li>
        <li><strong>For beginners:</strong> Helps bridge the gap between database admin tools (SQL) and Mendix logic (OQL).</li>
        <li><strong>Migration:</strong> Useful as a starting point when migrating pure SQL queries into Mendix OQL reporting datasets.</li>
      </ul>
    `
  },
  'query-intelligence-explain': {
    title: 'SQL Explain Plan Visualizer',
    description: 'Analyzes and visualizes PostgreSQL execution plans (EXPLAIN outputs) to help you find bottlenecks, sequence scans, and missing indexes.',
    howToGet: `
      <p>There are two ways to obtain a PostgreSQL execution plan:</p>
      <ul>
        <li>
          <strong>Option 1 (Directly from Mendix Logs - Recommended):</strong>
          <ol>
            <li>In Mendix Studio Pro, go to the <strong>Console</strong>.</li>
            <li>Click on <strong>Advanced</strong> > <strong>Set Log Levels...</strong>.</li>
            <li>Locate the <strong>DataStorage_QueryPlan</strong> log node and set its level to <code>DEBUG</code> or <code>TRACE</code>.</li>
            <li>Run the action that triggers the database query. Mendix will automatically execute an EXPLAIN query and log the resulting plan to the console.</li>
            <li>Copy the logged plan text.</li>
          </ol>
        </li>
        <li>
          <strong>Option 2 (Using a Database Client):</strong>
          <ol>
            <li>Connect to your Mendix PostgreSQL database using a DB client (e.g., pgAdmin, DBeaver).</li>
            <li>Prepend your SQL query with <code>EXPLAIN (ANALYZE, COSTS, VERBOSE, BUFFERS, FORMAT TEXT)</code> (or simply <code>EXPLAIN ANALYZE</code>) and execute it.</li>
            <li>Copy the resulting text output of the execution plan.</li>
          </ol>
        </li>
      </ul>
    `,
    howToUse: `
      <ol>
        <li>Paste the copied PostgreSQL EXPLAIN plan text into the input area.</li>
        <li>Click <strong>Visualize Query Plan</strong>.</li>
        <li>Review the generated visual tree:
          <ul>
            <li><strong style="color:var(--danger)">Seq Scan (Red):</strong> Table scan. Database is reading all rows. Consider adding indexes.</li>
            <li><strong style="color:var(--success)">Index Scan (Green):</strong> Optimal. The database uses an index to locate rows.</li>
          </ul>
        </li>
      </ol>
    `
  },
  'query-intelligence-schema': {
    title: 'OQL Schema Visualizer',
    description: 'Generates a visual diagram of your Mendix entities and their association relationships directly from an OQL query.',
    howToGet: `
      <p>Paste any OQL query containing <code>FROM</code> and <code>JOIN</code> statements connecting Mendix entities (e.g. <code>MyModule.Customer</code>).</p>
    `,
    howToUse: `
      <ol>
        <li>Paste the OQL query into the query textarea.</li>
        <li>The tool will automatically parse the entity paths (e.g., <code>Module.Entity</code>) and relationships.</li>
        <li>It will render a visual model showing the extracted entities grouped by Mendix Module and connected based on the OQL join conditions.</li>
      </ol>
    `
  },
  'odata-builder': {
    title: 'OData Query Builder',
    description: 'Convenient OData query generator (v3/v4 standard) for communicating with Mendix Published OData Services. Structured form fields for filters, sorting, and pagination eliminate syntax errors in hand-written URLs.',
    howToGet: 'Get the base URL of the OData service published in your Mendix application (e.g., <code>https://myapp.mendixcloud.com/odata/v1/</code>) and familiarize yourself with the entity names in the service.',
    howToUse: `
      <ol>
        <li>Enter the service base URL and the resource name (Entity Set).</li>
        <li>Add filters in the builder (e.g., <code>Age gt 18</code>, <code>Status eq 'Active'</code>), select fields to retrieve ($select) and sort order ($orderby).</li>
        <li>The tool will generate a full, correctly encoded query URL that you can paste into a browser, Postman, or integration configuration in Mendix.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>For beginners:</strong> OData query syntax is tricky (e.g. using <code>eq</code> instead of <code>=</code>). Use this builder to avoid frustrating syntax errors.</li>
        <li><strong>Performance:</strong> Always use <code>$select</code> to only fetch the columns you need, and <code>$top</code> to limit results, preventing server overload.</li>
      </ul>
    `
  },

  'architecture': {
    title: 'Domain Model & Architecture Diagrammer',
    description: 'Tool for rapid visualization of architecture and database relationships using text code and Mermaid diagrams. Allows you to instantly draw a Domain Model without using heavy graphic tools.',
    howToGet: `
      <p>Describe entities and relationships in simple pseudo-code (or paste a JSON schema with <code>entities</code> / <code>associations</code>):</p>
      <pre style="background:var(--bg-elevated);padding:var(--sp-2);border-radius:var(--r-sm);font-size:0.78rem">Customer
  Name: String
  Email: String

Order
  Total: Decimal

Customer [1] -- [*] Order : places</pre>
      <p>Supported relation forms: <code>A -> B : label</code> and <code>A [1] -- [*] B : label</code> (cardinalities are shown on the diagram).</p>
    `,
    howToUse: `
      <ol>
        <li>Type entities and their connections in the text editor on the left, then click <strong>Generate Diagram</strong>.</li>
        <li>A class diagram renders on the right side.</li>
        <li>Use <strong>Download SVG</strong> to save the diagram as a vector file, or <strong>Copy Mermaid</strong> to paste the diagram code into project documentation (e.g., GitHub / Confluence).</li>
      </ol>
    `
  },
  'dev-studio': {
    title: 'Mendix Developer Studio Connector',
    description: 'Local inspector for a Mendix project running on your machine. Via the Observability Bridge it reads the project configuration and presents a dashboard: database settings and live metrics, user roles, request handlers, scheduled events, constants, client bundle size, and Java code quality hints.',
    howToGet: `
      <ul>
        <li>Run your project locally in Mendix Studio Pro.</li>
        <li>Make sure the local bridge is running (<code>Start-MxDevSwissTool.bat</code> or <code>node server/mendix-observability-bridge.js</code>) &mdash; the topbar indicator should show <strong>Bridge Online</strong>. If Node.js is not installed on your machine, the launcher offers to download a portable copy (no admin rights needed).</li>
        <li><strong>Live PostgreSQL metrics only:</strong> this feature requires the optional <code>pg</code> module &mdash; run <code>npm install pg</code> once in the tool directory and restart the bridge. Everything else works without it.</li>
      </ul>
    `,
    howToUse: `
      <ol>
        <li>The tool automatically detects running Mendix projects &mdash; pick one from the <strong>Detected Mendix Projects</strong> list, or type the project root path manually (e.g., <code>C:\\Mendix_Projects\\MyApp</code>).</li>
        <li>Click <strong>Connect to Application</strong>.</li>
        <li>The dashboard loads: application &amp; database configuration, live PostgreSQL metrics, security roles, request handlers, scheduled events, and application constants.</li>
      </ol>
    `
  },
  'perf-lab': {
    title: 'Performance Lab (Load Tester)',
    description: 'Lightweight tool for conducting load tests (Load Testing) and performance analysis of selected endpoints (REST API, SOAP, HTML pages) directly from the browser. Measures response times and generates latency statistics.',
    howToGet: 'The URL address of the web service (e.g., Published REST Service in Mendix) and optional authorization data (Basic Auth, API tokens).',
    howToUse: `
      <ol>
        <li>Enter the tested URL and select the request method (GET, POST, etc.).</li>
        <li><strong>Headers & Body:</strong> Specify request headers (e.g., <code>{"Content-Type": "application/json"}</code>) and request body in JSON format.</li>
        <li><strong>Test Parameters:</strong> Set the number of concurrent connections (Threads) and the total number of requests.</li>
        <li><strong>Engine Selection:</strong> Choose <strong>Browser (Fetch)</strong> for simple requests, or <strong>Server (Turbo)</strong> to bypass browser CORS and connection limits (requires running <code>node mendix-observability-bridge.js</code>).</li>
        <li><strong>Presets:</strong> Use <em>Save Preset</em> and <em>Load Preset</em> buttons to store your frequently used test configurations.</li>
        <li>Click <strong>Start Load Test</strong>. The tool will begin sending requests in the background and draw a latency chart in real-time. You can pause the test at any time using the <strong>Stop</strong> button.</li>
        <li>After the test, click <strong>Export CSV</strong> to download the raw latency data for further analysis.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>p50 Response Time (Median):</strong> Average response time for half of the users. Should oscillate below 200 ms.</li>
        <li><strong>p99 Response Time:</strong> Metric for the 1% slowest requests. If p99 is drastically higher than p50 (e.g., 5 seconds vs 100 ms), the Mendix application might have issues with occasional thread blocking, database locking, or long Garbage Collector pauses.</li>
        <li><strong>Error Rate:</strong> Appearance of network errors or 5xx statuses under higher load suggests the application has reached its performance limit (e.g., CPU overload or database connection pool exhaustion).</li>
      </ul>
    `
  },

  'mock-server': {
    title: 'Mock Server & Chaos Engineering',
    description: 'A fully functional local Mock Server that allows you to simulate external API responses and test Chaos Engineering (intentionally introducing network faults). This tool works in tandem with the Mendix Observability Bridge to expose a real HTTP endpoint on your localhost.',
    howToGet: 'Before using this tool, you must start the local bridge by running <code>node mendix-observability-bridge.js</code> in your terminal. Once running, you can configure your Mendix <em>Call REST</em> actions to send requests to <code>http://localhost:9999/mock</code>.',
    howToUse: `
      <ol>
        <li><strong>Response Payload:</strong> Enter the JSON or XML that you want the simulated API to return to your Mendix application.</li>
        <li><strong>HTTP Status:</strong> This represents the server's response code. It defaults to <code>200 OK</code> (which means the request was successful). You can change this to simulate different scenarios. Common codes include:
          <ul>
            <li><code>400 Bad Request</code> (Client sent invalid data)</li>
            <li><code>401 Unauthorized</code> (Authentication failed)</li>
            <li><code>404 Not Found</code> (Endpoint doesn't exist)</li>
            <li><code>500 Internal Server Error</code> (Server crashed)</li>
            <li><code>504 Gateway Timeout</code> (Server took too long to respond)</li>
          </ul>
        </li>
        <li><strong>Latency:</strong> Set the base delay in milliseconds (e.g., 200ms) to simulate network travel time.</li>
        <li><strong>Chaos Monkey:</strong> Enable this checkbox to introduce random chaos. When active, some requests will randomly fail with a 500 error or experience huge latency spikes, perfectly mimicking an unstable microservice.</li>
        <li>Click <strong>Activate Responder</strong> to push this configuration to the local bridge server.</li>
        <li>(Optional) Click <strong>Trigger Manual Request</strong> to test the endpoint from your browser before calling it from Mendix.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>What is this for?</strong> You can point your Mendix <em>Call REST</em> actions to <code>http://localhost:9999/mock</code> instead of a real external API. This allows you to safely test how your application behaves under various conditions without needing an internet connection or relying on a third-party server.</li>
        <li><strong>Why is this important?</strong> It teaches you to build resilient applications. If your Mendix app integrates with a CRM system and that CRM goes down or slows down, your app shouldn't crash or freeze. Simulating these failures (Chaos Engineering) ensures you have proper Error Handlers and Timeouts configured in your Mendix REST calls.</li>
      </ul>
    `
  },
  'data-factory': {
    title: 'Data Factory (Mock Data Generator)',
    description: 'Generator of large sets of random, realistic test data (e.g., names, surnames, email addresses, phone numbers, dates, constants). Facilitates the preparation of CSV / JSON / XML files for import into the Mendix application database for performance testing.',
    howToGet: 'The tool generates data randomly based on selected templates. It does not require uploading files.',
    howToUse: `
      <ol>
        <li>Define the schema by adding columns. For each column, select the <strong>Data Type</strong> (e.g., <code>UUID</code>, <code>FullName</code>, <code>Email</code>, <code>Constant</code>) and then specify a custom <strong>Field Name</strong> (which will be used in the exported file).</li>
        <li><em>Tip:</em> Use the drag handle on the left of each row to reorder columns. If you select the <code>Constant</code> type, a third input will appear for you to enter the static value to be applied to every record.</li>
        <li>Select the desired output format (JSON, CSV, or XML).</li>
        <li>Check the live <strong>Sample Preview</strong> panel to immediately see how the first few records will look based on your current schema and format.</li>
        <li>Specify the number of records (e.g., 1000 or 10000 rows).</li>
        <li>Click <strong>Generate Data</strong> and download the generated file to disk. Then import it into Mendix using, for example, the <em>Excel Importer</em> module or a dedicated import action.</li>
      </ol>
    `
  },
  'api-economics': {
    title: 'API Economics Optimizer',
    description: 'Tool analyzing JSON data structures sent over REST APIs. Locates unnecessary data transfer overhead: empty properties (null), repeating key names, excessive whitespace, and suggests specific optimizations to save network transfer.',
    howToGet: 'Copy the JSON response body from a tool like Postman or from Mendix logs (at REST log level TRACE).',
    howToUse: `
      <ol>
        <li>Paste the JSON payload into the text field.</li>
        <li>Click the <strong>Analyze API Payload</strong> button.</li>
        <li>Analyze the results: size reduction rate after minification and a list of fields with default/null values that can be excluded in Mendix Export Mapping in Studio Pro to reduce data size.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>Redundancy Rate:</strong> If it exceeds 30%, it means your API transmits a lot of repeating information or empty fields. Optimizing export mappings (Export Mapping) in Mendix by unchecking empty attributes will bring immediate improvement in loading times on mobile devices.</li>
      </ul>
    `
  },
  'memory-inspector': {
    title: 'Memory Inspector (JVM Heap Analyzer)',
    description: 'Module for analyzing JVM memory statistics and Garbage Collector logs. Facilitates interpreting RAM usage data and finding potential memory leaks in Mendix applications.',
    howToGet: `
      <ul>
        <li>Garbage Collector logs (GC logs) can be downloaded from the Mendix Cloud administration console (Logs → GC Logs tab).</li>
        <li>Heap dump statistics can be obtained through a JVM diagnostic tool (e.g., <code>jmap -histo [PID]</code>).</li>
      </ul>
    `,
    howToUse: `
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
    howToUse: `
      <ol>
        <li>Paste the entire JWT token (three parts separated by dots) into the text field.</li>
        <li>The tool will instantly decode the token and show:
          <br>– <strong>Header:</strong> encryption algorithm and token type.
          <br>– <strong>Payload (Claims):</strong> encoded information about the user, their roles, and permissions.
          <br>– <strong>Expiration Status:</strong> information whether the token is active or expired, along with exact date &amp; time.
        </li>
      </ol>
    `
  },
  'saml-debugger': {
    title: 'SAML / OIDC Debugger',
    description: 'Decodes and inspects SAML Responses/Requests and OIDC id_tokens entirely in your browser. Essential for debugging Single Sign-On (SSO) integrations in Mendix (the SAML SSO and OIDC/OpenID Connect modules) where you must never paste real tokens into public online decoders.',
    howToGet: `
      <ul>
        <li><strong>SAML:</strong> In Chrome/Firefox DevTools open the <strong>Network</strong> tab, enable "Preserve log", and perform a login. Find the POST to your app's ACS endpoint (e.g. <code>/SSO/assertion</code>) and copy the <code>SAMLResponse</code> form field. For the Redirect binding, copy the <code>SAMLRequest</code>/<code>SAMLResponse</code> query parameter from the URL &mdash; URL-encoding and DEFLATE compression are handled automatically.</li>
        <li><strong>OIDC:</strong> Copy the <code>id_token</code> from the token response, or from the Mendix OIDC module logs / browser session. It is a JWT (three dot-separated parts).</li>
      </ul>
    `,
    howToUse: `
      <ol>
        <li>Choose the <strong>SAML Response / Request</strong> or <strong>OIDC id_token</strong> tab.</li>
        <li>Paste the value and click <strong>Decode</strong>.</li>
        <li><strong>SAML:</strong> Review the formatted XML on the left and the parsed summary on the right &mdash; issuer, subject (NameID), audience, the validity window (NotBefore / NotOnOrAfter with live status), attributes, and whether a signature is present.</li>
        <li><strong>OIDC:</strong> Review the decoded header and claims with inline explanations and expiry status.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>"not valid yet" / "expired":</strong> The most common SSO failure is clock skew between the IdP and the Mendix server. If NotBefore is in the future or NotOnOrAfter is in the past by a few minutes, sync the server clocks (NTP).</li>
        <li><strong>Audience mismatch:</strong> The <code>Audience</code> (SAML) or <code>aud</code> (OIDC) must match your app's Entity ID / client_id exactly. A mismatch is rejected even when everything else is valid.</li>
        <li><strong>No signature found:</strong> Mendix's SAML module requires signed assertions/responses by default. If no <code>ds:Signature</code> is present, check the IdP signing configuration.</li>
        <li><strong>Security note:</strong> This tool decodes and inspects only &mdash; it does <strong>not</strong> cryptographically verify the signature. Never trust an assertion based on decoding alone; signature validation happens in the Mendix runtime.</li>
      </ul>
    `
  },
  'hash-gen': {
    title: 'Hash Generator',
    description: 'Local generator of checksums and cryptographic hashes. Supports SHA-256, SHA-512, and SHA-1 (MD5 is deprecated and not available in browser WebCrypto). Useful for verifying file integrity, generating unique object keys, or testing authorization mechanisms in Mendix.',
    howToGet: 'Type the text string, or drag &amp; drop a file onto the input if you need to verify its integrity.',
    howToUse: `
      <ol>
        <li>Enter text in the input field, or drop a file onto it to hash the file contents.</li>
        <li>Hashes for all available cryptographic algorithms will be generated and displayed automatically below.</li>
        <li>Optionally paste an expected hash into the <strong>Compare Hash</strong> field &mdash; the tool marks the matching algorithm with <strong>MATCH</strong> / <strong>MISMATCH</strong>.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>For beginners:</strong> Hashing is a one-way street. It turns any text into a fixed-length string. If even one letter changes, the hash changes completely. Useful for verifying file integrity.</li>
        <li><strong>Security:</strong> MD5 and SHA-1 are considered broken for security purposes. Always use SHA-256 or SHA-512 for hashing sensitive data like passwords or tokens.</li>
      </ul>
    `
  },
  'regex-tester': {
    title: 'Java Regex Tester (Mendix)',
    description: 'Dedicated tool for testing Regular Expressions (Regex). It works based on Java regular expression engine rules (which is directly used by Mendix Runtime e.g., in attribute validation functions and in the <code>isMatch()</code> function in Microflows).',
    howToGet: 'Prepare a regular expression you want to test (e.g., zip code validator, tax ID) and test text.',
    howToUse: `
      <ol>
        <li>Enter the Regex pattern in the top field (e.g., <code>^\\d{2}-\\d{3}$</code> for Polish zip codes).</li>
        <li>Enter test text in the bottom field.</li>
        <li>The tool will instantly highlight matching text fragments and inform about potential syntax errors in the Java regular expression engine.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>Full String Match:</strong> Mendix's <code>isMatch()</code> requires the <strong>entire</strong> text to match the pattern. Enabling "Simulate isMatch()" simulates this by anchoring the pattern.</li>
        <li><strong>Multiline Testing:</strong> Because the tool has the <code>m</code> (multiline) flag enabled by default, it evaluates each line independently. This allows you to conveniently test multiple examples (one per line) simultaneously. To strictly simulate Mendix (which treats the whole multi-line text as a single string block), remove the <code>m</code> flag from the flags input.</li>
        <li><strong>Engine Differences:</strong> This tool uses the browser's JS engine. Some Java-specific regex features (like possessive quantifiers <code>.*+</code> or inline flags like <code>(?x)</code>) are not supported in JS and cannot be simulated here.</li>
      </ul>
    `
  },
  'timestamp': {
    title: 'Timestamp & Date Converter',
    description: 'Used for quick conversion of timestamps (Unix Timestamp in seconds or milliseconds) to readable calendar dates in various time zones (UTC, user local zone) and vice-versa. Useful for analyzing raw data in the Mendix database, where dates and times are often stored as numbers (Epoch).',
    howToGet: 'Get the numeric timestamp value from the database (e.g., <code>1719878400000</code>) or copy from a system log.',
    howToUse: `
      <ol>
        <li><strong>Convert to Date:</strong> Enter the timestamp value (seconds or milliseconds). The tool will instantly calculate and display the calendar date.</li>
        <li><strong>Convert to Timestamp:</strong> Select a date and time from the calendar to generate the corresponding Unix Epoch timestamp.</li>
        <li><strong>Scheduled Event Preview:</strong> Enter a recurrence (daily / weekly / every N hours or minutes) and whether it is configured in UTC or local time. The tool lists the next 10 runs in both UTC and your local timezone, flagging Daylight Saving shifts.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>UTC vs local:</strong> Mendix Cloud executes scheduled events in UTC. A "daily at 03:00" event configured as UTC fires at a different local wall-clock time depending on your timezone &mdash; use the preview to confirm it runs when the business expects.</li>
        <li><strong>DST shift flag:</strong> When a local-time run crosses a Daylight Saving boundary, the preview marks it. A "23:00 local" report can drift by an hour twice a year if the schedule is pinned to UTC.</li>
      </ul>
    `
  },
  'log-anonymizer': {
    title: 'Log & Text Anonymizer',
    description: 'Anonymizes sensitive data from any arbitrary text, JSON payloads, or Mendix logs before sharing them externally.',
    howToGet: 'Simply paste your Mendix log file content or drag and drop the log file into the tool.',
    howToUse: `
      <ol>
        <li>Select the types of data you want to anonymize (UUIDs, IP addresses, Emails, Mendix IDs, MAC Addresses, Credit Cards, Auth Tokens including AWS access keys, generic API keys, passwords embedded in URLs, and <code>Set-Cookie</code>/<code>Cookie</code> headers).</li>
        <li>Check "Consistent Masking (Pseudonymization)" to securely map identical values to the same pseudonym across the entire log (e.g. replacing the same email with [EMAIL-1] everywhere) to maintain traceability.</li>
        <li>You can also provide custom keywords (e.g., your company name or secret project names) to be redacted, and custom regex patterns (one per line, e.g. <code>ORD-\\d{6}</code>) for internal identifier formats the built-in rules don't know.</li>
        <li>Click Run or enable Auto-run to see the cleaned logs instantly.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>Enterprise standard:</strong> Never share raw logs publicly! This tool prevents Data Loss (DLP) by scrubbing personal, authentication, and network data locally in your browser.</li>
        <li><strong>Consistent Masking:</strong> Enables tracking a user session without knowing their actual identity.</li>
        <li><strong>Custom Keywords:</strong> Use this to hide proprietary table names or module names that might reveal your business logic.</li>
        <li><strong>Not exhaustive:</strong> The pattern list above covers the most common secret formats but cannot catch every possible secret shape (e.g. custom-formatted internal tokens). Always review the anonymized output yourself before sharing it externally, and add custom keywords for anything the built-in patterns might miss.</li>
      </ul>
    `
  },
  'password-generator': {
    title: 'Password Generator',
    description: 'Generates secure, complex passwords for database accounts, API keys, or MxAdmin credentials.',
    howToGet: 'Works locally in your browser. No input data required.',
    howToUse: `
      <ol>
        <li>Adjust the password length (default is usually secure enough for most systems).</li>
        <li>Toggle options for Uppercase, Lowercase, Numbers, and Symbols depending on the target system\'s requirements.</li>
        <li>Click Generate and copy the result.</li>
      </ol>
    `,
    interpretation: `
      <ul>
        <li><strong>Mendix Cloud:</strong> When setting up a new environment, use this to generate a 32+ character password for MxAdmin.</li>
        <li><strong>Database integrations:</strong> Some legacy databases have restrictions on certain symbols. You can disable symbols if your connection string fails.</li>
      </ul>
    `
  }
};

// ============================================================
// MODAL CONTROLLER FUNCTIONS
// ============================================================

function showActiveToolHelp() {
  let toolId = typeof window.currentTool !== 'undefined' ? window.currentTool : 'home';
  if (toolId === 'home') return;

  if (toolId === 'log-viewer') {
    const activeTab = document.querySelector('#panel-log-viewer .tabs .tab.active');
    toolId = (activeTab && activeTab.dataset.helpKey) || 'log-viewer-stream';
  }

  if (toolId === 'query-intelligence') {
    const activeTab = document.querySelector('#panel-query-intelligence .tabs .tab.active');
    toolId = (activeTab && activeTab.dataset.helpKey) || 'query-intelligence-formatter';
  }

  if (toolId === 'thread-dump') {
    const activeTab = document.querySelector('#panel-thread-dump .tabs .tab.active');
    toolId = (activeTab && activeTab.dataset.helpKey) || 'thread-dump';
  }

  const helpData = TOOLS_HELP[toolId];
  if (!helpData) {
    alert('Help for this module is currently under construction.');
    return;
  }

  // Populate title
  document.getElementById('help-modal-title').textContent = 'Help: ' + helpData.title;

  // Build body HTML dynamically using premium styled blocks
  let html = '';

  // 1. Description
  html += `
    <div class="help-section">
      <div style="display:flex; align-items:center; gap:var(--sp-2); margin-bottom:var(--sp-2); font-weight:600; color:var(--accent);">
        <span style="display:flex;align-items:center;"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg></span> About this module and its purpose
      </div>
      <p style="color:var(--text-secondary); margin:0; font-size:0.85rem; line-height:1.6;">${helpData.description}</p>
    </div>
  `;

  // 2. How to get/prepare data
  if (helpData.howToGet) {
    html += `
      <div class="help-section" style="background:var(--bg-elevated); padding:var(--sp-4); border-radius:var(--r-md); border:1px solid var(--border);">
        <div style="display:flex; align-items:center; gap:var(--sp-2); margin-bottom:var(--sp-2); font-weight:600; color:var(--info);">
          <span style="display:flex;align-items:center;"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg></span> How to obtain / prepare input data
        </div>
        <div style="color:var(--text-secondary); margin:0; font-size:0.85rem; line-height:1.6;">${helpData.howToGet}</div>
      </div>
    `;
  }

  // 3. How to use
  if (helpData.howToUse) {
    html += `
      <div class="help-section">
        <div style="display:flex; align-items:center; gap:var(--sp-2); margin-bottom:var(--sp-2); font-weight:600; color:var(--success);">
          <span style="display:flex;align-items:center;"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg></span> Step-by-step instructions
        </div>
        <div style="color:var(--text-secondary); margin:0; font-size:0.85rem; line-height:1.6;">${helpData.howToUse}</div>
      </div>
    `;
  }

  // 4. Interpretation (if exists)
  if (helpData.interpretation) {
    html += `
      <div class="help-section" style="background:color-mix(in srgb, var(--warning) 8%, transparent); padding:var(--sp-4); border-radius:var(--r-md); border:1px solid color-mix(in srgb, var(--warning) 30%, transparent);">
        <div style="display:flex; align-items:center; gap:var(--sp-2); margin-bottom:var(--sp-2); font-weight:600; color:var(--warning);">
          <span style="display:flex;align-items:center;"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg></span> Result interpretation and developer tips
        </div>
        <div style="color:var(--text-secondary); margin:0; font-size:0.85rem; line-height:1.6;">${helpData.interpretation}</div>
      </div>
    `;
  }

  document.getElementById('help-modal-body').innerHTML = html;

  // Open modal
  const overlay = document.getElementById('help-modal');
  if (overlay) overlay.classList.add('active');
}

function closeHelpModal() {
  const overlay = document.getElementById('help-modal');
  if (overlay) overlay.classList.remove('active');
}

// Add Escape key handler
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeHelpModal();
  }
});


window.showActiveToolHelp = showActiveToolHelp;
window.closeHelpModal = closeHelpModal;
export function init() {}
