// =========================================================================
// DATA FACTORY — SCHEMA IMPORT (DDL / mendixsystem$) · prefix `dfImp`
// =========================================================================
// Defining a 30-column schema by hand, one dropdown at a time, is the reason
// Data Factory gets abandoned halfway through. This module fills the schema
// from a description the developer already has: a DDL export, or — with a Live
// DB connection — the Mendix model itself, read from `mendixsystem$entity` /
// `$attribute` through the Bridge endpoint the Domain Model release added.
//
// Live DB is PROGRESSIVE ENHANCEMENT, as everywhere in wave 6: without a
// connection the DDL path still works, and without either one the tool behaves
// exactly as it always has. Nothing here is a prerequisite for generating data.
//
// Two parts carry all the risk:
//
//   1. THE DDL SPLITTER. A comma is only a column boundary at parenthesis
//      depth 0 and outside quotes — `numeric(10,2)` and
//      `CHECK (status IN (1,2,3))` both contain commas that are not. Getting
//      this wrong does not throw; it invents columns named "2)" and drops real
//      ones. Table-level constraints (PRIMARY KEY, FOREIGN KEY, CHECK…) sit in
//      the same comma-separated list as columns and have to be recognised by
//      their leading keyword rather than parsed as a column named "PRIMARY".
//
//   2. THE GENERATOR INFERENCE. Type alone is nearly useless — in a Mendix
//      model almost everything is String — so the column NAME decides, through
//      an ORDERED rule list whose order is the whole point: "emailaddress"
//      contains "address", "phonenumber" contains "number", "companyname"
//      contains "name". A name hint is then only accepted if it is COMPATIBLE
//      with the column's type family, so `city_id integer` stays an integer
//      instead of being filled with "London".
//
// Data principle: a column this module cannot generate meaningfully (binary /
// BLOB) is EXCLUDED and listed with the reason, rather than filled with random
// text that looks like data and corrupts the import it was made for. Every
// inference is shown in a mapping report — the user overrides it in the schema
// editor, which is why the report says what it guessed and why.
//
// The pure layer (dfParseDdl / dfInfer* / dfSchemaFrom*) attaches to
// window/self so scripts/parser-test.js exercises it in plain Node; the DOM
// handlers below never run at import time.
// =========================================================================

const DFI_GLOBAL = (typeof window !== 'undefined' ? window : self);
const DFI_AGENT_URL = 'http://localhost:9999';

// =========================================================================
// PURE LAYER
// =========================================================================

// ── DDL text ──────────────────────────────────────────────────────────────

// Strip `--` and `/* */` comments while respecting string literals and quoted
// identifiers. A naive regex eats the rest of the line on
// `DEFAULT 'a--b'`, taking every column after it with it.
function dfStripSqlComments(sql) {
  const s = String(sql == null ? '' : sql);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      // Copy the literal/identifier verbatim, honouring the doubled-quote escape.
      const q = c;
      out += c; i++;
      while (i < s.length) {
        if (s[i] === q && s[i + 1] === q) { out += q + q; i += 2; continue; }
        out += s[i];
        if (s[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    out += c; i++;
  }
  return out;
}

// Returns the index just past the ')' matching the '(' at `open`, or -1 when
// the statement is truncated. Quote-aware for the same reason as above.
function dfMatchParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < s.length) {
        if (s[i] === q && s[i + 1] === q) { i += 2; continue; }
        if (s[i] === q) break;
        i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Split on commas at depth 0 only — the single most important line in the DDL
// parser. See the header note.
function dfSplitTopLevel(body) {
  const parts = [];
  let depth = 0, cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const q = c === '[' ? ']' : c;
      cur += c; i++;
      while (i < body.length) {
        if (q !== ']' && body[i] === q && body[i + 1] === q) { cur += q + q; i += 2; continue; }
        cur += body[i];
        if (body[i] === q) break;
        i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(function (p) { return p.trim(); }).filter(Boolean);
}

// Read one identifier — bare, "double-quoted", `back-ticked` or [bracketed].
// Returns { name, rest }. Mendix table names carry a `$`, which is exactly why
// they arrive quoted; the quotes are delimiters, not part of the name.
function dfReadIdent(s) {
  const t = String(s).replace(/^[\s.]+/, '');
  const open = t[0];
  const closers = { '"': '"', '`': '`', '[': ']' };
  if (closers[open]) {
    const close = closers[open];
    let name = '';
    let i = 1;
    while (i < t.length) {
      if (t[i] === close && t[i + 1] === close && close !== ']') { name += close; i += 2; continue; }
      if (t[i] === close) { i++; break; }
      name += t[i]; i++;
    }
    return { name: name, rest: t.slice(i) };
  }
  const m = /^[A-Za-z_][A-Za-z0-9_$#]*/.exec(t);
  if (!m) return { name: '', rest: t };
  return { name: m[0], rest: t.slice(m[0].length) };
}

// Anything in this list starts a table-level constraint, not a column.
const DFI_CONSTRAINT_HEAD = /^(constraint|primary\s+key|foreign\s+key|unique|check|exclude|like|index|key|period)\b/i;

// Type words that are part of the type name rather than the start of a column
// constraint. `character varying`, `double precision`, `timestamp with time
// zone` all have to survive as one type.
const DFI_TYPE_CONT = /^(varying|precision|zone|time|local|with|without|unsigned|signed|byte|char)\b/i;

function dfParseColumnDef(part) {
  const idt = dfReadIdent(part);
  if (!idt.name) return null;
  let rest = idt.rest.trim();

  // Type: consume words until something that is clearly a constraint keyword.
  let type = '';
  let precision = 0, scale = 0, length = 0;
  while (rest) {
    const w = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (!w) break;
    const word = w[0];
    if (type && !DFI_TYPE_CONT.test(rest)) break;
    type += (type ? ' ' : '') + word;
    rest = rest.slice(word.length).trim();
    // A parenthesised size belongs to the type: varchar(200), numeric(10,2).
    if (rest[0] === '(') {
      const end = dfMatchParen(rest, 0);
      if (end !== -1) {
        const inner = rest.slice(1, end);
        const nums = inner.split(',').map(function (x) { return parseInt(x.trim(), 10); });
        if (!isNaN(nums[0])) { precision = nums[0]; length = nums[0]; }
        if (nums.length > 1 && !isNaN(nums[1])) scale = nums[1];
        rest = rest.slice(end + 1).trim();
      }
      break;
    }
  }

  const tail = rest;
  return {
    name: idt.name,
    sqlType: type.toLowerCase().replace(/\s+/g, ' '),
    rawType: type,
    length: length,
    precision: precision,
    scale: scale,
    notNull: /\bnot\s+null\b/i.test(tail),
    isPrimary: /\bprimary\s+key\b/i.test(tail)
  };
}

// Parse every CREATE TABLE in a script. Unparseable input yields tables: [] and
// a warning — never a silent empty success.
function dfParseDdl(sql) {
  const clean = dfStripSqlComments(sql);
  const tables = [];
  const warnings = [];
  const re = /\bcreate\s+(?:global\s+|local\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?/gi;
  let m;
  let found = 0;
  while ((m = re.exec(clean)) !== null) {
    found++;
    let rest = clean.slice(m.index + m[0].length);
    // [schema.]table — read one identifier, then a second if a dot follows.
    let first = dfReadIdent(rest);
    let schema = '';
    let name = first.name;
    let after = first.rest;
    if (/^\s*\./.test(after)) {
      const second = dfReadIdent(after.replace(/^\s*\./, ''));
      schema = name; name = second.name; after = second.rest;
    }
    if (!name) { warnings.push('A CREATE TABLE statement has no readable table name — skipped.'); continue; }

    const openRel = after.indexOf('(');
    if (openRel === -1) { warnings.push('Table "' + name + '" has no column list — skipped.'); continue; }
    const close = dfMatchParen(after, openRel);
    if (close === -1) {
      warnings.push('Table "' + name + '" is missing its closing parenthesis — the statement looks truncated, so it was skipped.');
      continue;
    }

    const body = after.slice(openRel + 1, close);
    const columns = [];
    const pkCols = [];
    dfSplitTopLevel(body).forEach(function (part) {
      if (DFI_CONSTRAINT_HEAD.test(part)) {
        // Only PRIMARY KEY (a, b) tells us something we use.
        const pk = /primary\s+key\s*\(([^)]*)\)/i.exec(part);
        if (pk) {
          pk[1].split(',').forEach(function (c) {
            const id = dfReadIdent(c.trim());
            if (id.name) pkCols.push(id.name.toLowerCase());
          });
        }
        return;
      }
      const col = dfParseColumnDef(part);
      if (col && col.name && col.sqlType) columns.push(col);
    });
    columns.forEach(function (c) {
      if (pkCols.indexOf(c.name.toLowerCase()) !== -1) c.isPrimary = true;
    });

    if (!columns.length) {
      warnings.push('Table "' + name + '" was found but no column definitions could be read from it.');
      continue;
    }
    tables.push({ name: name, schema: schema, fullName: (schema ? schema + '.' : '') + name, columns: columns });
  }

  if (!found) {
    warnings.push('No CREATE TABLE statement found. Paste the DDL export of your database (pg_dump --schema-only, or "Generate Scripts" in SQL Server Management Studio) — a SELECT or a result set cannot describe a schema.');
  }
  return { tables: tables, warnings: warnings };
}

// ── Type families ─────────────────────────────────────────────────────────
// Family, not type, is what decides whether a name hint may be applied. Every
// generator belongs to exactly one family, and a hint from a different family
// is discarded rather than forced.

const DFI_GEN_FAMILY = {
  'UUID': 'uuid',
  'Name': 'text', 'Surname': 'text', 'FullName': 'text', 'Email': 'text',
  'String': 'text', 'Address': 'text', 'City': 'text', 'Country': 'text',
  'Phone': 'text', 'Company': 'text', 'IP Address': 'text', 'Constant': 'text',
  'Number': 'number', 'Integer': 'number', 'Positive value': 'number',
  'Negative value': 'number', 'Decimal': 'number',
  'Boolean': 'bool',
  'Date': 'date'
};

const DFI_SQL_TYPES = {
  // uuid
  'uuid': 'uuid', 'uniqueidentifier': 'uuid',
  // text
  'varchar': 'text', 'character varying': 'text', 'character': 'text', 'char': 'text',
  'nvarchar': 'text', 'nchar': 'text', 'varchar2': 'text', 'nvarchar2': 'text',
  'text': 'text', 'ntext': 'text', 'clob': 'text', 'nclob': 'text', 'citext': 'text',
  'json': 'text', 'jsonb': 'text', 'xml': 'text', 'string': 'text', 'enum': 'text',
  // integers
  'smallint': 'int', 'int2': 'int', 'integer': 'int', 'int': 'int', 'int4': 'int',
  'serial': 'int', 'smallserial': 'int', 'tinyint': 'int', 'mediumint': 'int',
  // wide integers
  'bigint': 'bigint', 'int8': 'bigint', 'bigserial': 'bigint',
  // exact numerics — scale decides Integer vs Decimal
  'numeric': 'exact', 'decimal': 'exact', 'number': 'exact', 'dec': 'exact',
  'money': 'float', 'smallmoney': 'float',
  // approximate numerics
  'real': 'float', 'float': 'float', 'float4': 'float', 'float8': 'float',
  'double': 'float', 'double precision': 'float',
  'binary_float': 'float', 'binary_double': 'float',
  // boolean
  'boolean': 'bool', 'bool': 'bool', 'bit': 'bool',
  // date/time
  'date': 'date', 'timestamp': 'date', 'timestamptz': 'date', 'datetime': 'date',
  'datetime2': 'date', 'smalldatetime': 'date', 'datetimeoffset': 'date',
  'time': 'date', 'timetz': 'date',
  'timestamp with time zone': 'date', 'timestamp without time zone': 'date',
  'time with time zone': 'date', 'time without time zone': 'date',
  // binary — deliberately excluded, see header
  'bytea': 'binary', 'blob': 'binary', 'raw': 'binary', 'long raw': 'binary',
  'varbinary': 'binary', 'binary': 'binary', 'image': 'binary'
};

// ── Name rules ────────────────────────────────────────────────────────────
// Matching is done on TOKENS, not on substrings of the whole name, and that is
// not a refinement — substring matching is simply wrong here. Verified against
// 2 845 real attribute names: "BankAccountOwner" contains "town"
// (accoun+towner) and would be filled with city names; "Capacity" contains
// "city"; "discount" contains "count". Splitting the name on separators and
// camel-case boundaries first makes all three disappear, because "town",
// "city" and "count" are then simply not tokens of those names.
//
// ORDER IS STILL THE CONTRACT for names that legitimately hold two matching
// tokens: "EmailAddress" is [email, address] and must be an e-mail, not a
// street; "PhoneNumber" is [phone, number]; "CompanyName" is [company, name].
// The first rule that matches any token wins.
//
// `words` matches a whole token; `re` matches the separator-stripped name, for
// compounds that survive tokenisation ("firstname", "ipaddress").

const DFI_NAME_RULES = [
  // Before `address`: "EmailAddress" holds both tokens.
  { words: ['email', 'mail'], re: /(email|mailaddress)/, gen: 'Email' },
  { re: /(firstname|givenname|forename)/, gen: 'Name' },
  { re: /(lastname|surname|familyname)/, gen: 'Surname' },
  // Only names that denote a PERSON become a person's name. A generic
  // "ProductName" filled with "John Smith" is plausible-looking nonsense.
  { re: /(fullname|displayname|contactname|personname|customername|employeename|ownername|username)/, gen: 'FullName' },
  // A URL is text, and it is not the organisation it belongs to — without this
  // "OrganizationURL" becomes a company name.
  // The suffix form is needed because "url" is too short to match as a
  // substring: the concatenated `organizationurl` would otherwise fall through
  // to the company rule below.
  { words: ['url', 'uri', 'link', 'href', 'endpoint'], re: /(url|uri|href)$/, gen: 'String' },
  // Before `number`: "PhoneNumber" holds both tokens.
  { words: ['phone', 'mobile', 'telephone', 'tel', 'fax'], re: /phoneno/, gen: 'Phone' },
  // Before the person-name rules: "CompanyName" holds both tokens.
  { words: ['company', 'organisation', 'organization', 'employer', 'supplier', 'vendor'], gen: 'Company' },
  { words: ['ip'], re: /(ipaddress|ipaddr|remoteaddr|clientip)/, gen: 'IP Address' },
  { words: ['city', 'town'], gen: 'City' },
  { words: ['country', 'nationality'], gen: 'Country' },
  { words: ['street', 'address'], re: /(streetname|addressline|postaladdress)/, gen: 'Address' },
  { words: ['uuid', 'guid'], gen: 'UUID' },
  { words: ['price', 'amount', 'total', 'cost', 'salary', 'balance', 'revenue', 'fee', 'discount', 'vat', 'tax'], gen: 'Decimal' },
  { words: ['quantity', 'qty', 'count', 'stock', 'age', 'number'], gen: 'Positive value' }
];

function dfNormalizeName(name) {
  return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Does `word` occur in this name in a way we are willing to act on?
//
// Tokens alone are not enough: Mendix column names in the DATABASE are
// lower-cased and concatenated (`mainphonenumber`, `shippingstreet`), so the
// DDL path produces exactly one token and every rule would miss. Pure
// substring matching is not enough either — it is what made "town" match
// `bankaccountowner` (accoun+towner). Length decides between the two:
//
//   ≤ 3 chars  a whole token only. "ip" would otherwise match `shippingstreet`
//              and `zipcode`; "tel" matches `hotel`.
//   4 chars    a token, or the END of the name — `buyercity` is a city,
//              `bankaccountowner` is not a town. The vowel guard excludes the
//              Latin "-acity/-icity/-ocity" abstract nouns (capacity, velocity,
//              publicity), which are never places.
//   5+ chars   anywhere in the name. A five-letter word landing inside an
//              unrelated column name by accident is rare enough to accept,
//              and the mapping report shows the guess either way.
function dfWordMatches(word, tokens, blob) {
  if (tokens.indexOf(word) !== -1) return true;
  if (word.length <= 3) return false;
  if (word.length === 4) {
    if (blob.length <= word.length || blob.slice(-word.length) !== word) return false;
    if (word === 'city' && /[aeiou]city$/.test(blob)) return false;
    return true;
  }
  return blob.indexOf(word) !== -1;
}

// snake_case and camelCase both tokenise; the second replace keeps acronym
// boundaries intact so "IPAddress" becomes [ip, address] rather than [ipaddress].
function dfNameTokens(name) {
  return String(name == null ? '' : name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(function (t) { return t.toLowerCase(); });
}

// A hint is only honoured when its family matches the column's. UUID is also
// accepted on a text column, because a guid is very often stored in a varchar.
function dfHintFits(gen, family) {
  const gf = DFI_GEN_FAMILY[gen];
  if (!gf) return false;
  if (family === 'uuid') return gf === 'uuid';
  if (family === 'text') return gf === 'text' || gf === 'uuid';
  return gf === family;
}

// The one inference entry point: given a family, a type-derived default and a
// name, decide the generator and say where the decision came from.
function dfPickGenerator(name, family, fallback, opts) {
  opts = opts || {};
  const norm = dfNormalizeName(name);
  const tokens = dfNameTokens(name);
  for (let i = 0; i < DFI_NAME_RULES.length; i++) {
    const rule = DFI_NAME_RULES[i];
    const byWord = rule.words && rule.words.some(function (w) { return dfWordMatches(w, tokens, norm); });
    const byRe = rule.re && rule.re.test(norm);
    if (!byWord && !byRe) continue;
    if (!dfHintFits(rule.gen, family)) {
      // The name suggests something the type cannot hold — `city_id integer`.
      // Fall through to the type-based default rather than force it.
      return { type: fallback, reason: 'from the column type (the name suggests ' + rule.gen +
        ', but the column is ' + family + ')' };
    }
    return { type: rule.gen, reason: 'from the column name' };
  }
  if (opts.isPrimary && family === 'number') {
    return { type: 'Positive value', reason: 'primary key — generated as a positive number' };
  }
  return { type: fallback, reason: 'from the column type' };
}

// Turn a family + size into the generator used when the name says nothing.
function dfDefaultForFamily(family, precision, scale) {
  switch (family) {
    case 'uuid': return 'UUID';
    case 'text': return 'String';
    case 'int': return 'Integer';
    case 'bigint': return 'Number';
    // NUMBER(10,0) is Oracle's integer; treating it as a decimal writes "12.34"
    // into a column that only ever holds whole numbers. A bare `numeric` with
    // no precision at all is the opposite case — unconstrained arbitrary
    // precision, which in practice holds money, so it stays a Decimal.
    case 'exact': return scale > 0 ? 'Decimal' : (precision > 0 ? 'Integer' : 'Decimal');
    case 'float': return 'Decimal';
    case 'bool': return 'Boolean';
    case 'date': return 'Date';
    default: return 'String';
  }
}

// Families as the name rules see them: every numeric family is just 'number'.
function dfHintFamily(family) {
  if (family === 'int' || family === 'bigint' || family === 'exact' || family === 'float') return 'number';
  return family;
}

// Infer the generator for one DDL column. Returns { name, type, skip, note,
// reason, source } — `type: null` + `skip: true` means "deliberately excluded".
function dfInferColumn(col) {
  col = col || {};
  const raw = String(col.sqlType || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const family = DFI_SQL_TYPES[raw];
  const source = (col.rawType || col.sqlType || '?') +
    (col.precision ? '(' + col.precision + (col.scale ? ',' + col.scale : '') + ')' : '');

  if (family === 'binary') {
    return {
      name: col.name, type: null, skip: true, source: source,
      note: 'Binary column — random bytes are not test data, so this column is left out. Add it by hand if your import needs a placeholder.'
    };
  }
  if (!family) {
    const picked = dfPickGenerator(col.name, 'text', 'String', col);
    return {
      name: col.name, type: picked.type, skip: false, source: source, reason: picked.reason,
      note: 'Unrecognised SQL type "' + (col.rawType || col.sqlType) + '" — generated as text. Change the type above if that is wrong.'
    };
  }

  const fallback = dfDefaultForFamily(family, col.precision, col.scale);
  const picked = dfPickGenerator(col.name, dfHintFamily(family), fallback, col);
  return { name: col.name, type: picked.type, skip: false, source: source, reason: picked.reason, note: null };
}

// Infer for a Mendix attribute, whose type arrives as the display string that
// server/livedb.js already produced ("String(200)", "DateTime", "Enum"…).
function dfInferAttribute(attr) {
  attr = attr || {};
  const t = String(attr.type || '');
  const base = (/^([A-Za-z]+)/.exec(t) || [])[1] || '';
  const lower = base.toLowerCase();

  if (lower === 'binary') {
    return {
      name: attr.name, type: null, skip: true, source: t,
      note: 'Binary attribute — Mendix stores the bytes outside the entity table and random content is not test data, so it is left out.'
    };
  }
  if (lower === 'enum') {
    // The enumeration's values live in the model, not in mendixsystem$attribute,
    // so inventing one would be inventing data. Name inference is deliberately
    // NOT applied here: an enum is a closed set of codes, so "AddressType"
    // would otherwise be filled with street addresses and "CompanyType" with
    // company names — both real cases on the reference database.
    return {
      name: attr.name, type: 'String', skip: false, source: t,
      reason: 'enumeration — generated as text',
      note: 'Enumeration values are not stored in the database metadata, so this is generated as text. Switch it to Constant and type one of the real values if the import validates them.'
    };
  }

  const MX = {
    'string': 'text', 'autonumber': 'auto', 'integer': 'int', 'long': 'int',
    'decimal': 'exact', 'boolean': 'bool', 'datetime': 'date'
  };
  const family = MX[lower];
  if (!family) {
    const picked = dfPickGenerator(attr.name, 'text', 'String', {});
    return {
      name: attr.name, type: picked.type, skip: false, source: t, reason: picked.reason,
      note: 'Unrecognised Mendix attribute type "' + t + '" — generated as text.'
    };
  }
  if (family === 'auto') {
    return { name: attr.name, type: 'Positive value', skip: false, source: t,
      reason: 'auto number — generated as a positive number', note: null };
  }
  // Mendix Decimal always carries a fraction, so scale is 2 rather than 0.
  const fallback = dfDefaultForFamily(family, 0, family === 'exact' ? 2 : 0);
  const picked = dfPickGenerator(attr.name, dfHintFamily(family), fallback, {});
  return { name: attr.name, type: picked.type, skip: false, source: t, reason: picked.reason, note: null };
}

// Collect inferences into the { name, type } rows the schema editor holds,
// keeping the excluded columns and the notes so the UI can show both.
function dfCollect(inferred, emptyNote) {
  const schema = [], skipped = [], notes = [], mapping = [];
  inferred.forEach(function (r) {
    if (r.skip) {
      skipped.push({ name: r.name, source: r.source, reason: r.note });
      return;
    }
    schema.push({ name: r.name, type: r.type });
    mapping.push({ name: r.name, source: r.source, type: r.type, reason: r.reason, note: r.note });
  });
  if (!schema.length) notes.push(emptyNote);
  return { schema: schema, skipped: skipped, notes: notes, mapping: mapping };
}

function dfSchemaFromTable(table) {
  table = table || {};
  const cols = table.columns || [];
  const res = dfCollect(cols.map(dfInferColumn),
    'No column of "' + (table.name || 'this table') + '" can be generated — every one of them is a binary column. Add the fields you need by hand.');
  res.source = 'table ' + (table.fullName || table.name || '');
  return res;
}

function dfSchemaFromEntity(entity) {
  entity = entity || {};
  const attrs = entity.attributes || [];
  const res = dfCollect(attrs.map(dfInferAttribute),
    'Entity ' + (entity.name || '') + ' has no attribute that can be generated. In Mendix an entity may legitimately hold only associations — pick another entity, or add fields by hand.');
  res.source = 'entity ' + (entity.name || '');
  return res;
}

DFI_GLOBAL.dfStripSqlComments = dfStripSqlComments;
DFI_GLOBAL.dfSplitTopLevel = dfSplitTopLevel;
DFI_GLOBAL.dfReadIdent = dfReadIdent;
DFI_GLOBAL.dfParseDdl = dfParseDdl;
DFI_GLOBAL.dfInferColumn = dfInferColumn;
DFI_GLOBAL.dfInferAttribute = dfInferAttribute;
DFI_GLOBAL.dfSchemaFromTable = dfSchemaFromTable;
DFI_GLOBAL.dfSchemaFromEntity = dfSchemaFromEntity;

// =========================================================================
// UI
// =========================================================================
// Nothing below touches the DOM until a handler is invoked, so this half is
// inert under require() in Node — no `typeof document` guard needed.

const dfImp = { tables: [], model: null, module: '', filter: '', lastReport: null };

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function el(id) { return document.getElementById(id); }

function note(html, kind) {
  return '<div class="notice notice-' + (kind || 'info') + '" style="font-size:0.78rem">' + html + '</div>';
}

// Data principle: with nothing loaded these areas render NOTHING at all —
// no empty table, no "0 tables found" chrome.
function dfImpClear(id) {
  const box = el(id);
  if (box) { box.innerHTML = ''; box.style.display = 'none'; }
}

function dfImpShow(id, html) {
  const box = el(id);
  if (!box) return;
  box.innerHTML = html;
  box.style.display = html ? '' : 'none';
}

// ── Source switch ───────────────────────────────────────────────────────
DFI_GLOBAL.dfImpSetSource = function (source) {
  ['ddl', 'db'].forEach(function (s) {
    const pane = el('df-import-' + s);
    if (pane) pane.style.display = s === source ? '' : 'none';
    const tab = el('df-import-tab-' + s);
    if (tab) tab.className = 'btn btn-sm ' + (s === source ? 'btn-primary' : 'btn-ghost');
  });
};

// ── DDL path ────────────────────────────────────────────────────────────
DFI_GLOBAL.dfImpParseDdl = function () {
  const input = el('df-ddl-input');
  const text = input ? input.value : '';
  if (!text.trim()) {
    dfImpShow('df-import-tables', note(
      '<strong>Paste a DDL script first.</strong> Any <code>CREATE TABLE</code> export works: ' +
      '<code>pg_dump --schema-only</code>, "Generate Scripts" in SQL Server Management Studio, or the ' +
      'DDL tab of your database client. Only the column list is read — nothing is executed.'));
    dfImpClear('df-import-report');
    return;
  }
  const parsed = dfParseDdl(text);
  dfImp.tables = parsed.tables;

  let html = '';
  if (parsed.warnings.length) {
    html += note(parsed.warnings.map(esc).join('<br>'), 'warning');
  }
  if (parsed.tables.length) {
    html += '<div style="font-size:0.76rem;color:var(--text-muted);margin:var(--sp-2) 0 4px">' +
      parsed.tables.length + ' table' + (parsed.tables.length === 1 ? '' : 's') +
      ' found — pick the one to generate data for.</div>' +
      '<div style="max-height:180px;overflow:auto;display:flex;flex-direction:column;gap:4px">' +
      parsed.tables.map(function (t, i) {
        return '<button class="btn btn-ghost btn-sm" style="justify-content:flex-start;text-align:left" ' +
          'onclick="dfImpUseTable(' + i + ')">' + esc(t.fullName) +
          ' <span style="color:var(--text-muted);margin-left:6px">' + t.columns.length + ' columns</span></button>';
      }).join('') + '</div>';
  }
  dfImpShow('df-import-tables', html);
  dfImpClear('df-import-report');
};

DFI_GLOBAL.dfImpUseTable = function (index) {
  const table = dfImp.tables[index];
  if (!table) return;
  dfImpApply(dfSchemaFromTable(table), 'table ' + table.fullName);
};

// ── Live DB path ────────────────────────────────────────────────────────
DFI_GLOBAL.dfImpLoadModel = async function (btn) {
  if (!DFI_GLOBAL.mtDb || !DFI_GLOBAL.mtDb.isConnected()) {
    dfImpShow('df-import-entities', note(
      'Connect a database above first. Without one, use the <strong>Paste DDL</strong> tab — or keep defining ' +
      'the schema by hand, exactly as before. Nothing else about Data Factory changes.', 'warning'));
    return;
  }
  const old = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = 'Loading…'; }
  try {
    const resp = await fetch(DFI_AGENT_URL + '/livedb/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(DFI_GLOBAL.mtDb.getConfig())
    });
    const data = await resp.json();
    if (!data || data.error) {
      dfImpShow('df-import-entities', note(esc((data && data.message) || 'Could not read the model.'), 'warning'));
      return;
    }
    dfImp.model = data;
    // The largest non-System module is the application's own model — System
    // alone would be 60 platform entities nobody came here to mock.
    const first = (data.modules || []).filter(function (m) { return m.name !== 'System'; })[0] || (data.modules || [])[0];
    dfImp.module = first ? first.name : '';
    dfImp.filter = '';
    dfImpRenderEntities();
  } catch (e) {
    dfImpShow('df-import-entities', note(
      'Observability Bridge not reachable on ' + DFI_AGENT_URL + '. Start it with <code>npm run bridge</code> — ' +
      'Live DB needs the Bridge to reach PostgreSQL.', 'warning'));
  } finally {
    if (btn && old !== null) { btn.disabled = false; btn.innerHTML = old; }
  }
};

DFI_GLOBAL.dfImpSetModule = function (name) { dfImp.module = name; dfImpRenderEntities(); };
DFI_GLOBAL.dfImpSetFilter = function (value) { dfImp.filter = value; dfImpRenderEntities(true); };

function dfImpRenderEntities(listOnly) {
  const model = dfImp.model;
  if (!model) return;
  const q = dfImp.filter.trim().toLowerCase();
  const entities = (model.entities || []).filter(function (e) {
    if (dfImp.module && e.module !== dfImp.module) return false;
    if (q && String(e.name).toLowerCase().indexOf(q) === -1) return false;
    return true;
  });

  const rows = entities.length
    ? entities.map(function (e) {
        const idx = model.entities.indexOf(e);
        return '<button class="btn btn-ghost btn-sm" style="justify-content:flex-start;text-align:left" ' +
          'onclick="dfImpUseEntity(' + idx + ')">' + esc(e.shortName || e.name) +
          ' <span style="color:var(--text-muted);margin-left:6px">' + e.attributes.length + ' attributes</span></button>';
      }).join('')
    : '<div style="font-size:0.76rem;color:var(--text-muted);padding:var(--sp-2)">No entity matches this filter.</div>';

  if (listOnly) {
    const list = el('df-import-entity-list');
    if (list) { list.innerHTML = rows; return; }
  }

  const meta = model.meta
    ? '<span style="color:var(--text-muted);margin-left:auto">' + esc(model.meta.project || '') +
      ' · Mendix ' + esc(model.meta.mendixVersion || '') + '</span>'
    : '';
  const options = (model.modules || []).map(function (m) {
    return '<option value="' + esc(m.name) + '"' + (m.name === dfImp.module ? ' selected' : '') + '>' +
      esc(m.name) + ' (' + m.entityCount + ')</option>';
  }).join('');

  dfImpShow('df-import-entities',
    '<div style="display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap;font-size:0.78rem;margin-bottom:var(--sp-2)">' +
      '<strong>' + (model.stats ? model.stats.entityCount : 0) + '</strong> entities in ' +
      '<strong>' + (model.stats ? model.stats.moduleCount : 0) + '</strong> modules' + meta +
    '</div>' +
    '<div style="display:flex;gap:var(--sp-2);align-items:flex-end;margin-bottom:var(--sp-2);flex-wrap:wrap">' +
      '<label style="display:flex;flex-direction:column;gap:2px;font-size:0.68rem;color:var(--text-secondary)">Module' +
        '<select class="select select-sm" onchange="dfImpSetModule(this.value)" style="width:200px">' + options + '</select></label>' +
      '<label style="display:flex;flex-direction:column;gap:2px;font-size:0.68rem;color:var(--text-secondary)">Find entity' +
        '<input class="input input-sm" style="width:180px" placeholder="name contains…" ' +
        'value="' + esc(dfImp.filter) + '" oninput="dfImpSetFilter(this.value)"></label>' +
    '</div>' +
    '<div id="df-import-entity-list" style="max-height:180px;overflow:auto;display:flex;flex-direction:column;gap:4px">' +
      rows + '</div>');
}

DFI_GLOBAL.dfImpUseEntity = function (index) {
  const entity = dfImp.model && dfImp.model.entities[index];
  if (!entity) return;
  dfImpApply(dfSchemaFromEntity(entity), 'entity ' + entity.name);
};

// ── Applying the import ─────────────────────────────────────────────────
function dfImpApply(result, label) {
  // window.dfSchema and data-factory.js's module-local `dfSchema` are the SAME
  // array. Assigning a new array to window.dfSchema would leave the editor
  // bound to the old one, so the contents are replaced in place.
  const target = DFI_GLOBAL.dfSchema;
  if (Array.isArray(target) && result.schema.length) {
    target.length = 0;
    result.schema.forEach(function (s) { target.push({ name: s.name, type: s.type }); });
    if (DFI_GLOBAL.dfRenderSchema) DFI_GLOBAL.dfRenderSchema();
    if (DFI_GLOBAL.dfPreview) DFI_GLOBAL.dfPreview();
  }
  dfImp.lastReport = result;
  dfImpRenderReport(result, label);
}

// The report is the honesty layer: every inference is shown with its source
// and its reason, so an overridden guess is a two-second fix rather than a
// surprise discovered in the generated file.
function dfImpRenderReport(result, label) {
  let html = '';
  if (result.notes.length) {
    html += note(result.notes.map(esc).join('<br>'), 'warning');
  }
  if (result.mapping.length) {
    html += '<div style="font-size:0.78rem;margin:var(--sp-2) 0 4px">' +
      'Imported <strong>' + result.mapping.length + '</strong> field' +
      (result.mapping.length === 1 ? '' : 's') + ' from ' + esc(label) +
      ' — every generator below is a guess you can change in <em>1. Define Schema</em>.</div>' +
      '<div style="max-height:220px;overflow:auto"><table class="data-table" style="font-size:0.74rem">' +
      '<thead><tr><th>Field</th><th>Source type</th><th>Generator</th><th>Why</th></tr></thead><tbody>' +
      result.mapping.map(function (m) {
        return '<tr><td>' + esc(m.name) + '</td><td style="font-family:var(--font-mono)">' + esc(m.source) +
          '</td><td>' + esc(m.type) + '</td><td style="color:var(--text-muted)">' + esc(m.reason) +
          (m.note ? '<br><span style="color:var(--warning)">' + esc(m.note) + '</span>' : '') +
          '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  if (result.skipped.length) {
    html += '<div style="font-size:0.76rem;color:var(--text-muted);margin-top:var(--sp-2)">' +
      '<strong>' + result.skipped.length + '</strong> column' + (result.skipped.length === 1 ? '' : 's') +
      ' left out: ' + result.skipped.map(function (s) {
        return '<code>' + esc(s.name) + '</code> (' + esc(s.source) + ')';
      }).join(', ') + '. ' + esc(result.skipped[0].reason) + '</div>';
  }
  dfImpShow('df-import-report', html);
}

DFI_GLOBAL.dfImpReset = function () {
  dfImp.tables = []; dfImp.model = null; dfImp.module = ''; dfImp.filter = ''; dfImp.lastReport = null;
  const input = el('df-ddl-input');
  if (input) input.value = '';
  dfImpClear('df-import-tables');
  dfImpClear('df-import-entities');
  dfImpClear('df-import-report');
};
