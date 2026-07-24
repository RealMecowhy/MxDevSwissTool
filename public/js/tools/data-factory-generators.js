// =========================================================================
// DATA FACTORY — GENERATOR ENGINE (declarative, parametrized) · prefix `dfg`
// =========================================================================
// The shared value engine behind every Data Factory output (flat CSV/JSON/XML,
// the relational SQL seed) and, later, the message generator. One idea carries
// the whole design: a generator is DECLARATIVE — it names its family and the
// PARAMETERS it accepts (a Date's from/to, a Country's region, a Number's
// min/max, a Custom list's values+weights), and the UI renders those parameters
// generically in the review step's "Options" column. Adding a parameter is data,
// not a new UI branch.
//
// Separation of concerns is strict: this engine produces RAW values
// (string/number/boolean/null). Turning a value into a CSV cell, an XML node or
// a SQL literal is the output layer's job — never here. That boundary is what
// lets the future message generator reuse this file unchanged.
//
// Two cross-cutting parameters live outside the per-generator params because
// they apply to any column:
//   • emptyPercent — a share of rows left NULL (real data has holes; NULLs also
//     change query plans, which is half the point of this tool).
//   • unique — the column carries a UNIQUE index (Mendix "unique" validation).
//     A duplicate would abort the whole SQL transaction, so uniqueness here is
//     correctness, not polish. rowIndex is globally unique per run, so weaving it
//     in guarantees no collision.
//
// Pure: attaches to window/self so scripts/parser-test.js exercises it in Node.
// =========================================================================

const DFG_GLOBAL = (typeof window !== 'undefined' ? window : self);

// ── seedable PRNG (mulberry32) so a "reproducible" run is byte-identical ──
function dfgRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dfgInt(min, max, rng) { return Math.floor(rng() * (max - min + 1)) + min; }
function dfgPick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }
function dfgPad(n, width) { let s = String(n); while (s.length < width) s = '0' + s; return s; }

// =========================================================================
// DATA POOLS — region-aware. Bigger than the legacy 10-name lists so 10 000
// rows don't read as a dozen "Jane Doe"s; grouped by nationality/continent so a
// Polish demo gets Polish names and a European report gets European cities.
// =========================================================================

const DFG_POOLS = {
  first: {
    global: ['James','Maria','Wei','Ahmed','Sofia','Liam','Yuki','Olga','Carlos','Priya','Noah','Amara','Chen','Elena','Omar','Ingrid','Diego','Fatima','Lucas','Nadia'],
    polish: ['Jan','Anna','Piotr','Katarzyna','Andrzej','Małgorzata','Tomasz','Agnieszka','Marcin','Barbara','Krzysztof','Ewa','Paweł','Magdalena','Michał','Joanna'],
    german: ['Lukas','Anna','Felix','Marie','Paul','Sophie','Max','Emma','Jonas','Laura','Leon','Hannah','Finn','Lena','Tim','Julia'],
    us: ['James','Emily','Michael','Sarah','David','Jessica','Chris','Ashley','Daniel','Amanda','Matthew','Jennifer','Andrew','Elizabeth','Joshua','Megan']
  },
  last: {
    global: ['Smith','Garcia','Wang','Khan','Rossi','Müller','Kowalski','Silva','Nakamura','Johansson','Dubois','Ivanov','Costa','Yilmaz','Nguyen','Okafor','Andersson','Haddad','Popov','Reyes'],
    polish: ['Nowak','Kowalski','Wiśniewski','Wójcik','Kowalczyk','Kamiński','Lewandowski','Zieliński','Szymański','Woźniak','Dąbrowski','Kozłowski','Jankowski','Mazur','Krawczyk','Piotrowski'],
    german: ['Müller','Schmidt','Schneider','Fischer','Weber','Meyer','Wagner','Becker','Schulz','Hoffmann','Koch','Richter','Bauer','Klein','Wolf','Neumann'],
    us: ['Smith','Johnson','Williams','Brown','Jones','Miller','Davis','Wilson','Anderson','Taylor','Thomas','Moore','Jackson','Martin','Lee','Harris']
  },
  city: {
    global: ['New York','London','Tokyo','Paris','Berlin','Sydney','Toronto','Dubai','Mumbai','São Paulo','Singapore','Cape Town','Warsaw','Seoul','Mexico City','Amsterdam'],
    europe: ['London','Paris','Berlin','Madrid','Rome','Warsaw','Amsterdam','Vienna','Prague','Lisbon','Stockholm','Munich','Copenhagen','Dublin','Budapest','Kraków'],
    asia: ['Tokyo','Seoul','Shanghai','Mumbai','Singapore','Bangkok','Jakarta','Manila','Delhi','Osaka','Taipei','Hanoi','Kuala Lumpur','Dubai'],
    americas: ['New York','Toronto','Chicago','Los Angeles','Mexico City','São Paulo','Buenos Aires','Lima','Bogotá','Vancouver','Montreal','Santiago','Houston','Miami']
  },
  country: {
    global: ['USA','UK','Germany','France','Poland','Japan','Brazil','India','Canada','Australia','Spain','Italy','Netherlands','Sweden','Mexico','South Korea'],
    europe: ['Poland','Germany','France','Spain','Italy','Netherlands','Sweden','Austria','Czechia','Portugal','Denmark','Ireland','Belgium','Norway','Finland','Greece'],
    asia: ['Japan','South Korea','China','India','Singapore','Thailand','Indonesia','Vietnam','Malaysia','Philippines','Taiwan','UAE'],
    americas: ['USA','Canada','Mexico','Brazil','Argentina','Chile','Colombia','Peru','Uruguay','Ecuador']
  },
  company: {
    global: ['Acme Corp','Globex','Initech','Umbrella','Soylent','Massive Dynamic','Stark Industries','Wayne Enterprises','Hooli','Vandelay','Wonka','Cyberdyne','Gringotts','Tyrell','Aperture','Nakatomi'],
    polish: ['Orlen','Żabka','CD Projekt','Allegro','LPP','InPost','Comarch','Asseco','Dino','PKN','Grupa Azoty','mBank','PZU','Cyfrowy Polsat'],
    us: ['Acme Corp','Globex','Initech','Vandelay Industries','Hooli','Pied Piper','Aviato','Dunder Mifflin','Sterling Cooper','Wayne Enterprises','Stark Industries']
  },
  street: {
    global: ['Main St','High St','Park Ave','Broadway','Elm St','Maple Dr','Oak Ln','Pine Rd','Church St','Market St','King St','Queen St'],
    polish: ['ul. Kwiatowa','ul. Lipowa','ul. Słoneczna','ul. Ogrodowa','ul. Polna','ul. Krótka','ul. Leśna','ul. Długa','ul. Szkolna','al. Jerozolimskie'],
    us: ['Main St','Oak Ave','Maple Dr','Washington Blvd','Park Ave','Lincoln St','2nd St','Sunset Blvd','Cedar Ln','Highland Ave']
  }
};

function dfgPoolFor(kind, region) {
  const g = DFG_POOLS[kind];
  return (g && g[region]) || (g && g.global) || [''];
}

// Phone format per region — a Polish demo should not show +1 numbers.
function dfgPhone(region, rng) {
  switch (region) {
    case 'polish': return '+48 ' + dfgInt(500, 899, rng) + ' ' + dfgInt(100, 999, rng) + ' ' + dfgInt(100, 999, rng);
    case 'german': return '+49 ' + dfgInt(150, 179, rng) + ' ' + dfgInt(1000000, 9999999, rng);
    case 'us': return '+1 (' + dfgInt(200, 989, rng) + ') ' + dfgInt(200, 999, rng) + '-' + dfgInt(1000, 9999, rng);
    default: return '+' + dfgInt(1, 99, rng) + ' ' + dfgInt(100, 999, rng) + ' ' + dfgInt(100000, 999999, rng);
  }
}

// =========================================================================
// PARAMETER OPTION SETS (shared across generators for consistent dropdowns)
// =========================================================================
const DFG_NATIONALITY = [
  { value: 'global', label: 'Global' }, { value: 'polish', label: 'Polish' },
  { value: 'german', label: 'German' }, { value: 'us', label: 'US / English' }
];
const DFG_CONTINENT = [
  { value: 'global', label: 'Global' }, { value: 'europe', label: 'Europe' },
  { value: 'asia', label: 'Asia' }, { value: 'americas', label: 'Americas' }
];
const DFG_IPRANGE = [
  { value: 'any', label: 'Any' }, { value: 'private', label: 'Private (10/192.168)' },
  { value: 'public', label: 'Public' }
];

// =========================================================================
// GENERATOR REGISTRY
// Each: { label, family, params:[{key,type,label,default,options?,...}], gen }
//   family ∈ text | number | bool | date | uuid  (for column-type compatibility)
//   gen(params, ctx, rng) → raw value.  ctx carries { rowIndex } and per-column
//   state; params are already merged with defaults by dfgGenerate.
// =========================================================================

const DFG_GENERATORS = {
  'UUID': {
    label: 'UUID', family: 'uuid', params: [],
    gen: function (p, ctx, rng) {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.floor(rng() * 16);
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }
  },
  'Name': {
    label: 'First name', family: 'text',
    params: [{ key: 'region', type: 'select', label: 'Region', default: 'global', options: DFG_NATIONALITY }],
    gen: function (p, ctx, rng) { return dfgPick(dfgPoolFor('first', p.region), rng); }
  },
  'Surname': {
    label: 'Surname', family: 'text',
    params: [{ key: 'region', type: 'select', label: 'Region', default: 'global', options: DFG_NATIONALITY }],
    gen: function (p, ctx, rng) { return dfgPick(dfgPoolFor('last', p.region), rng); }
  },
  'FullName': {
    label: 'Full name', family: 'text',
    params: [{ key: 'region', type: 'select', label: 'Region', default: 'global', options: DFG_NATIONALITY }],
    gen: function (p, ctx, rng) { return dfgPick(dfgPoolFor('first', p.region), rng) + ' ' + dfgPick(dfgPoolFor('last', p.region), rng); }
  },
  'Email': {
    label: 'Email', family: 'text',
    params: [
      { key: 'domain', type: 'text', label: 'Domain', default: 'example.com' },
      { key: 'region', type: 'select', label: 'Names', default: 'global', options: DFG_NATIONALITY }
    ],
    gen: function (p, ctx, rng) {
      const f = dfgAscii(dfgPick(dfgPoolFor('first', p.region), rng)).toLowerCase();
      const l = dfgAscii(dfgPick(dfgPoolFor('last', p.region), rng)).toLowerCase();
      return f + '.' + l + dfgInt(1, 9999, rng) + '@' + (p.domain || 'example.com');
    }
  },
  'Number': {
    label: 'Number', family: 'number',
    params: [{ key: 'min', type: 'number', label: 'Min', default: 1 }, { key: 'max', type: 'number', label: 'Max', default: 10000 }],
    gen: function (p, ctx, rng) { return dfgInt(dfgNum(p.min, 1), dfgNum(p.max, 10000), rng); }
  },
  'Integer': {
    label: 'Integer', family: 'number',
    params: [{ key: 'min', type: 'number', label: 'Min', default: -10000 }, { key: 'max', type: 'number', label: 'Max', default: 10000 }],
    gen: function (p, ctx, rng) { return dfgInt(dfgNum(p.min, -10000), dfgNum(p.max, 10000), rng); }
  },
  'Positive value': {
    label: 'Positive value', family: 'number',
    params: [{ key: 'min', type: 'number', label: 'Min', default: 1 }, { key: 'max', type: 'number', label: 'Max', default: 100000 }],
    gen: function (p, ctx, rng) { return dfgInt(Math.max(1, dfgNum(p.min, 1)), dfgNum(p.max, 100000), rng); }
  },
  'Negative value': {
    label: 'Negative value', family: 'number',
    params: [{ key: 'min', type: 'number', label: 'Min', default: -100000 }, { key: 'max', type: 'number', label: 'Max', default: -1 }],
    gen: function (p, ctx, rng) { return dfgInt(dfgNum(p.min, -100000), Math.min(-1, dfgNum(p.max, -1)), rng); }
  },
  'Decimal': {
    label: 'Decimal', family: 'number',
    params: [
      { key: 'min', type: 'number', label: 'Min', default: 0 }, { key: 'max', type: 'number', label: 'Max', default: 10000 },
      { key: 'scale', type: 'number', label: 'Decimals', default: 2 }
    ],
    gen: function (p, ctx, rng) {
      const min = dfgNum(p.min, 0), max = dfgNum(p.max, 10000), scale = Math.max(0, dfgNum(p.scale, 2));
      const v = min + rng() * (max - min);
      return Number(v.toFixed(scale));
    }
  },
  'Boolean': {
    label: 'Boolean', family: 'bool',
    params: [{ key: 'truePercent', type: 'number', label: '% true', default: 50 }],
    gen: function (p, ctx, rng) { return rng() * 100 < dfgNum(p.truePercent, 50); }
  },
  'Date': {
    label: 'Date / time', family: 'date',
    params: [
      { key: 'from', type: 'date', label: 'From', default: '2020-01-01' },
      { key: 'to', type: 'date', label: 'To', default: '2026-12-31' }
    ],
    gen: function (p, ctx, rng) {
      const a = dfgParseDate(p.from, Date.UTC(2020, 0, 1));
      const b = dfgParseDate(p.to, Date.now());
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const d = new Date(lo + Math.floor(rng() * (hi - lo + 1)));
      return d.toISOString().slice(0, 19).replace('T', ' ');
    }
  },
  'String': {
    label: 'Random string', family: 'text',
    params: [{ key: 'minLen', type: 'number', label: 'Min length', default: 6 }, { key: 'maxLen', type: 'number', label: 'Max length', default: 12 }],
    gen: function (p, ctx, rng) {
      const min = Math.max(1, dfgNum(p.minLen, 6)), max = Math.max(min, dfgNum(p.maxLen, 12));
      const n = dfgInt(min, max, rng), al = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let s = '';
      for (let i = 0; i < n; i++) s += al[Math.floor(rng() * al.length)];
      return s;
    }
  },
  'Address': {
    label: 'Street address', family: 'text',
    params: [{ key: 'region', type: 'select', label: 'Region', default: 'global', options: DFG_NATIONALITY }],
    gen: function (p, ctx, rng) { return dfgInt(1, 999, rng) + ' ' + dfgPick(dfgPoolFor('street', p.region), rng); }
  },
  'City': {
    label: 'City', family: 'text',
    params: [{ key: 'region', type: 'select', label: 'Region', default: 'global', options: DFG_CONTINENT }],
    gen: function (p, ctx, rng) { return dfgPick(dfgPoolFor('city', p.region), rng); }
  },
  'Country': {
    label: 'Country', family: 'text',
    params: [{ key: 'region', type: 'select', label: 'Region', default: 'global', options: DFG_CONTINENT }],
    gen: function (p, ctx, rng) { return dfgPick(dfgPoolFor('country', p.region), rng); }
  },
  'Phone': {
    label: 'Phone', family: 'text',
    params: [{ key: 'region', type: 'select', label: 'Region', default: 'global', options: DFG_NATIONALITY }],
    gen: function (p, ctx, rng) { return dfgPhone(p.region, rng); }
  },
  'Company': {
    label: 'Company', family: 'text',
    params: [{ key: 'region', type: 'select', label: 'Region', default: 'global', options: DFG_NATIONALITY }],
    gen: function (p, ctx, rng) { return dfgPick(dfgPoolFor('company', p.region), rng); }
  },
  'IP Address': {
    label: 'IP address', family: 'text',
    params: [{ key: 'range', type: 'select', label: 'Range', default: 'any', options: DFG_IPRANGE }],
    gen: function (p, ctx, rng) {
      if (p.range === 'private') return (rng() < 0.5 ? '10.' + dfgInt(0, 255, rng) : '192.168.' + dfgInt(0, 255, rng)) + '.' + dfgInt(1, 254, rng);
      if (p.range === 'public') return dfgInt(1, 223, rng) + '.' + dfgInt(0, 255, rng) + '.' + dfgInt(0, 255, rng) + '.' + dfgInt(1, 254, rng);
      return dfgInt(1, 255, rng) + '.' + dfgInt(0, 255, rng) + '.' + dfgInt(0, 255, rng) + '.' + dfgInt(0, 255, rng);
    }
  },
  'Constant': {
    label: 'Constant', family: 'text',
    params: [{ key: 'value', type: 'text', label: 'Value', default: '' }],
    gen: function (p) { return p.value == null ? '' : p.value; }
  },
  // ── new parametrized generators ──
  'Pattern': {
    label: 'Code / pattern', family: 'text',
    params: [{ key: 'mask', type: 'text', label: 'Mask (# digit, ? A–Z, * alnum)', default: 'ORD-#####' }],
    gen: function (p, ctx, rng) {
      const mask = String(p.mask == null ? '' : p.mask);
      let out = '';
      for (let i = 0; i < mask.length; i++) {
        const c = mask[i];
        if (c === '#') out += dfgInt(0, 9, rng);
        else if (c === '?') out += String.fromCharCode(65 + dfgInt(0, 25, rng));
        else if (c === '*') { const al = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; out += al[dfgInt(0, al.length - 1, rng)]; }
        else out += c;
      }
      return out;
    }
  },
  'Sequence': {
    label: 'Sequence', family: 'text',
    params: [
      { key: 'prefix', type: 'text', label: 'Prefix', default: 'INV-' },
      { key: 'start', type: 'number', label: 'Start', default: 1 },
      { key: 'width', type: 'number', label: 'Zero-pad width', default: 6 }
    ],
    // Naturally unique — the row index drives the counter, so no collisions.
    gen: function (p, ctx) {
      const start = dfgNum(p.start, 1), width = Math.max(0, dfgNum(p.width, 6));
      const n = start + (ctx.rowIndex || 0);
      return (p.prefix == null ? '' : p.prefix) + dfgPad(n, width);
    }
  },
  'Custom list': {
    label: 'Custom list', family: 'text',
    params: [
      { key: 'values', type: 'list', label: 'Values', default: [] },
      { key: 'weights', type: 'weights', label: 'Weights (optional)', default: [] }
    ],
    gen: function (p, ctx, rng) {
      const values = dfgToList(p.values);
      if (!values.length) return '';
      const weights = dfgToList(p.weights).map(Number).filter(function (w) { return isFinite(w); });
      if (weights.length === values.length && weights.some(function (w) { return w > 0; })) {
        let total = 0; for (let i = 0; i < weights.length; i++) total += Math.max(0, weights[i]);
        let x = rng() * total;
        for (let i = 0; i < values.length; i++) { x -= Math.max(0, weights[i]); if (x <= 0) return values[i]; }
        return values[values.length - 1];
      }
      return dfgPick(values, rng);
    }
  }
};

// Enum is Custom list with the same mechanics — kept as a distinct id so the UI
// can label it and pre-fill values from a DISTINCT sniff of the live column.
DFG_GENERATORS['Enum'] = {
  label: 'Enumeration', family: 'text',
  params: [{ key: 'values', type: 'list', label: 'Allowed values', default: [] }, { key: 'weights', type: 'weights', label: 'Weights (optional)', default: [] }],
  gen: DFG_GENERATORS['Custom list'].gen
};

// ── small helpers used by generators ──
function dfgNum(v, dflt) { const n = Number(v); return isFinite(n) ? n : dflt; }
function dfgParseDate(v, dflt) {
  if (v == null || v === '') return dflt;
  const t = Date.parse(v);
  return isNaN(t) ? dflt : t;
}
function dfgToList(v) {
  if (Array.isArray(v)) return v.map(function (x) { return String(x).trim(); }).filter(function (x) { return x.length; });
  if (v == null) return [];
  return String(v).split(/[,\n]/).map(function (x) { return x.trim(); }).filter(function (x) { return x.length; });
}
// Strip diacritics so "Wiśniewski" → a clean e-mail local part.
function dfgAscii(s) {
  const str = String(s);
  const combining = new RegExp('[\\u0300-\\u036f]', 'g');
  const folded = str.normalize ? str.normalize('NFD').replace(combining, '') : str;
  return folded.replace(/[^a-zA-Z0-9]/g, '');
}

// =========================================================================
// PUBLIC API
// =========================================================================

// Merge caller params over the generator's declared defaults.
function dfgDefaults(genName) {
  const g = DFG_GENERATORS[genName];
  const out = {};
  if (g) g.params.forEach(function (pr) { out[pr.key] = pr.default; });
  return out;
}

// The single entry point. Returns a raw value or null (empty).
//   genName  a key of DFG_GENERATORS (falls back to 'String')
//   params   caller overrides (merged over defaults)
//   ctx      { rowIndex, emptyPercent, unique }
//   rng      a function returning [0,1); pass a seeded one for reproducibility
function dfgGenerate(genName, params, ctx, rng) {
  ctx = ctx || {};
  rng = rng || Math.random;
  const g = DFG_GENERATORS[genName] || DFG_GENERATORS['String'];
  // emptyPercent is a column-level hole, evaluated before generation.
  if (ctx.emptyPercent && rng() * 100 < ctx.emptyPercent) return null;
  const merged = Object.assign(dfgDefaults(genName), params || {});
  let val = g.gen(merged, ctx, rng);
  if (ctx.unique) val = dfgMakeUnique(val, g.family, genName, ctx);
  return val;
}

// Guarantee uniqueness by weaving in rowIndex (unique per run). Sequence is
// already unique; UUID practically so. Text gets a compact suffix; e-mails keep
// a valid shape by inserting a +tag before the @.
function dfgMakeUnique(val, family, genName, ctx) {
  if (genName === 'Sequence' || genName === 'UUID') return val;
  const tag = (ctx.rowIndex || 0).toString(36);
  if (family === 'text') {
    const s = String(val);
    const at = s.indexOf('@');
    if (at !== -1) return s.slice(0, at) + '+' + tag + s.slice(at);
    return s + '-' + tag;
  }
  if (family === 'number') return Math.floor(Number(val) || 0) * 100000 + (ctx.rowIndex || 0);
  return val;
}

// Metadata for the UI: list of { id, label, family, params } for the Options
// column and the generator dropdown.
function dfgList() {
  return Object.keys(DFG_GENERATORS).map(function (id) {
    const g = DFG_GENERATORS[id];
    return { id: id, label: g.label, family: g.family, params: g.params };
  });
}

function dfgFamily(genName) { const g = DFG_GENERATORS[genName]; return g ? g.family : 'text'; }

DFG_GLOBAL.dfgRng = dfgRng;
DFG_GLOBAL.dfgGenerate = dfgGenerate;
DFG_GLOBAL.dfgDefaults = dfgDefaults;
DFG_GLOBAL.dfgList = dfgList;
DFG_GLOBAL.dfgFamily = dfgFamily;
DFG_GLOBAL.dfgToList = dfgToList;
DFG_GLOBAL.DFG_GENERATORS = DFG_GENERATORS;
