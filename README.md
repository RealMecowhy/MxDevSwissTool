# MxDev Swiss Tool

The **MxDev Swiss Tool** is an offline-first, all-in-one developer toolkit designed specifically for Mendix developers. It runs entirely locally in your browser to guarantee 100% data privacy—ensuring you never have to paste sensitive client logs, database queries, or authorization tokens into public web utilities.

![MxDev Swiss Tool Home](assets/screenshot-home.png)

---

## 🛠️ Included Tools & Features

The toolkit is divided into logical categories to assist you across the entire development and diagnostic lifecycle:

### 1. Diagnostics & Logs
* **Mendix Log Viewer**: Tail, search, and filter Mendix logs with time-range filtering, error aggregation, and interactive Sequence/Gantt chart visualization.
  ![Mendix Log Viewer](assets/screenshot-log-viewer.png)
* **Log & Text Anonymizer**: Automatically strip sensitive PII (emails, IPs, UUIDs, custom keywords) from logs before sharing them with support.
* **Log Query Extractor**: Extract, parse, and correlate executed SQL, OQL, and XPath queries from Mendix TRACE logs, complete with parameter binding.
  ![Log Query Extractor](assets/screenshot-log-query-extractor.png)
* **Nginx Log Analyzer**: Analyze access logs to identify top IPs, request paths, status codes, and response times, with optional IP geolocation mapping.
  ![Nginx Log Analyzer](assets/screenshot-nginx-analyzer.png)
* **Client Traffic Analyzer (HAR)**: Decode a browser HAR into named Mendix client operations (microflows, XPath retrieves) to spot client-side N+1 patterns, chatty microflows, and oversized responses that raw DevTools can't surface.
* **JVM Health Analyzer**: Analyze JVM thread dumps, garbage collector logs, and heap histograms to locate blocked threads, diagnose GC pauses, and spot memory leaks.

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
* **Markdown Editor & Table Generator**: Write module documentation with a live HTML preview — drop a `.md` file straight onto the editor to load it. The table generator turns a range pasted from Excel, Google Sheets, or a CSV into a ready Markdown table, with per-column alignment and no hand-typed pipes.

### 4. Mendix Platform Utilities
* **OData / XPath Query Builders**: Sandboxes to build and test queries with cheat sheets.
  ![XPath Builder](assets/screenshot-xpath-builder.png)
* **Domain Model & Architecture Visualizer**: Generate Mermaid.js class diagrams from Domain Model JSON schemas or pseudocode.
* **OQL / XPath Formatters**: Format and structure database and retrieve constraints.

### 5. Security & Utilities
* **JWT Decoder**: Inspect JWT tokens securely without transmitting them externally.
  ![JWT Decoder](assets/screenshot-jwt-decoder.png)
* **SAML / OIDC Debugger**: Decode SAML responses/requests (Base64, URL-encoded or DEFLATE-compressed) and OIDC id_tokens locally to debug SSO integrations — inspect assertions, claims, and validity windows without pasting tokens online.
* **Hash / Password Generators**: Generate strong passwords and cryptographic hashes (SHA-256, SHA-512) locally.
* **Java Regex Tester**: Evaluate regular expressions using a Java-compatible regex engine.
* **Timestamp Converter**: Convert between Unix epochs, ISO 8601, and local timezone formats.
* **Diff / Text Compare**: Compare two text blocks or code side-by-side with differences highlighted.
  ![Text Diff](assets/screenshot-text-diff.png)

---

## 🔒 Data Privacy First

This application is built with a strict **local-first** philosophy:
* All formatters, generators, decoders, and parsers execute completely within your browser.
* No data is uploaded to external servers.
* The local Node.js bridge server only acts as a read-only reader for local log files and database details on your machine.

---

## 🚀 How to Run the Application

### 1. Default (Recommended)
Simply double-click the `Start-MxDevSwissTool.bat` file in the project root directory. This starts the local bridge server and automatically launches the tool UI in your default browser.

### 2. Manual Command Line
If running `.bat` files is blocked by security policies in your corporate environment:
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

---

## 📁 Directory Structure

* [public/](file:///c:/Users/mikol/Documents/Antigravity_Projects/MendixTools/public) - Web frontend application interface (HTML, CSS, JS).
* [server/](file:///c:/Users/mikol/Documents/Antigravity_Projects/MendixTools/server) - Local Node.js bridge server (`mendix-observability-bridge.js`).
* [scripts/](file:///c:/Users/mikol/Documents/Antigravity_Projects/MendixTools/scripts) - Build and maintain utility scripts.
* `Start-MxDevSwissTool.bat` - Quick launch script for Windows.
