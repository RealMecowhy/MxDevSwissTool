// =========================================================================
// REST LOAD TESTER — MESSAGE FACTORY · prefix `plm`
// =========================================================================
// A load test that sends the same bytes 5 000 times measures a cache. This
// module turns ONE pasted sample message into an endless stream of different
// ones, so the app under test does real work: different keys, different rows,
// different query plans.
//
// Four decisions carry the design:
//
//   1. THE SAMPLE IS THE TEMPLATE, NOT A SCHEMA. What the user pasted is kept
//      verbatim and only chosen VALUES are replaced. For XML that means the
//      original text with slot offsets — no parse/serialize round-trip, so
//      namespaces, prefixes, attribute order, self-closing tags and formatting
//      survive byte for byte. Re-emitting XML through a serializer is the
//      easiest way to break a message that worked.
//
//   2. THE SAMPLE'S TYPE IS THE CONTRACT. In JSON a value is written back as
//      the type it had in the sample: a field that was "1000" (string) stays a
//      string even if a Number generator produced it. Changing 123 to "123"
//      silently breaks half the import mappings on the Mendix side, and the
//      failure surfaces as a 400 that looks like the app's fault.
//
//   3. CONFIG IS PER PATH, VALUES ARE PER SLOT. Two <line> elements share the
//      path /Order/lines/line/sku, so the user configures `sku` once — but each
//      occurrence gets its OWN generated value, because two identical SKUs in
//      one order is not test data. Same for JSON arrays, whose paths normalise
//      to `lines[].sku`.
//
//   4. CORRELATION IS A SECOND PASS. A message whose header customerId differs
//      from its line-level customerId is rejected by validation, so the test
//      would measure the error path — fast, green-looking, and meaningless. A
//      field can therefore copy another ("Same as"), resolved after every
//      independent value exists, so reference order does not matter.
//
// Pure: no DOM, no fetch. Attaches to window/self so the Bridge can `require`
// this exact file (server/perf-session.js) and scripts/parser-test.js can
// exercise it in plain Node. Browser preview and server traffic must come from
// one implementation, or the preview is a lie.
// =========================================================================

const PLM_GLOBAL = (typeof window !== 'undefined' ? window : self);

// Not a dfg generator — a Message Factory concept, resolved in pass two.
const PLM_SAME_AS = 'Same as';

// =========================================================================
// JSON: walk the parsed sample into slots
// =========================================================================

// steps  concrete location, e.g. ['order','lines',0,'sku'] — used to write
// path   config identity, e.g. 'order.lines[].sku' — array indexes collapsed,
//        so one UI row configures every element of an array
function plmJsonSlots(value, steps, path, out) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      plmJsonSlots(value[i], steps.concat(i), path + '[]', out);
    }
    return;
  }
  if (value && typeof value === 'object') {
    Object.keys(value).forEach(function (k) {
      plmJsonSlots(value[k], steps.concat(k), path ? path + '.' + k : k, out);
    });
    return;
  }
  out.push({
    steps: steps,
    path: path,
    name: plmLeafName(path),
    sample: value,
    jsonType: value === null ? 'null' : typeof value
  });
}

function plmLeafName(path) {
  const clean = String(path || '').replace(/\[\]/g, '');
  const parts = clean.split(/[./]/);
  const last = parts[parts.length - 1] || '';
  return last.replace(/^@/, '');
}

// =========================================================================
// XML: scan the raw text into slots with character offsets
// =========================================================================
// Deliberately a scanner and not a DOM parse: the output has to be the input's
// exact bytes outside the replaced spans, and it has to run in Node without a
// DOM implementation.

// '>' that actually closes the tag — one inside an attribute value does not.
function plmFindTagEnd(text, from) {
  let quote = '';
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i;
  }
  return -1;
}

// Attribute VALUES become slots (the span inside the quotes, quotes excluded).
function plmXmlAttrSlots(text, from, to, elemPath, out) {
  const re = /([^\s=/<>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  const chunk = text.slice(from, to);
  let m;
  while ((m = re.exec(chunk)) !== null) {
    const attr = m[1];
    // A namespace declaration is structure, not data. Varying xmlns:soap turns
    // a valid SOAP envelope into something the service cannot even route.
    if (attr === 'xmlns' || attr.indexOf('xmlns:') === 0) continue;
    const raw = m[2];
    const valueStart = from + m.index + m[0].length - raw.length + 1;
    const value = raw.slice(1, -1);
    out.push({
      start: valueStart,
      end: valueStart + value.length,
      path: elemPath + '/@' + attr,
      name: attr,
      sample: value,
      xmlAttr: true,
      // xsi:type / xsi:nil drive how the receiver deserializes the element.
      // Listed so the user can see them, but left alone unless asked.
      structural: attr.indexOf('xsi:') === 0
    });
  }
}

function plmXmlSlots(text) {
  const out = [];
  const stack = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;

    // Text node: only inside an element, only if it carries something.
    if (lt > i && stack.length) {
      const raw = text.slice(i, lt);
      if (raw.trim()) {
        // Slot covers the trimmed run, so surrounding indentation survives.
        const lead = raw.length - raw.replace(/^\s+/, '').length;
        const trail = raw.length - raw.replace(/\s+$/, '').length;
        out.push({
          start: i + lead,
          end: lt - trail,
          path: '/' + stack.join('/'),
          name: stack[stack.length - 1],
          sample: raw.trim()
        });
      }
    }

    // Prologue, comments, CDATA and doctype are copied through untouched.
    // A CDATA section in particular is content the user chose to protect.
    if (text.startsWith('<!--', lt)) { const e = text.indexOf('-->', lt); i = e === -1 ? n : e + 3; continue; }
    if (text.startsWith('<![CDATA[', lt)) { const e = text.indexOf(']]>', lt); i = e === -1 ? n : e + 3; continue; }
    if (text.startsWith('<?', lt)) { const e = text.indexOf('?>', lt); i = e === -1 ? n : e + 2; continue; }
    if (text.startsWith('<!', lt)) { const e = plmFindTagEnd(text, lt); i = e === -1 ? n : e + 1; continue; }

    const gt = plmFindTagEnd(text, lt);
    if (gt === -1) break;
    const inner = text.slice(lt + 1, gt);

    if (inner[0] === '/') { stack.pop(); i = gt + 1; continue; }

    const nameMatch = /^[^\s/>]+/.exec(inner);
    const name = nameMatch ? nameMatch[0] : '';
    stack.push(name);
    plmXmlAttrSlots(text, lt + 1 + name.length, gt, '/' + stack.join('/'), out);
    if (inner[inner.length - 1] === '/') stack.pop();
    i = gt + 1;
  }

  return out;
}

// =========================================================================
// ANALYSIS — sample text → { kind, slots, fields }
// =========================================================================

function plmDetectKind(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return 'empty';
  if (t[0] === '{' || t[0] === '[') return 'json';
  if (t[0] === '<') return 'xml';
  return 'text';
}

// The family a generator hint is matched against. XML carries no types, so the
// sample VALUE is read: "2025-01-30" is a date, "42" a number, "true" a bool.
function plmFamilyOf(sample, jsonType) {
  if (jsonType === 'number') return 'number';
  if (jsonType === 'boolean') return 'bool';
  const s = String(sample == null ? '' : sample).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return 'number';
  if (/^(true|false)$/i.test(s)) return 'bool';
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(s)) return 'date';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return 'uuid';
  return 'text';
}

// Whole words, not substrings: `validate` ends in the letters "date" and is a
// boolean, `paid` ends in "id" and is not a key. Splitting camelCase and
// separators first is what keeps a name rule from firing on an accident.
function plmNameTokens(name) {
  return String(name == null ? '' : name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(function (s) { return s.toLowerCase(); });
}

const PLM_NUMBER_WORDS = ['id', 'ids', 'number', 'nr', 'count', 'qty', 'quantity', 'amount', 'index', 'page', 'size', 'limit', 'offset', 'total'];
const PLM_DATE_WORDS = ['date', 'day', 'from', 'to', 'since', 'until', 'timestamp'];
const PLM_UUID_WORDS = ['guid', 'uuid'];

function plmHasWord(tokens, words) {
  for (let i = 0; i < tokens.length; i++) if (words.indexOf(tokens[i]) !== -1) return true;
  return false;
}

function plmUrlFamily(name) {
  const tokens = plmNameTokens(name);
  if (plmHasWord(tokens, PLM_UUID_WORDS)) return 'uuid';
  if (plmHasWord(tokens, PLM_NUMBER_WORDS)) return 'number';
  if (plmHasWord(tokens, PLM_DATE_WORDS)) return 'date';
  return 'text';
}

function plmFallbackFor(family) {
  if (family === 'number') return 'Number';
  if (family === 'bool') return 'Boolean';
  if (family === 'date') return 'Date';
  if (family === 'uuid') return 'UUID';
  return 'String';
}

// One config row per path, in first-seen order. `occurrences` tells the user a
// row drives several places in the message (an array's elements).
function plmFieldsFromSlots(slots, origin, hints) {
  const byPath = {};
  const fields = [];
  const pick = PLM_GLOBAL.dfPickGenerator;

  slots.forEach(function (s) {
    if (byPath[s.path]) { byPath[s.path].occurrences++; return; }
    // A URL placeholder has no sample value to read a type from, so the name is
    // all there is — unless the caller knows better. An OpenAPI import does:
    // the spec declares the parameter's type, and a declared type beats any
    // amount of guessing from a name.
    // A hint is what an API specification DECLARED about this field. It beats
    // both the name rules and the sample value, which are inferences.
    const hint = hints ? (origin === 'url' ? hints[s.name] : hints[s.path]) : null;
    const hintFamily = hint ? (typeof hint === 'string' ? hint : hint.family) : null;
    const family = hintFamily || (origin === 'url' ? plmUrlFamily(s.name) : plmFamilyOf(s.sample, s.jsonType));
    const fallback = plmFallbackFor(family);
    const decided = pick ? pick(s.name, family, fallback) : { type: fallback, reason: 'from the sample value' };
    // A declared enumeration is the strongest hint of all: anything outside the
    // list comes back 400, so the run would measure validation, not the app.
    const enumValues = (hint && hint.enumValues && hint.enumValues.length) ? hint.enumValues : null;
    const f = {
      path: s.path,
      name: s.name,
      origin: origin || 'body',
      sample: s.sample,
      family: family,
      gen: enumValues ? 'Enum' : decided.type,
      reason: enumValues ? 'the specification lists the allowed values'
        : (hintFamily ? 'from the API specification' : decided.reason),
      params: enumValues
        ? { values: enumValues, weights: [] }
        : (PLM_GLOBAL.dfgDefaults ? PLM_GLOBAL.dfgDefaults(decided.type) : {}),
      constant: !!s.structural,
      unique: false,
      occurrences: 1
    };
    byPath[s.path] = f;
    fields.push(f);
  });

  return fields;
}

// `{name}` — OpenAPI's own path-template syntax, so a spec imported later fills
// these in the format it already writes.
//
// The path is namespaced `url:` because a placeholder and a top-level body
// field routinely share a name — `/orders/{orderId}` posting a body that also
// has `orderId`. Sharing one key would make editing one row silently retune the
// other, which is the kind of bug nobody thinks to look for.
function plmUrlSlots(url) {
  const out = [];
  const re = /\{([^{}\s]+)\}/g;
  let m;
  while ((m = re.exec(String(url || ''))) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, path: 'url:' + m[1], name: m[1], sample: '' });
  }
  return out;
}

// The single entry point the UI calls. Never throws: a malformed sample is a
// typo, and an error message beats a stack trace.
// hints — optional knowledge from an API specification, in two parts:
//   { url:  { placeholderName: family | {family, enumValues} },
//     body: { fieldPath:       {family, enumValues} } }
// A plain string is accepted for url entries so a caller with nothing but a
// family stays simple.
function plmAnalyze(sampleText, urlTemplate, hints) {
  const urlHints = hints && hints.url ? hints.url : hints;
  const bodyHints = hints && hints.body ? hints.body : null;
  const kind = plmDetectKind(sampleText);
  const result = { kind: kind, source: String(sampleText == null ? '' : sampleText), fields: [], error: '' };

  if (kind === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(result.source);
    } catch (e) {
      result.error = 'Not valid JSON: ' + e.message;
      return plmWithUrlFields(result, urlTemplate, urlHints);
    }
    const slots = [];
    plmJsonSlots(parsed, [], '', slots);
    result.fields = plmFieldsFromSlots(slots, 'body', bodyHints);
  } else if (kind === 'xml') {
    result.fields = plmFieldsFromSlots(plmXmlSlots(result.source), 'body', bodyHints);
    if (result.fields.length === 0) result.error = 'No text or attribute values found in this XML.';
  } else if (kind === 'text') {
    result.error = 'The sample is neither JSON nor XML — it will be sent unchanged.';
  }

  return plmWithUrlFields(result, urlTemplate, urlHints);
}

function plmWithUrlFields(result, urlTemplate, urlHints) {
  const urlFields = plmFieldsFromSlots(plmUrlSlots(urlTemplate), 'url', urlHints);
  result.fields = urlFields.concat(result.fields);
  return result;
}

// =========================================================================
// COMPILE — done once per run, not per request
// =========================================================================

function plmSplitBySlots(text, slots) {
  const sorted = slots.slice().sort(function (a, b) { return a.start - b.start; });
  const parts = [];
  const paths = [];
  let at = 0;
  sorted.forEach(function (s) {
    parts.push(text.slice(at, s.start));
    paths.push(s.path);
    at = s.end;
  });
  parts.push(text.slice(at));
  return { parts: parts, paths: paths };
}

function plmCompile(message) {
  message = message || {};
  const kind = message.kind || plmDetectKind(message.source);
  const compiled = {
    kind: kind,
    fields: message.fields || [],
    seed: message.seed || 1,
    urlTemplate: message.urlTemplate || '',
    // Always kept: if the sample turns out to be unparseable, the run still
    // sends what the user pasted rather than silently sending no body at all.
    raw: message.source || '',
    error: ''
  };

  const byPath = {};
  compiled.fields.forEach(function (f) { byPath[f.path] = f; });
  compiled.byPath = byPath;

  if (compiled.urlTemplate) {
    const u = plmSplitBySlots(compiled.urlTemplate, plmUrlSlots(compiled.urlTemplate));
    compiled.urlParts = u.parts;
    compiled.urlPaths = u.paths;
  }

  if (kind === 'json') {
    try {
      compiled.jsonTemplate = JSON.parse(message.source);
    } catch (e) {
      compiled.error = 'Not valid JSON: ' + e.message;
      return compiled;
    }
    const slots = [];
    plmJsonSlots(compiled.jsonTemplate, [], '', slots);
    compiled.jsonSlots = slots;
  } else if (kind === 'xml') {
    // Scanned once and sorted once: plmSplitBySlots sorts internally, so a
    // second unsorted copy here would silently pair a value with the wrong slot.
    const slots = plmXmlSlots(message.source).sort(function (a, b) { return a.start - b.start; });
    const x = plmSplitBySlots(message.source, slots);
    compiled.xmlParts = x.parts;
    compiled.xmlPaths = x.paths;
    compiled.xmlSlots = slots;
  }

  return compiled;
}

// =========================================================================
// RENDER — one message per request
// =========================================================================

// Each message gets its own value stream, derived from the run seed and the
// request index, so message N is byte-identical on a re-run with the same seed
// — and independent of how many threads happened to be racing.
function plmRngFor(seed, index) {
  const mixed = ((seed | 0) + Math.imul(index | 0, 2654435761)) | 0;
  return PLM_GLOBAL.dfgRng ? PLM_GLOBAL.dfgRng(mixed) : Math.random;
}

// Values are produced PER SLOT (so repeated elements differ) but the first
// value seen for a path is what "Same as" copies.
function plmSlotValues(compiled, paths, index, rng, firstByPath) {
  const values = new Array(paths.length);
  const copies = [];

  for (let i = 0; i < paths.length; i++) {
    const f = compiled.byPath[paths[i]];
    if (!f || f.constant) { values[i] = undefined; continue; }   // keep the sample
    if (f.gen === PLM_SAME_AS) { copies.push(i); continue; }
    const v = PLM_GLOBAL.dfgGenerate
      ? PLM_GLOBAL.dfgGenerate(f.gen, f.params, { rowIndex: index, unique: !!f.unique }, rng)
      : f.sample;
    values[i] = v;
    if (!(paths[i] in firstByPath)) firstByPath[paths[i]] = v;
  }

  // Pass two: every independent value now exists, so a reference can point
  // forward as happily as backward.
  copies.forEach(function (i) {
    const f = compiled.byPath[paths[i]];
    const ref = (f.params && f.params.ref) || '';
    values[i] = ref in firstByPath ? firstByPath[ref] : f.sample;
  });

  return values;
}

function plmXmlEscape(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function plmXmlAttrEscape(v) {
  return plmXmlEscape(v).replace(/"/g, '&quot;');
}

// A generated value adopts the sample's JSON type — see decision 2 in the
// header. Only a sample that was already null has no type to preserve.
function plmCoerceJson(value, sampleType) {
  if (value === null || value === undefined) return null;
  if (sampleType === 'string') return String(value);
  if (sampleType === 'number') {
    const n = Number(value);
    return isFinite(n) ? n : 0;
  }
  if (sampleType === 'boolean') {
    if (typeof value === 'boolean') return value;
    return /^(true|1|yes)$/i.test(String(value));
  }
  return value;
}

function plmSetAtSteps(root, steps, value) {
  let node = root;
  for (let i = 0; i < steps.length - 1; i++) node = node[steps[i]];
  node[steps[steps.length - 1]] = value;
}

function plmRender(compiled, index) {
  const rng = plmRngFor(compiled.seed, index);
  const firstByPath = {};
  const out = { url: compiled.urlTemplate, body: undefined };

  // The URL goes first so a body field can copy a path parameter.
  if (compiled.urlParts) {
    const vals = plmSlotValues(compiled, compiled.urlPaths, index, rng, firstByPath);
    let url = compiled.urlParts[0];
    for (let i = 0; i < vals.length; i++) {
      const bare = String(compiled.urlPaths[i]).replace(/^url:/, '');
      const raw = vals[i] === undefined ? '{' + bare + '}' : vals[i];
      url += encodeURIComponent(String(raw)) + compiled.urlParts[i + 1];
    }
    out.url = url;
  }

  if (compiled.kind === 'json' && compiled.jsonTemplate !== undefined) {
    const paths = compiled.jsonSlots.map(function (s) { return s.path; });
    const vals = plmSlotValues(compiled, paths, index, rng, firstByPath);
    const doc = JSON.parse(JSON.stringify(compiled.jsonTemplate));
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] === undefined) continue;
      const slot = compiled.jsonSlots[i];
      plmSetAtSteps(doc, slot.steps, plmCoerceJson(vals[i], slot.jsonType));
    }
    out.body = JSON.stringify(doc);
  } else if (compiled.kind === 'xml' && compiled.xmlParts) {
    const vals = plmSlotValues(compiled, compiled.xmlPaths, index, rng, firstByPath);
    let s = compiled.xmlParts[0];
    for (let i = 0; i < vals.length; i++) {
      const slot = compiled.xmlSlots[i];
      const keep = vals[i] === undefined;
      const raw = keep ? slot.sample : vals[i];
      const text = raw === null ? '' : (slot.xmlAttr ? plmXmlAttrEscape(raw) : plmXmlEscape(raw));
      s += text + compiled.xmlParts[i + 1];
    }
    out.body = s;
  } else {
    out.body = compiled.raw;
  }

  return out;
}

// Cheap Content-Type when the user did not set one: a mismatched header is a
// 415 that looks like the app rejecting valid data.
function plmContentType(kind) {
  if (kind === 'json') return 'application/json';
  if (kind === 'xml') return 'application/xml';
  return '';
}

PLM_GLOBAL.PLM_SAME_AS = PLM_SAME_AS;
PLM_GLOBAL.plmDetectKind = plmDetectKind;
PLM_GLOBAL.plmAnalyze = plmAnalyze;
PLM_GLOBAL.plmUrlSlots = plmUrlSlots;
PLM_GLOBAL.plmXmlSlots = plmXmlSlots;
PLM_GLOBAL.plmCompile = plmCompile;
PLM_GLOBAL.plmRender = plmRender;
PLM_GLOBAL.plmContentType = plmContentType;
PLM_GLOBAL.plmFamilyOf = plmFamilyOf;
