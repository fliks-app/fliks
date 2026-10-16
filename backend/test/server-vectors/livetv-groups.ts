import { Logger } from '@nestjs/common';
import { LiveTvAccessService } from '../../src/modules/livetv/services/livetv-access.service';
import { User } from '../../src/modules/users/entities/user.entity';
import { emit, mulberry32, pick, ri } from './_util';

Logger.overrideLogger(false);

const RESTRICTED = 'livetv_restricted_groups';
const EXEMPT = 'livetv_restricted_groups_exempt';
const VANISHED = 'livetv_restricted_groups_vanished';
const STALE = 'livetv_stale_stream_days';
const DAY = 86_400_000;

// `new Date()` and `Date.now()` follow the scenario clock.
const RealDate = Date;
let NOW = 0;
class FakeDate extends RealDate {
  constructor(...a: unknown[]) {
    if (a.length === 0) super(NOW);
    else super(...(a as [string]));
  }
  static now() {
    return NOW;
  }
}
(global as { Date: unknown }).Date = FakeDate;

type Step =
  | { op: 'set'; groups: string[] }
  | { op: 'adult'; names: string[] }
  | { op: 'expire'; live: string[]; advanceDays: number }
  | { op: 'grants'; userId: number; groups: string[] }
  | { op: 'denied'; userId: number }
  | { op: 'view' };

interface Scenario {
  settings: Record<string, string>;
  users: { id: number; permissions: string[] }[];
  grants: [number, string][];
  now: string;
  steps: Step[];
}

async function run(input: Scenario) {
  NOW = Date.parse(input.now);
  const settings: Record<string, string | null> = { ...input.settings };
  let rows = input.grants.map(([userId, groupName]) => ({ userId, groupName }));
  const accessRepo = {
    find: (opts?: { where?: { user?: { id: number } } }) => {
      const uid = opts?.where?.user?.id;
      return Promise.resolve((uid != null ? rows.filter((r) => r.userId === uid) : rows).map((r) => ({ groupName: r.groupName })));
    },
    delete: (where: { groupName?: { value: string[] }; user?: { id: number } }) => {
      if (where.groupName) {
        const dropped = new Set(where.groupName.value);
        rows = rows.filter((r) => !dropped.has(r.groupName));
      } else if (where.user) {
        const uid = where.user.id;
        rows = rows.filter((r) => r.userId !== uid);
      }
      return Promise.resolve({});
    },
    save: (list: { user: { id: number }; groupName: string }[]) => {
      for (const r of list) rows.push({ userId: r.user.id, groupName: r.groupName });
      return Promise.resolve({});
    },
    create: (row: unknown) => row,
  };
  const settingsService = {
    get: (key: string) => Promise.resolve(settings[key] ?? null),
    set: (key: string, value: string) => {
      settings[key] = value;
      return Promise.resolve();
    },
  };
  const service = new LiveTvAccessService(accessRepo as never, {} as never, settingsService as never, { revokeOwner: () => undefined } as never);
  const userOf = (id: number) => ({ id, permissions: input.users.find((u) => u.id === id)?.permissions ?? [] }) as User;

  const results: unknown[] = [];
  for (const step of input.steps) {
    switch (step.op) {
      case 'set': results.push(await service.setRestrictedGroups(step.groups)); break;
      case 'adult': results.push(await service.restrictAdultGroups(step.names)); break;
      case 'expire':
        NOW += step.advanceDays * DAY;
        results.push(await service.expireVanishedGroups(step.live));
        break;
      case 'grants': results.push(await service.setGrants(step.userId, step.groups)); break;
      case 'denied': results.push(await service.deniedGroups(userOf(step.userId))); break;
      case 'view': results.push(await service.restrictedGroupsView()); break;
    }
  }
  const parse = (k: string) => {
    const raw = settings[k];
    if (raw === undefined) return null;
    try {
      return JSON.parse(raw as string);
    } catch {
      return raw;
    }
  };
  return {
    results,
    final: { restricted: parse(RESTRICTED), exempt: parse(EXEMPT), vanished: parse(VANISHED) },
    grants: rows.map((r) => [r.userId, r.groupName]).sort((a, b) => (a[0] as number) - (b[0] as number) || ((a[1] as string) < (b[1] as string) ? -1 : (a[1] as string) > (b[1] as string) ? 1 : 0)),
  };
}

// ---- inputs -------------------------------------------------------------------------------

const NOW0 = '2026-10-16T12:00:00.000Z';
const base = (steps: Step[], over: Partial<Scenario> = {}): Scenario => ({ settings: {}, users: [{ id: 1, permissions: [] }, { id: 2, permissions: ['manage:all'] }, { id: 3, permissions: ['settings.access'] }], grants: [], now: NOW0, steps, ...over });
const iso = (daysAgo: number) => new RealDate(Date.parse(NOW0) - daysAgo * DAY).toISOString();

const inputs: Scenario[] = [
  base([{ op: 'denied', userId: 1 }]),
  base([{ op: 'denied', userId: 1 }, { op: 'denied', userId: 2 }, { op: 'denied', userId: 3 }], { settings: { [RESTRICTED]: JSON.stringify(['XXX', 'Adult']) }, grants: [[1, 'Adult']] }),
  base([{ op: 'denied', userId: 1 }], { settings: { [RESTRICTED]: JSON.stringify(['XXX', 'xxx']) }, grants: [[1, 'XXX']] }),
  base([{ op: 'adult', names: ['FR | SPORT', 'XXX FR', 'News', 'Adult Swim'] }, { op: 'view' }]),
  base([{ op: 'adult', names: ['ADULTES', 'adultes', 'Sussex', '+18', '18+', '18+Movies'] }, { op: 'set', groups: [] }, { op: 'adult', names: ['ADULTES'] }]),
  base([{ op: 'set', groups: ['XXX', ' xxx ', 'Kids', ''] }, { op: 'grants', userId: 1, groups: ['xxx', 'Nope', ' KIDS '] }, { op: 'set', groups: ['Kids'] }]),
  base([{ op: 'set', groups: ['XXX'] }, { op: 'set', groups: ['xxx'] }, { op: 'set', groups: [] }, { op: 'set', groups: ['XXX'] }], { grants: [[1, 'XXX'], [2, 'xxx']] }),
  base([{ op: 'expire', live: [], advanceDays: 0 }, { op: 'expire', live: [], advanceDays: 0 }], { settings: { [RESTRICTED]: JSON.stringify(['XXX']), [STALE]: '0' }, grants: [[1, 'XXX']] }),
  base([{ op: 'expire', live: [], advanceDays: 0 }, { op: 'expire', live: [], advanceDays: 6 }, { op: 'expire', live: [], advanceDays: 2 }], { settings: { [RESTRICTED]: JSON.stringify(['XXX', 'Kids']) }, grants: [[1, 'XXX'], [1, 'Kids']] }),
  base([{ op: 'expire', live: ['xxx '], advanceDays: 0 }, { op: 'view' }], { settings: { [RESTRICTED]: JSON.stringify(['XXX']), [VANISHED]: JSON.stringify({ XXX: iso(3) }) } }),
  base([{ op: 'expire', live: [], advanceDays: 0 }, { op: 'view' }], { settings: { [RESTRICTED]: JSON.stringify(['XXX']), [EXEMPT]: JSON.stringify(['Adult']), [VANISHED]: JSON.stringify({ XXX: iso(30), Adult: iso(30), Old: iso(2) }) } }),
  base([{ op: 'expire', live: [], advanceDays: 1 }], { settings: { [RESTRICTED]: JSON.stringify(['XXX']), [VANISHED]: JSON.stringify({ XXX: 'garbage' }), [STALE]: '7abc' } }),
  base([{ op: 'denied', userId: 1 }, { op: 'view' }], { settings: { [RESTRICTED]: '{"a":1}', [EXEMPT]: 'nope', [VANISHED]: '[1,2]' } }),
  base([{ op: 'denied', userId: 1 }, { op: 'view' }], { settings: { [RESTRICTED]: JSON.stringify(['A', 1, null, 'B']), [VANISHED]: JSON.stringify({ A: 5, B: iso(1) }) } }),
  base([{ op: 'grants', userId: 1, groups: [] }, { op: 'grants', userId: 1, groups: ['A', 'a'] }, { op: 'grants', userId: 2, groups: ['B'] }], { settings: { [RESTRICTED]: JSON.stringify(['A', 'a', 'B']) }, grants: [[1, 'A']] }),
  base([{ op: 'grants', userId: 1, groups: ['x'] }, { op: 'view' }], { settings: { [RESTRICTED]: JSON.stringify(['X']), [VANISHED]: JSON.stringify({ X: iso(2), x: iso(1), Y: iso(1) }) } }),
];

{
  const rng = mulberry32(31337);
  const POOL = ['XXX', 'xxx ', 'Adult', 'Adulte', 'Sport', 'News', 'Kids', 'FR | SPORT', '+18', 'Sussex', 'Erotik', 'Film', 'film', ' Docs', 'Porno HD', 'Adult Swim', 'é', 'É'];
  const some = (n: number) => Array.from({ length: ri(rng, 0, n) }, () => pick(rng, POOL));
  for (let i = 0; i < 80; i++) {
    const restricted = some(5);
    const steps: Step[] = [];
    for (let s = 0; s < ri(rng, 3, 9); s++) {
      const r = rng();
      if (r < 0.2) steps.push({ op: 'set', groups: some(5) });
      else if (r < 0.4) steps.push({ op: 'adult', names: some(6) });
      else if (r < 0.65) steps.push({ op: 'expire', live: some(6), advanceDays: pick(rng, [0, 0, 1, 3, 7, 8]) });
      else if (r < 0.8) steps.push({ op: 'grants', userId: ri(rng, 1, 2), groups: some(4) });
      else if (r < 0.9) steps.push({ op: 'denied', userId: ri(rng, 1, 3) });
      else steps.push({ op: 'view' });
    }
    const vanished: Record<string, string> = {};
    for (const g of some(3)) if (rng() < 0.7) vanished[g] = iso(ri(rng, 0, 12));
    inputs.push(base(steps, {
      settings: {
        [RESTRICTED]: JSON.stringify(restricted),
        ...(rng() < 0.5 ? { [EXEMPT]: JSON.stringify(some(3)) } : {}),
        ...(rng() < 0.6 ? { [VANISHED]: JSON.stringify(vanished) } : {}),
        ...(rng() < 0.4 ? { [STALE]: pick(rng, ['0', '3', '7', '-1', 'x']) } : {}),
      },
      grants: Array.from({ length: ri(rng, 0, 4) }, () => [ri(rng, 1, 2), pick(rng, POOL)] as [number, string]),
    }));
  }
}

void emit('livetv-groups', inputs, run);
