// =========================================================================
// DATA FACTORY — RELATIONAL DB SEED (SQL INSERT script) · prefix `dfs`
// =========================================================================
// The flat generator (data-factory.js) makes one table of independent rows.
// This makes MANY tables of *linked* rows: a customer has orders, an order has
// lines, and the link distribution is realistic — a few customers have hundreds
// of orders, most have a handful, some have none. The output is a downloadable
// `.sql` script the developer runs themselves; nothing here writes to the
// database (the Bridge stays read-only), it only READS the schema to build the
// script from.
//
// Three things carry the risk, and each is a pure, unit-tested function below:
//
//   1. FK DIRECTION. Mendix's `buildDomainModel` reports, for a column-stored
//      association, `one`/`many` where the FK column lives on the MANY side and
//      references the ONE side's id (Order.many holds a customer_id → Customer.
//      one). So the ONE side must be inserted first (topological order), and to
//      make "some customers have many orders" we sample a customer id per order
//      with SKEWED weights — uniform sampling gives every customer ~the same
//      count, which is exactly not what real data looks like.
//
//   2. THE ID SPACE. Mendix ids are one global bigint space allocated by the
//      runtime. We assign ids from MAX(id)+1 upward on a single shared counter.
//      This is safe ONLY on a dev/reset database with the app STOPPED while the
//      script runs — stated loudly in the script header. Reusing ids the runtime
//      will later hand out would collide; a reset database never does.
//
//   3. THE COLUMN CONTRACT. Mendix metadata knows names/types/length but not
//      nullability, defaults, or the physical FK/system columns. So the exact
//      insertable contract comes from information_schema.columns (read live), and
//      a value is clamped to character_maximum_length / numeric scale before it
//      becomes a literal — an 80-char string never goes into a varchar(50).
//
// v1 scope (agreed): column-stored associations (1-* and 1-1) with a skewed or
// uniform distribution, linking to freshly generated rows and/or existing rows.
// Junction tables (*-*) and enum value sets are deliberately out of scope.
//
// Pure only: seed* attaches to window/self so scripts/parser-test.js exercises
// it in plain Node. The 4-step wizard (data-factory.js, prefix `dfw`) drives
// these functions directly for its "Multiple linked tables" source — this file
// has no UI of its own.
// =========================================================================

const DFS_GLOBAL = (typeof window !== 'undefined' ? window : self);

// =========================================================================
// PURE LAYER
// =========================================================================

// A tiny seedable PRNG (mulberry32). The distribution functions take an `rng`
// so tests are deterministic; the UI passes Math.random for non-reproducible
// data, or a seeded one when the user asks for a repeatable script.
function seedRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher–Yates, using the supplied rng. Returns the same array (mutated).
function seedShuffle(arr, rng) {
  rng = rng || Math.random;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// Topological order of the selected entities so a parent (the ONE side of a
// column-stored association) is emitted before its children (the MANY side that
// holds the FK). Only associations whose BOTH ends are selected constrain the
// order — an association to an existing-only parent imposes nothing.
//
// Returns { order, cyclic } — on a dependency cycle (self-reference, or two
// entities that each hold an optional FK to the other) the nodes that could not
// be ordered are appended and named in `cyclic`, so the caller can warn and fall
// back to nullable/existing ids for the back-edge FK.
function seedTopoOrder(selectedNames, associations) {
  const nodes = selectedNames.slice();
  const inSel = new Set(nodes);
  const edgeSet = new Set();          // 'one|many' — dedupe multi-edges
  const edges = [];
  (associations || []).forEach(function (a) {
    if (a.storage !== 'column') return;
    if (!inSel.has(a.one) || !inSel.has(a.many)) return;
    if (a.one === a.many) return;     // self-reference is a cycle by definition
    const key = a.one + '|' + a.many;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push([a.one, a.many]);
  });

  const indeg = new Map();
  nodes.forEach(function (n) { indeg.set(n, 0); });
  const out = new Map();
  nodes.forEach(function (n) { out.set(n, []); });
  edges.forEach(function (e) {
    out.get(e[0]).push(e[1]);
    indeg.set(e[1], indeg.get(e[1]) + 1);
  });

  // Stable Kahn: keep the user's selection order among ready nodes.
  const queue = nodes.filter(function (n) { return indeg.get(n) === 0; });
  const order = [];
  while (queue.length) {
    const n = queue.shift();
    order.push(n);
    out.get(n).forEach(function (m) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) queue.push(m);
    });
  }

  const cyclic = nodes.filter(function (n) { return order.indexOf(n) === -1; });
  cyclic.forEach(function (n) { order.push(n); });
  return { order: order, cyclic: cyclic };
}

// Assign a parent id (from `oneIds`) to each of `manyCount` child rows.
//   mode        'skew' (realistic) | 'uniform'
//   cardinality '1-*' | '1-1'  (1-1 draws parents WITHOUT replacement — the FK
//               column carries a UNIQUE index, so a parent is used at most once)
//   optional    the FK column is nullable → some children may get null
//   nullFraction fraction of children left null when optional (orphan children)
//   orphanFraction fraction of PARENTS guaranteed zero children (skew only)
//   skew        Zipf exponent; higher = heavier head (a few parents dominate)
//   maxPer      soft cap on children per parent (best-effort, limited retries)
// Returns an array of length manyCount, each an id from oneIds or null.
function seedDistribute(oneIds, manyCount, opts, rng) {
  opts = opts || {};
  rng = rng || Math.random;
  const n = oneIds.length;
  const result = new Array(manyCount);
  const optional = !!opts.optional;
  const nullFraction = optional ? (opts.nullFraction || 0) : 0;

  if (manyCount <= 0) return result;

  // 1-1: an injective parent→child mapping. Shuffle parents, hand out at most
  // one each; anything beyond the parent count can only be null (needs a
  // nullable FK — the caller validates that).
  if (opts.cardinality === '1-1') {
    const pool = seedShuffle(oneIds.slice(), rng);
    for (let i = 0; i < manyCount; i++) {
      if (i < pool.length && !(optional && rng() < nullFraction)) result[i] = pool[i];
      else result[i] = null;
    }
    return result;
  }

  if (n === 0) { for (let i = 0; i < manyCount; i++) result[i] = null; return result; }

  // Weights per parent. Uniform → all equal. Skew → Zipf over a random
  // permutation so the "heavy" parents are not just the first ids; a guaranteed
  // orphan fraction zeroes the lightest tail so "some parents have none" is real
  // rather than merely probable.
  const weights = new Array(n);
  if (opts.mode === 'skew') {
    const alpha = typeof opts.skew === 'number' ? opts.skew : 1.1;
    const perm = seedShuffle(rangeArray(n), rng);
    for (let r = 0; r < n; r++) weights[perm[r]] = Math.pow(r + 1, -alpha);
    const orphans = Math.min(n - 1, Math.floor((opts.orphanFraction || 0) * n));
    for (let k = 0; k < orphans; k++) weights[perm[n - 1 - k]] = 0;
  } else {
    for (let i = 0; i < n; i++) weights[i] = 1;
  }

  const cum = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) { total += weights[i]; cum[i] = total; }

  const maxPer = opts.maxPer && opts.maxPer > 0 ? opts.maxPer : Infinity;
  const counts = new Array(n).fill(0);
  for (let i = 0; i < manyCount; i++) {
    if (optional && rng() < nullFraction) { result[i] = null; continue; }
    if (total <= 0) { result[i] = null; continue; }
    let j = -1;
    for (let attempt = 0; attempt < 4; attempt++) {
      const pick = lowerBound(cum, rng() * total);
      if (counts[pick] < maxPer) { j = pick; break; }
      j = pick;
    }
    counts[j]++;
    result[i] = oneIds[j];
  }
  return result;
}

function rangeArray(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = i; return a; }

// First index whose cumulative value is > x. cum is strictly the prefix sum.
function lowerBound(cum, x) {
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Map an information_schema column (data_type / udt_name) to the family that
// decides how a value is written as a literal. Kept local so the pure layer has
// no cross-file dependency under require().
const DFS_TYPE_FAMILY = {
  'uuid': 'uuid',
  'character varying': 'text', 'varchar': 'text', 'character': 'text', 'char': 'text',
  'bpchar': 'text', 'text': 'text', 'citext': 'text', 'name': 'text',
  'json': 'text', 'jsonb': 'text', 'xml': 'text',
  'smallint': 'int', 'integer': 'int', 'int2': 'int', 'int4': 'int',
  'bigint': 'bigint', 'int8': 'bigint',
  'numeric': 'exact', 'decimal': 'exact',
  'real': 'float', 'double precision': 'float', 'float4': 'float', 'float8': 'float', 'money': 'float',
  'boolean': 'bool', 'bool': 'bool',
  'date': 'date', 'timestamp': 'date', 'timestamptz': 'date',
  'timestamp without time zone': 'date', 'timestamp with time zone': 'date',
  'time': 'date', 'time without time zone': 'date', 'time with time zone': 'date',
  'bytea': 'binary'
};

function seedColumnFamily(colMeta) {
  colMeta = colMeta || {};
  const dt = String(colMeta.dataType || '').toLowerCase().trim();
  const udt = String(colMeta.udtName || '').toLowerCase().trim();
  return DFS_TYPE_FAMILY[dt] || DFS_TYPE_FAMILY[udt] || 'text';
}

// Values come from the shared engine (data-factory-generators.js → dfgGenerate):
// region-aware pools, per-column parameters, emptyPercent and uniqueness all
// live there. seedSqlLiteral below only turns a produced value into a SQL literal.

function seedEscapeString(s) { return String(s).replace(/'/g, "''"); }

// Turn a raw value + real column metadata into a SQL literal, clamping to the
// column's constraints. This is the line that guarantees an over-long string or
// an over-precise decimal never reaches a column that cannot hold it.
function seedSqlLiteral(value, colMeta) {
  if (value === null || value === undefined) return 'NULL';
  colMeta = colMeta || {};
  const family = colMeta.family || seedColumnFamily(colMeta);
  switch (family) {
    case 'int':
    case 'bigint': {
      const n = Math.round(Number(value));
      return isFinite(n) ? String(n) : 'NULL';
    }
    case 'exact': {
      const num = Number(value);
      if (!isFinite(num)) return 'NULL';
      const scale = colMeta.numericScale != null ? Math.max(0, colMeta.numericScale | 0) : 0;
      return num.toFixed(scale);
    }
    case 'float': {
      const num = Number(value);
      return isFinite(num) ? String(num) : 'NULL';
    }
    case 'bool':
      return (value === true || value === 'true' || value === 't' || value === 1) ? 'true' : 'false';
    case 'date':
      return "'" + seedEscapeString(value) + "'";
    case 'uuid':
      return "'" + seedEscapeString(value) + "'";
    case 'binary':
      return 'NULL';
    default: {
      let s = String(value);
      const max = colMeta.maxLength;
      if (typeof max === 'number' && max > 0 && s.length > max) s = s.slice(0, max);
      return "'" + seedEscapeString(s) + "'";
    }
  }
}

function seedQuoteIdent(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

// Build one multi-row INSERT from rows already turned into literal arrays.
function seedInsertStatement(table, colNames, rowsOfLiterals) {
  if (!rowsOfLiterals.length) return '';
  const cols = colNames.map(seedQuoteIdent).join(', ');
  const values = rowsOfLiterals.map(function (r) { return '  (' + r.join(', ') + ')'; }).join(',\n');
  return 'INSERT INTO ' + seedQuoteIdent(table) + ' (' + cols + ') VALUES\n' + values + ';';
}

// Summarise a distribution assignment for the "is this realistic?" report:
// how many parents got zero, the median and the max children per parent.
function seedDistributionStats(oneIds, assignment) {
  const counts = new Map();
  oneIds.forEach(function (id) { counts.set(id, 0); });
  let linked = 0, nulls = 0;
  assignment.forEach(function (id) {
    if (id === null || id === undefined) { nulls++; return; }
    linked++;
    counts.set(id, (counts.get(id) || 0) + 1);
  });
  const vals = Array.from(counts.values()).sort(function (a, b) { return a - b; });
  const zero = vals.filter(function (v) { return v === 0; }).length;
  const median = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  const max = vals.length ? vals[vals.length - 1] : 0;
  return { parents: oneIds.length, zero: zero, median: median, max: max, linked: linked, nulls: nulls };
}

DFS_GLOBAL.seedRng = seedRng;
DFS_GLOBAL.seedTopoOrder = seedTopoOrder;
DFS_GLOBAL.seedDistribute = seedDistribute;
DFS_GLOBAL.seedColumnFamily = seedColumnFamily;
DFS_GLOBAL.seedSqlLiteral = seedSqlLiteral;
DFS_GLOBAL.seedInsertStatement = seedInsertStatement;
DFS_GLOBAL.seedDistributionStats = seedDistributionStats;
DFS_GLOBAL.seedQuoteIdent = seedQuoteIdent;
