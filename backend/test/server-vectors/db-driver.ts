// Run from a checkout of fk-plugin-download (its pinned `pg` and its `customTypes`), with TZ=UTC
// and DB_DRIVER_URL pointing at a scratch database: `npx tsx <this file>`.
import { writeFileSync } from 'fs';
import { join } from 'path';
import { Client, types } from 'pg';

const CASES: [string, unknown[]][] = [
  ['SELECT $1::int4 AS v', [{ t: 'int', v: 42 }]], ['SELECT $1::int8 AS v', [{ t: 'int', v: 9007199254740991 }]],
  ['SELECT $1::int2 AS v', [{ t: 'int', v: -7 }]], ['SELECT $1::text AS v', [{ t: 'text', v: 'héllo' }]],
  ['SELECT $1::numeric AS v', [{ t: 'text', v: '12.3400' }]], ['SELECT $1::numeric AS v', [{ t: 'int', v: -5 }]],
  ['SELECT $1::numeric AS v', [{ t: 'float', v: 0.5 }]], ['SELECT 0.0001::numeric AS v', []],
  ['SELECT 123456789.000012::numeric AS v', []], ["SELECT 'NaN'::numeric AS v", []],
  ['SELECT $1::timestamptz AS v', [{ t: 'text', v: '2026-10-16T12:34:56.789+02:00' }]],
  ['SELECT $1::timestamp AS v', [{ t: 'text', v: '2026-10-16 12:34:56.7' }]], ['SELECT $1::date AS v', [{ t: 'text', v: '1999-12-31' }]],
  ['SELECT $1::jsonb AS v', [{ t: 'json', v: { a: [1, true] } }]], ['SELECT $1::json AS v', [{ t: 'json', v: { a: 1 } }]],
  ['SELECT array_length($1::text[], 1) AS v', [{ t: 'text-list', v: ['a', 'b"c', 'd\\e'] }]],
  ['SELECT ($1::text[])[2] AS v', [{ t: 'text-list', v: ['a', 'b"c'] }]], ['SELECT ($1::int8[])[3] AS v', [{ t: 'int-list', v: [1, 2, 3] }]],
  ['SELECT 3 = ANY($1::int4[]) AS v', [{ t: 'int-list', v: [1, 2, 3] }]], ['SELECT $1::bool AS v', [{ t: 'bool', v: true }]],
  ['SELECT $1::bool AS v', [{ t: 'bool', v: false }]], ['SELECT $1::bytea AS v', [{ t: 'bytes', v: [0, 255, 16] }]],
  ['SELECT length($1::bytea) AS v', [{ t: 'bytes', v: [1, 2, 3, 4] }]], ['SELECT $1::float8 AS v', [{ t: 'float', v: 1.5 }]],
  ['SELECT $1::float4 AS v', [{ t: 'float', v: 0.25 }]], ['SELECT $1::int4 IS NULL AS v', [{ t: 'null' }]],
  ['SELECT NULL::text AS v', []], ['SELECT $1 AS v', [{ t: 'text', v: 'inferred text' }]],
  ['SELECT $1::varchar AS v', [{ t: 'text', v: 'vc' }]], ['SELECT $1::char(3) AS v', [{ t: 'text', v: 'ab' }]],
  ["SELECT 'n'::name AS v", []], ["SELECT '6ba7b810-9dad-11d1-80b4-00c04fd430c8'::uuid AS v", []],
  ['SELECT $1::int4 + 1 AS v', [{ t: 'text', v: '41' }]], ['SELECT $1::int8 AS v', [{ t: 'text', v: '-9000000000' }]],
  ["SELECT $1::jsonb ->> 'k' AS v", [{ t: 'json', v: { k: 'v' } }]], ["SELECT 'infinity'::timestamptz AS v", []],
  ["SELECT '-infinity'::timestamp AS v", []], ["SELECT '2000-01-01'::date - 1 AS v", []],
  ['SELECT pg_advisory_unlock_all() AS v', []], ['SELECT now() - now() AS v', []], ['SELECT $1::int4 AS v', [{ t: 'text', v: 'x' }]],
  ['SELECT $1::float8 AS v', [{ t: 'float', v: -0.0001 }]], ['SELECT ARRAY[1,2]::int4[] AS v', []],
];

// The download plugin's parsers (`src/db/pool.ts`), as the plugin ran them.
const parsers = {
  getTypeParser(oid: number, format?: any) {
    if (oid === types.builtins.INT8) return (val: string) => Number(val);
    if (oid === types.builtins.TIMESTAMPTZ) return (val: string) => new Date(val).toISOString();
    return types.getTypeParser(oid, format);
  },
};

const param = (p: any) => (p.t === 'null' ? null : p.t === 'bytes' ? Buffer.from(p.v) : p.t === 'json' ? JSON.stringify(p.v) : p.v);

// The value as the plugin's code saw it, in JSON: a Buffer as its bytes, a Date as its ISO text.
function canon(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return { bytes: [...v] };
  if (v instanceof Date) return { date: Number.isNaN(v.getTime()) ? String(v) : v.toISOString() };
  return v;
}

async function main() {
  const client = new Client({ connectionString: process.env.DB_DRIVER_URL, types: parsers as never });
  await client.connect();
  const cases: string[] = [];
  for (const [sql, params] of CASES) {
    let expected: unknown;
    try {
      const r = await client.query(sql, params.map(param));
      expected = { columns: r.fields.map((f) => f.name), value: canon(r.rows[0]?.v) };
    } catch {
      expected = 'error';
    }
    cases.push(JSON.stringify({ input: { sql, params }, expected }));
  }
  await client.end();
  const out = join(__dirname, '../../../server/fixtures/db-driver/cases.json');
  writeFileSync(out, `{"cases":[\n${cases.join(',\n')}\n]}\n`, 'utf8');
}

void main();
