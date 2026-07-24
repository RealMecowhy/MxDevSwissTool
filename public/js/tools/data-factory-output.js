// =========================================================================
// DATA FACTORY — OUTPUT LAYER (serializers) · prefix `dfo`
// =========================================================================
// Turns generated rows into a file format. Deliberately separate from the value
// engine (data-factory-generators.js): the engine makes values, this turns a
// grid of values into CSV / JSON / XML text. SQL is different enough — it needs
// per-column type literals and identifier quoting — that it lives with the seed
// helpers (seedInsertStatement / seedSqlLiteral), not here.
//
// Contract: colNames is an array of column names; rows is an array of value
// arrays aligned to colNames. A value is a string, number, boolean or null.
//
// Pure: attaches to window/self for scripts/parser-test.js.
// =========================================================================

const DFO_GLOBAL = (typeof window !== 'undefined' ? window : self);

function dfoCell(v) {
  if (v === null || v === undefined) return '';
  if (v === true) return 'true';
  if (v === false) return 'false';
  return String(v);
}

function dfoCsv(colNames, rows) {
  const esc = function (v) {
    const s = dfoCell(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [colNames.map(esc).join(',')];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r], cells = new Array(colNames.length);
    for (let c = 0; c < colNames.length; c++) cells[c] = esc(row[c]);
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

function dfoJson(colNames, rows) {
  const arr = new Array(rows.length);
  for (let r = 0; r < rows.length; r++) {
    const obj = {}, row = rows[r];
    for (let c = 0; c < colNames.length; c++) obj[colNames[c]] = row[c] === undefined ? null : row[c];
    arr[r] = obj;
  }
  return JSON.stringify(arr, null, 2);
}

function dfoXmlEsc(v) {
  return dfoCell(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function dfoXmlName(n) {
  const s = String(n == null ? '' : n).replace(/[^A-Za-z0-9_]/g, '');
  return /^[A-Za-z_]/.test(s) ? s : 'Field';
}

function dfoXml(colNames, rows, opts) {
  opts = opts || {};
  const root = dfoXmlName(opts.root || 'Data');
  const rec = dfoXmlName(opts.record || 'Record');
  const safeNames = colNames.map(dfoXmlName);
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<' + root + '>'];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    parts.push('  <' + rec + '>');
    for (let c = 0; c < colNames.length; c++) {
      if (row[c] === null || row[c] === undefined) continue; // a null field is an absent node
      parts.push('    <' + safeNames[c] + '>' + dfoXmlEsc(row[c]) + '</' + safeNames[c] + '>');
    }
    parts.push('  </' + rec + '>');
  }
  parts.push('</' + root + '>');
  return parts.join('\n');
}

// Convenience dispatcher used by the wizard's single-table file output.
function dfoSerialize(format, colNames, rows, opts) {
  if (format === 'json') return dfoJson(colNames, rows);
  if (format === 'xml') return dfoXml(colNames, rows, opts);
  return dfoCsv(colNames, rows);
}

DFO_GLOBAL.dfoCsv = dfoCsv;
DFO_GLOBAL.dfoJson = dfoJson;
DFO_GLOBAL.dfoXml = dfoXml;
DFO_GLOBAL.dfoSerialize = dfoSerialize;
