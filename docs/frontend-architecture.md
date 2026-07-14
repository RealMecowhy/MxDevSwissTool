# Frontend Architecture & ES Module Migration Guide

## Current State (Legacy)
Historically, the MxDev Swiss Tool frontend relied on global variables attached to the `window` object to register tool functionalities and state. Tools were written as plain scripts where functions like `tsConvert()` were globally accessible, allowing inline event handlers in `index.html` (e.g. `onclick="tsConvert()"`).

This approach led to:
- Namespace pollution and collision risks
- Difficulty in linting and tracking dependencies
- Implicit coupling between tools and the core system

## New Architecture (ES Modules)
To ensure scalability, maintainability, and clean code boundaries, we are migrating the frontend tools to **ES Modules**.

### Standards for Tool Migration:
1. **No Global Variables**: Tools must not attach variables or functions to the `window` object unless absolutely necessary for external vendor libraries.
2. **Explicit Exports**: Tools should expose an `init()` function (and any other necessary lifecycle hooks) via `export`.
3. **Event Delegation**: Inline HTML event handlers (`onclick`, `oninput`) must be removed from `index.html`. Instead, elements should be given descriptive `id` attributes, and event listeners should be attached dynamically within the tool's `init()` function.
4. **Dependency Imports**: If a tool relies on shared utilities (like `escHtml` or `copyToClipboard`), those should ideally be imported from a shared `utilities.js` module. (During transition, using `window.escHtml` is an acceptable temporary bridge to satisfy linters until `utilities.js` is fully modularized).

### Migration Example (Proof of Concept)
The `timestamp.js` tool was successfully migrated as a Proof of Concept:
1. **HTML Updates**: 
   - `onclick="tsSetNow()"` was replaced with `id="ts-btn-now"`.
   - `oninput="tsConvert()"` was removed, and an `id="ts-input"` was utilized.
2. **JavaScript Updates**:
   - Removed `window.tsConvert = tsConvert;`.
   - Implemented `export function init() { ... }` which grabs DOM elements by ID and attaches `addEventListener('click', ...)` and `addEventListener('input', ...)`.
3. **Core Registry**:
   - `core.js` automatically imports the tools via `import * as tool from './tools/tool.js'`. When a tool is selected, it can invoke `tool.init()` if provided.

This architectural shift paves the way for better testing, cleaner code, and fewer linting errors (eliminating "function not defined" issues in CI).

## UI Conventions

Following the UX/UI audit (`_local_assets/MxDevSwissTool-Audyt-UX-UI.md`), the following placement rules apply to all tool panels going forward:

1. **Auto-processing dual-pane tools** (paste input on one side, formatted/transformed output on the other, re-processing on every keystroke — e.g. JSON/XML/SQL Formatter, Character Sanitizer, XPath Formatter): helper actions (Format/Minify/Clear/Copy) live inside each pane's own `.json-pane-header`, not in `.tool-header-actions`. This keeps an action scoped to the pane it affects.
2. **Manual "run analysis/generation" tools** (the user must click something before anything happens — e.g. Memory Inspector, Mock Server & Chaos, Performance Lab, API Economics, Architecture, Thread Dump Analyzer, WASM Profiler, Query Intelligence Suite, OData Builder): exactly one `btn-primary` lives in `.tool-header-actions`, positioned last (rightmost). Do not bury the primary action inside the panel body.
   - **Exception:** Data Factory intentionally keeps its "Generate Data" button attached to step 2 of its numbered wizard (1/2/3) — the multi-step schema-builder flow justifies this deviation.
3. **Multi-button toolbars** (several actions available at once, e.g. Log Viewer, Log Anonymizer, Nginx Log Analyzer, Telemetry Monitor): the single primary action is always last/rightmost in `.tool-header-actions`; every other button is `btn-secondary`/`btn-ghost`. Never have two `btn-primary` buttons visible in the same toolbar at once.
