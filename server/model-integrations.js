// =========================================================================
// MODEL INTEGRATIONS — what the app exposes, and what it calls out to (Plan 014)
// =========================================================================
// Pure shaping over mprListUnits() output (server/mpr-reader.js). No fs, no
// sqlite here — the Bridge opens the .mpr and hands the decoded units to
// miCollect(). "What does this app expose, and what does it call?" is an
// audit-surface question the model already answers, with nothing running.
//
// Field names verified 2026-09-09 against Web Order Entry.mpr (Mendix 9.24 —
// 6 published REST services / 8 operations, 1 published OData service):
//   Rest$PublishedRestService     — Name, Path, Version, ServiceName,
//     Documentation, AllowedRoles[], AuthenticationTypes[],
//     AuthenticationMicroflow, Resources[] of Rest$PublishedRestServiceResource
//     { Name, Documentation, Operations[] of Rest$PublishedRestServiceOperation
//       { HttpMethod, Path, Microflow, Documentation } }
//   Rest$PublishedOdataServiceImpl — Name, Path, ServiceName, Version,
//     ODataVersion, Description, AllowedModuleRoles[], AuthenticationTypes[],
//     AuthenticationMicroflow, Resources[] of Rest$PublishedRestResourceImpl
//     { ExposedName, Path, DataEntity.Entity }
//
// Consumed REST and Business Events were absent from all three test projects,
// so those two shapers follow the plan's field table and the model SDK names
// and are exercised by hand-built fixtures only. The authentication field on a
// published OData service really is AllowedModuleRoles (published REST uses
// AllowedRoles).
// =========================================================================
'use strict';

const { mprArray } = require('./mpr-reader');

// A qualified name — Module.Something(.Something). A consumed-REST base URL that
// is backed by a Constant is stored as the Constant's qualified name, not a URL.
const QUALIFIED_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;

function str(v) {
  return (typeof v === 'string' && v.trim()) ? v.trim() : null;
}

function strList(v) {
  return mprArray(v).filter(function (x) { return typeof x === 'string' && x.length > 0; });
}

// ── Published REST ─────────────────────────────────────────────────────────
function miShapePublishedRest(doc) {
  const d = doc || {};
  const allowedRoles = strList(d.AllowedRoles);
  const authMicroflow = str(d.AuthenticationMicroflow);
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
  return {
    name: str(d.Name),
    path: str(d.Path),
    version: str(d.Version),
    serviceName: str(d.ServiceName),
    documentation: str(d.Documentation),
    allowedRoles: allowedRoles,
    authenticationTypes: strList(d.AuthenticationTypes),
    authenticationMicroflow: authMicroflow,
    // First approximation: no allowed roles and no authentication microflow
    // means the service answers an anonymous caller. A role that maps only to
    // the anonymous user role also counts as unauthenticated — that needs the
    // security model (plan 006) and is left as a follow-up.
    authenticated: allowedRoles.length > 0 || !!authMicroflow,
    resources: resources,
    operationCount: resources.reduce(function (n, r) { return n + r.operations.length; }, 0)
  };
}

// ── Published OData ────────────────────────────────────────────────────────
function miShapePublishedOData(doc) {
  const d = doc || {};
  const allowedRoles = strList(d.AllowedModuleRoles);
  const authMicroflow = str(d.AuthenticationMicroflow);
  const entitySets = mprArray(d.Resources).concat(mprArray(d.PublishedEntities)).map(function (r) {
    return {
      name: str(r.ExposedName) || str(r.Name),
      path: typeof r.Path === 'string' ? r.Path : '',
      entity: (r.DataEntity && str(r.DataEntity.Entity)) || str(r.Entity)
    };
  });
  return {
    name: str(d.Name),
    path: str(d.Path),
    serviceName: str(d.ServiceName),
    version: str(d.Version),
    odataVersion: str(d.ODataVersion),
    documentation: str(d.Description) || str(d.Documentation),
    allowedRoles: allowedRoles,
    authenticationTypes: strList(d.AuthenticationTypes),
    authenticationMicroflow: authMicroflow,
    authenticated: allowedRoles.length > 0 || !!authMicroflow,
    entitySets: entitySets
  };
}

// ── Consumed REST ─────────────────────────────────────────────────────────
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
  'Services$PublishedODataService': ['publishedOData', miShapePublishedOData],
  'Rest$ConsumedRestService': ['consumedRest', miShapeConsumedRest],
  'BusinessEvents$BusinessEventService': ['businessEvents', miShapeBusinessEvents]
};

// units is mprListUnits() output: [{ id, type, name, doc }]. Unknown types and
// units with no decoded doc are ignored.
function miCollect(units) {
  const out = { publishedRest: [], publishedOData: [], consumedRest: [], businessEvents: [] };
  const list = Array.isArray(units) ? units : [];
  for (const u of list) {
    if (!u || !u.doc) continue;
    const entry = DISPATCH[u.type];
    if (!entry) continue;
    out[entry[0]].push(entry[1](u.doc));
  }
  return out;
}

module.exports = {
  miShapePublishedRest,
  miShapePublishedOData,
  miShapeConsumedRest,
  miShapeBusinessEvents,
  miCollect
};
