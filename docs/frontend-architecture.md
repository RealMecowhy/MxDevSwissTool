# Frontend Architecture

How the MxDev Swiss Tool frontend is actually built, and why. Written from the
code as it stands, not from a plan for it.

> **History note.** This file used to describe a migration to "clean" ES modules
> with no globals and no inline handlers, illustrated by one tool converted as a
> proof of concept. That migration did not happen, and after 49 tools it is not
> going to: the shape below is deliberate and the constraints that produced it
> are still in force. The old text was removed rather than left to mislead.

## The shipped artifact is `public/`, unbuilt

`release.yml` copies `public/` verbatim into the release ZIP. Nothing is bundled,
transpiled or minified on the way out. `index.html` loads exactly one module
script (`js/core.js`) and the browser resolves the rest.

**This is the constraint everything else follows from.** A `vite.config.js` and a
`dist/` build exist and are useful for a quick dev server, but `dist/` is *not*
what users receive. Any technique that only works after a build step — bundler
path rewriting, JSX, TypeScript, bare module specifiers, tree shaking — cannot be
used in `public/`, because in `public/` it will simply not run.

The same constraint is why `mtLoadVendor()` (`js/tools/utilities.js`) injects a
`<script>` tag for the two heavy vendor libraries instead of using a dynamic
`import()`: the Vite config sets `inlineDynamicImports`, so an `import()` would
be inlined back into the bundle and defeat the point. There are exactly **two**
occurrences of `import(` in the whole application, and both are in the comment
explaining that decision.

## Modules, and the globals that connect them

- `js/core.js` — the registry. 61 static imports: every tool module, every shared
  component. Holds the `TOOLS` table (id, label, description, icon, section) that
  drives the sidebar, the Home screen, the command palette and deep links, plus
  `navigate()`, the global loader and the bridge status poll.
- `js/tools/` — 49 tool modules (plus `tools/telemetry/` for the one tool large
  enough to split). 35 of them export an `init()`; the rest need no setup.
- `js/components/` — the pieces more than one tool uses: `toast`, `tool-state`,
  `data-hub`, `exporters`, `virtual-list`, `virtual-viewer`, `command-palette`,
  `welcome`, `update-checker`, `db-connection`, `a11y`.
- `js/tools-help.js` — one entry per tool (or per tab, for the three multi-tab
  tools), rendered by the Help button.
- `js/tools/mendix-log-parser.js` — the single parser for both Mendix log
  formats, shared by the four log tools so they cannot disagree about a record.

Modules are ES modules, but **the wiring between markup and behaviour is
`window`**: 513 `window.x = x` assignments backing 376 inline `onclick`
attributes in `index.html`, plus more in generated HTML.

That is not an accident, and it is not technical debt to be paid off silently:

1. **Tables are rendered as HTML strings.** Row-heavy views build markup and
   assign `innerHTML`. Listeners attached to those rows would have to be
   reattached after every render; an `onclick` attribute survives, because it is
   part of the markup being written.
2. **A handler in the markup is visible where it is used.** For a tool whose
   panel is a few hundred lines of HTML, `onclick="lqeSort('duration')"` is
   readable in place, and grep finds every caller of a function instantly.
3. **There is no build step to help.** Delegated listeners across 49 tools would
   need a registry of their own — which is the thing the global namespace already
   is, at less cost.

### The rules this imposes

- **A function reachable from markup must be on `window`.** Exporting it is not
  enough. This is the single most common way to ship a broken feature here, and
  no linter catches it — `jshint` sees a defined function, the browser sees
  `undefined is not a function`. `scripts/browser-smoke-test.js` exists because
  of this class of defect.
- **Strings interpolated into an `onclick` need two escapes, not one.** JavaScript
  first, then HTML. A raw SQL statement containing `"` has closed an attribute and
  thrown `SyntaxError` on click while every unit test was green (v1.33.0).
- **Prefer a shared helper on `window` over a second implementation.** The log
  parser, `mxEntityForTable`, `createVirtualList`, `mtExport*`, `mtToast` and
  `mtLoadVendor` are all there to be reused.

## Offline and versioning

`public/service-worker.js` precaches the whole application — 82 entries. That
list is **generated from the filesystem** by `scripts/sync-sw-version.js`, not
maintained by hand, and `CACHE_NAME` carries the version from `package.json`.

Version consistency is enforced by mechanism, not habit, because `release.yml`
copies `public/` literally and never runs `prebuild`:

- `prestart` and `prebuild` both run `sync-app-version.js` + `sync-sw-version.js`;
- the `pre-push` hook blocks a push to `main` when `CACHE_NAME` disagrees with
  `package.json`, and blocks an untagged version bump.

Both sync scripts are dependency-free and both are shipped in the release ZIP,
because `npm start` runs them through `prestart`. (Shipping only one of them made
the documented `npm start` fallback fail with `MODULE_NOT_FOUND` from v1.32.0
until v1.40.0; the `.bat` launcher calls `node` directly and never hit it.)

## Testing, in four layers

`npm test` runs all four, in this order:

| Script | What it can see |
|---|---|
| `parser-test.js` | The pure layer: parsers, aggregators, formatters, report builders. 1 467 assertions. Loads ES modules in plain Node by stripping `export` and compiling in a CommonJS wrapper. |
| `help-coverage-test.js` | Every tool and tab resolves to a real help entry, and `tools-help.js` still parses (an unescaped apostrophe in prose once took the whole module — and with it every tool — down at load). |
| `smoke-test.js` | The bridge server. |
| `browser-smoke-test.js` | Everything only a browser has: 376 inline handlers, every render path, the cross-tool jumps, the keyboard and focus behaviour. Serves `public/` on an ephemeral port and drives it with Puppeteer. Exits 0 with a notice when no browser is available. |

The split matters: **the pure layer being green says nothing about the shipped
application.** Every real defect found in waves 13–21 was invisible to the first
three and visible to the fourth — or, twice, only to a screenshot.

## Conventions

### Data-driven UI

A view reacts to the content of its data. No empty tables, no report sections
with nothing in them. When there is nothing to show, either the section is hidden
entirely or an empty state explains *why* it is empty and what to do about it —
"this log was recorded at INFO, which does not stamp correlation IDs; raise
MicroflowEngine to DEBUG" is a useful answer, an empty list is not.

### Cross-tool hand-offs carry context

A jump from one tool to another passes what the target needs to narrow itself —
a correlation ID, a time window, a statement. Landing in an unfiltered 60 MB log
is not a hand-off. The receiving half is usually already written; check before
building a new one.

### Accessibility is decoration, not markup edits

`components/a11y.js` decorates the control families, delegates Enter/Space
activation, and drives focus trapping and dialog state from a `MutationObserver`
on the `active` class. A new dialog or filter chip is covered automatically. Do
not add `tabindex` to rows rendered into a virtual list — a list of 450 000 rows
in the tab order is worse than not being there; that needs a roving tabindex.

### Button placement

1. **Auto-processing dual-pane tools** (paste input on one side, formatted output
   on the other, re-processing on every keystroke — JSON/XML/SQL Formatter,
   Character Sanitizer, XPath Formatter): helper actions (Format/Minify/Clear/
   Copy) live inside each pane's own `.json-pane-header`, not in
   `.tool-header-actions`. An action stays scoped to the pane it affects.
2. **Manual "run analysis" tools** (nothing happens until the user clicks —
   Memory Inspector, Mock Server & Chaos, Performance Lab, API Economics,
   Architecture, Thread Dump Analyzer, WASM Profiler, Query Intelligence, OData
   Builder): exactly one `btn-primary` in `.tool-header-actions`, positioned
   last. Never bury the primary action in the panel body.
   - **Exception:** Data Factory keeps "Generate Data" attached to step 2 of its
     numbered wizard; the multi-step flow justifies it.
3. **Multi-button toolbars** (Log Viewer, Log Anonymizer, Nginx Log Analyzer,
   Telemetry Monitor): the primary action is last/rightmost; everything else is
   `btn-secondary`/`btn-ghost`. Never two visible `btn-primary` in one toolbar.

### Privacy

Nothing leaves the browser. Files are read locally, results are held in memory,
and the only network calls are to the optional local bridge on `localhost:9999`
and to endpoints the user types in themselves. `mtExportSettings` writes
preferences only — never log, HAR or database content.
