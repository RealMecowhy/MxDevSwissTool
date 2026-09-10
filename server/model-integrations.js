// =========================================================================
// MODEL INTEGRATIONS — what the app exposes, and what it calls out to (Plan 014)
// =========================================================================
// Pure shaping over the decoded units from server/mpr-reader.js (with module
// names resolved by model-graph's mgResolveModuleNames). No fs, no sqlite here —
// the Bridge opens the .mpr and hands the units to miCollect(). "What does this
// app expose, and what does it call?" is an audit-surface question the model
// already answers, with nothing running.
//
// Field names verified 2026-09-09/10 against real projects (Mendix 9.24-11.12):
//   Rest$PublishedRestService      — Name, Path, Version, ServiceName,
//     AllowedRoles[], AuthenticationTypes[], AuthenticationMicroflow,
//     Resources[] { Name, Operations[] { HttpMethod, Path, Microflow } }
//   Rest$PublishedOdataServiceImpl — (Mendix 9) AllowedModuleRoles[],
//     AuthenticationTypes[], Resources[] { ExposedName, Path, DataEntity.Entity }
//   ODataPublish$PublishedODataService2 — (Mendix 10+) same auth fields,
//     EntitySets[] { ExposedName, EntityTypePointer } -> EntityTypes[] { $ID, Entity }
//   WebServices$PublishedService   — VersionedWebServices[] { HeaderAuthentication
//     ('None' | 'UsernamePassword' | …), HeaderMicroflow, Operations[] { Name, Microflow } }
//   Microflows$RestCallAction      — HttpConfiguration { HttpMethod,
//     CustomLocationTemplate { Text, Parameters[] { Expression } },
//     UseHttpAuthentication, HttpAuthenticationPassword, HttpHeaderEntries[] }
//
// "Requires authentication" on a published REST / OData service is the
// AuthenticationTypes list: empty means "No" — the service answers anyone, and
// its allowed roles do not apply. Roles decide who may call it once signed in.
//
// Consumed REST documents and Business Events were absent from every test
// project, so those two shapers follow the model SDK names and are exercised by
// hand-built fixtures only.
// =========================================================================
'use strict';

const { mprArray } = require('./mpr-reader');

// A qualified name — Module.Something(.Something). A consumed-REST base URL that
// is backed by a Constant is stored as the Constant's qualified name, not a URL.
const QUALIFIED_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
// A Mendix expression that is one plain string literal: 'secret'. Concatenation
// or a variable makes it something else.
const STRING_LITERAL = /^'[^']+'$/;
const SECRET_HEADER = /authorization|api[-_ ]?key|token|secret|password/i;
const EXPRESSION_PREVIEW = 80;

function str(v) {
  return (typeof v === 'string' && v.trim()) ? v.trim() : null;
}

function strList(v) {
  return mprArray(v).filter(function (x) { return typeof x === 'string' && x.length > 0; });
}

// The authentication fields shared by published REST and OData services.
function miAuth(d, rolesKey) {
  const allowedRoles = strList(d[rolesKey]);
  const authenticationTypes = strList(d.AuthenticationTypes);
  const authenticated = authenticationTypes.length > 0;
  return {
    allowedRoles: allowedRoles,
    authenticationTypes: authenticationTypes,
    authenticationMicroflow: str(d.AuthenticationMicroflow),
    // Requires authentication = No: anyone can call it.
    authenticated: authenticated,
    // Requires authentication, but no role may call it — misconfigured, or
    // every call is refused.
    noRoles: authenticated && allowedRoles.length === 0
  };
}

// ── Published REST ─────────────────────────────────────────────────────────
function miShapePublishedRest(doc) {
  const d = doc || {};
  const resources = mprArray(d.Resources).map(function (r) {
    return {
      name: str(r.Name),
      documentation: str(r.Documentation),
      operations: mprArray(r.Operations).map(function (op) {
        return {
          httpMethod: str(op.HttpMethod),
          path: typeof op.Path === 'string' ? op.Path : '',
          microflow: str(op.Microflow),
          documentation: str(op.Documentation)
        };
      })
    };
  });
  return Object.assign({
    name: str(d.Name),
    path: str(d.Path),
    version: str(d.Version),
    serviceName: str(d.ServiceName),
    documentation: str(d.Documentation)
  }, miAuth(d, 'AllowedRoles'), {
    resources: resources,
    operationCount: resources.reduce(function (n, r) { return n + r.operations.length; }, 0)
  });
}

// ── Published OData ────────────────────────────────────────────────────────
// Mendix 9 lists Resources with the entity inline; Mendix 10+ lists EntitySets
// that point at an EntityType by $ID.
function miShapePublishedOData(doc) {
  const d = doc || {};
  const typeById = {};
  for (const t of mprArray(d.EntityTypes)) {
    if (t && typeof t.$ID === 'string') typeById[t.$ID] = t;
  }
  const legacy = mprArray(d.Resources).concat(mprArray(d.PublishedEntities)).map(function (r) {
    return {
      name: str(r.ExposedName) || str(r.Name),
      path: typeof r.Path === 'string' ? r.Path : '',
      entity: (r.DataEntity && str(r.DataEntity.Entity)) || str(r.Entity)
    };
  });
  const sets = mprArray(d.EntitySets).map(function (s) {
    const t = typeById[s.EntityTypePointer];
    return { name: str(s.ExposedName), path: '', entity: t ? str(t.Entity) : null };
  });
  return Object.assign({
    name: str(d.Name),
    path: str(d.Path),
    serviceName: str(d.ServiceName),
    version: str(d.Version),
    odataVersion: str(d.ODataVersion),
    documentation: str(d.Description) || str(d.Documentation)
  }, miAuth(d, 'AllowedModuleRoles'), {
    entitySets: legacy.concat(sets)
  });
}

// ── Published SOAP ─────────────────────────────────────────────────────────
// A published web service carries one entry per version; the latest (last) is
// what the app serves.
function miShapePublishedSoap(doc) {
  const d = doc || {};
  const versions = mprArray(d.VersionedWebServices);
  const v = versions.length ? (versions[versions.length - 1] || {}) : {};
  const headerAuthentication = str(v.HeaderAuthentication);
  return {
    name: str(d.Name),
    caption: str(v.Caption),
    headerAuthentication: headerAuthentication,
    authenticationMicroflow: str(v.HeaderMicroflow),
    authenticated: !!headerAuthentication && headerAuthentication !== 'None',
    operations: mprArray(v.Operations).map(function (op) {
      return { name: str(op.Name), microflow: str(op.Microflow) };
    })
  };
}

// ── Consumed REST (the Mendix 10+ "Consumed REST service" document) ─────────
function miShapeConsumedRest(doc) {
  const d = doc || {};
  const baseUrl = str(d.BaseUrl) || str(d.Location) || str(d.BaseURL);
  return {
    name: str(d.Name),
    baseUrl: baseUrl,
    // A base URL backed by a Constant is stored as the Constant's qualified
    // name. Surface it verbatim — resolving it would leak a per-environment
    // endpoint that lives outside the model.
    baseUrlIsReference: !!baseUrl && !/:\/\//.test(baseUrl) && QUALIFIED_NAME.test(baseUrl),
    authenticationScheme: str(d.AuthenticationScheme) || str(d.Authentication),
    operations: mprArray(d.Operations).map(function (op) {
      return {
        name: str(op.Name),
        httpMethod: str(op.HttpMethod) || str(op.Method),
        location: typeof op.Location === 'string' ? op.Location
          : (typeof op.Path === 'string' ? op.Path : '')
      };
    })
  };
}

// ── Outgoing REST calls (the "Call REST service" microflow activity) ────────
// Most apps call out this way rather than through a consumed-REST document.
// `target` groups calls: the host of a literal URL, or the expression the URL
// starts with (usually a constant). Credentials are NEVER copied out — only
// whether one is typed into the microflow as a literal.
function miShapeRestCall(action, microflow) {
  const cfg = (action && action.HttpConfiguration) || {};
  const tpl = cfg.CustomLocationTemplate || {};
  const params = mprArray(tpl.Parameters).map(function (p) {
    const e = (p && typeof p.Expression === 'string') ? p.Expression.trim() : '';
    return e.length > EXPRESSION_PREVIEW ? e.slice(0, EXPRESSION_PREVIEW) + '…' : e;
  });
  const location = str(tpl.Text) || str(cfg.CustomLocation) || '';
  const hostOf = function (url) {
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#{]+)/i.exec(url);
    return m ? m[1] : null;
  };
  let target = '(no URL)';
  if (hostOf(location)) target = hostOf(location);
  else if (/^\{1\}/.test(location) && params[0]) {
    // The URL starts with an expression: a constant, a variable, or a literal.
    const first = params[0];
    target = (STRING_LITERAL.test(first) && hostOf(first.slice(1, -1))) || first;
  } else if (location) target = location.split(/[/?]/)[0] || location;

  const literal = function (v) { return typeof v === 'string' && STRING_LITERAL.test(v.trim()); };
  const hardcodedPassword = cfg.UseHttpAuthentication === true && literal(cfg.HttpAuthenticationPassword);
  // "X-…-Token-Type: 'KEYPAIR_JWT'" names a kind of token, not a secret.
  const hardcodedHeader = mprArray(cfg.HttpHeaderEntries).some(function (h) {
    return h && typeof h.Key === 'string' && SECRET_HEADER.test(h.Key) && !/type$/i.test(h.Key) && literal(h.Value);
  });
  return {
    microflow: microflow,
    httpMethod: str(cfg.HttpMethod),
    location: location,
    locationParams: params,
    target: target,
    basicAuth: cfg.UseHttpAuthentication === true,
    hardcodedCredentials: hardcodedPassword || hardcodedHeader
  };
}

function miFindRestCalls(node, microflow, out) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) miFindRestCalls(node[i], microflow, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (node.$Type === 'Microflows$RestCallAction') {
    out.push(miShapeRestCall(node, microflow));
    return;
  }
  for (const k in node) {
    if (Object.prototype.hasOwnProperty.call(node, k)) miFindRestCalls(node[k], microflow, out);
  }
}

// ── Business Events ───────────────────────────────────────────────────────
function miShapeBusinessEvents(doc) {
  const d = doc || {};
  return {
    name: str(d.Name),
    serviceName: str(d.ServiceName),
    eventNamePrefix: str(d.EventNamePrefix),
    channels: mprArray(d.Channels).map(function (c) {
      return { name: str(c.Name), microflow: str(c.Microflow) || str(c.SubscriptionMicroflow) };
    }),
    messages: mprArray(d.Messages).map(function (m) { return { name: str(m.Name) }; })
  };
}

// ── Dispatch ──────────────────────────────────────────────────────────────
const DISPATCH = {
  'Rest$PublishedRestService': ['publishedRest', miShapePublishedRest],
  'Rest$PublishedOdataServiceImpl': ['publishedOData', miShapePublishedOData],
  'ODataPublish$PublishedODataService2': ['publishedOData', miShapePublishedOData],
  'Services$PublishedODataService': ['publishedOData', miShapePublishedOData],
  'WebServices$PublishedService': ['publishedSoap', miShapePublishedSoap],
  'Rest$ConsumedRestService': ['consumedRest', miShapeConsumedRest],
  'BusinessEvents$BusinessEventService': ['businessEvents', miShapeBusinessEvents]
};

// units: [{ type, name, moduleName?, doc }] — mprListUnits output, ideally with
// module names resolved (they name the microflow behind an outgoing call).
// Unknown types and units with no decoded doc are ignored.
function miCollect(units) {
  const out = { publishedRest: [], publishedOData: [], publishedSoap: [], consumedRest: [], restCalls: [], businessEvents: [] };
  const list = Array.isArray(units) ? units : [];
  for (const u of list) {
    if (!u || !u.doc) continue;
    if (u.type === 'Microflows$Microflow') {
      const qn = (u.moduleName ? u.moduleName + '.' : '') + (u.name || '?');
      miFindRestCalls(u.doc, qn, out.restCalls);
      continue;
    }
    const entry = DISPATCH[u.type];
    if (!entry) continue;
    out[entry[0]].push(entry[1](u.doc));
  }
  out.restCalls.sort(function (a, b) {
    return a.target.localeCompare(b.target) || a.microflow.localeCompare(b.microflow);
  });
  return out;
}

module.exports = {
  miShapePublishedRest,
  miShapePublishedOData,
  miShapePublishedSoap,
  miShapeConsumedRest,
  miShapeRestCall,
  miShapeBusinessEvents,
  miCollect
};
