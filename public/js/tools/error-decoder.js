// MENDIX ERROR DECODER (wave 5)
// ============================================================
// Decodes the *mechanism* behind a Mendix/Java/PostgreSQL error message or
// stack trace. Owner contract (18.07.2026): this is a decoder, NOT a fix
// advisor. For every matched pattern the card carries three sections:
//   1. "What happened technically" — certain, follows directly from the message.
//   2. "Typical causes"            — an explicit list of hypotheses.
//   3. "How to check which"        — a diagnostic checklist, cross-referencing
//                                    the Log Query Extractor / JVM Health / Tracer.
// The matched pattern is always shown so the reader judges the fit themselves.
// No imperative "do X" fixes. No match ⇒ no card, never a "probably it's…" guess
// (data-driven rule). The ruleset is intentionally high-confidence: each rule
// keys off a signature that Mendix/Postgres/the JVM emit verbatim.
//
// edxDecode(text) is a pure function attached to window/self so it can be unit
// tested in Node exactly like the MFT/LQE/WSRE extractors.

(function (root) {
  'use strict';

  // Each rule: a signature (regexes, first match wins), a specificity used to
  // rank overlapping matches (specific DB/JVM signatures outrank a generic NPE),
  // and the three card sections. `mechanism`/`causes`/`checks` receive the
  // RegExp match array so a captured constraint/column name can be woven in.
  // A check may name a `tool` (a tool id) — the UI turns that into an "Open" link.
  const EDX_RULES = [
    // ── Database — PostgreSQL constraint & lock signatures ──────────────────
    {
      id: 'pg-unique-violation',
      title: 'Unique constraint violation',
      category: 'Database',
      specificity: 90,
      patterns: [
        /duplicate key value violates unique constraint "([^"]+)"/i,
        /violates unique constraint "([^"]+)"/i,
        /ERROR:\s*duplicate key value/i
      ],
      mechanism: function (m) {
        const c = m[1] ? ' (<code>' + m[1] + '</code>)' : '';
        return 'PostgreSQL rejected an <code>INSERT</code> or <code>UPDATE</code> because a value would duplicate one already present in a column protected by a UNIQUE index/constraint' + c + '. The database enforced this — the row was never committed, and Mendix surfaced the driver error as a runtime exception.';
      },
      causes: function () {
        return [
          'Two microflows (or a scheduled event and a user action) created the same logical record at nearly the same time — a race with no locking around the "check then insert" step.',
          'A retried operation (TaskQueue retry, user double-submit, replayed REST call) re-inserted a record that the first attempt already committed.',
          'An import/sync loaded a key that already exists, or the uniqueness assumption in the domain model does not match the source data.',
          'A Mendix "unique" validation rule is missing, so the collision is only caught at the database level instead of being handled in the microflow.'
        ];
      },
      checks: function (m) {
        return [
          { text: 'Identify the entity/attribute behind the index name' + (m[1] ? ' <code>' + m[1] + '</code>' : '') + ' (Mendix names indexes after the table and columns) to know which value collided.' },
          { text: 'Look for two commits with the same key around this timestamp — the SQL that ran in the same window shows the competing INSERTs.', tool: 'log-query-extractor' },
          { text: 'Check whether the calling microflow was fired twice (retry / double request) around this time.', tool: 'microflow-tracer' }
        ];
      }
    },
    {
      id: 'pg-notnull-violation',
      title: 'Not-null constraint violation',
      category: 'Database',
      specificity: 85,
      patterns: [/null value in column "([^"]+)"[^]*?violates not-null constraint/i, /violates not-null constraint/i],
      mechanism: function (m) {
        const c = m[1] ? ' <code>' + m[1] + '</code>' : '';
        return 'PostgreSQL rejected a write because column' + c + ' received <code>NULL</code>, but the column is defined <code>NOT NULL</code> (a Mendix attribute marked "required" or a system column). The database enforced it after the microflow committed — no Mendix validation caught it first.';
      },
      causes: function () {
        return [
          'A required attribute was never set on the object before it was committed.',
          'An association or calculated value that feeds the column resolved to empty on this path through the microflow.',
          'An object was committed with "without events", bypassing a before-commit microflow that would normally populate the value.'
        ];
      },
      checks: function (m) {
        return [
          { text: 'Map column' + (m[1] ? ' <code>' + m[1] + '</code>' : '') + ' back to its Mendix attribute and confirm it is "required".' },
          { text: 'Trace the microflow that committed this object and find the branch where the attribute stays empty.', tool: 'microflow-tracer' }
        ];
      }
    },
    {
      id: 'pg-fk-violation',
      title: 'Foreign key constraint violation',
      category: 'Database',
      specificity: 85,
      patterns: [/violates foreign key constraint "([^"]+)"/i, /violates foreign key constraint/i],
      mechanism: function (m) {
        const c = m[1] ? ' (<code>' + m[1] + '</code>)' : '';
        return 'PostgreSQL rejected the write because it would leave an association pointing at a row that does not exist' + c + '. Mendix associations are backed by foreign keys; the referenced object was missing (never committed, or deleted) at the moment of the write.';
      },
      causes: function () {
        return [
          'The associated object was deleted (or rolled back) while another object still referenced it.',
          'Objects were committed in the wrong order — the child before the parent it points to.',
          'A concurrent transaction removed the parent between the reference being set and this commit.'
        ];
      },
      checks: function () {
        return [
          { text: 'Identify the two entities joined by this constraint and which side was written here.' },
          { text: 'Look for a DELETE on the referenced entity just before this error in the same time window.', tool: 'log-query-extractor' }
        ];
      }
    },
    {
      id: 'pg-deadlock',
      title: 'Database deadlock',
      category: 'Database',
      specificity: 88,
      patterns: [/deadlock detected/i, /Process \d+ waits for .*Lock/i],
      mechanism: function () {
        return 'PostgreSQL detected two (or more) transactions each holding a lock the other needs, so it aborted one of them to break the cycle. The aborted transaction is the one that raised this error; the other proceeded. This is the database resolving a circular wait, not data corruption.';
      },
      causes: function () {
        return [
          'Two microflows updated the same set of objects in the opposite order, so each locked a row the other already held.',
          'A long-running transaction held locks while a second transaction touched the same rows.',
          'Bulk updates over overlapping object sets ran concurrently (parallel scheduled events, a batch plus live traffic).'
        ];
      },
      checks: function () {
        return [
          { text: 'Read the "Process … waits for …" detail in the log — it names both processes and the locked relations.' },
          { text: 'Find the two transactions active at this timestamp and the objects each was writing.', tool: 'log-query-extractor' },
          { text: 'Check whether two microflows write the same entities in a different order.', tool: 'microflow-tracer' }
        ];
      }
    },
    {
      id: 'pg-statement-timeout',
      title: 'Query cancelled — statement timeout',
      category: 'Database',
      specificity: 82,
      patterns: [/canceling statement due to statement timeout/i, /canceling statement due to user request/i, /query.*cancell?ed/i],
      mechanism: function () {
        return 'PostgreSQL cancelled a query because it ran longer than the configured <code>statement_timeout</code> (or was cancelled by request). The database stopped the work and returned an error rather than letting it run indefinitely — the query itself did not "fail", it was interrupted.';
      },
      causes: function () {
        return [
          'A retrieve with no supporting index scanned a large table (sequential scan).',
          'An XPath/OQL constraint that the optimizer could not push down (function on a column, leading wildcard, OR across attributes).',
          'The table grew past the point where a previously fast query stays under the timeout.',
          'Lock contention made the statement wait, and the wait counted against the timeout.'
        ];
      },
      checks: function () {
        return [
          { text: 'Find this exact query and its duration, then inspect its plan for a Seq Scan or a missing index.', tool: 'log-query-extractor' },
          { text: 'Compare the row count / cost against faster runs of the same query signature.', tool: 'log-query-extractor' }
        ];
      }
    },
    {
      id: 'db-pool-exhausted',
      title: 'Database connection pool exhausted',
      category: 'Database',
      specificity: 84,
      patterns: [
        /Cannot get a connection, pool (?:error|exhausted)/i,
        /Timeout waiting for idle (?:object|connection)/i,
        /connection is not available, request timed out after/i,
        /connection pool.*(?:exhausted|timeout)/i
      ],
      mechanism: function () {
        return 'A thread asked the connection pool for a database connection, every connection was already checked out, and the thread waited past the pool\'s max-wait before giving up. The pool protected the database from unbounded connections — the shortage is on the application side, not a database outage.';
      },
      causes: function () {
        return [
          'A spike in concurrent requests or scheduled events needed more connections than the pool size.',
          'Long-running queries held their connections for a long time, starving other threads.',
          'A connection leak — a transaction/connection was not released — steadily drained the pool.',
          'The pool is sized smaller than the real concurrency the app sees at peak.'
        ];
      },
      checks: function () {
        return [
          { text: 'Look at query durations in this window — a cluster of slow queries explains held connections.', tool: 'log-query-extractor' },
          { text: 'Check the thread state at this moment for many threads blocked waiting on the pool.', tool: 'thread-dump' }
        ];
      }
    },
    {
      id: 'mendix-nonexistent-object',
      title: 'Retrieve of a non-existent object',
      category: 'Database',
      specificity: 80,
      patterns: [
        /(?:Trying to )?retrieve (?:a )?nonexistent object/i,
        /Object with (?:id|guid) '?[\w$.-]+'? (?:does not exist|no longer exists|could not be found)/i,
        /nonexistent object with id/i
      ],
      mechanism: function () {
        return 'Mendix tried to load an object by its id, but no row with that id exists anymore. The reference (a variable, a page context, a queued id) outlived the object it pointed to. The runtime reported the miss rather than returning a phantom object.';
      },
      causes: function () {
        return [
          'The object was deleted (by another user, a scheduled event, or delete-behavior on an association) while this reference was still held.',
          'A stale page/client sent back an id for an object that has since been removed.',
          'A background task stored an object id and processed it later, after the object was gone.'
        ];
      },
      checks: function () {
        return [
          { text: 'Look for a DELETE of that object id shortly before this retrieve in the same window.', tool: 'log-query-extractor' },
          { text: 'Trace the microflow to see where the now-missing reference originated.', tool: 'microflow-tracer' }
        ];
      }
    },

    // ── JVM — memory & thread exhaustion ────────────────────────────────────
    {
      id: 'oom-heap',
      title: 'Out of memory — Java heap space',
      category: 'JVM / Memory',
      specificity: 92,
      patterns: [/OutOfMemoryError:\s*Java heap space/i],
      mechanism: function () {
        return 'The JVM could not allocate an object because the heap (bounded by <code>-Xmx</code>) was full and garbage collection could not reclaim enough space. Once this is thrown the JVM is in a degraded state — threads may die and the runtime often needs a restart to recover cleanly.';
      },
      causes: function () {
        return [
          'A retrieve pulled a very large object set into memory at once (missing amount/offset paging, an unbounded list).',
          'A genuine leak — objects held in a static/singleton or a growing cache — climbs over time until the heap fills.',
          'A large file/import processed fully in memory instead of streaming.',
          'The heap is simply undersized for the workload and peak concurrency.'
        ];
      },
      checks: function () {
        return [
          { text: 'Inspect the heap histogram to see which class dominates the live set.', tool: 'thread-dump' },
          { text: 'Look for a large retrieve (high row count) in this window that matches the growth.', tool: 'log-query-extractor' },
          { text: 'Decide leak vs. spike: a steady climb across restarts points to a leak; a single burst points to one operation.' }
        ];
      }
    },
    {
      id: 'oom-metaspace',
      title: 'Out of memory — Metaspace',
      category: 'JVM / Memory',
      specificity: 92,
      patterns: [/OutOfMemoryError:\s*Metaspace/i, /OutOfMemoryError:\s*(?:Compressed )?Class space/i],
      mechanism: function () {
        return 'The JVM exhausted Metaspace — the native memory region that holds class metadata (not the object heap). This fills from the number of loaded classes, not from data volume, so it usually reflects class loading rather than a data spike.';
      },
      causes: function () {
        return [
          'A classloader leak: repeated redeploys/hot-reloads, or a library that generates and loads classes at runtime, accumulate class metadata.',
          'Heavy use of dynamic proxies / bytecode generation (some serialization, scripting or ORM paths).',
          'Metaspace is capped (<code>-XX:MaxMetaspaceSize</code>) below what the loaded class set needs.'
        ];
      },
      checks: function () {
        return [
          { text: 'Check whether the error follows redeploys/restarts rather than traffic peaks.' },
          { text: 'Review loaded-class growth over the app\'s lifetime in the JVM metrics.', tool: 'thread-dump' }
        ];
      }
    },
    {
      id: 'oom-gc-overhead',
      title: 'Out of memory — GC overhead limit',
      category: 'JVM / Memory',
      specificity: 90,
      patterns: [/OutOfMemoryError:\s*GC overhead limit exceeded/i],
      mechanism: function () {
        return 'The JVM spent almost all recent time in garbage collection while reclaiming almost no memory, and gave up. It is the early-warning form of heap exhaustion: the heap is nearly full and GC is thrashing rather than the app running out in a single allocation.';
      },
      causes: function () {
        return [
          'The live object set is close to the heap ceiling, so every GC frees only a sliver.',
          'A slow leak has brought the heap to the edge over hours/days.',
          'Workload grew but <code>-Xmx</code> did not.'
        ];
      },
      checks: function () {
        return [
          { text: 'Read the GC log — long, frequent full GCs reclaiming little confirm the thrash.', tool: 'thread-dump' },
          { text: 'Treat the causes the same way as a heap-space OOM (leak vs. undersized heap).' }
        ];
      }
    },
    {
      id: 'oom-native-thread',
      title: 'Out of memory — cannot create native thread',
      category: 'JVM / Memory',
      specificity: 90,
      patterns: [/OutOfMemoryError:\s*unable to create (?:new )?native thread/i, /unable to create native thread/i],
      mechanism: function () {
        return 'The JVM asked the OS for a new thread and was refused — the process hit a thread/ulimit ceiling or ran out of native memory for thread stacks. This is native-side exhaustion, so it can fire even with heap to spare.';
      },
      causes: function () {
        return [
          'Thread count climbed unbounded — a thread pool without a ceiling, or threads that never terminate.',
          'The OS <code>ulimit -u</code> / process thread limit is lower than the app needs at peak.',
          'Many blocked threads (e.g. all waiting on a slow dependency) accumulated without completing.'
        ];
      },
      checks: function () {
        return [
          { text: 'Count threads and their states — a large blocked/waiting population points to a stuck dependency.', tool: 'thread-dump' },
          { text: 'Check whether thread count grows steadily rather than spiking once.' }
        ];
      }
    },

    // ── Integration — HTTP / TLS / sockets ──────────────────────────────────
    {
      id: 'jetty-eof',
      title: 'Client closed connection (Jetty EofException)',
      category: 'Integration',
      specificity: 78,
      patterns: [/org\.eclipse\.jetty\.io\.EofException/i, /Early EOF/i, /EofException/i],
      mechanism: function () {
        return 'Jetty was writing the HTTP response when the client\'s TCP connection went away, so the write hit end-of-stream. The server did its work; the receiver disconnected first. This is a symptom of the client side, not a server-side failure of the request logic.';
      },
      causes: function () {
        return [
          'The user navigated away, closed the tab, or lost connectivity before the response finished.',
          'A proxy/load balancer in front of Mendix timed out and dropped the connection while the app was still responding.',
          'The response was slow enough that the client\'s own timeout elapsed first.'
        ];
      },
      checks: function () {
        return [
          { text: 'Check whether the matching request was slow — a slow response makes client/proxy timeouts likely.', tool: 'log-query-extractor' },
          { text: 'Correlate with the proxy access log for a 499/504 at the same instant.', tool: 'nginx-log' }
        ];
      }
    },
    {
      id: 'socket-read-timeout',
      title: 'Outgoing call timed out (socket read timeout)',
      category: 'Integration',
      specificity: 82,
      patterns: [/java\.net\.SocketTimeoutException:\s*Read timed out/i, /SocketTimeoutException:\s*connect timed out/i, /Read timed out/i],
      mechanism: function () {
        return 'An outgoing HTTP/SOAP call opened its connection but the remote service did not send a (complete) response within the client\'s configured read timeout, so the socket gave up waiting. The failure is in waiting for the peer, not in your request being rejected.';
      },
      causes: function () {
        return [
          'The external service was slow or overloaded on this call.',
          'The configured client timeout is shorter than the service\'s real worst-case response time.',
          'A network hop (proxy/firewall) silently held or dropped the connection.'
        ];
      },
      checks: function () {
        return [
          { text: 'Find this call and its timing — the request/response gap and the configured timeout are shown side by side.', tool: 'ws-rest-extractor' },
          { text: 'Check whether the same endpoint times out repeatedly or just once.', tool: 'ws-rest-extractor' }
        ];
      }
    },
    {
      id: 'ssl-pkix',
      title: 'TLS trust failure (PKIX path building failed)',
      category: 'Integration',
      specificity: 86,
      patterns: [/PKIX path building failed/i, /unable to find valid certification path to requested target/i, /SSLHandshakeException/i],
      mechanism: function () {
        return 'During the TLS handshake the JVM could not build a trust chain from the server\'s certificate to a CA in its truststore, so it aborted the connection before any request was sent. This is certificate trust, not authentication or authorization — the two sides never agreed on TLS.';
      },
      causes: function () {
        return [
          'The server presents a certificate signed by a CA (or an internal/self-signed CA) that is not in the JVM truststore.',
          'The server did not send the full intermediate chain, so the JVM cannot reach a trusted root.',
          'The endpoint URL / hostname does not match the certificate, or a TLS-terminating proxy swapped the certificate.'
        ];
      },
      checks: function () {
        return [
          { text: 'Inspect the certificate chain the endpoint actually presents and compare it to the JVM truststore contents.' },
          { text: 'Confirm which host failed — the outgoing call record names the endpoint.', tool: 'ws-rest-extractor' }
        ];
      }
    },
    {
      id: 'connection-refused',
      title: 'Connection refused',
      category: 'Integration',
      specificity: 80,
      patterns: [/java\.net\.ConnectException:\s*Connection refused/i, /Connection refused(?:\s*\(Connection refused\))?/i],
      mechanism: function () {
        return 'A TCP connection attempt was actively refused: something answered at that address but nothing was listening on the target port (or a firewall sent a reset). The connection never opened, so no request was sent.';
      },
      causes: function () {
        return [
          'The target service is down or still starting up.',
          'The host/port in the configuration is wrong, or points at the wrong environment.',
          'A firewall / security group blocks the port from the Mendix runtime.'
        ];
      },
      checks: function () {
        return [
          { text: 'Confirm the host and port the call used, then verify the service is listening there.', tool: 'ws-rest-extractor' },
          { text: 'Check whether every call to this endpoint fails (config/network) or only some (flapping service).', tool: 'ws-rest-extractor' }
        ];
      }
    },

    // ── Authentication — SAML / SSO ─────────────────────────────────────────
    {
      id: 'saml-audience',
      title: 'SAML audience restriction mismatch',
      category: 'Authentication',
      specificity: 84,
      patterns: [/audience[^\n.]*not valid/i, /AudienceRestriction/i, /Audience .* (?:does not match|is not valid)/i, /not a valid audience/i],
      mechanism: function () {
        return 'The SAML assertion carried an <code>AudienceRestriction</code> whose value does not equal this application\'s Service Provider EntityID, so the SP refused it. The identity provider issued a token addressed to a different audience than the one validating it — a configuration mismatch, not a credential problem.';
      },
      causes: function () {
        return [
          'The SP EntityID configured in the IdP does not match the EntityID the Mendix SAML module uses.',
          'The token was issued for a different environment (acceptance vs. production) and replayed against this one.',
          'A recent change to the SP metadata / EntityID was applied on only one side.'
        ];
      },
      checks: function () {
        return [
          { text: 'Compare the Audience value in the assertion against the SP EntityID (decode the SAML response to read it).', tool: 'saml-debugger' },
          { text: 'Confirm the IdP is configured with the same EntityID for this environment.' }
        ];
      }
    },
    {
      id: 'saml-clock',
      title: 'SAML assertion validity window (clock skew)',
      category: 'Authentication',
      specificity: 84,
      patterns: [/assertion is not yet valid/i, /NotBefore/i, /NotOnOrAfter/i, /Conditions.*not (?:yet )?(?:valid|met)/i, /clock skew/i],
      mechanism: function () {
        return 'The SAML assertion\'s <code>Conditions</code> define a validity window (<code>NotBefore</code> … <code>NotOnOrAfter</code>) and the validating server\'s current time fell outside it, so the assertion was rejected. The token is well-formed; server and IdP disagree on the current time (or the token is genuinely expired).';
      },
      causes: function () {
        return [
          'The Mendix server clock and the IdP clock differ by more than the allowed skew (NTP drift on one side).',
          'Network/processing delay pushed validation past a short <code>NotOnOrAfter</code>.',
          'The configured allowed clock skew is smaller than the real difference between the systems.'
        ];
      },
      checks: function () {
        return [
          { text: 'Read the NotBefore / NotOnOrAfter values from the assertion and compare them to the server time of this log line.', tool: 'saml-debugger' },
          { text: 'Confirm NTP is in sync on the runtime host.' }
        ];
      }
    },

    // ── Platform / runtime ──────────────────────────────────────────────────
    {
      id: 'port-in-use',
      title: 'Port already in use (startup bind failure)',
      category: 'Platform',
      specificity: 80,
      patterns: [/Address already in use/i, /java\.net\.BindException/i, /Failed to bind to .*:\d+/i],
      mechanism: function () {
        return 'The runtime tried to bind a listening socket to a port that another process already holds, so the OS refused the bind and startup failed. Nothing is wrong with the app logic — two things want the same port.';
      },
      causes: function () {
        return [
          'A previous instance of the runtime did not shut down and still holds the port.',
          'Another service on the host is bound to the same port.',
          'A restart raced its own predecessor before the socket was released (TIME_WAIT).'
        ];
      },
      checks: function () {
        return [
          { text: 'Identify which process owns the port on the host, and whether an old runtime instance is still alive.' },
          { text: 'Check the surrounding startup log for the port number and a prior unclean shutdown.', tool: 'log-viewer' }
        ];
      }
    },
    {
      id: 'microflow-exception',
      title: 'Microflow execution failed (wrapped exception)',
      category: 'Microflow',
      specificity: 45,
      patterns: [
        /com\.mendix\.modules\.microflowengine\.MicroflowException/i,
        /Error in \(sub\)?microflow/i,
        /An error (?:has )?occurred while executing.*microflow/i
      ],
      mechanism: function () {
        return 'The microflow engine caught an exception thrown by an activity and rethrew it wrapped as a <code>MicroflowException</code>, unwinding the microflow (and any callers). The wrapper names the microflow chain; the real mechanism is in the <em>Caused by</em> further down the stack.';
      },
      causes: function () {
        return [
          'An activity inside the microflow threw — the wrapper is only the outer layer.',
          'A "Caused by" line below carries the specific failure (database, null, integration, etc.).',
          'A custom Java action or a Marketplace module raised the underlying error.'
        ];
      },
      checks: function () {
        return [
          { text: 'Read the deepest "Caused by:" in the stack — that root cause is what to decode next.' },
          { text: 'Trace this microflow to see which activity was executing when it threw.', tool: 'microflow-tracer' }
        ];
      }
    },
    {
      id: 'npe',
      title: 'Null reference (NullPointerException)',
      category: 'JVM / Runtime',
      specificity: 25,
      patterns: [/java\.lang\.NullPointerException/i],
      mechanism: function () {
        return 'Java code dereferenced a reference that was <code>null</code> — a member/method was accessed on an object that had not been set. Newer JVMs append a "Cannot invoke … because … is null" detail that names the exact null reference.';
      },
      causes: function () {
        return [
          'An object variable or association was empty on this path but the code assumed it was set.',
          'A retrieve returned nothing and the result was used without an emptiness check.',
          'A custom Java action or module received a null argument it did not guard.'
        ];
      },
      checks: function () {
        return [
          { text: 'Read the helpful NPE message (if present) — it names the reference that was null.' },
          { text: 'Trace the microflow to the activity that dereferenced it and find where the value should have been set.', tool: 'microflow-tracer' }
        ];
      }
    }
  ];

  // Detects whether the input looks like it carries a stack trace (indented
  // frames, `at …`, `Caused by:`) — surfaced in the UI as context, never a match.
  function edxHasStackTrace(text) {
    return /\n\s+at\s+[\w$.<>]+\(/.test(text) ||
      /\bat\s+(?:java|com|org|javax|sun|scala|net)\./.test(text) ||
      /Caused by:/i.test(text);
  }

  // Runs one rule's patterns; returns the first RegExp match (with captures) or null.
  function edxRunRule(rule, text) {
    for (let i = 0; i < rule.patterns.length; i++) {
      const m = text.match(rule.patterns[i]);
      if (m) return m;
    }
    return null;
  }

  // Pure decode. Returns every rule whose signature is present, most specific
  // first. Empty `matches` is the honest answer for an unrecognized error — the
  // UI shows guidance, never a guessed cause (data-driven rule).
  function edxDecode(text) {
    text = String(text == null ? '' : text);
    const trimmed = text.trim();
    const matches = [];
    if (trimmed) {
      for (let i = 0; i < EDX_RULES.length; i++) {
        const rule = EDX_RULES[i];
        const m = edxRunRule(rule, text);
        if (!m) continue;
        matches.push({
          id: rule.id,
          title: rule.title,
          category: rule.category,
          specificity: rule.specificity,
          matchedText: (m[0] || '').replace(/\s+/g, ' ').trim().slice(0, 240),
          mechanism: rule.mechanism(m),
          causes: rule.causes(m),
          checks: rule.checks(m)
        });
      }
      // Most specific signature first; stable by rule order within equal scores.
      matches.sort(function (a, b) { return b.specificity - a.specificity; });
    }

    return {
      input: {
        empty: trimmed.length === 0,
        lineCount: trimmed ? trimmed.split(/\r?\n/).length : 0,
        hasStackTrace: edxHasStackTrace(text)
      },
      matches: matches
    };
  }

  root.edxDecode = edxDecode;
  root.EDX_RULES = EDX_RULES;
})(typeof window !== 'undefined' ? window : self);


// ============================================================
// UI — paste, decode, render cards (browser only)
// ============================================================
// Attached to window like the MFT/WSRE handlers. Only edxDecode above is unit
// tested; the code below never runs at import time (assignments only), so the
// Node test can require this file without a DOM.

// Short labels for the tools a diagnostic check can point at. Kept local so the
// decoder does not depend on core.js's TOOLS registry load order.
const EDX_TOOL_LABELS = {
  'log-query-extractor': 'Log Query Extractor',
  'microflow-tracer': 'Microflow Tracer',
  'ws-rest-extractor': 'REST & WS Extractor',
  'thread-dump': 'JVM Health',
  'log-viewer': 'Log Viewer',
  'nginx-log': 'Nginx Log Analyzer',
  'saml-debugger': 'SAML / OIDC Debugger'
};

function edxEsc(s) {
  return (typeof window !== 'undefined' && window.escHtml)
    ? window.escHtml(s)
    : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

window.edxOpenTool = function (toolId) {
  if (window.navigateWithReturn) window.navigateWithReturn(toolId);
  else if (window.navigate) window.navigate(toolId, null);
};

function edxCheckHtml(check) {
  // The check text is authored in the ruleset (trusted HTML with <code>/<em>);
  // only the optional tool link is generated here.
  let link = '';
  if (check.tool && EDX_TOOL_LABELS[check.tool]) {
    link = ' <button type="button" class="edx-tool-link" onclick="window.edxOpenTool(\'' + check.tool + '\')" title="Open the ' +
      edxEsc(EDX_TOOL_LABELS[check.tool]) + '">' +
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
      edxEsc(EDX_TOOL_LABELS[check.tool]) + '</button>';
  }
  return '<li class="edx-check">'
    + '<span class="edx-check-mark"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></span>'
    + '<span class="edx-check-body">' + check.text + link + '</span></li>';
}

// PostgreSQL errors name tables (`eshop$order`), Mendix developers think in
// entities (`eShop.Order`). When a domain model has been loaded from a live
// database (Domain Model & Architecture → Load model from database) the map is
// on window and we can translate. Pure so it is unit-testable; returns [] when
// no model is loaded, so the card section simply does not appear.
function edxMapTables(text, tableMap) {
  if (!text || !tableMap) return [];
  const found = [];
  const seen = {};
  Object.keys(tableMap).forEach(function (table) {
    if (!table || seen[table]) return;
    if (String(text).toLowerCase().indexOf(String(table).toLowerCase()) === -1) return;
    seen[table] = true;
    found.push({ table: table, entity: tableMap[table] });
  });
  // Longest first: `eshop$orderline` is more specific than `eshop$order`.
  found.sort(function (a, b) { return b.table.length - a.table.length; });
  return found;
}

function edxCardHtml(match) {
  const causes = (match.causes || []).map(function (c) { return '<li>' + c + '</li>'; }).join('');
  const checks = (match.checks || []).map(edxCheckHtml).join('');
  const tables = (typeof window !== 'undefined')
    ? edxMapTables(match.matchedText, window._mxTableMap)
    : [];
  const tableSection = tables.length
    ? '<div class="edx-section"><div class="edx-section-label">Tables in this message</div><ul class="edx-list">'
      + tables.map(function (t) {
        return '<li><code>' + edxEsc(t.table) + '</code> &rarr; <strong>' + edxEsc(t.entity) + '</strong></li>';
      }).join('')
      + '</ul></div>'
    : '';
  return '<div class="edx-card">'
    + '<div class="edx-card-head">'
    +   '<span class="edx-cat">' + edxEsc(match.category) + '</span>'
    +   '<span class="edx-title">' + edxEsc(match.title) + '</span>'
    + '</div>'
    + '<div class="edx-matched"><span class="edx-matched-label">Matched pattern</span>' + edxEsc(match.matchedText) + '</div>'
    + tableSection
    + '<div class="edx-section edx-section-mechanism">'
    +   '<div class="edx-section-label"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>What happened technically</div>'
    +   '<p class="edx-mechanism">' + match.mechanism + '</p>'
    + '</div>'
    + '<div class="edx-section edx-section-causes">'
    +   '<div class="edx-section-label"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>Typical causes <span style="font-weight:400;text-transform:none;letter-spacing:0;opacity:0.7;">(hypotheses)</span></div>'
    +   '<ul class="edx-list">' + causes + '</ul>'
    + '</div>'
    + '<div class="edx-section edx-section-checks">'
    +   '<div class="edx-section-label"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>How to check which</div>'
    +   '<ul class="edx-list edx-checks">' + checks + '</ul>'
    + '</div>'
    + '</div>';
}

function edxRender(result) {
  const out = document.getElementById('edx-results');
  if (!out) return;

  if (result.input.empty) {
    out.innerHTML = '<div class="edx-empty">'
      + '<p style="font-weight:600; color:var(--text-primary);">Paste an error to decode its mechanism</p>'
      + '<p>The decoder recognizes known Mendix, Java and PostgreSQL error signatures and explains, for each one it matches: <strong>what happened technically</strong> (certain), <strong>typical causes</strong> (hypotheses) and <strong>how to check which cause applies</strong> (a diagnostic checklist).</p>'
      + '<p>It is a decoder, not a fix advisor — it never tells you what to change, and when it does not recognize a message it says so rather than guessing.</p></div>';
    return;
  }

  const stackNote = result.input.hasStackTrace
    ? 'stack trace detected'
    : 'no stack trace — pasting the full trace (with <code>Caused by:</code>) improves matching';

  if (result.matches.length === 0) {
    // Data-driven rule: no recognized signature ⇒ say so, never invent a cause.
    out.innerHTML = '<div class="edx-context">' + result.input.lineCount + ' line(s) analyzed · ' + stackNote + '</div>'
      + '<div class="edx-empty">'
      + '<p style="font-weight:600; color:var(--text-primary);">No known pattern matched</p>'
      + '<p>The decoder only shows a card when it recognizes an error mechanism with confidence — it will not guess a cause for an unrecognized message.</p>'
      + '<p>Try pasting the <strong>full stack trace</strong>, including the deepest <code>Caused by:</code> line (that root cause is usually what a pattern keys off), or open the message in the <button type="button" class="edx-tool-link" style="margin-left:0;" onclick="window.edxOpenTool(\'log-viewer\')">Log Viewer</button> to see its surrounding context.</p></div>';
    return;
  }

  const many = result.matches.length > 1;
  const context = '<div class="edx-context">' + result.input.lineCount + ' line(s) analyzed · ' + stackNote + ' · '
    + '<strong>' + result.matches.length + '</strong> matched pattern' + (many ? 's' : '')
    + (many ? ' — shown most specific first. A wrapped exception\'s deepest match is usually its root cause; read the cards together.' : '') + '</div>';

  const cards = result.matches.map(edxCardHtml).join('');
  const disclaimer = '<div class="edx-disclaimer">This decoder explains error mechanisms and lists causes to check — it does not prescribe fixes. Always confirm the matched pattern fits your actual message before acting on it.</div>';
  out.innerHTML = context + cards + disclaimer;
}

window.edxAnalyze = function () {
  const input = document.getElementById('edx-input');
  const text = input ? input.value : '';
  edxRender(window.edxDecode(text));
};

// Debounced live decode as the user pastes/edits.
let edxInputTimer = null;
window.edxOnInput = function () {
  if (edxInputTimer) clearTimeout(edxInputTimer);
  edxInputTimer = setTimeout(window.edxAnalyze, 250);
};

window.edxClear = function () {
  const input = document.getElementById('edx-input');
  if (input) input.value = '';
  edxRender(window.edxDecode(''));
};

// Cross-tool hand-off: the Log Viewer "Explain" chip navigates here and feeds the
// ERROR record's full message (headline + stack) straight into the decoder.
// Exposed for unit tests and for any tool that wants the same translation.
window.edxMapTables = edxMapTables;

window.edxDecodeText = function (text) {
  const input = document.getElementById('edx-input');
  if (input) input.value = text != null ? String(text) : '';
  window.edxAnalyze();
};

window.edxLoadExample = function () {
  const input = document.getElementById('edx-input');
  if (!input) return;
  input.value = [
    "2026-07-18T09:14:22.517 [runtime-container/abc]  ERROR - Connector: com.mendix.systemwideinterfaces.core.UserException: An error has occurred while handling the request. [User 'Anonymous_9f' with roles 'Guest']",
    "com.mendix.modules.microflowengine.MicroflowException: Error in (sub)microflow call 'MyFirstModule.ACT_Order_Save'",
    "Advanced stacktrace:",
    "\tat com.mendix.modules.microflowengine.MicroflowEngine.executeMicroflow(MicroflowEngine.java:120)",
    "Caused by: org.postgresql.util.PSQLException: ERROR: duplicate key value violates unique constraint \"order_ordernumber_key\"",
    "  Detail: Key (ordernumber)=(ORD-100241) already exists.",
    "\tat org.postgresql.core.v3.QueryExecutorImpl.receiveErrorResponse(QueryExecutorImpl.java:2725)"
  ].join('\n');
  window.edxAnalyze();
};
