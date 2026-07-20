// Minimal .xlsx writer — TEST AND SCREENSHOT FIXTURES ONLY.
//
// The Excel Converter only ever READS workbooks; this exists so that
// scripts/parser-test.js can exercise the reader against a genuine ZIP, and so
// scripts/generate-screenshots.js can produce a demo workbook with no personal
// data in it (the real spreadsheets live outside the repo).
//
// It writes the same structure Excel does — shared strings, a style table, one
// part per sheet — because a reader tested only against a stripped-down
// archive proves very little about the files users actually drop on it.

const zlib = require('zlib');

// ── ZIP ─────────────────────────────────────────────────────────────────────

const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// files: [{ name, data, store? }] — `store` writes the entry uncompressed
// (method 0), which Excel does for very small parts and the reader handles too.
function buildZip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = Buffer.from(f.name, 'utf8');
    const raw = Buffer.from(f.data, 'utf8');
    const method = f.store ? 0 : 8;
    const comp = f.store ? raw : zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBytes.length, 26);
    local.push(lh, nameBytes, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBytes);

    offset += lh.length + nameBytes.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cdBuf, eocd]);
}

// ── Workbook ────────────────────────────────────────────────────────────────

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colName(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// "2024-03-01" / "2024-03-01T09:30:00" → Excel serial (1900 date system).
function dateToSerial(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(iso);
  if (!m) return 0;
  const days = (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000;
  const frac = ((+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) / 86400;
  return days + frac;
}

// Style indices written into cellXfs below, referenced by cell s="N".
const STYLE = { general: 0, date: 1, dateTime: 2, money: 3 };

// Cell values may be:
//   string | number | boolean
//   { date: '2024-03-01' } | { date: '2024-03-01T09:30:00', time: true }
//   { formula: 'D2*2', value: 2469 }
//   { money: 1234.5 }
//   null / undefined → an empty cell
function buildWorkbook(sheets) {
  const shared = [];
  const sharedIndex = new Map();
  const internString = function (s) {
    if (sharedIndex.has(s)) return sharedIndex.get(s);
    const i = shared.length;
    shared.push(s);
    sharedIndex.set(s, i);
    return i;
  };

  const sheetXml = sheets.map(function (sheet) {
    const rows = sheet.rows.map(function (row, r) {
      const cells = row.map(function (v, c) {
        if (v === null || v === undefined || v === '') return '';
        const ref = colName(c) + (r + 1);
        if (typeof v === 'number') return '<c r="' + ref + '"><v>' + v + '</v></c>';
        if (typeof v === 'boolean') return '<c r="' + ref + '" t="b"><v>' + (v ? 1 : 0) + '</v></c>';
        if (typeof v === 'object' && v.date) {
          return '<c r="' + ref + '" s="' + (v.time ? STYLE.dateTime : STYLE.date) + '"><v>' +
            dateToSerial(v.date) + '</v></c>';
        }
        if (typeof v === 'object' && v.money !== undefined) {
          return '<c r="' + ref + '" s="' + STYLE.money + '"><v>' + v.money + '</v></c>';
        }
        if (typeof v === 'object' && v.formula) {
          return '<c r="' + ref + '" s="' + STYLE.money + '"><f>' + xmlEscape(v.formula) + '</f><v>' + v.value + '</v></c>';
        }
        return '<c r="' + ref + '" t="s"><v>' + internString(String(v)) + '</v></c>';
      }).join('');
      return cells ? '<row r="' + (r + 1) + '">' + cells + '</row>' : '';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData>' + rows + '</sheetData></worksheet>';
  });

  const sharedXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + shared.length +
    '" uniqueCount="' + shared.length + '">' +
    shared.map(function (s) { return '<si><t xml:space="preserve">' + xmlEscape(s) + '</t></si>'; }).join('') +
    '</sst>';

  // numFmtId 14 = built-in short date; 165 is a custom date+time format; 4 is
  // "#,##0.00" — a number that must NOT be mistaken for a date.
  const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/></numFmts>' +
    '<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>' +
    '<cellXfs count="4">' +
    '<xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="165"/><xf numFmtId="4"/>' +
    '</cellXfs></styleSheet>';

  const workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets.map(function (s, i) {
      return '<sheet name="' + xmlEscape(s.name) + '" sheetId="' + (i + 1) + '"' +
        (s.hidden ? ' state="hidden"' : '') + ' r:id="rId' + (i + 1) + '"/>';
    }).join('') + '</sheets></workbook>';

  const relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map(function (s, i) {
      return '<Relationship Id="rId' + (i + 1) + '" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
    }).join('') +
    '<Relationship Id="rIdSst" Target="sharedStrings.xml"/>' +
    '<Relationship Id="rIdSty" Target="styles.xml"/></Relationships>';

  const parts = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', store: true },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: relsXml },
    { name: 'xl/sharedStrings.xml', data: sharedXml },
    { name: 'xl/styles.xml', data: stylesXml }
  ];
  sheetXml.forEach(function (xml, i) {
    parts.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: xml });
  });
  return buildZip(parts);
}

// The workbook used for the README screenshot and the browser end-to-end run.
// Entirely invented data — no PII — but shaped like a real Mendix import file:
// Polish characters, dates, a money column, a formula, booleans, a gap, a
// second sheet and a hidden one.
function buildDemoWorkbook() {
  return buildWorkbook([
    {
      name: 'Products',
      rows: [
        [],
        ['Product code', 'Name', 'Category', 'Price', 'Updated', 'Active'],
        ['PRD-1001', 'Zażółć gęślą jaźń', 'Kable', { money: 129.99 }, { date: '2026-03-01' }, true],
        ['PRD-1002', 'Przewód zasilający 3 m', 'Kable', { money: 45.5 }, { date: '2026-03-02T09:30:00', time: true }, true],
        ['PRD-1003', 'Śruba M8 × 40', 'Złączki', { money: 0.89 }, { date: '2026-03-02' }, false],
        ['PRD-1004', 'Obudowa IP65', 'Obudowy', { formula: 'D5*2', value: 1.78 }, { date: '2026-03-05' }, true],
        ['PRD-1005', 'Zestaw montażowy', null, { money: 310 }, { date: '2026-03-07' }, false],
        ['PRD-1006', 'Taśma izolacyjna', 'Akcesoria', { money: 7.2 }, { date: '2026-03-09' }, true]
      ]
    },
    {
      name: 'Categories',
      rows: [
        ['Category', 'Owner', 'Margin %'],
        ['Kable', 'Sales NL', 22],
        ['Złączki', 'Sales PL', 31],
        ['Obudowy', 'Sales PL', 18],
        ['Akcesoria', 'Sales DE', 27]
      ]
    },
    { name: 'Scratch notes', hidden: true, rows: [['Do not import this sheet']] }
  ]);
}

module.exports = { buildZip, buildWorkbook, buildDemoWorkbook, dateToSerial };
