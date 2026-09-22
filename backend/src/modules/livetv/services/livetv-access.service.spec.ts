import { LiveTvAccessService } from './livetv-access.service';
import type { User } from '../../users/entities/user.entity';

function makeUser(id: number, permissions: string[] = []): User {
  return { id, permissions } as User;
}

const RESTRICTED_KEY = 'livetv_restricted_groups';

describe('LiveTvAccessService', () => {
  let settings: Record<string, string | null>;
  let grants: { groupName: string }[];
  let users: { id: number; username: string }[];
  let accessRows: { userId: number; groupName: string }[];
  let service: LiveTvAccessService;

  beforeEach(() => {
    settings = {};
    grants = [];
    users = [];
    accessRows = [];
    const accessRepo = {
      find: jest.fn(() => Promise.resolve(grants)),
      delete: jest.fn(() => Promise.resolve({})),
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
    const settingsService = {
      get: jest.fn((key: string) => Promise.resolve(settings[key] ?? null)),
      set: jest.fn((key: string, value: string) => {
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
      { name: 'Kids Manual Pick', automatic: false },
      { name: 'XXX FR', automatic: true },
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
});
