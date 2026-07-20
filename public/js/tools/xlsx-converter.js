// =========================================================================
// EXCEL CONVERTER (.xlsx → JSON / CSV) · prefix `xls`
// =========================================================================
// Converts an Excel workbook — the whole file or one selected sheet — into
// JSON or CSV, entirely in the browser. The usual route (open Excel → Save As
// CSV → fix the encoding and the separator by hand) is replaced by a drop zone.
//
// ZERO NEW DEPENDENCIES, and that is the whole design constraint:
//
//   • .xlsx is a ZIP of XML parts, so the archive is read with the native
//     `DecompressionStream('deflate-raw')` — the same trick the parked
//     Deployment Package Inspector was costed with. Only the two compression
//     methods a spreadsheet actually uses are supported (stored + deflate).
//   • The XML is read with a small scanner rather than `DOMParser`, for two
//     reasons: DOMParser does not exist in Node, so every pure function here
//     would be untestable; and a sheet with 100k rows builds a DOM far more
//     expensive than the flat scan the data warrants. Sheet XML is machine
//     generated and well-formed, which is exactly when scanning is safe.
//   • .xls (the binary pre-2007 format) is NOT a ZIP and is out of scope —
//     the loader detects it and says "save as .xlsx" instead of failing with a
//     confusing parse error.
//
// The pure layer (xlsParse* / xlsRowsTo* / xlsSerialToIso) attaches to
// window/self so `scripts/parser-test.js` can exercise it in plain Node; the
// DOM handlers below never run at import time.
//
// Data principle: a workbook whose sheets are all empty produces an explicit
// "this sheet has no rows" note, never a blank table pretending to be output.
// =========================================================================

const XLS_GLOBAL = (typeof window !== 'undefined' ? window : self);

// ── XML text ──────────────────────────────────────────────────────────────

// Entity + escape decoding for the text nodes we lift out of the XML. Excel
// writes characters that are illegal in XML as _xHHHH_, and escapes a literal
// "_x0041_" as "_x005F_x0041_" — handled implicitly, because the left-to-right
// scan consumes the _x005F_ ("_") first and leaves the rest as literal text.
function xlsDecodeXmlText(s) {
  if (s === undefined || s === null) return '';
  s = String(s);
  if (s.indexOf('&') < 0 && s.indexOf('_x') < 0) return s;
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  let out = s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, function (m, e) {
    if (e.charAt(0) !== '#') return named[e];
    const cp = (e.charAt(1) === 'x' || e.charAt(1) === 'X')
      ? parseInt(e.slice(2), 16)
      : parseInt(e.slice(1), 10);
    return (isNaN(cp) || cp < 0 || cp > 0x10FFFF) ? m : String.fromCodePoint(cp);
  });
  out = out.replace(/_x([0-9a-fA-F]{4})_/g, function (m, hex) {
    return String.fromCharCode(parseInt(hex, 16));
  });
  return out;
}

// Reads one attribute off a captured tag-attribute string.
function xlsAttr(attrs, name) {
  const m = new RegExp('\\s' + name + '\\s*=\\s*"([^"]*)"').exec(' ' + attrs);
  return m ? xlsDecodeXmlText(m[1]) : null;
}

// Concatenates every <t> node in a fragment — shared strings split into runs
// (<r><t>Bold</t></r><r><t> tail</t></r>) must come back as one string.
function xlsCollectText(frag) {
  if (!frag) return '';
  let out = '';
  const re = /<t(?:\s[^>]*)?\/>|<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(frag)) !== null) {
    if (m[1] !== undefined) out += xlsDecodeXmlText(m[1]);
  }
  return out;
}

// ── Column references ─────────────────────────────────────────────────────

// "A1" / "BC" → zero-based column index. Accepts a bare column or a full ref.
function xlsColToIndex(ref) {
  if (!ref) return -1;
  const letters = String(ref).toUpperCase().replace(/[^A-Z]/g, '');
  if (!letters) return -1;
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

// 0 → "A", 25 → "Z", 26 → "AA" — used to name columns a header row left blank.
function xlsIndexToCol(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ── Workbook parts ────────────────────────────────────────────────────────

// xl/workbook.xml → sheet order, names, relationship ids and the date system.
// Sheet ORDER matters: it is the tab order the user sees in Excel, and it is
// not recoverable from the file names (sheet3.xml can be the first tab).
function xlsParseWorkbook(xml) {
  const sheets = [];
  const re = /<sheet\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(xml || '')) !== null) {
    const attrs = m[1];
    const name = xlsAttr(attrs, 'name');
    if (name === null) continue;
    sheets.push({
      name: name,
      sheetId: xlsAttr(attrs, 'sheetId'),
      rid: xlsAttr(attrs, 'r:id') || xlsAttr(attrs, 'id'),
      hidden: /^(hidden|veryHidden)$/i.test(xlsAttr(attrs, 'state') || '')
    });
  }
  const pr = /<workbookPr\b([^>]*)\/?>/.exec(xml || '');
  const d1904 = pr ? xlsAttr(pr[1], 'date1904') : null;
  return { sheets: sheets, date1904: d1904 === '1' || d1904 === 'true' };
}

// xl/_rels/workbook.xml.rels → { rId1: "worksheets/sheet1.xml" }
function xlsParseRels(xml) {
  const out = {};
  const re = /<Relationship\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(xml || '')) !== null) {
    const id = xlsAttr(m[1], 'Id');
    const target = xlsAttr(m[1], 'Target');
    if (id && target) out[id] = target;
  }
  return out;
}

// xl/sharedStrings.xml → the string table cells with t="s" index into.
function xlsParseSharedStrings(xml) {
  const out = [];
  const re = /<si\/>|<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml || '')) !== null) out.push(m[1] === undefined ? '' : xlsCollectText(m[1]));
  return out;
}

// Number formats Excel ships built in. A cell is a date only because of its
// FORMAT — the value itself is an ordinary number, so this table (plus the
// custom formats below) is the only thing standing between "2024-03-01" and
// a column full of 45352.
const XLS_BUILTIN_DATE_FMT = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22,
  27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47,
  50, 51, 52, 53, 54, 55, 56, 57, 58
]);

// A custom format code is a date format if any date/time token survives once
// literals are stripped. [Red] and [$-409] are decoration; [h] / [mm] / [ss]
// are elapsed-time tokens and must be kept.
function xlsIsDateFormat(code) {
  if (!code) return false;
  let c = String(code).replace(/\\./g, '').replace(/"[^"]*"/g, '');
  c = c.replace(/\[(?![hms]+\])[^\]]*\]/gi, '');
  return /[ymdhs]/i.test(c);
}

// xl/styles.xml → for each cellXfs entry, "is this a date format?".
// The <xf> elements inside <cellStyleXfs> look identical but are NOT what a
// cell's s="N" points at — reading the wrong block shifts every style index
// and silently turns random numeric columns into 1900-era dates.
function xlsParseStyles(xml) {
  xml = xml || '';
  const formats = {};
  const nfRe = /<numFmt\b([^>]*)\/?>/g;
  let m;
  while ((m = nfRe.exec(xml)) !== null) {
    const id = xlsAttr(m[1], 'numFmtId');
    const code = xlsAttr(m[1], 'formatCode');
    if (id !== null && code !== null) formats[id] = code;
  }
  const dateXf = [];
  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (block) {
    const xfRe = /<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g;
    let x;
    while ((x = xfRe.exec(block[1])) !== null) {
      const id = xlsAttr(x[1], 'numFmtId');
      const num = id === null ? 0 : parseInt(id, 10);
      dateXf.push(XLS_BUILTIN_DATE_FMT.has(num) || xlsIsDateFormat(formats[String(num)]));
    }
  }
  return { dateXf: dateXf, formats: formats };
}

// ── Values ────────────────────────────────────────────────────────────────

// Excel serial → ISO 8601. Two quirks are load-bearing:
//   • 1900 mode counts a 29th of February 1900 that never existed, so serials
//     below 60 need a day added on top of the 1899-12-30 epoch. Serial 60
//     itself is that phantom day; it resolves to 1900-02-28 rather than
//     inventing a date.
//   • A value with no date part (serial < 1) is a time, and a value with no
//     time part is a date — emitting "1899-12-30T09:30:00" for a duration
//     column would be worse than useless.
function xlsSerialToIso(serial, date1904) {
  if (typeof serial !== 'number' || !isFinite(serial) || serial < 0) return null;
  let s = serial;
  if (!date1904 && s < 60) s += 1;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const ms = Math.round((epoch + s * 86400000) / 1000) * 1000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const p = function (n) { return String(n).padStart(2, '0'); };
  const date = d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  const time = p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
  if (serial > 0 && serial < 1) return time;
  if (time === '00:00:00') return date;
  return date + 'T' + time;
}

// ── Sheet ─────────────────────────────────────────────────────────────────

// Parses one worksheet into a dense grid of JS values.
// opts: { shared, dateXf, date1904, dates: 'iso' | 'serial' }
//
// Returns { rows, merged, skippedTop, truncated }. `rows` is trimmed of fully
// empty leading and trailing rows: a sheet whose data starts at row 4 would
// otherwise hand three blank rows to the header detector and produce JSON keyed
// by "A", "B", "C". Interior blank rows are kept — they are part of the data.
function xlsParseSheet(xml, opts) {
  opts = opts || {};
  const shared = opts.shared || [];
  const dateXf = opts.dateXf || [];
  const date1904 = !!opts.date1904;
  const asSerial = opts.dates === 'serial';
  const maxRows = opts.maxRows || 0;

  const grid = [];
  let truncated = false;
  const rowRe = /<row\b([^>]*)\/>|<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let m;
  while ((m = rowRe.exec(xml || '')) !== null) {
    const attrs = m[1] !== undefined ? m[1] : m[2];
    const inner = m[3] || '';
    const rAttr = xlsAttr(attrs, 'r');
    const rowIdx = rAttr ? parseInt(rAttr, 10) - 1 : grid.length;
    if (rowIdx < 0) continue;
    if (maxRows && rowIdx >= maxRows) { truncated = true; break; }
    const row = [];
    let cursor = 0;
    const cellRe = /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let c;
    while ((c = cellRe.exec(inner)) !== null) {
      const cAttrs = c[1] !== undefined ? c[1] : c[2];
      const cInner = c[3] || '';
      const ref = xlsAttr(cAttrs, 'r');
      let col = ref ? xlsColToIndex(ref) : -1;
      if (col < 0) col = cursor;
      cursor = col + 1;
      row[col] = xlsCellValue(cAttrs, cInner, shared, dateXf, date1904, asSerial);
    }
    grid[rowIdx] = row;
  }

  // Densify: a sparse grid indexed by row number becomes a plain array, with
  // holes as empty rows, so downstream code never sees `undefined` rows.
  const rows = [];
  for (let i = 0; i < grid.length; i++) rows.push(grid[i] || []);

  const isEmptyRow = function (r) {
    for (let i = 0; i < r.length; i++) {
      const v = r[i];
      if (v !== undefined && v !== null && v !== '') return false;
    }
    return true;
  };
  let start = 0;
  while (start < rows.length && isEmptyRow(rows[start])) start++;
  let end = rows.length;
  while (end > start && isEmptyRow(rows[end - 1])) end--;

  const mergeCount = (xml && xml.match(/<mergeCell\b/g) || []).length;
  return {
    rows: rows.slice(start, end),
    merged: mergeCount,
    skippedTop: start,
    truncated: truncated
  };
}

// One cell. Typed by the `t` attribute; a formula cell carries its cached <v>,
// which is what a converter wants — the recomputed value, not "=SUM(A1:A9)".
function xlsCellValue(attrs, inner, shared, dateXf, date1904, asSerial) {
  const t = xlsAttr(attrs, 't') || 'n';
  if (t === 'inlineStr') return xlsCollectText(inner);

  const vm = /<v(?:\s[^>]*)?\/>|<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
  if (!vm || vm[1] === undefined) return '';
  const raw = xlsDecodeXmlText(vm[1]);
  if (raw === '') return '';

  if (t === 's') {
    const idx = parseInt(raw, 10);
    return (isNaN(idx) || idx < 0 || idx >= shared.length) ? '' : shared[idx];
  }
  if (t === 'str') return raw;
  if (t === 'b') return raw === '1' || raw.toLowerCase() === 'true';
  if (t === 'e') return raw; // #N/A, #REF! — surfaced verbatim, not swallowed

  const num = Number(raw);
  if (isNaN(num)) return raw;
  if (!asSerial) {
    const sAttr = xlsAttr(attrs, 's');
    const styleIdx = sAttr === null ? -1 : parseInt(sAttr, 10);
    if (styleIdx >= 0 && dateXf[styleIdx]) {
      const iso = xlsSerialToIso(num, date1904);
      if (iso !== null) return iso;
    }
  }
  return num;
}

// ── Conversion ────────────────────────────────────────────────────────────

// Column names for object mode. A blank header cell becomes its column letter
// (so the field still exists and is addressable), and a duplicate gets a _2
// suffix — silently dropping a second "Name" column would lose data.
function xlsHeaderNames(header, width) {
  header = header || [];
  width = Math.max(width || 0, header.length);
  const used = Object.create(null);
  const names = [];
  for (let i = 0; i < width; i++) {
    const raw = header[i];
    const base = (raw === undefined || raw === null || String(raw).trim() === '')
      ? xlsIndexToCol(i)
      : String(raw).trim();
    let name = base;
    let n = 2;
    while (used[name]) name = base + '_' + (n++);
    used[name] = true;
    names.push(name);
  }
  return names;
}

function xlsGridWidth(rows) {
  let w = 0;
  for (let i = 0; i < (rows || []).length; i++) w = Math.max(w, rows[i].length);
  return w;
}

// rows → JSON value. mode 'objects' reads the first row as the header;
// 'arrays' hands back the raw grid. Empty cells are null in both, so the shape
// stays rectangular for whatever consumes the file.
function xlsRowsToJson(rows, opts) {
  opts = opts || {};
  rows = rows || [];
  const width = xlsGridWidth(rows);
  const cell = function (v) { return v === undefined ? null : v; };

  if (opts.mode === 'arrays') {
    return rows.map(function (r) {
      const out = [];
      for (let i = 0; i < width; i++) out.push(cell(r[i]));
      return out;
    });
  }
  if (!rows.length) return [];
  const names = xlsHeaderNames(rows[0], width);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const obj = {};
    for (let c = 0; c < names.length; c++) obj[names[c]] = cell(rows[i][c]);
    out.push(obj);
  }
  return out;
}

// rows → CSV, delegating quoting to the shared exporter (extended in wave 6
// with delimiter/quote options rather than growing a second CSV writer here).
// Booleans render as TRUE/FALSE, matching what Excel itself writes on export.
function xlsRowsToCsv(rows, opts) {
  opts = opts || {};
  rows = rows || [];
  if (!rows.length) return '';
  const width = xlsGridWidth(rows);
  const cell = function (v) {
    if (v === undefined || v === null) return '';
    if (v === true) return 'TRUE';
    if (v === false) return 'FALSE';
    return v;
  };
  const grid = rows.map(function (r) {
    const out = [];
    for (let i = 0; i < width; i++) out.push(cell(r[i]));
    return out;
  });
  const toCsv = XLS_GLOBAL.mtExportToCsv;
  if (!toCsv) return '';
  return toCsv(grid[0], grid.slice(1), {
    delimiter: opts.delimiter || ',',
    quote: opts.quote || 'all',
    eol: opts.eol
  });
}

// ── ZIP reader ────────────────────────────────────────────────────────────

const XLS_SIG_EOCD = 0x06054b50;
const XLS_SIG_CDIR = 0x02014b50;

function xlsInflateRaw(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
}

// Reads the central directory of a ZIP and returns an accessor over its
// entries. Deliberately minimal: no ZIP64, no encryption, no data descriptors
// (sizes are taken from the central directory, which is authoritative even
// when the local header left them at zero).
function xlsOpenZip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder('utf-8');

  if (bytes.length > 8 && bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0) {
    throw new Error('This is a legacy .xls file (binary format), not .xlsx. Open it in Excel and use File → Save As → Excel Workbook (.xlsx).');
  }

  let eocd = -1;
  const floor = Math.max(0, bytes.length - 66000);
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === XLS_SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file — no ZIP end-of-central-directory record was found.');

  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xFFFF || cdOffset === 0xFFFFFFFF) {
    throw new Error('ZIP64 archives are not supported. Re-save the workbook from Excel to produce a standard .xlsx.');
  }

  const entries = Object.create(null);
  let p = cdOffset;
  for (let i = 0; i < count && p + 46 <= bytes.length; i++) {
    if (view.getUint32(p, true) !== XLS_SIG_CDIR) break;
    const method = view.getUint16(p + 10, true);
    const cSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const cmtLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries[name] = { method: method, cSize: cSize, localOffset: localOffset };
    p += 46 + nameLen + extraLen + cmtLen;
  }

  return {
    names: Object.keys(entries),
    has: function (name) { return !!entries[name]; },
    text: function (name) {
      const e = entries[name];
      if (!e) return Promise.resolve(null);
      const nameLen = view.getUint16(e.localOffset + 26, true);
      const extraLen = view.getUint16(e.localOffset + 28, true);
      const start = e.localOffset + 30 + nameLen + extraLen;
      const raw = bytes.subarray(start, start + e.cSize);
      if (e.method === 0) return Promise.resolve(decoder.decode(raw));
      if (e.method !== 8) {
        return Promise.reject(new Error('Unsupported ZIP compression method ' + e.method + ' in ' + name + '.'));
      }
      return xlsInflateRaw(raw).then(function (out) { return decoder.decode(out); });
    }
  };
}

// Full read: ArrayBuffer → { fileName, date1904, sheets: [{ name, rows, … }] }.
// opts.dates ('iso' | 'serial') is applied here because the date decision is
// made per cell during parsing, not afterwards on a lossy value.
function xlsReadWorkbook(buffer, opts) {
  opts = opts || {};
  let zip;
  try {
    zip = xlsOpenZip(buffer);
  } catch (e) {
    return Promise.reject(e);
  }
  if (!zip.has('xl/workbook.xml')) {
    return Promise.reject(new Error('No xl/workbook.xml inside the archive — this ZIP is not an Excel workbook.'));
  }

  let book, rels, shared = [], styles = { dateXf: [] };
  return zip.text('xl/workbook.xml').then(function (xml) {
    book = xlsParseWorkbook(xml);
    return zip.has('xl/_rels/workbook.xml.rels') ? zip.text('xl/_rels/workbook.xml.rels') : null;
  }).then(function (xml) {
    rels = xlsParseRels(xml);
    return zip.has('xl/sharedStrings.xml') ? zip.text('xl/sharedStrings.xml') : null;
  }).then(function (xml) {
    if (xml) shared = xlsParseSharedStrings(xml);
    return zip.has('xl/styles.xml') ? zip.text('xl/styles.xml') : null;
  }).then(function (xml) {
    if (xml) styles = xlsParseStyles(xml);

    // Sheets are read in workbook (tab) order, one after another — a 40-sheet
    // workbook would otherwise inflate 40 parts concurrently and spike memory.
    const out = [];
    let chain = Promise.resolve();
    book.sheets.forEach(function (sheet) {
      chain = chain.then(function () {
        const target = rels[sheet.rid];
        if (!target) { out.push(Object.assign({ rows: [], merged: 0, missing: true }, sheet)); return; }
        const path = target.charAt(0) === '/'
          ? target.slice(1)
          : (target.indexOf('xl/') === 0 ? target : 'xl/' + target.replace(/^\.\//, ''));
        if (!zip.has(path)) { out.push(Object.assign({ rows: [], merged: 0, missing: true }, sheet)); return; }
        return zip.text(path).then(function (xml) {
          const parsed = xlsParseSheet(xml, {
            shared: shared,
            dateXf: styles.dateXf,
            date1904: book.date1904,
            dates: opts.dates
          });
          out.push(Object.assign({}, sheet, parsed));
        });
      });
    });
    return chain.then(function () {
      return { fileName: opts.fileName || '', date1904: book.date1904, sheets: out };
    });
  });
}

XLS_GLOBAL.xlsDecodeXmlText = xlsDecodeXmlText;
XLS_GLOBAL.xlsColToIndex = xlsColToIndex;
XLS_GLOBAL.xlsIndexToCol = xlsIndexToCol;
XLS_GLOBAL.xlsParseWorkbook = xlsParseWorkbook;
XLS_GLOBAL.xlsParseRels = xlsParseRels;
XLS_GLOBAL.xlsParseSharedStrings = xlsParseSharedStrings;
XLS_GLOBAL.xlsParseStyles = xlsParseStyles;
XLS_GLOBAL.xlsIsDateFormat = xlsIsDateFormat;
XLS_GLOBAL.xlsSerialToIso = xlsSerialToIso;
XLS_GLOBAL.xlsParseSheet = xlsParseSheet;
XLS_GLOBAL.xlsHeaderNames = xlsHeaderNames;
XLS_GLOBAL.xlsRowsToJson = xlsRowsToJson;
XLS_GLOBAL.xlsRowsToCsv = xlsRowsToCsv;
XLS_GLOBAL.xlsOpenZip = xlsOpenZip;
XLS_GLOBAL.xlsReadWorkbook = xlsReadWorkbook;

// =========================================================================
// UI (browser only)
// =========================================================================

let xlsBook = null;        // last parsed workbook
let xlsActiveSheet = 0;    // index into xlsBook.sheets
let xlsRawBuffer = null;   // kept so toggling "dates as serial" can re-read

const XLS_PREVIEW_ROWS = 50;

function xlsEsc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function xlsOpt(id, fallback) {
  const el = document.getElementById(id);
  if (!el) return fallback;
  return el.type === 'checkbox' ? el.checked : el.value;
}

function xlsReset() {
  xlsBook = null;
  xlsRawBuffer = null;
  xlsActiveSheet = 0;
  const empty = document.getElementById('xls-empty');
  const results = document.getElementById('xls-results');
  if (empty) empty.style.display = 'flex';
  if (results) results.style.display = 'none';
  const input = document.getElementById('xls-file-input');
  if (input) input.value = '';
}

function xlsHandleDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  if (e.dataTransfer.files && e.dataTransfer.files.length) xlsLoadFile(e.dataTransfer.files);
}

function xlsLoadFile(files) {
  if (!files || !files.length) return;
  const file = files[0];
  if (window.showLoader) window.showLoader('Reading ' + file.name + '…');
  file.arrayBuffer().then(function (buf) {
    xlsRawBuffer = buf;
    return xlsReadWorkbook(buf, { fileName: file.name, dates: xlsOpt('xls-dates', 'iso') });
  }).then(function (book) {
    xlsBook = book;
    xlsActiveSheet = 0;
    // Land on the first sheet that actually has rows — opening on an empty
    // cover sheet reads as "the file failed to parse".
    for (let i = 0; i < book.sheets.length; i++) {
      if (book.sheets[i].rows.length) { xlsActiveSheet = i; break; }
    }
    document.getElementById('xls-empty').style.display = 'none';
    document.getElementById('xls-results').style.display = 'flex';
    xlsRender();
  }).catch(function (err) {
    alert('Could not read the workbook.\n\n' + err.message);
  }).then(function () {
    if (window.hideLoader) window.hideLoader();
  });
}

// Re-reads the workbook when the date option changes — the ISO/serial choice
// is made per cell at parse time, so it cannot be applied to parsed values.
function xlsReparse() {
  if (!xlsRawBuffer) return;
  const active = xlsActiveSheet;
  if (window.showLoader) window.showLoader('Re-reading workbook…');
  xlsReadWorkbook(xlsRawBuffer, {
    fileName: xlsBook ? xlsBook.fileName : '',
    dates: xlsOpt('xls-dates', 'iso')
  }).then(function (book) {
    xlsBook = book;
    xlsActiveSheet = Math.min(active, book.sheets.length - 1);
    xlsRender();
  }).catch(function (err) {
    alert('Could not re-read the workbook.\n\n' + err.message);
  }).then(function () {
    if (window.hideLoader) window.hideLoader();
  });
}

function xlsSelectSheet(i) {
  xlsActiveSheet = i;
  xlsRender();
}

function xlsRender() {
  if (!xlsBook) return;
  xlsRenderSheetList();
  xlsRenderFormatOptions();
  xlsRenderPreview();
  xlsRenderOutput();
}

function xlsRenderSheetList() {
  const el = document.getElementById('xls-sheets');
  if (!el) return;
  el.innerHTML = xlsBook.sheets.map(function (s, i) {
    const cols = xlsGridWidth(s.rows);
    const active = i === xlsActiveSheet;
    const badges = (s.hidden ? '<span class="xls-badge">hidden</span>' : '')
      + (s.merged ? '<span class="xls-badge">' + s.merged + ' merged</span>' : '');
    return '<button type="button" class="xls-sheet' + (active ? ' active' : '') + '" onclick="xlsSelectSheet(' + i + ')">'
      + '<span class="xls-sheet-name">' + xlsEsc(s.name) + '</span>'
      + '<span class="xls-sheet-meta">' + s.rows.length + ' rows × ' + cols + ' cols' + '</span>'
      + badges
      + '</button>';
  }).join('');
}

function xlsRenderFormatOptions() {
  const isCsv = xlsOpt('xls-format', 'json-objects') === 'csv';
  const csvOpts = document.getElementById('xls-csv-options');
  if (csvOpts) csvOpts.style.display = isCsv ? 'flex' : 'none';
}

function xlsRenderPreview() {
  const head = document.getElementById('xls-preview-head');
  const body = document.getElementById('xls-preview-body');
  const note = document.getElementById('xls-preview-note');
  if (!head || !body) return;
  const sheet = xlsBook.sheets[xlsActiveSheet];
  if (!sheet) return;

  // Data principle: an empty sheet says so, and says what that means, instead
  // of rendering an empty table that looks like a broken parse.
  if (!sheet.rows.length) {
    head.innerHTML = '';
    body.innerHTML = '<tr><td style="padding:var(--sp-4);color:var(--text-muted);font-size:0.85rem">'
      + 'This sheet has no cells with values'
      + (sheet.missing ? ' (its XML part is missing from the archive).' : '.')
      + ' Pick another sheet on the left, or check the workbook in Excel.'
      + '</td></tr>';
    if (note) note.textContent = '';
    return;
  }

  const width = xlsGridWidth(sheet.rows);
  const objectMode = xlsOpt('xls-format', 'json-objects') === 'json-objects';
  const names = objectMode ? xlsHeaderNames(sheet.rows[0], width) : null;
  const dataRows = objectMode ? sheet.rows.slice(1) : sheet.rows;

  head.innerHTML = '<tr>'
    + '<th style="width:48px;text-align:right;color:var(--text-muted)">#</th>'
    + (names || Array.from({ length: width }, function (_, i) { return xlsIndexToCol(i); }))
        .map(function (n) { return '<th>' + xlsEsc(n) + '</th>'; }).join('')
    + '</tr>';

  const shown = dataRows.slice(0, XLS_PREVIEW_ROWS);
  body.innerHTML = shown.map(function (r, i) {
    const cells = [];
    for (let c = 0; c < width; c++) {
      const v = r[c];
      const empty = v === undefined || v === null || v === '';
      cells.push('<td' + (empty ? ' style="color:var(--text-muted)"' : '') + '>' + xlsEsc(empty ? '' : v) + '</td>');
    }
    return '<tr><td style="text-align:right;color:var(--text-muted);font-family:var(--font-mono)">'
      + (i + 1 + (objectMode ? 1 : 0)) + '</td>' + cells.join('') + '</tr>';
  }).join('');

  if (note) {
    const parts = [];
    if (dataRows.length > shown.length) parts.push('showing first ' + shown.length + ' of ' + dataRows.length + ' rows');
    if (objectMode) parts.push('row 1 used as the header');
    if (sheet.skippedTop) parts.push(sheet.skippedTop + ' empty leading row(s) skipped');
    if (sheet.merged) parts.push(sheet.merged + ' merged range(s) — only the top-left cell carries the value');
    note.textContent = parts.join(' · ');
  }
}

function xlsBuildOutput() {
  if (!xlsBook) return { text: '', ext: 'txt', mime: 'text/plain' };
  const format = xlsOpt('xls-format', 'json-objects');
  const scope = xlsOpt('xls-scope', 'sheet');
  const sheets = scope === 'all' ? xlsBook.sheets : [xlsBook.sheets[xlsActiveSheet]];

  if (format === 'csv') {
    const delimiter = xlsOpt('xls-delimiter', ',');
    // CSV is one table per file by definition — "all sheets" therefore produces
    // one download per sheet rather than concatenating them into a shape no
    // spreadsheet can read back.
    const files = sheets.filter(Boolean).map(function (s) {
      return {
        name: xlsSafeName(s.name) + '.csv',
        text: xlsRowsToCsv(s.rows, { delimiter: delimiter === 'tab' ? '\t' : delimiter })
      };
    });
    return { files: files, ext: 'csv', mime: 'text/csv', text: files.length ? files[0].text : '' };
  }

  const mode = format === 'json-arrays' ? 'arrays' : 'objects';
  let value;
  if (scope === 'all') {
    value = {};
    xlsBook.sheets.forEach(function (s) { value[s.name] = xlsRowsToJson(s.rows, { mode: mode }); });
  } else {
    value = xlsRowsToJson(sheets[0] ? sheets[0].rows : [], { mode: mode });
  }
  return { text: JSON.stringify(value, null, 2), ext: 'json', mime: 'application/json' };
}

function xlsSafeName(s) {
  return String(s || 'sheet').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'sheet';
}

function xlsRenderOutput() {
  const out = document.getElementById('xls-output');
  const note = document.getElementById('xls-output-note');
  if (!out) return;
  const built = xlsBuildOutput();
  const text = built.text || '';
  const CAP = 200000;
  out.textContent = text.length > CAP ? text.slice(0, CAP) + '\n\n… preview truncated — download for the full file.' : text;
  if (note) {
    const parts = [xlsFormatBytes(text.length)];
    // CSV + all sheets downloads one file per sheet, but this box can only show
    // one of them — name which, so it isn't mistaken for the whole output.
    if (built.files && built.files.length > 1) {
      const firstName = xlsBook.sheets[0] ? xlsBook.sheets[0].name : 'the first sheet';
      parts.push('preview shows "' + firstName + '" only — all ' + built.files.length + ' sheets download as separate files');
    }
    if (text.length > CAP) parts.push('preview truncated');
    note.textContent = parts.join(' · ');
  }
}

function xlsFormatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function xlsDownloadText(text, filename, mime, bom) {
  const parts = bom ? ['﻿', text] : [text];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(parts, { type: mime + ';charset=utf-8' }));
  a.download = filename;
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
}

function xlsDownload() {
  if (!xlsBook) return;
  const built = xlsBuildOutput();
  const base = (xlsBook.fileName || 'workbook').replace(/\.[^.]+$/, '');
  if (built.ext === 'csv') {
    // Without a BOM, Excel reads UTF-8 CSV as the local ANSI codepage and
    // mangles every accented character — on by default for exactly that reason.
    const bom = xlsOpt('xls-bom', true);
    built.files.forEach(function (f, i) {
      const name = built.files.length > 1 ? base + '-' + f.name : base + '.csv';
      setTimeout(function () { xlsDownloadText(f.text, name, 'text/csv', bom); }, i * 150);
    });
    return;
  }
  xlsDownloadText(built.text, base + '.json', 'application/json', false);
}

function xlsCopy(btn) {
  const built = xlsBuildOutput();
  if (!navigator.clipboard) return;
  navigator.clipboard.writeText(built.text || '').then(function () {
    if (!btn) return;
    const old = btn.innerHTML;
    btn.innerHTML = 'Copied!';
    setTimeout(function () { btn.innerHTML = old; }, 2000);
  });
}

// Hands the generated JSON to the JSON Formatter for tree exploration —
// the same cross-link pattern the log tools use.
function xlsOpenInJson() {
  const built = xlsBuildOutput();
  if (built.ext !== 'json' || !built.text) return;
  window.navigateWithReturn('json-formatter');
  const input = document.getElementById('json-input');
  if (input) {
    input.value = built.text;
    if (window.jsonFormat) window.jsonFormat();
  }
}

if (typeof document !== 'undefined') {
  XLS_GLOBAL.xlsLoadFile = xlsLoadFile;
  XLS_GLOBAL.xlsHandleDrop = xlsHandleDrop;
  XLS_GLOBAL.xlsReset = xlsReset;
  XLS_GLOBAL.xlsSelectSheet = xlsSelectSheet;
  XLS_GLOBAL.xlsRender = xlsRender;
  XLS_GLOBAL.xlsReparse = xlsReparse;
  XLS_GLOBAL.xlsDownload = xlsDownload;
  XLS_GLOBAL.xlsCopy = xlsCopy;
  XLS_GLOBAL.xlsOpenInJson = xlsOpenInJson;
}
