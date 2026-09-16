import { LiveTvAccessService } from './livetv-access.service';
import type { User } from '../../users/entities/user.entity';

function makeUser(id: number, permissions: string[] = []): User {
  return { id, permissions } as User;
}

describe('LiveTvAccessService', () => {
  let settingsValue: string | null;
  let grants: { groupName: string }[];
  let service: LiveTvAccessService;

  beforeEach(() => {
    settingsValue = null;
    grants = [];
    const accessRepo = {
      find: jest.fn(async () => grants),
      delete: jest.fn(async () => ({})),
      save: jest.fn(async () => ({})),
      create: jest.fn((row: unknown) => row),
    };
    const settings = {
      get: jest.fn(async () => settingsValue),
      set: jest.fn(async (_key: string, value: string) => {
        settingsValue = value;
      }),
    };
    service = new LiveTvAccessService(accessRepo as never, settings as never);
  });

  it('denies nothing while no group is restricted', async () => {
    expect(await service.deniedGroups(makeUser(1))).toEqual([]);
  });

  it('denies a restricted group the user was not granted', async () => {
    settingsValue = JSON.stringify(['XXX', 'Adult']);
    grants = [{ groupName: 'Adult' }];
    expect(await service.deniedGroups(makeUser(2))).toEqual(['XXX']);
  });

  it('never denies an administrator, by either permission spelling', async () => {
    settingsValue = JSON.stringify(['XXX']);
    expect(await service.deniedGroups(makeUser(1, ['manage:all']))).toEqual([]);
    // The seeded Admin role carries this one rather than `manage:all`.
    expect(await service.deniedGroups(makeUser(2, ['settings.access']))).toEqual([]);
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
    settingsValue = JSON.stringify([]);
    await service.setRestrictedGroups([]);
    const after = await service.restrictAdultGroups(['News']);
    expect(after).toEqual([]);
  });

  it('survives a corrupt settings value rather than failing every read', async () => {
    settingsValue = 'not json';
    expect(await service.restrictedGroups()).toEqual([]);
  });
});
