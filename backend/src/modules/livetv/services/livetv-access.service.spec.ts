import { Logger } from '@nestjs/common';
import { LiveTvAccessService } from './livetv-access.service';
import type { User } from '../../users/entities/user.entity';

function makeUser(id: number, permissions: string[] = []): User {
  return { id, permissions } as User;
}

const RESTRICTED_KEY = 'livetv_restricted_groups';
const EXEMPT_KEY = 'livetv_restricted_groups_exempt';
const VANISHED_KEY = 'livetv_restricted_groups_vanished';
const STALE_DAYS_KEY = 'livetv_stale_stream_days';
const DAY_MS = 86_400_000;
const isoDaysAgo = (days: number) =>
  new Date(Date.now() - days * DAY_MS).toISOString();
const parseVanished = (raw: string | null): Record<string, string> =>
  raw ? (JSON.parse(raw) as Record<string, string>) : {};

describe('LiveTvAccessService', () => {
  let settings: Record<string, string | null>;
  let grants: { groupName: string }[];
  let users: { id: number; username: string }[];
  let accessRows: { userId: number; groupName: string }[];
  let accessRepo: {
    find: jest.Mock;
    delete: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let settingsService: { get: jest.Mock; set: jest.Mock };
  let calls: string[];
  let service: LiveTvAccessService;

  beforeEach(() => {
    settings = {};
    grants = [];
    users = [];
    accessRows = [];
    calls = [];
    accessRepo = {
      find: jest.fn(() => Promise.resolve(grants)),
      // Either `{ groupName: In(dropped) }` (a `FindOperator` exposing `.value`)
      // or `{ user: { id } }`, whichever write path called `delete`.
      delete: jest.fn(
        (where: { groupName?: { value: string[] }; user?: { id: number } }) => {
          if (where.groupName) {
            calls.push('delete:groups');
            const dropped = new Set(where.groupName.value);
            accessRows = accessRows.filter((r) => !dropped.has(r.groupName));
            grants = grants.filter((g) => !dropped.has(g.groupName));
          } else if (where.user) {
            calls.push('delete:user');
            const uid = where.user.id;
            accessRows = accessRows.filter((r) => r.userId !== uid);
          }
          return Promise.resolve({});
        },
      ),
      save: jest.fn(() => Promise.resolve({})),
      create: jest.fn((row: unknown) => row),
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest.fn(() => Promise.resolve(accessRows)),
      })),
    };
    const userRepo = {
      find: jest.fn(() => Promise.resolve(users)),
    };
    settingsService = {
      get: jest.fn((key: string) => Promise.resolve(settings[key] ?? null)),
      set: jest.fn((key: string, value: string) => {
        calls.push(`set:${key}`);
        settings[key] = value;
        return Promise.resolve();
      }),
    };
    service = new LiveTvAccessService(
      accessRepo as never,
      userRepo as never,
      settingsService as never,
    );
  });

  it('denies nothing while no group is restricted', async () => {
    expect(await service.deniedGroups(makeUser(1))).toEqual([]);
  });

  it('denies a restricted group the user was not granted', async () => {
    settings[RESTRICTED_KEY] = JSON.stringify(['XXX', 'Adult']);
    grants = [{ groupName: 'Adult' }];
    expect(await service.deniedGroups(makeUser(2))).toEqual(['XXX']);
  });

  it('never denies an administrator, by either permission spelling', async () => {
    settings[RESTRICTED_KEY] = JSON.stringify(['XXX']);
    expect(await service.deniedGroups(makeUser(1, ['manage:all']))).toEqual([]);
    // The seeded Admin role carries this one rather than `manage:all`.
    expect(
      await service.deniedGroups(makeUser(2, ['settings.access'])),
    ).toEqual([]);
  });

  it('restricts an adult group the moment a sync first sees it', async () => {
    const restricted = await service.restrictAdultGroups([
      'FR | SPORT',
      'XXX FR',
      'Adult Movies',
      'News',
    ]);
    expect(restricted).toEqual(['Adult Movies', 'XXX FR']);
  });

  it('does not re-add a group an administrator deliberately unrestricted', async () => {
    settings[RESTRICTED_KEY] = JSON.stringify([]);
    await service.setRestrictedGroups([]);
    const after = await service.restrictAdultGroups(['News']);
    expect(after).toEqual([]);
  });

  it('survives a corrupt settings value rather than failing every read', async () => {
    settings[RESTRICTED_KEY] = 'not json';
    expect(await service.restrictedGroups()).toEqual([]);
  });

  it('exposes each restricted group flagged with whether it still matches the pattern', async () => {
    settings[RESTRICTED_KEY] = JSON.stringify(['Kids Manual Pick', 'XXX FR']);
    expect(await service.restrictedGroupsView()).toEqual([
      {
        name: 'Kids Manual Pick',
        automatic: false,
        vanishedSince: null,
        cleanupAt: null,
      },
      { name: 'XXX FR', automatic: true, vanishedSince: null, cleanupAt: null },
    ]);
  });

  describe('exemptions', () => {
    it('keeps an admin-exempted group unrestricted across the next sync', async () => {
      await service.restrictAdultGroups(['XXX FR']);
      expect(await service.restrictedGroups()).toEqual(['XXX FR']);

      // Unchecking it in the UI removes it via the same PUT the sync uses to add it.
      await service.setRestrictedGroups([]);
      expect(await service.exemptGroups()).toEqual(['XXX FR']);

      const afterSync = await service.restrictAdultGroups(['XXX FR']);
      expect(afterSync).toEqual([]);
      expect(await service.restrictedGroups()).toEqual([]);
    });

    it('retires the exemption and restricts the group again once it is rechecked', async () => {
      await service.restrictAdultGroups(['XXX FR']);
      await service.setRestrictedGroups([]);
      expect(await service.exemptGroups()).toEqual(['XXX FR']);

      // Rechecking it manually is what "retires" the exemption.
      await service.setRestrictedGroups(['XXX FR']);
      expect(await service.restrictedGroups()).toEqual(['XXX FR']);
      expect(await service.exemptGroups()).toEqual([]);
    });
  });

  describe('expireVanishedGroups', () => {
    it('marks a restricted group missing from the live set without touching its grants', async () => {
      settings[RESTRICTED_KEY] = JSON.stringify(['News']);
      accessRows = [{ userId: 1, groupName: 'News' }];

      const expired = await service.expireVanishedGroups([]);

      expect(expired).toEqual([]);
      expect(accessRepo.delete).not.toHaveBeenCalled();
      expect(await service.restrictedGroups()).toEqual(['News']);
      expect(Object.keys(parseVanished(settings[VANISHED_KEY]))).toEqual([
        'News',
      ]);
    });

    it('leaves a group alone while it is still in the live set', async () => {
      settings[RESTRICTED_KEY] = JSON.stringify(['News']);

      await service.expireVanishedGroups(['News']);

      expect(settings[VANISHED_KEY]).toBeUndefined();
    });

    it('clears the absence timer the moment a group reappears, keeping its grants', async () => {
      settings[RESTRICTED_KEY] = JSON.stringify(['News']);
      settings[VANISHED_KEY] = JSON.stringify({ News: isoDaysAgo(5) });
      users = [{ id: 1, username: 'alice' }];
      accessRows = [{ userId: 1, groupName: 'News' }];

      const expired = await service.expireVanishedGroups(['News']);

      expect(expired).toEqual([]);
      expect(accessRepo.delete).not.toHaveBeenCalled();
      expect(parseVanished(settings[VANISHED_KEY])).toEqual({});
      expect(await service.listUserAccess()).toEqual([
        { id: 1, username: 'alice', groups: ['News'] },
      ]);
    });

    it('drops grants, the restricted entry and the exempt entry once the grace period elapses', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      settings[RESTRICTED_KEY] = JSON.stringify(['News', 'XXX FR']);
      settings[EXEMPT_KEY] = JSON.stringify(['News']);
      settings[VANISHED_KEY] = JSON.stringify({ News: isoDaysAgo(8) });
      settings[STALE_DAYS_KEY] = '7';
      users = [{ id: 1, username: 'alice' }];
      accessRows = [
        { userId: 1, groupName: 'News' },
        { userId: 1, groupName: 'XXX FR' },
      ];

      // 'XXX FR' is still live: only 'News' is under test here.
      const expired = await service.expireVanishedGroups(['XXX FR']);

      expect(expired).toEqual(['News']);
      expect(await service.restrictedGroups()).toEqual(['XXX FR']);
      expect(await service.exemptGroups()).toEqual([]);
      expect(await service.listUserAccess()).toEqual([
        { id: 1, username: 'alice', groups: ['XXX FR'] },
      ]);
      expect(parseVanished(settings[VANISHED_KEY])).toEqual({});
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('News'));
    });

    it('respects a custom grace period rather than the 7-day default', async () => {
      settings[RESTRICTED_KEY] = JSON.stringify(['News']);
      settings[VANISHED_KEY] = JSON.stringify({ News: isoDaysAgo(2) });
      settings[STALE_DAYS_KEY] = '1';

      const expired = await service.expireVanishedGroups([]);

      expect(expired).toEqual(['News']);
      expect(await service.restrictedGroups()).toEqual([]);
    });

    it('stays quiet about a group that is neither restricted nor exempted', async () => {
      const expired = await service.expireVanishedGroups(['News']);
      expect(expired).toEqual([]);
      expect(accessRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe('restrictedGroupsView with a vanished group', () => {
    it('reports since when a group has been missing and when it clears', async () => {
      settings[RESTRICTED_KEY] = JSON.stringify(['News']);
      settings[VANISHED_KEY] = JSON.stringify({
        News: '2024-01-01T00:00:00.000Z',
      });
      settings[STALE_DAYS_KEY] = '7';

      const view = await service.restrictedGroupsView();

      expect(view).toEqual([
        {
          name: 'News',
          automatic: false,
          vanishedSince: '2024-01-01T00:00:00.000Z',
          cleanupAt: '2024-01-08T00:00:00.000Z',
        },
      ]);
    });

    it('reports null for a group currently seen', async () => {
      settings[RESTRICTED_KEY] = JSON.stringify(['News']);

      const view = await service.restrictedGroupsView();

      expect(view).toEqual([
        {
          name: 'News',
          automatic: false,
          vanishedSince: null,
          cleanupAt: null,
        },
      ]);
    });
  });

  describe('grants when a group leaves the restricted set', () => {
    it("drops that group's grants, and only that group's", async () => {
      settings[RESTRICTED_KEY] = JSON.stringify(['News', 'XXX FR']);
      users = [
        { id: 1, username: 'alice' },
        { id: 2, username: 'bob' },
      ];
      accessRows = [
        { userId: 1, groupName: 'News' },
        { userId: 1, groupName: 'XXX FR' },
        { userId: 2, groupName: 'XXX FR' },
      ];

      await service.setRestrictedGroups(['XXX FR']);

      expect(await service.listUserAccess()).toEqual([
        { id: 1, username: 'alice', groups: ['XXX FR'] },
        { id: 2, username: 'bob', groups: ['XXX FR'] },
      ]);
    });

    it('does not resurrect a dropped grant when the group is restricted again later', async () => {
      settings[RESTRICTED_KEY] = JSON.stringify(['XXX FR']);
      users = [{ id: 1, username: 'alice' }];
      accessRows = [{ userId: 1, groupName: 'XXX FR' }];

      await service.setRestrictedGroups([]);
      await service.setRestrictedGroups(['XXX FR']);

      expect(await service.listUserAccess()).toEqual([
        { id: 1, username: 'alice', groups: [] },
      ]);
    });

    it('never deletes a grant when a sync adds newly seen adult groups', async () => {
      settings[RESTRICTED_KEY] = JSON.stringify(['News']);
      users = [{ id: 1, username: 'alice' }];
      accessRows = [{ userId: 1, groupName: 'News' }];

      await service.restrictAdultGroups(['News', 'XXX FR']);

      expect(accessRepo.delete).not.toHaveBeenCalled();
      expect(await service.listUserAccess()).toEqual([
        { id: 1, username: 'alice', groups: ['News'] },
      ]);
    });
  });

  describe('listUserAccess', () => {
    it('returns every user with the restricted groups they were granted', async () => {
      users = [
        { id: 1, username: 'alice' },
        { id: 2, username: 'bob' },
      ];
      accessRows = [
        { userId: 1, groupName: 'XXX FR' },
        { userId: 1, groupName: 'Adult Movies' },
      ];
      expect(await service.listUserAccess()).toEqual([
        { id: 1, username: 'alice', groups: ['XXX FR', 'Adult Movies'] },
        { id: 2, username: 'bob', groups: [] },
      ]);
    });

    it('exposes no user field beyond id, username and groups', async () => {
      users = [{ id: 1, username: 'alice' }];
      const [row] = await service.listUserAccess();
      expect(Object.keys(row).sort()).toEqual(['groups', 'id', 'username']);
    });
  });

  describe('ADULT_GROUP_PATTERN coverage', () => {
    // Exercised through `restrictAdultGroups`, since the pattern itself isn't exported:
    // a name is "positive" if a sync restricts it, "negative" if it stays untouched.
    it.each([
      'ADULTES',
      'Adulte',
      'Adultes FR',
      'FOR ADULTS',
      'PORNO',
      'Eroticos',
      'Erotik',
      'SEX',
      'X-RATED',
      '+18',
      '18+',
    ])('restricts %s', async (name) => {
      expect(await service.restrictAdultGroups([name])).toEqual([name]);
    });

    it.each([
      'HOT',
      'HOT TV Israel',
      'Hot Hits',
      'Adult Swim',
      'News',
      'FR | SPORT',
    ])('leaves %s alone', async (name) => {
      expect(await service.restrictAdultGroups([name])).toEqual([]);
    });
  });

  describe('setGrants', () => {
    it('grants only the requested groups that are currently restricted', async () => {
      settings[RESTRICTED_KEY] = JSON.stringify(['News', 'XXX FR']);

      const result = await service.setGrants(1, ['News', 'XXX FR']);

      expect(result).toEqual({ groups: ['News', 'XXX FR'], ignored: [] });
      expect(accessRepo.save).toHaveBeenCalledWith([
        { user: { id: 1 }, groupName: 'News' },
        { user: { id: 1 }, groupName: 'XXX FR' },
      ]);
    });

    it('drops a requested group that is not restricted and reports it as ignored', async () => {
      settings[RESTRICTED_KEY] = JSON.stringify(['News']);

      const result = await service.setGrants(1, ['News', 'Adulte']);

      expect(result).toEqual({ groups: ['News'], ignored: ['Adulte'] });
      expect(accessRepo.save).toHaveBeenCalledWith([
        { user: { id: 1 }, groupName: 'News' },
      ]);
    });

    it('grants nothing and ignores everything when no group is restricted', async () => {
      const result = await service.setGrants(1, ['Adulte']);
      expect(result).toEqual({ groups: [], ignored: ['Adulte'] });
      expect(accessRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('write ordering', () => {
    it("drops a removed group's grants before writing the restricted-groups setting", async () => {
      settings[RESTRICTED_KEY] = JSON.stringify(['News']);
      accessRows = [{ userId: 1, groupName: 'News' }];

      await service.setRestrictedGroups([]);

      expect(calls).toEqual(['delete:groups', `set:${RESTRICTED_KEY}`]);
    });
  });

  describe('concurrency between a sync pass and an admin edit', () => {
    it('holds an admin setRestrictedGroups call until an in-flight sync pass finishes', async () => {
      settings[RESTRICTED_KEY] = JSON.stringify(['News']);
      let releaseSyncWrite: () => void;
      const syncWriteGate = new Promise<void>((resolve) => {
        releaseSyncWrite = resolve;
      });
      // Gate only the sync pass's own write (its distinct value), not the admin's.
      const syncValue = JSON.stringify(['News', 'XXX FR']);
      const originalSet = settingsService.set.getMockImplementation()!;
      // Reassigning the property is enough: `service` holds this same object by
      // reference, so its next `this.settings.set(...)` call picks this up.
      settingsService.set = jest.fn(async (key: string, value: string) => {
        if (key === RESTRICTED_KEY && value === syncValue) await syncWriteGate;
        return originalSet(key, value);
      });

      const syncPromise = service.restrictAdultGroups(['News', 'XXX FR']);
      const adminPromise = service.setRestrictedGroups([]);
      let adminSettled = false;
      adminPromise.then(() => {
        adminSettled = true;
      });

      // However many microtasks run, the admin call is queued behind the lock and
      // cannot even start its own read while the sync pass is stuck on the gate.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(adminSettled).toBe(false);

      releaseSyncWrite!();
      await syncPromise;
      await adminPromise;

      expect(adminSettled).toBe(true);
      expect(await service.restrictedGroups()).toEqual([]);
    });
  });
});
