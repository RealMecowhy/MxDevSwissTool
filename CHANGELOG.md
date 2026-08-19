# Changelog

Every version of MxDev Swiss Tool, newest first.

This records what the [GitHub Releases](https://github.com/RealMecowhy/MxDevSwissTool/releases)
page cannot: **21 of these versions were never published as releases.** They
shipped as commits — most of `v1.19.0`–`v1.30.0` was written offline over four
days in late July and reached users in one batch. Those are marked *(no release
published)*: the feature is in the tool, there is simply no ZIP carrying that
number. Anyone reading the Releases page alone sees a jump from v1.18.1 straight
to v1.30.1 with eleven versions' worth of work unaccounted for.

Dates are release dates where a release exists, commit dates otherwise.

---

## v1.47.0 — 2026-08-19

Domain Model & Architecture's working view is now an owned, interactive SVG
canvas instead of a static Mermaid picture — the question behind this wave
was "what does a developer actually need this for," and the answer split
into two roles the tool now keeps separate: **exploring** a model (click,
expand, drag, inspect) and **documenting** one (Mermaid text, unchanged,
still the export path for GitHub/Confluence).

- **Click an entity for its real structure.** A new Details panel — reading
  the live model directly, not the stripped `{name,type}` projection Mermaid
  uses — shows the table name, every column name and type, and every
  association with its FK column or junction table and which side is "1".
  None of this is visible in Studio Pro.
- **Double-click to expand attributes in place**, one entity at a time — the
  ring it sits on widens automatically so nothing overlaps, verified down to
  a genuinely enormous case in the reference app: one entity with 174
  attributes expanded cleanly with zero collisions.
- **Drag any entity out of the way.** Positions are kept in an override map
  keyed by entity, so a drag survives expanding or collapsing unrelated
  nodes, and only resets when you explore a different focus entity.
- **Coloured by module**, same palette as the Diagram/Modules Mermaid views,
  with a legend for the modules actually on screen and the focus entity
  outlined in accent.
- Pan, zoom, zoom-to-fit and the light/dark theme redraw are the exact same
  code architecture.js already had for Mermaid — the canvas draws into the
  same container and gets all of it for free.
- Two real bugs caught during verification, not by inspection: an
  **async race** where the Mermaid diagram's own (unawaited) render could
  finish late and silently overwrite an already-drawn canvas, and
  **Modules view clearing the explore state** it wasn't supposed to own
  anymore, which made "peek at Modules, then click Explore" forget where you
  were. Both are now fixed and covered by the manual verification pass.
- New pure, unit-tested layout engine (`arch-canvas.js`, 27 assertions) —
  radial rings by hop distance from the focus entity, deterministic node
  sizing, and a documented decision *not* to try colouring individual
  association lines: the vendored Mermaid's `classDiagram` grammar has no
  `linkStyle` at all, confirmed by reading its parser tables, not assumed.
- **Fixed: Data Factory's generated INSERT statements could assign duplicate
  ids on a mature application.** Mendix ids are 64-bit; once an application's
  ids pass 2^53, a JS `Number` can no longer represent every following
  integer exactly, so `MAX(id) + 1` silently stopped incrementing and every
  generated row after that point got the same id — the INSERT would fail on
  a unique-constraint violation from the second such row on. Id handling
  (`server/livedb.js`'s `runSeedSchema`, and `data-factory.js` /
  `data-factory-seed.js`) now carries ids as `BigInt` end to end instead of
  passing them through `Number()`.

## v1.46.0 — 2026-08-19

Domain Model & Architecture was reported unusable on a real application
(277 entities, 34 modules): the connection panel ate half the window, the JSON
pane held half the width permanently, and the diagram opened at 3% zoom in a
652 × 382 px box. Measured on that same application, with the same module
selected:

| | before | after |
|---|---|---|
| zoom after auto-fit | 3% | 12% |
| diagram panel | 652 × 382 px | 1320 × 698 px |
| diagram canvas height | 13 138 px | 1 522 px |
| connection panel | 449 px (50% of the body) | 34 px, collapsed |
| model summary strip | 220 px | 77 px |

- **The connection form now collapses once a model is loaded**, and the model
  summary moved out of it so it stays on screen — it is the working surface,
  the form is setup you touch once. On a *failed* load the panel stays open,
  because then the form is exactly what you need.
- **Split / JSON / Diagram switch**, reusing the same pane manager seven other
  tools already use. Loading from a database switches to Diagram on its own:
  the JSON is a generated projection at that point, not something being typed.
- **Attributes: Auto / All / None.** Attribute rows are what make a real model
  enormous, and Auto drops them past 12 entities. This, not the extra panel
  width, is what moves the fit percentage.
- **Entities are coloured by module**, with a legend for the modules actually
  on screen, and the explored entity is outlined in accent. `System` is always
  neutral grey — platform infrastructure, not your model. Colours are literal
  hex rather than CSS variables so `Copy Mermaid` still renders in GitHub and
  Confluence; a theme switch therefore regenerates the diagram.
- **Fixed: an entity with no attributes rendered an empty `{ }` class body,
  which mermaid rejects outright** — "Expecting 'MEMBER', got 'STRUCT_STOP'" —
  taking the *whole* diagram down, not just that entity. Latent before (models
  from a database always had attributes) and unavoidable once attributes could
  be hidden.
- Per-association colouring was investigated and **is not possible**: the
  vendored mermaid's `classDiagram` grammar has no `linkStyle`. Relation lines
  got a contrast lift instead; cardinality remains on the edge labels.

## v1.45.0 — 2026-08-19

Domain Model Explorer — the follow-up parked on 10.08 when the module picker
shipped: pick a whole module because it's the only filter available, even
when the actual question is "what touches this one entity."

- **Explore one entity and its neighbors.** Below the module picker, type or
  pick an entity, choose 1 or 2 hops, and the tool draws just that entity
  and what associates to it — no new dependency, no new query, the same
  in-memory model the module picker already projects from. The 150-entity
  size guard that protects "All modules" applies here too, since a 2-hop
  radius around a hub can still be large.
- **Click a neighbor to re-center there.** The result isn't a one-shot
  filter: clicking any entity node in an explored diagram walks the
  neighborhood outward from that entity instead, at the same radius —
  scoped to stay off diagrams drawn from the module picker, where a click
  doing something new would be a surprise.
- Help and README updated; `archProjectModel` (the module-based projector)
  is refactored to share its entity/association-shaping logic with the new
  neighbor-based path (`archProjectEntities`) rather than duplicating it —
  and picked up 3 regression tests in the process, since it had none before.

## v1.44.0 — 2026-08-19

Domain Model & Architecture reframed: the tool was named and documented as a
diagram generator, but three of its four real value props have nothing to do
with drawing a picture — reading a model out of a live Postgres with no
`.mpr`/Studio Pro, publishing a table→entity map the Error Decoder and
Query Intelligence Suite pick up automatically, and a module dependency view
Studio Pro cannot produce (it renders one module per tab). A 150-entity guard
already stops the one mode that genuinely doesn't scale ("draw the whole
model"), so this wave fixes the promise rather than the renderer.

- **Model insights panel.** Loading a model now surfaces, before you draw
  anything: the most-coupled module pairs, the highest-degree ("hub")
  entities, and a count of orphan entities with zero associations — all
  derived client-side from data already in memory, no new queries. Verified
  against a real 338-entity/40-module application: `System.User` (109
  associations) and `Beneficiary.Beneficiary` (47) surfaced as the top hubs,
  `MxModelReflection ↔ System` (18) as the tightest module coupling, and 66
  entities flagged as orphans.
- **Tool renamed** from "Domain Model & Architecture Diagrammer" /
  "... Visualizer" (two different oversold names in help text and README) to
  the plain "Domain Model & Architecture" already used in the sidebar.
- **Help rewritten**: the live-database path now leads instead of appearing
  as step 4, the previously-undocumented Modules view gets its own step, and
  a new interpretation section explains what a hub, an orphan, and a module
  coupling count actually mean for someone reading an unfamiliar model.

## v1.43.2 — 2026-08-18

One parsing bug, reported from the Query Extractor and traced back to the log
parser every log tool shares — plus two display fixes that were already waiting in
the tree.

- **Log lines from bundled libraries no longer get glued onto the record above
  them.** Mendix Cloud interleaves the runtime's own log with anything a bundled
  library prints straight to stdout — opensaml, the AWS SDK, Xerces — and those
  lines carry no Mendix prefix, no container tag and no timestamp. The parser
  treated every unrecognized line as a continuation, which is right for stack
  traces and multi-line query plans and wrong for these: the foreign text was
  appended to whatever record happened to be open. When that record was a
  `ConnectionBus_Queries` slow-query warning, the text landed **inside the SQL**,
  so the Runnable SQL panel ended a statement with
  `ORDER BY … ASC [JettyServer-14065] INFO org.opensaml…` and the SQL formatter
  dutifully rendered the library's `from` as a second `FROM` clause. Measured on
  a production log of 123 883 records: **23 769 records carried foreign text and
  130 of 556 extracted queries had corrupted SQL — now 0 and 0**, with the query
  count itself unchanged. Across the ten-app reference corpus the bug hit **6 of
  10 apps**; the four clean ones use neither SAML nor S3, which is the whole
  pattern. Apps that do are hit hard: ~19% of all records in the worst file.
- **Those lines now appear as their own entries** rather than vanishing —
  filed under the logger that wrote them (`org.opensaml.xmlsec.algorithm.AlgorithmSupport`),
  at their own level, keeping the thread name, and inheriting the timestamp of the
  record they interrupted, since they carry none of their own. Nothing is dropped:
  the skipped-line counter is unchanged on every file in the corpus.

Both parsers were fixed, because there are two: the shared one behind the Query
Extractor, Microflow Tracer and WS/REST Extractor, and the Log Viewer's own. Their
routes into the bug differed — the shared parser treats any unmatched line as a
continuation, the Log Viewer falls through its pattern list into the same glue —
but the corrupted output was identical.

v1.43.0 recorded this defect from the other end without recognising it: three
queries that still could not be planned by "Run EXPLAIN live" were written off as
"SAML log lines the Query Extractor mis-extracts as SQL". They were not
mis-extracted. They were correctly extracted statements with a SAML log line
stapled to the end.

The on-prem log format is a separate, still-open gap: the shared parser does not
recognise it at all (`2026-07-10 11:39:04.612 INFO - Node: msg` — a space instead
of `T`, no container tag), so `detectFormat` falls through to CSV and shreds the
file on commas. The Log Viewer is unaffected; it has its own pattern for that
shape. Left for its own change rather than folded in here.

Two display fixes ride along, unrelated to any of the above:

- **HTTP Status Codes no longer prints its own markup as text.** Three entries — 303,
  401 and 560 — write `<code>` and `<strong>` into their *In Mendix* and *More
  Information* text, because what they are drawing a distinction between is URL paths
  (`/SSO/assertion` vs `/link/…`, `/xas/` vs `/odata/…`), and those have to read as
  code for the sentence to make its point. Both render paths escaped those fields, so
  the reader got a literal `<strong>two unrelated problems that share one code</strong>`
  mid-sentence instead. The two fields that carry markup now render as HTML; `name` and
  `desc`, which carry none, stay escaped. The table is a hardcoded literal in the tool's
  own source and nothing user-supplied reaches it.
- **The JSON Formatter's empty-state icon is drawn from the icon sprite** like every
  other one. It was the last place still carrying a hand-pasted inline SVG, and that
  copy put its two chevrons on `x=2…22` while the page outline they sit on spans
  `x=4…20` — so the brackets crossed and overshot the edges of the document they were
  meant to sit inside. The XML Formatter's identical empty state had been using the
  sprite all along.

---

## v1.43.1 — 2026-08-16

A layout defect in the Nginx Log Analyzer, found while regenerating the README
screenshots — and the reason it went unnoticed for so long is worth recording.

- **Error Log results no longer leak onto the Access Log tab.** The results block
  was nested one level too high in the markup — a sibling of the tab container
  rather than a child of it. Two consequences, both fixed by moving a single
  closing tag: analysing an error log and then switching back to Access Log left
  the error results sitting on screen under the wrong tab, and the emptied input
  container kept its `flex: 1` share, pushing the results down behind **365 px of
  blank space**. The Access Log tab was always nested correctly, which is why only
  one half of the tool showed the bug.
- **README screenshots regenerated against v1.43.x** and reduced to the 24 the
  README actually references — three orphans that no page linked to are gone.

The screenshot pipeline itself had been reporting success while producing wrong
images: it drove a "Gantt" tab the Nginx analyzer has never had (so that shot was
a byte-identical copy of the Access Log one), it skipped the Query Extractor demo
on a fixture path that had moved (so that shot showed an empty tool), and it drove
the Data Factory UI from before the v1.19.0 wizard rewrite (so that shot showed an
empty first step). All three are fixed in the dev-only generator, which is not part
of the shipped package.

---

## v1.43.0 — 2026-08-16

Acting on an external audit — but only on the parts that survived being checked
against the code. Several of its findings were measured and turned out not to be
defects; those are listed at the end so nobody re-opens them.

- **"Run EXPLAIN live" now works on queries taken from a log.** Mendix writes its
  SQL with JDBC `?` placeholders, not PostgreSQL's `$1`, and PostgreSQL cannot
  parse them — so the feature failed on almost everything real while working
  perfectly on hand-typed examples. Measured by SQLSTATE on a production log:
  **43 of 44 distinct queries died with `syntax_error`; now 3 do** — and those
  three are not queries at all, they are SAML log lines the Query Extractor
  mis-extracts as SQL. Placeholders are rewritten, then planned one of three
  ways: with the **actual values** when the log captured them (TRACE only), with
  PostgreSQL 16's `EXPLAIN (GENERIC_PLAN)` when it did not, and plainly when
  there are none. The UI says which kind of plan it is, because a generic plan's
  row estimates are not value-specific. Substituting `NULL` would have been
  easier and would have produced a plan for `column = NULL` — a different query.
- **The Bridge no longer dies silently on a port conflict.** `listen()` failures
  arrive as an event, not an exception; with no listener Node killed the process
  with a raw stack trace and the UI just said "Bridge Offline" forever. Now it
  names the port, the likely cause (an earlier Bridge still running) and the
  command to find the owner.
- **`/project-insights` no longer freezes the Bridge.** Its directory walks were
  synchronous, so scanning `deployment/web` and `javasource` blocked everything
  else the Bridge was doing — live log streaming, load-test polling, OTEL ingest.
  On a 13 000-file tree the old code blocked the event loop for **1 270 ms**; the
  new one leaves it responsive (worst gap **64 ms** while serving 27 concurrent
  requests), with identical results.
- **Long load tests survive a background tab.** Browsers throttle timers in a
  hidden tab to roughly one firing per minute, but the Bridge's dead-man switch
  gave up after 15 s — so switching tabs killed a healthy run with "the browser
  stopped polling for results". The switch now waits 90 s, and the page polls
  immediately on returning so the numbers are current rather than a minute stale.
- **A truncated OTLP timestamp no longer rejects a whole batch of spans.** The
  zero-dependency protobuf decoder read `fixed64` fields without checking the
  buffer length, so a short field threw out of the decoder and turned into HTTP
  400 for the entire request.

Checked and deliberately **not** changed, with the evidence, so they stay closed:
exporting 30 000 rows takes **108 ms** (not the reported 3–8 s freeze); the
virtual list forces an explicit height on every row and its content is
`nowrap`, so rows cannot vary; the cross-tool Data Hub holds log text **by
reference**, so it costs no extra memory and moving it to IndexedDB would add a
copy; the SAML debugger says "signed (ds:Signature present)", never that an
assertion is valid; the Architecture visualizer already guards models over 150
entities. One proposed fix was rejected as incorrect: treating the leading column
of a composite `UNIQUE(a, b)` index as unique would turn a correctly detected
many-to-many into a false one-to-many — `UNIQUE(a, b)` does not make `a` unique.

## v1.42.1 — 2026-08-15

No user-facing change: the application in this ZIP is identical to v1.42.0 apart
from the version string. It exists to carry the CI/release-pipeline fix below to
a tag, which is the only way the new publish action can actually be exercised.

- **The workflows no longer run on the deprecated Node 20 action runtime.** The
  runner had started forcing node24 on `actions/checkout@v4`,
  `actions/setup-node@v4` and `softprops/action-gh-release@v1`, all of which still
  declared node20 — so every run carried a deprecation warning and executed code
  on a runtime it was not built against. Now on the current majors (checkout v7,
  setup-node v7, action-gh-release v3).
- **CI builds on Node 24 instead of 20, which fixed a real mismatch rather than
  just modernising.** `puppeteer` 25 declares `engines.node >= 22.12.0` and
  `vite` 8 `^20.19.0 || >=22.12.0`, so the test suite had been running on a Node
  older than its own toolchain supports.

## v1.42.0 — 2026-08-15

- **The anonymizer now masks the secrets its Help had been promising.** The Help
  listed AWS access keys, generic API keys, passwords embedded in URLs and
  `Cookie`/`Set-Cookie` headers under "Auth Tokens"; the code only ever matched
  JWTs and `Bearer`/`Basic`. In a tool whose job is to decide whether a secret
  leaves the building, an overstated coverage claim is a security problem, not a
  documentation one — someone reads the Help, believes their AWS key was masked,
  and sends the log. All four are now implemented, plus a fifth: the same
  sensitive headers **inside a HAR**, where the name and value sit in separate
  JSON fields and neither the raw-header nor the `label=value` rule could see
  them. A HAR is the densest secret-bearing file a developer shares, and this
  toolkit has an analyzer for it.
- **Only the secret is replaced, not its context.** `Cookie: [COOKIE]`,
  `api_key=[SECRET]`, `scheme://user:[URL_PASSWORD]@host` — the label, header
  name, URL host and user survive, so the log is still diagnosable after
  anonymizing. Generic secrets are matched by their *label* rather than by value
  shape, because an API key has no universal format; the Help now says so
  plainly, including the consequence that a secret under an unusual name needs a
  custom keyword or regex.
- **Fixed: a URL password was labelled `[EMAIL]` and took the hostname with it.**
  `scheme://user:pass@host` parses as an e-mail address (`pass@host`), and e-mail
  masking is on by default, so the e-mail rule won the tie on identical start
  offsets. The password was still masked — no leak — but the label was wrong and
  the hostname the URL rule deliberately preserves was swallowed. Secret rules
  now register ahead of every general-purpose rule. Found by running the real
  Worker in a browser; the unit tests could not see it because each isolates a
  single rule with the other categories switched off.
- **First tests for this tool, ever.** ~35 assertions that execute the stringified
  `workerLogic` — the exact source that ships to the browser — including a group
  that runs with the real default checkboxes to cover cross-category collisions.
  Verified against 2 454 066 lines of production logs plus a HAR, a CSV and an
  XML export: zero false positives.

## v1.41.0 — 2026-08-13

Mined from a new reference corpus: **3.1 GB of production logs from ten Mendix
apps** (340 863 ERROR/WARNING records, 7 791 364 HTTP requests). Every number
below was measured by running the shipped code over that corpus, not estimated.

- **Error Decoder: 43 → 56 rules, coverage 75.7% → 89.7%.** The existing ruleset
  was run over all 340 863 records to find what it missed; grouping the 82 891
  misses by log node showed ~58% were platform signatures with no rule. Thirteen
  new ones close that gap: autocommitted objects surviving to logout (25 301
  records alone), slow-query warnings, widget XPaths missing a parameter, refused
  microflow calls, `Ids should not be null`, malformed email recipients, import
  mapping and XSD validation failures, missing cachebust tokens, and more. Most
  decode a *warning* rather than an exception — the lines an operator scrolls
  past for months, each naming a concrete modelling defect. What stays unmatched
  is deliberate: each app's own custom log nodes, which generalise to no other
  Mendix app. `_local_assets/edx-coverage.js` reproduces the figure.
- **Nginx Analyzer: 404s are classified by whose fault they are.** The bot
  detector was inline in the render function — unmeasurable and untestable — and
  caught 1 415 of 48 499 real 404s (2.9%). It is now a pure
  `nginxClassifyTraffic(records)` splitting them into scanner probes (95.5%),
  browser conventions (2.9%) and **your own broken references (1.6%)** — the only
  fixable group, now listed first and tagged. That surfaced a dead REST endpoint,
  a missing theme image, a missing webfont and two undeployed widget source maps
  that had been invisible under the noise. Classification uses path and user agent,
  then attributes an IP's remaining 404s to the same sweep once it has made three
  confirmed probes — behaviour instead of an ever-growing blocklist, which is what
  shrank the app bucket from 45.4% to 1.6%. **Scanner sources** now also reports
  how many *distinct* paths each IP swept (the top one asked for 4 676).
- **HTTP Status Codes: the codes a Mendix access log actually returns.** Added
  **303** (62 769× in the corpus — SAML SSO and Deep Link completing, and normally
  not a problem), **560** (not IANA-registered but the Mendix runtime's own, on
  `/xas/`; established by correlation — every one lines up to the millisecond with
  an `An error has occurred while handling the request` line in the runtime log)
  and **408**. **401** was rewritten as the two unrelated problems that share it:
  an expired browser session on `/xas/` versus wrong integration credentials on
  `/odata/`–`/rest/`. `551` occurred exactly once in 7.8M requests — too thin to
  define, so it is named in the 560 entry rather than given an invented meaning.

## v1.40.0 — 2026-08-10

- **Frontend architecture documented as it actually is.** `docs/frontend-architecture.md`
  described a migration to global-free ES modules, illustrated by one converted
  tool. It never happened, and after 49 tools it will not: the rewrite explains
  the real shape — `public/` shipped unbuilt, 513 `window` assignments backing
  376 inline handlers, and the rules that follow from both — instead of a plan
  contradicted by every file in the repository.
- **This changelog.**
- **Fixed: `npm start` from the release ZIP failed with `MODULE_NOT_FOUND`.** The
  package shipped `sync-app-version.js` but not `sync-sw-version.js`, and
  `prestart` runs both. Broken from v1.32.0; unnoticed because the `.bat`
  launcher calls `node` directly and skips npm entirely. Found by unpacking the
  published v1.39.0 artifact and running the documented command.

## v1.39.0 — 2026-08-10

- **The application can be operated from the keyboard.** All six built-in dialogs
  plus the command palette were in the tab order *while closed*; none trapped or
  restored focus; Escape closed two of eight; 45 controls (sort headers, filter
  chips) were unreachable. `components/a11y.js` fixes all of it by observation —
  decoration plus one delegated key handler plus a `MutationObserver` — rather
  than by editing ~60 markup sites.
- `--text-muted` failed WCAG AA in both themes (2.8:1); now clears 4.5:1 against
  every background it appears on.
- The theme follows `prefers-color-scheme` until you choose one; `prefers-reduced-motion`
  applies app-wide instead of only to toasts; long parses announce their progress.

## v1.38.0 — 2026-08-10

- **Correlation Flow has the ID list its help had been promising.** The tab was an
  empty box, useful only if you already knew the ID. It now ranks every
  correlation ID in the log — errors first, then volume — each labelled with its
  microflow. IDs are read from the runtime's own bracketed marker, not from any
  UUID on the line, because a log carrying SAML assertions is full of
  identity-provider claim IDs that are not correlation IDs.
- A log with no correlation IDs (the norm at INFO) says so and names the log node
  to raise.

## v1.37.0 — 2026-08-10

- **Error Decoder rules mined from 15 000 real error records** instead of from
  documentation. Measured against five production logs, the decoder recognised
  10% of the volume and only 4 of its 33 rules ever fired. Ten new rules took
  coverage to 91%; what remains unmatched is application logging, deliberately.
- The log node now travels with the message, so `SAML_SSO: null` — the single most
  frequent line in the corpus — no longer arrives as a bare `null`.

## v1.36.0 — 2026-08-10

- **A domain model you can read and navigate.** Diagrams rendered at an effective
  0.07× on a large model, in stale theme colours at 1.3:1 contrast, with no zoom
  and nothing to scroll. Adds wheel zoom, drag-pan, Fit and 1:1, and re-themes on
  toggle. (The measuring bug behind it: `mermaid.init()` is async in v11, so
  everything was sized from a placeholder.)

## v1.35.0 — 2026-08-10

- **Startup payload 5.47 MB → 1.87 MB (−66%).** mermaid and chart.js were loaded
  unconditionally for four tools out of 38; they now arrive on first use. Offline
  precaching is unchanged.
- **`browser-smoke-test.js` joins `npm test`** — the first test that loads
  `index.html`, walks all 37 tools and exercises the cross-tool jumps.

## v1.34.0 — 2026-08-10

- **Context travels with the click.** The Error Decoder receives the timestamp and
  correlation ID of the row it was opened from, so a diagnostic check scopes the
  Query Extractor to ±30 s and the Log Viewer and Tracer to that ID.
- HAR data joins the Incident Report; "By endpoint" view for REST & WS Extractor.

## v1.33.0 — 2026-08-10

- **"What costs the most", not "what was slowest once".** By-statement aggregation
  in the Query Extractor, plus two Insights categories (slow queries grouped by
  statement, log nodes running at TRACE/DEBUG).

## v1.32.0 — 2026-08-10

- **Failures surface instead of being swallowed.** 78 `alert()` calls became
  toasts, plus a global error handler.
- Portable settings (export/import), and offline that actually works — the service
  worker precache went from 8 entries to 81, generated from the filesystem.

## v1.31.0 — 2026-08-10

- **The diagnostic loop closes back to the Log Viewer.** Every cross-link led away
  from it and nothing came back, though the receiving half was already written.
- Fixes to three shipped features, including an N+1 detector that was testing the
  wrong string.

## v1.30.4 — 2026-08-10

- Query preview formatted by the SQL Formatter engine; bound parameters no longer lost.

## v1.30.3 — 2026-08-10 *(no release published)*

- Sanitizer reveals a flagged character in the input, wrapped lines included.

## v1.30.2 — 2026-08-10

- The old bridge window is closed during auto-update; SQL bracket matching.

## v1.30.1 — 2026-07-27

- Anonymizer: Luhn check on card numbers, specific-before-generic match order.

## v1.30.0 — 2026-07-27 *(no release published)*

- REST Load Tester: Basic/Bearer auth and a run summary.

## v1.29.0 — 2026-07-27 *(no release published)*

- Import a published OpenAPI/Swagger operation straight into a load test.

## v1.28.0 — 2026-07-27 *(no release published)*

- **Message Factory** — one sample message becomes a different message per request.

## v1.27.0 — 2026-07-26 *(no release published)*

- **REST Load Tester** with a live thread slider and continuous runs; Mock Server
  unblocked for Mendix callers.

## v1.26.1 — 2026-07-25 *(no release published)*

- Incident Report mirrors each tool's current filter (WYSIWYG) rather than the
  full loaded set.

## v1.26.0 — 2026-07-25 *(no release published)*

- Formatters overhaul: tokenizer highlighting, bracket/if-else and tag matching,
  an Edit view, recursive SQL subqueries.

## v1.25.0 — 2026-07-25 *(no release published)*

- Error Decoder 404 rules; the Log Viewer's Explain chip appears only when the
  decoder actually recognises the signature.

## v1.24.1 — 2026-07-25 *(no release published)*

- Post-review hardening: bcrypt cost guard, SAML certificate dates, seed numeric
  precision.

## v1.24.0 — 2026-07-25 *(no release published)*

- Platform and security depth: HAR waterfall, XPath→OQL, OData filter builder,
  SAML X.509, BCrypt verify, Data Factory FK links, Dev Studio auto-reconnect.

## v1.23.0 — 2026-07-24 *(no release published)*

- Data & Format depth: JSON path/find, XML XPath, Sanitizer clean summary, Excel
  column override, Markdown snippets, Mendix REST payload.

## v1.22.0 — 2026-07-24 *(no release published)*

- The utility tools brought up to the diagnostic tools' level of polish.

## v1.21.0 — 2026-07-24 *(no release published)*

- Sharper diagnostics: Log Viewer correlation ID and badges, Query Extractor
  compare, Error Decoder ruleset, Incident Report summary, REST/WS highlighting.

## v1.20.0 — 2026-07-24 *(no release published)*

- Deep links, per-tool state persistence, JWT signature verification.
- A consistent Ctrl+Enter shortcut and configurable telemetry alert thresholds.

## v1.19.0 — 2026-07-24 *(no release published)*

- **Data Factory 4-step wizard**, unifying manual, single and multi generation.
- String/comment-safe SQL/OQL formatter engine, three SQL Explain detectors, a
  Microflow Expression Formatter, configurable indent and keyword case.

## v1.18.1 — 2026-07-20

- Curated screenshots for the v1.18.0 features.

## v1.18.0 — 2026-07-20

- Live DB Index Advisor, Domain Model, **Data Hub** (load a log once, use it in
  four tools), Scheduled Events Monitor, Excel Converter, Data Factory import.

## v1.17.1 — 2026-07-19

- Help and README for the v1.17.0 features.

## v1.17.0 — 2026-07-19

- Live EXPLAIN, the Microflow Tracer N+1 detector, telemetry modularization,
  nginx p95/p99, command-palette actions.

## v1.16.0 — 2026-07-19

- Log Viewer: levels matrix and line bookmarks.

## v1.15.1 — 2026-07-19 *(no release published)*

- Control heights normalized via `--control-h`; undefined-variable aliases completed.

## v1.15.0 — 2026-07-18

- **Error Decoder**, **Incident Report**, unified exports.

## v1.14.0 — 2026-07-18

- **Log Insights** tab.

## v1.13.0 — 2026-07-18

- **REST & WS Extractor**.

## v1.12.0 — 2026-07-17

- Hardening: aggregation tests, Help coverage lint, a reusable virtual list.

## v1.11.0 — 2026-07-17

- Sanitizer detects escaped control-character references and PUA/noncharacter codepoints.

## v1.10.1 — 2026-07-17

- Form-row button height normalized.

## v1.10.0 — 2026-07-17

- **Microflow Tracer**.

## v1.9.4 — 2026-07-16

- Annotated tags, so `--follow-tags` actually pushes them.

## v1.9.3 — 2026-07-16

- Release guard against untagged version bumps; one-shot `npm run release`.

## v1.9.2 — 2026-07-16

- A hint when a non-error log lands in the Error Log tab.

## v1.9.1 — 2026-07-15 *(no release published)*

- Nginx: Clear no longer breaks the Error Log input layout.

## v1.9.0 — 2026-07-15 *(no release published)*

- **The shared single-pass log parser plus a Web Worker** — the parser all four
  log tools still use.

## v1.8.0 — 2026-07-15 *(no release published)*

- In-place XPath preview and a return chip for cross-tool jumps.

## v1.7.1 — 2026-07-15 *(no release published)*

- Drag & drop log files onto the query list.

## v1.7.0 — 2026-07-15 *(no release published)*

- Query Extractor: stats bar, slow-only filter, export, slow-query warning ingest.

## v1.6.0 — 2026-07-15

- In-app update checker with self-update, and the welcome tour.

## v1.5.0 — 2026-07-15

- The launcher downloads portable Node.js when it is missing.

## v1.4.3 — 2026-07-14

- Release packaging fixes.

## v1.4.2 — 2026-07-14

- The bridge starts without `npm install`.

## v1.4.1 — 2026-07-14

- XPath Formatter reprofiled as a linter; the top bar became the single owner of
  tool identity; Markdown drag & drop.

## v1.3.0 — 2026-07-13

- Security and code-quality audit implemented; README with the full tool list and
  screenshots.

## v1.2.0 — 2026-07-12

- Nginx Analyzer improvements, global filters, UI refactor.

## v1.1.0 — 2026-07-11

- Data Factory preview; screenshots for Mock Server, Nginx and Query Extractor.

## v1.0.0 — 2026-07-11

- First release, with the GitHub Actions release pipeline.
