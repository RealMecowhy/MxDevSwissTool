# MxDev Swiss Tool

The **MxDev Swiss Tool** is an offline-first, all-in-one developer toolkit designed specifically for Mendix developers. It runs entirely locally in your browser to guarantee 100% data privacy—ensuring you never have to paste sensitive client logs, database queries, or authorization tokens into public web utilities.

![MxDev Swiss Tool Home](assets/screenshot-home.png)

---

## ⚡ Quick Start

1. **Download** the latest `MxDevSwissTool-Release-*.zip` from the [Releases page](https://github.com/RealMecowhy/MxDevSwissTool/releases/latest) — it's listed under **Assets** (don't use the "Source code" links).
2. **Extract** the ZIP to any folder — Desktop or Documents is fine, no admin rights needed.
3. **Run** `Start-MxDevSwissTool.bat` (double-click). The tool opens automatically in your default browser.

No Node.js installed? No problem — the launcher offers to download a portable one for you. If Windows shows a security warning on first launch, choose **More info → Run anyway**. Details and alternatives in [How to Run the Application](#-how-to-run-the-application).

---

## 🛠️ Included Tools & Features

The toolkit is divided into logical categories to assist you across the entire development and diagnostic lifecycle:

### 1. Diagnostics & Logs
* **Mendix Log Viewer**: Tail, search, and filter Mendix logs with time-range filtering, error aggregation, and interactive Sequence/Gantt chart visualization. Reads both Mendix Cloud live logs (`.txt`/`.log`/`.gz`) and Studio Pro CSV exports.
  ![Mendix Log Viewer](assets/screenshot-log-viewer.png)
* **Log & Text Anonymizer**: Automatically strip sensitive PII (emails, IPs, UUIDs, custom keywords) from logs before sharing them with support.
* **Log Query Extractor**: Extract, parse, and correlate executed SQL, OQL, and XPath queries from Mendix TRACE logs, complete with parameter binding. Live filter stats (total/avg/slowest time, duplicates), a "Slow only > X ms" filter, and CSV/Markdown export of the filtered list. Also ingests slow-query warnings (`ConnectionBus_Queries`) that Mendix logs at default levels — a production performance signal with zero configuration, picked up from CSV exports and Cloud live logs alike. A shared, single-pass parser reads both formats and runs off the main thread (Web Worker) so even 100 MB+ TRACE logs load without freezing the UI.
  ![Log Query Extractor](assets/screenshot-log-query-extractor.png)
* **Microflow Tracer**: Rebuild microflow executions from `MicroflowEngine` logs — exact durations from DEBUG records, activity-by-activity timelines and sub-microflow call trees from TRACE. Aggregate per-microflow view (calls / total / avg / max) finds hot paths in seconds, recursion gets flagged, and a "Queries in window" jump opens the Log Query Extractor filtered to the SQL that ran inside the selected execution — one log file powers both tools. Reads Studio Pro CSV exports and Mendix Cloud live logs; a real 69 MB production log parses in ~2 s without freezing the UI.
  ![Microflow Tracer](assets/screenshot-microflow-tracer.png)
* **Nginx Log Analyzer**: Analyze access logs to identify top IPs, request paths, status codes, and response times, with optional IP geolocation mapping.
  ![Nginx Log Analyzer](assets/screenshot-nginx-analyzer.png)
* **Client Traffic Analyzer (HAR)**: Decode a browser HAR into named Mendix client operations (microflows, XPath retrieves) to spot client-side N+1 patterns, chatty microflows, and oversized responses that raw DevTools can't surface.
  ![Client Traffic Analyzer](assets/screenshot-har-analyzer.png)
* **Metrics & Telemetry**: Visualize Mendix Prometheus metrics (heap, threads, request rate, database queries) as live dashboards and explore OpenTelemetry traces/logs, locally or from cloud endpoints. Includes a sandbox mode for exploring without a running app.
  ![Metrics & Telemetry](assets/screenshot-telemetry.png)
* **JVM Health Analyzer**: Analyze JVM thread dumps, garbage collector logs, and heap histograms to locate blocked threads, diagnose GC pauses, and spot memory leaks.
  ![JVM Health Analyzer](assets/screenshot-thread-dump.png)
* **HTTP Status Codes**: A searchable status code reference with Mendix-specific context.

### 2. Performance & Testing
* **Performance Lab**: Simulate concurrent load on Mendix HTTP/REST endpoints with real-time latency tracking and statistics (min/avg/max and p50/p95/p99 percentiles).
* **Mock Server & Chaos Engineering**: Simulate external REST endpoints with configurable mock responses, artificial latency, and injected connection errors (5xx, timeouts).
  ![Mock Server](assets/screenshot-mock-server.png)
* **Data Factory**: A high-volume mock data generator (JSON/CSV) to generate realistic test data based on configurable schemas.
  ![Data Factory](assets/screenshot-data-factory.png)

### 3. Data & Formatting
* **JSON / XML Formatters**: Format, validate, and explore payloads with interactive tree views.
  ![JSON Formatter](assets/screenshot-json-formatter.png)
* **SQL Formatter**: Format and highlight complex ORM-generated database queries.
* **Base64 / URL Encoder**: Encode and decode strings and HTML entities locally.
* **XML & Text Sanitizer**: Detect and clean hidden control characters, zero-width spaces, and Mojibake.
* **XPath Formatter (Linter)**: Format Mendix XPath constraints and lint them for index-blocking patterns before they hit the database.
  ![XPath Formatter](assets/screenshot-xpath-builder.png)
* **Text Diff**: Compare two text blocks or code side-by-side with differences highlighted.
  ![Text Diff](assets/screenshot-text-diff.png)
* **Markdown Editor & Table Generator**: Write module documentation with a live HTML preview — drop a `.md` file straight onto the editor to load it. The table generator turns a range pasted from Excel, Google Sheets, or a CSV into a ready Markdown table, with per-column alignment and no hand-typed pipes.

### 4. Mendix Platform Utilities
* **Query Intelligence Suite**: A consolidated query workbench — OQL formatter, OQL ↔ SQL translator, PostgreSQL EXPLAIN plan visualizer with index suggestions, and a schema visualizer that draws entities and associations from an OQL query.
  ![Query Intelligence Suite](assets/screenshot-query-intelligence.png)
* **OData Query Builder**: Build correct OData v3/v4 queries for Published OData Services without hand-crafting URLs.
* **Domain Model & Architecture Visualizer**: Generate Mermaid.js class diagrams from Domain Model JSON schemas or pseudocode.
* **Developer Studio**: A dashboard for your locally running Studio Pro project via the Observability Bridge — configuration, user roles, request handlers, scheduled events, constants, and client bundle size.
* **API Economics**: Analyze JSON payloads to cut response size and spot redundant fields.

### 5. Security & Utilities
* **JWT Decoder**: Inspect JWT tokens securely without transmitting them externally.
  ![JWT Decoder](assets/screenshot-jwt-decoder.png)
* **SAML / OIDC Debugger**: Decode SAML responses/requests (Base64, URL-encoded or DEFLATE-compressed) and OIDC id_tokens locally to debug SSO integrations — inspect assertions, claims, and validity windows without pasting tokens online.
  ![SAML / OIDC Debugger](assets/screenshot-saml-debugger.png)
* **Hash / Password Generators**: Generate strong passwords and cryptographic hashes (SHA-256, SHA-512) locally.
* **Java Regex Tester (Mendix)**: Evaluate regular expressions against the Java regex engine — exactly how Mendix validates them at runtime.
* **Timestamp Converter**: Convert between Unix epochs, ISO 8601, and local timezone formats.

---

## 🧭 Getting Around

* **Welcome tour**: on the very first launch a short onboarding modal introduces the essentials below; reopen it anytime via the **Welcome tour** button on the Home screen.
* **Built-in help**: every tool has a **Help** button in the top bar explaining what it does and, where relevant, how to extract the input data (e.g. a HAR from browser DevTools or TRACE logs from Mendix).
* **Favorites**: click the ☆ star next to a tool's name (or on its Home card) to pin it to the top of the Home screen.
* **Command palette**: press **Ctrl+K** to jump to any tool by name.

---

## 🔒 Data Privacy First

This application is built with a strict **local-first** philosophy:
* All formatters, generators, decoders, and parsers execute completely within your browser.
* No data is uploaded to external servers.
* The local Node.js bridge server only acts as a read-only reader for local log files and database details on your machine.

---

## 🚀 How to Run the Application

**First time here?** Download and extract the release ZIP first — see [Quick Start](#-quick-start) at the top.

### 1. Default (Recommended)
Simply double-click the `Start-MxDevSwissTool.bat` file in the project root directory. This starts the local bridge server and automatically launches the tool UI in your default browser.

**No Node.js on your machine?** Not a problem — the launcher detects it and offers to download a portable `node.exe` (official nodejs.org binary, ~90 MB) into a `runtime` folder next to the launcher. No installation and **no admin rights** required, which makes it work on locked-down corporate laptops. If a proxy blocks the download, the launcher prints a short manual fallback: save [node.exe](https://nodejs.org/dist/latest-v24.x/win-x64/node.exe) into the `runtime` folder yourself.

### 2. Manual Command Line
If running `.bat` files is blocked by security policies in your corporate environment (requires Node.js available on `PATH`):
1. Open a terminal in the project directory.
2. Start the bridge server using Node.js:
   ```bash
   npm start
   ```
   *Alternatively, if npm is not configured, run directly:*
   ```bash
   node server/mendix-observability-bridge.js
   ```
3. Open your browser and navigate to: [http://localhost:9999/](http://localhost:9999/)

### 3. Optional: Live PostgreSQL Metrics
The bridge itself starts with **zero npm dependencies** — no `npm install` needed. Only the live PostgreSQL metrics feature requires the `pg` module. To enable it, run this once in the project directory and restart the bridge:
```bash
npm install pg
```
Everything else works without it.

---

## 🔄 Updating

Shortly after startup the tool checks [GitHub Releases](https://github.com/RealMecowhy/MxDevSwissTool/releases) for a newer version (a single anonymous API call; silent when offline or blocked by a proxy). When one exists, a popup shows the release notes of everything you missed and offers two paths:

* **Update now** — the bridge downloads the release ZIP, unpacks it, replaces its own files via a small updater window and restarts. The UI reloads automatically on the new version.
* **Download ZIP** — manual fallback for locked-down machines: grab the ZIP and unpack it over the tool folder, then start the launcher again.

You can also snooze the reminder for a day or skip a version entirely.

**Your local data is safe either way:** favorites, presets and theme live in your browser's storage (not in the tool folder), and the update never touches the `runtime/` folder with portable Node.js.

---

## 📁 Directory Structure

* [public/](file:///c:/Users/mikol/Documents/Antigravity_Projects/MendixTools/public) - Web frontend application interface (HTML, CSS, JS).
* [server/](file:///c:/Users/mikol/Documents/Antigravity_Projects/MendixTools/server) - Local Node.js bridge server (`mendix-observability-bridge.js`).
* [scripts/](file:///c:/Users/mikol/Documents/Antigravity_Projects/MendixTools/scripts) - Build and maintain utility scripts.
* `Start-MxDevSwissTool.bat` - Quick launch script for Windows. Creates an optional `runtime/` folder if you let it download portable Node.js.
