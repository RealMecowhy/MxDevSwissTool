// =========================================================================
// REST LOAD TESTER — OPENAPI / SWAGGER IMPORT · prefix `plo`
// =========================================================================
// Typing a Mendix published REST operation into the tester by hand — URL,
// method, headers, a body that matches the contract — is where a load test
// gets abandoned. The service already publishes all of it. This module reads
// that document and fills the form.
//
// JSON only, by decision: Mendix publishes `openapi.json`, so the URL path
// works out of the box, and a YAML parser would be a dependency (or worse, a
// hand-rolled subset that silently mis-parses a nested schema).
//
// Both dialects are read because Mendix versions differ in what they emit:
// OpenAPI 3 (`servers`, `requestBody.content`) and Swagger 2 (`host` +
// `basePath` + `schemes`, a `body` parameter). They disagree about structure,
// never about intent, so the parser normalises both into one operation shape.
//
// Two rules decide what a generated sample looks like:
//
//   1. AN EXAMPLE IN THE SPEC ALWAYS WINS. If the author wrote `example`, that
//      is real knowledge about the service; anything synthesised from a bare
//      `type: string` is a guess. Guesses are only used where nothing is given.
//
//   2. RECURSION MUST TERMINATE. Domain models are full of self-referential
//      schemas (an Order holding Lines holding an Order). A naive $ref walk
//      hangs the browser tab, so a schema already being expanded is emitted as
//      null rather than followed again.
//
// The path template is emitted with `{placeholders}` intact — the Message
// Factory reads exactly that syntax, so an imported operation flows straight
// into per-request variation with no adapter in between.
//
// Pure: no DOM, no fetch. Attaches to window/self for scripts/parser-test.js.
// =========================================================================

const PLO_GLOBAL = (typeof window !== 'undefined' ? window : self);

const PLO_MAX_DEPTH = 12;
const PLO_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

// =========================================================================
// SPEC SHAPE
// =========================================================================

function ploDetectVersion(spec) {
  if (!spec || typeof spec !== 'object') return '';
  if (typeof spec.openapi === 'string' && spec.openapi.indexOf('3') === 0) return '3';
  if (spec.swagger === '2.0' || spec.swagger === 2) return '2';
  // Some generators omit the version marker; the structure still tells them
  // apart, and refusing a usable document over a missing field helps nobody.
  if (spec.components || (spec.servers && spec.paths)) return '3';
  if (spec.definitions || spec.basePath || spec.host) return '2';
  return spec.paths ? '3' : '';
}

// The origin + base path the operation paths hang off. A relative server URL
// ("/rest/myservice/v1", which Mendix emits) is resolved against the URL the
// document itself came from — that is the only place the host is known.
function ploBaseUrl(spec, version, specUrl) {
  let base = '';
  if (version === '3') {
    const servers = Array.isArray(spec.servers) ? spec.servers : [];
    base = servers.length && servers[0] && servers[0].url ? String(servers[0].url) : '';
  } else {
    const scheme = (Array.isArray(spec.schemes) && spec.schemes.length) ? spec.schemes[0] : 'https';
    if (spec.host) base = scheme + '://' + spec.host + (spec.basePath || '');
    else base = spec.basePath || '';
  }

  if (/^https?:\/\//i.test(base)) return base.replace(/\/+$/, '');
  if (specUrl) {
    try {
      const origin = new URL(specUrl).origin;
      return (origin + (base.indexOf('/') === 0 ? base : '/' + base)).replace(/\/+$/, '');
    } catch (e) { /* fall through to the bare base */ }
  }
  return base.replace(/\/+$/, '');
}

// Path-level parameters apply to every operation under that path; operation
// level wins on a (name, in) collision.
function ploMergeParams(pathParams, opParams) {
  const out = (pathParams || []).slice();
  (opParams || []).forEach(function (p) {
    const i = out.findIndex(function (q) { return q && p && q.name === p.name && q.in === p.in; });
    if (i === -1) out.push(p); else out[i] = p;
  });
  return out.filter(Boolean);
}

function ploParseSpec(text, specUrl) {
  const result = { ok: false, error: '', title: '', version: '', baseUrl: '', operations: [], spec: null };

  let spec;
  if (text && typeof text === 'object') {
    spec = text;
  } else {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) { result.error = 'Nothing to parse.'; return result; }
    if (raw[0] !== '{') {
      result.error = raw.indexOf('openapi:') !== -1 || raw.indexOf('swagger:') !== -1
        ? 'This looks like YAML. Paste the JSON form of the spec (Mendix publishes openapi.json).'
        : 'Not a JSON document.';
      return result;
    }
    try {
      spec = JSON.parse(raw);
    } catch (e) {
      result.error = 'Not valid JSON: ' + e.message;
      return result;
    }
  }

  const version = ploDetectVersion(spec);
  if (!version) { result.error = 'This JSON is not an OpenAPI or Swagger document.'; return result; }
  if (!spec.paths || typeof spec.paths !== 'object') { result.error = 'The document has no "paths" section.'; return result; }

  result.spec = spec;
  result.version = version;
  result.title = (spec.info && spec.info.title) ? String(spec.info.title) : '';
  result.baseUrl = ploBaseUrl(spec, version, specUrl);

  Object.keys(spec.paths).forEach(function (path) {
    const item = spec.paths[path];
    if (!item || typeof item !== 'object') return;
    PLO_METHODS.forEach(function (m) {
      const op = item[m];
      if (!op || typeof op !== 'object') return;
      result.operations.push({
        method: m.toUpperCase(),
        path: path,
        summary: String(op.summary || op.description || '').split('\n')[0].slice(0, 120),
        operationId: op.operationId || '',
        params: ploMergeParams(item.parameters, op.parameters),
        op: op
      });
    });
  });

  if (result.operations.length === 0) { result.error = 'The document declares no operations.'; return result; }
  result.ok = true;
  return result;
}

// =========================================================================
// SCHEMA → SAMPLE VALUE
// =========================================================================

function ploResolveRef(spec, ref) {
  if (typeof ref !== 'string' || ref.indexOf('#/') !== 0) return null;
  const parts = ref.slice(2).split('/');
  let node = spec;
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i].replace(/~1/g, '/').replace(/~0/g, '~');
    if (!node || typeof node !== 'object') return null;
    node = node[key];
  }
  return node && typeof node === 'object' ? node : null;
}

// allOf is a merge; oneOf/anyOf pick the first branch, because a load test
// needs one concrete shape and the first is the author's primary case.
function ploFlatten(spec, schema, seen) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.$ref) {
    if (seen.indexOf(schema.$ref) !== -1) return null;   // cycle
    const target = ploResolveRef(spec, schema.$ref);
    if (!target) return null;
    return ploFlatten(spec, target, seen.concat(schema.$ref));
  }
  if (Array.isArray(schema.allOf)) {
    const merged = { type: 'object', properties: {}, required: [] };
    schema.allOf.forEach(function (part) {
      const flat = ploFlatten(spec, part, seen);
      if (!flat) return;
      Object.assign(merged.properties, flat.properties || {});
      if (Array.isArray(flat.required)) merged.required = merged.required.concat(flat.required);
      if (flat.example !== undefined && merged.example === undefined) merged.example = flat.example;
    });
    Object.keys(schema).forEach(function (k) {
      if (k !== 'allOf' && merged[k] === undefined) merged[k] = schema[k];
    });
    return merged;
  }
  const branch = Array.isArray(schema.oneOf) ? schema.oneOf[0] : (Array.isArray(schema.anyOf) ? schema.anyOf[0] : null);
  if (branch) return ploFlatten(spec, branch, seen);
  return schema;
}

// A value that is plausible for the FORMAT, not just the type: "2025-01-30"
// rather than "string" for a date. The Message Factory reads these back to
// infer a generator, so a shapeless placeholder would cost real accuracy.
function ploByFormat(schema, name) {
  const fmt = String(schema.format || '').toLowerCase();
  if (fmt === 'date') return '2025-01-30';
  if (fmt === 'date-time') return '2025-01-30T10:15:00Z';
  if (fmt === 'uuid') return '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  if (fmt === 'email') return 'user@example.com';
  if (fmt === 'byte') return 'ZXhhbXBsZQ==';
  if (fmt === 'binary') return '';
  if (fmt === 'uri' || fmt === 'url') return 'https://example.com/resource';
  const n = String(name || '').toLowerCase();
  if (n.indexOf('email') !== -1) return 'user@example.com';
  if (n.indexOf('date') !== -1) return '2025-01-30';
  return 'string';
}

// `collect` (optional) gathers what the SCHEMA knows about each leaf, keyed by
// the same path the Message Factory uses. A declared enum is the clearest case:
// a Mendix enumeration attribute rejects anything outside its list, so a random
// string there means every single request comes back 400 and the run measures
// validation instead of the app.
function ploSampleValue(spec, schema, name, depth, seen, collect, path) {
  if (depth > PLO_MAX_DEPTH) return null;
  const flat = ploFlatten(spec, schema, seen || []);
  if (!flat) return null;

  // Rule 1: an example in the document is knowledge, not a guess.
  const isLeaf = flat.example !== undefined || flat.default !== undefined || (Array.isArray(flat.enum) && flat.enum.length);
  if (isLeaf && collect && path) collect[path] = ploLeafHint(flat);
  if (flat.example !== undefined) return flat.example;
  if (flat.default !== undefined) return flat.default;
  if (Array.isArray(flat.enum) && flat.enum.length) return flat.enum[0];

  const nextSeen = (seen || []).concat(schema && schema.$ref ? [schema.$ref] : []);
  const type = flat.type || (flat.properties ? 'object' : (flat.items ? 'array' : 'string'));

  if (type === 'object') {
    const props = flat.properties || {};
    const out = {};
    Object.keys(props).forEach(function (key) {
      const childPath = path ? path + '.' + key : key;
      const v = ploSampleValue(spec, props[key], key, depth + 1, nextSeen, collect, childPath);
      out[key] = v === undefined ? null : v;
    });
    return out;
  }
  if (type === 'array') {
    // Two elements, not one: it is the second that proves the Message Factory
    // varies repeated items independently, and bulk payloads are the point.
    const item = ploSampleValue(spec, flat.items, name, depth + 1, nextSeen, collect, path ? path + '[]' : '');
    return item === undefined || item === null ? [] : [item, item];
  }
  if (collect && path) collect[path] = ploLeafHint(flat);
  if (type === 'integer') return 1;
  if (type === 'number') return 1.5;
  if (type === 'boolean') return true;
  return ploByFormat(flat, name);
}

// =========================================================================
// OPERATION → REQUEST
// =========================================================================

// OpenAPI type/format → the family the Message Factory reasons in. Swagger 2
// puts the type on the parameter itself, OpenAPI 3 nests it under `schema`.
// What the schema declares about one leaf, in the shape the Message Factory
// consumes: a family, plus the allowed values when the schema names them.
function ploLeafHint(flat) {
  const hint = {};
  const type = String(flat.type || '').toLowerCase();
  const fmt = String(flat.format || '').toLowerCase();
  if (type === 'integer' || type === 'number') hint.family = 'number';
  else if (type === 'boolean') hint.family = 'bool';
  else if (fmt === 'uuid') hint.family = 'uuid';
  else if (fmt === 'date' || fmt === 'date-time') hint.family = 'date';
  else hint.family = 'text';
  if (Array.isArray(flat.enum) && flat.enum.length) hint.enumValues = flat.enum.map(String);
  return hint;
}

function ploParamFamily(spec, param) {
  const flat = ploFlatten(spec, param.schema || param, []) || {};
  const type = String(flat.type || '').toLowerCase();
  const fmt = String(flat.format || '').toLowerCase();
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'boolean') return 'bool';
  if (fmt === 'uuid') return 'uuid';
  if (fmt === 'date' || fmt === 'date-time') return 'date';
  return 'text';
}

function ploBodySchema(spec, operation, version) {
  const op = operation.op || {};
  if (version === '3') {
    const content = (op.requestBody && op.requestBody.content) || {};
    const key = Object.keys(content).filter(function (k) { return k.indexOf('json') !== -1; })[0]
      || Object.keys(content).filter(function (k) { return k.indexOf('xml') !== -1; })[0]
      || Object.keys(content)[0];
    if (!key) return null;
    const media = content[key] || {};
    return { schema: media.schema, example: media.example, contentType: key };
  }
  const bodyParam = (operation.params || []).filter(function (p) { return p.in === 'body'; })[0];
  if (!bodyParam) return null;
  const consumes = Array.isArray(op.consumes) ? op.consumes : (Array.isArray(spec.consumes) ? spec.consumes : []);
  return { schema: bodyParam.schema, example: undefined, contentType: consumes[0] || 'application/json' };
}

// Everything the form needs, in the shape the form expects. Query parameters
// become {placeholders} rather than fixed values, so the Message Factory can
// vary them the same way it varies the body — a load test that reads the same
// row a thousand times is measuring a cache.
function ploOperationRequest(parsed, operation) {
  const spec = parsed.spec;
  const version = parsed.version;
  const out = { method: operation.method, url: '', headers: {}, sample: '', kind: '', notes: [], paramFamilies: {}, bodyHints: {} };

  let url = (parsed.baseUrl || '') + operation.path;

  const params = operation.params || [];
  const query = [];
  params.forEach(function (p) {
    if (!p || !p.name) return;
    // The spec declares the parameter's type. Handing that to the Message
    // Factory beats letting it guess from the name — `validate` is a boolean
    // whose name happens to end in the letters "date".
    if (p.in === 'path' || p.in === 'query') out.paramFamilies[p.name] = ploParamFamily(spec, p);
    if (p.in === 'query') {
      if (p.required) query.push(encodeURIComponent(p.name) + '={' + p.name + '}');
    } else if (p.in === 'header') {
      const schema = p.schema || p;
      const v = ploSampleValue(spec, schema, p.name, 0, []);
      out.headers[p.name] = v === null || typeof v === 'object' ? '' : String(v);
    }
  });
  if (query.length) url += (url.indexOf('?') === -1 ? '?' : '&') + query.join('&');
  out.url = url;

  const body = ploBodySchema(spec, operation, version);
  if (body) {
    let sample = body.example;
    if (sample === undefined && body.schema) sample = ploSampleValue(spec, body.schema, '', 0, [], out.bodyHints, '');
    if (sample !== undefined && sample !== null) {
      if (String(body.contentType).indexOf('xml') !== -1) {
        out.kind = 'xml';
        out.sample = typeof sample === 'string' ? sample : ploToXml(sample, operation);
        out.notes.push('The service declares ' + body.contentType + '. The sample was built from the schema — check the element names against a real message before trusting it.');
      } else {
        out.kind = 'json';
        out.sample = JSON.stringify(sample, null, 2);
      }
      out.headers['Content-Type'] = body.contentType;
    }
  }

  const pathParams = params.filter(function (p) { return p && p.in === 'path'; }).length;
  if (pathParams) out.notes.push(pathParams + ' path parameter' + (pathParams === 1 ? '' : 's') + ' left as {placeholders} — the Message Factory will vary them.');
  return out;
}

// A schema-derived XML sample is a best effort: OpenAPI's xml bindings
// (namespaces, attributes, wrapped arrays) are not modelled here, which is why
// the caller attaches a warning next to it.
function ploToXml(value, operation) {
  const root = (operation && operation.operationId) ? String(operation.operationId).replace(/[^A-Za-z0-9_]/g, '') || 'Request' : 'Request';
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + ploXmlNode(root, value, 0);
}

function ploXmlNode(name, value, depth) {
  const pad = new Array(depth + 1).join('  ');
  const safe = String(name).replace(/[^A-Za-z0-9_]/g, '') || 'Field';
  if (Array.isArray(value)) {
    return value.map(function (v) { return ploXmlNode(safe, v, depth); }).join('\n');
  }
  if (value && typeof value === 'object') {
    const inner = Object.keys(value).map(function (k) { return ploXmlNode(k, value[k], depth + 1); }).join('\n');
    return pad + '<' + safe + '>\n' + inner + '\n' + pad + '</' + safe + '>';
  }
  const text = value === null || value === undefined ? '' : String(value);
  return pad + '<' + safe + '>' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</' + safe + '>';
}

PLO_GLOBAL.ploParseSpec = ploParseSpec;
PLO_GLOBAL.ploOperationRequest = ploOperationRequest;
PLO_GLOBAL.ploSampleValue = ploSampleValue;
PLO_GLOBAL.ploLeafHint = ploLeafHint;
PLO_GLOBAL.ploResolveRef = ploResolveRef;
PLO_GLOBAL.ploBaseUrl = ploBaseUrl;
PLO_GLOBAL.ploDetectVersion = ploDetectVersion;
