// =========================================================================
// MODEL i18n — translation completeness from a .mpr (Plan 010)
// =========================================================================
// "Which texts are not translated into language X" has no answer in Studio Pro
// short of clicking through every document. On the plan-006 offline reader it is
// a walk over unit BSON collecting `Texts$Text` nodes.
//
// A translatable caption/label is a `Texts$Text` node with an `Items` array
// (int32 version marker at index 0, real entries from index 1); each entry is a
// `Texts$Translation` with `LanguageCode` + `Text` (confirmed against
// Mendix_11_12 v2, Web Order Entry v1 and Calculator v2 on 2026-09-09 — the
// spelling the plan guessed was correct, so no adaptation was needed).
//
// The enabled languages and the default language live in the
// `Settings$ProjectSettings` unit, inside a `Settings$LanguageSettings` part:
// `DefaultLanguageCode` (string) and `Languages` (array marker + `Texts$Language`
// items carrying `Code`).
//
// Everything here is pure — no fs, no sqlite — so scripts/parser-test.js unit-
// tests it from hand-built decoded units. server/mendix-observability-bridge.js
// does the disk read (via server/mpr-reader.js) and feeds the units in.
// =========================================================================
'use strict';

// Model arrays carry an int32 version marker at index 0 — real values from 1.
function miArray(v) {
  return Array.isArray(v) ? v.slice(1) : [];
}

// items: [3, { LanguageCode: 'en_US', Text: 'Order' }, ...] -> { en_US: 'Order' }
// The index-0 marker is a number, not an object, so it is skipped naturally.
function miFromItems(items) {
  const out = {};
  if (!Array.isArray(items)) return out;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it !== 'object') continue;
    if (typeof it.LanguageCode === 'string') {
      out[it.LanguageCode] = typeof it.Text === 'string' ? it.Text : '';
    }
  }
  return out;
}

// Recurse into a decoded unit, pushing one record per `Texts$Text` found.
// ctx: { path:[string], unitName, unitType }
function miWalkTexts(value, ctx, out) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (i === 0 && typeof value[i] === 'number') continue; // version marker
      miWalkTexts(value[i], ctx, out);
    }
    return;
  }
  if (value.$Type === 'Texts$Text') {
    out.push({
      location: ctx.path.length ? ctx.path.join('/') : '(root)',
      unitName: ctx.unitName,
      unitType: ctx.unitType,
      byLanguage: miFromItems(value.Items)
    });
    return; // Items hold Texts$Translation only — no nested Texts$Text
  }
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === '$Type' || k === '$ID') continue;
    const nextPath = /^\d+$/.test(k) ? ctx.path : ctx.path.concat(k);
    miWalkTexts(value[k], { path: nextPath, unitName: ctx.unitName, unitType: ctx.unitType }, out);
  }
}

// units: [{ name, type, module?, doc }] — `doc` is a fully decoded unit or null.
// Returns the flat list of every Texts$Text, excluding the platform-supplied
// System-module texts (they are never "missing" — Mendix ships them).
function miCollectTexts(units) {
  const out = [];
  const list = Array.isArray(units) ? units : [];
  for (let i = 0; i < list.length; i++) {
    const u = list[i];
    if (!u || !u.doc) continue;
    if (u.type === 'Texts$SystemTextCollection') continue;
    if (u.module === 'System') continue;
    miWalkTexts(u.doc, { path: [], unitName: u.name || null, unitType: u.type || null }, out);
  }
  return out;
}

// Locate the enabled languages + default language in the decoded units.
// Returns { languages: ['en_US', ...], defaultLang: 'en_US' } or
// { languages: [], defaultLang: null } when no language settings unit is present.
function miLanguages(units) {
  const list = Array.isArray(units) ? units : [];
  let found = null;
  const walk = function (v) {
    if (found || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) walk(v[i]); return; }
    if (typeof v.DefaultLanguageCode === 'string') { found = v; return; }
    const keys = Object.keys(v);
    for (let i = 0; i < keys.length; i++) walk(v[keys[i]]);
  };
  for (let i = 0; i < list.length && !found; i++) walk(list[i] && list[i].doc);
  if (!found) return { languages: [], defaultLang: null };
  const languages = miArray(found.Languages)
    .map(l => (l && typeof l.Code === 'string') ? l.Code : null)
    .filter(Boolean);
  const defaultLang = found.DefaultLanguageCode || null;
  if (defaultLang && languages.indexOf(defaultLang) === -1) languages.unshift(defaultLang);
  return { languages: languages, defaultLang: defaultLang || (languages[0] || null) };
}

// texts:      output of miCollectTexts
// languages:  ['en_US','nl_NL']   defaultLang: 'en_US'
// Returns:
//   missing:    [{ location, unitName, language, defaultText }]
//   hardcoded:  [{ location, unitName, text }]  — present in the default language
//               only, while the project has more than one language (a heuristic)
//   byLanguage: { nl_NL: { total, translated, missing }, ... }  (non-default only)
function miGaps(texts, languages, defaultLang) {
  const langs = Array.isArray(languages) ? languages.filter(Boolean) : [];
  const others = langs.filter(l => l !== defaultLang);
  const list = Array.isArray(texts) ? texts : [];
  const missing = [];
  const hardcoded = [];
  const byLanguage = {};
  for (let i = 0; i < others.length; i++) byLanguage[others[i]] = { total: 0, translated: 0, missing: 0 };

  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const bl = (t && t.byLanguage) || {};
    const defRaw = typeof bl[defaultLang] === 'string' ? bl[defaultLang] : '';
    if (!defRaw.trim()) continue; // no default text — nothing to measure against
    let translatedElsewhere = 0;
    for (let j = 0; j < others.length; j++) {
      const l = others[j];
      const v = typeof bl[l] === 'string' ? bl[l] : '';
      byLanguage[l].total++;
      if (v.trim()) {
        byLanguage[l].translated++;
        translatedElsewhere++;
      } else {
        byLanguage[l].missing++;
        missing.push({ location: t.location, unitName: t.unitName, language: l, defaultText: defRaw });
      }
    }
    if (langs.length > 1 && others.length >= 1 && translatedElsewhere === 0) {
      hardcoded.push({ location: t.location, unitName: t.unitName, text: defRaw });
    }
  }
  return { missing: missing, hardcoded: hardcoded, byLanguage: byLanguage };
}

module.exports = {
  miArray: miArray,
  miFromItems: miFromItems,
  miWalkTexts: miWalkTexts,
  miCollectTexts: miCollectTexts,
  miLanguages: miLanguages,
  miGaps: miGaps
};
