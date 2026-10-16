import { CronExpressionParser } from 'cron-parser';
import { emit, mulberry32, pick, ri } from './_util';

const CORE = ['0 02 * * *', '0 04 * * *', '0 3 * * *', '0 0-23/6 * * *'];
const EXPRS = [
  ...CORE, '0 * * * *', '*/15 * * * *', '30 0 2 * * *', '0 30 2 * * *', '0 30 1 * * *', '15 2 * * *', '0 2 * * 1', '0 0 1 * *',
  '*/10 * * * * *', '0 0 */2 * *', '0 9-17 * * 1-5', '0 0 29 2 *', '5 4 * * sun', '0 0 L * *',
];
const TZS = ['UTC', 'Europe/Paris', 'America/New_York'];
// Instants straddling both DST changes of 2026 in Paris and New York, plus plain ones.
const FROMS = [
  '2026-01-15T12:00:00.000Z', '2026-03-07T00:00:00.000Z', '2026-03-08T05:59:59.000Z', '2026-03-08T07:00:00.000Z', '2026-03-28T00:00:00.000Z',
  '2026-03-29T00:30:00.000Z', '2026-03-29T01:00:00.000Z', '2026-06-30T23:59:59.999Z', '2026-10-24T22:00:00.000Z', '2026-10-25T00:30:00.000Z',
  '2026-10-25T01:00:00.000Z', '2026-10-31T05:00:00.000Z', '2026-11-01T05:30:00.000Z', '2026-11-01T06:00:00.000Z', '2026-12-31T23:00:00.000Z',
  '2026-10-16T02:00:00.000Z',
];

const inputs: unknown[] = [];
for (const expr of EXPRS) for (const tz of TZS) for (const from of FROMS) inputs.push({ expr, tz, from });
const rng = mulberry32(0xc20);
for (let i = 0; i < 200; i++) {
  const t = Date.UTC(2026, 0, 1) + ri(rng, 0, 365 * 24 * 12) * 5 * 60_000;
  inputs.push({ expr: pick(rng, EXPRS), tz: pick(rng, TZS), from: new Date(t).toISOString() });
}

function run(i: any): unknown {
  try {
    const it = CronExpressionParser.parse(i.expr, { currentDate: new Date(i.from), tz: i.tz });
    return { next: [it.next().toDate().toISOString(), it.next().toDate().toISOString(), it.next().toDate().toISOString()] };
  } catch (e) {
    return { error: true };
  }
}

(async () => {
  await emit('cron-next', inputs, run);
  console.log(`cron-next ${inputs.length}`);
})();
