import { NotFoundException } from '@nestjs/common';
import { LiveTvChannelsService } from './livetv-channels.service';
import { UNGROUPED_SENTINEL } from '../parsing/group-name';
import type { User } from '../../users/entities/user.entity';
import type { LiveTvChannel } from '../entities/livetv-channel.entity';

function makeUser(id = 1): User {
  return { id, permissions: [] } as unknown as User;
}

/** Captures the conditions a query builder was given, so a spec can assert on
 *  the filtering without standing up Postgres. */
function fakeQueryBuilder(entities: Partial<LiveTvChannel>[]) {
  const conditions: { sql: string; params?: Record<string, unknown> }[] = [];
  const qb = {
    conditions,
    leftJoin: () => qb,
    addSelect: () => qb,
    select: () => qb,
    where: (sql: string, params?: Record<string, unknown>) => {
      conditions.push({ sql, params });
      return qb;
    },
    andWhere: (sql: string, params?: Record<string, unknown>) => {
      conditions.push({ sql, params });
      return qb;
    },
    orderBy: () => qb,
    addOrderBy: () => qb,
    offset: () => qb,
    limit: () => qb,
    groupBy: () => qb,
    clone: () => qb,
    leftJoinAndSelect: () => qb,
    update: () => qb,
    set: () => qb,
    whereInIds: () => qb,
    execute: async () => ({ affected: entities.length }),
    getMany: async () => entities,
    getRawAndEntities: async () => ({ entities, raw: entities.map(() => ({})) }),
    getCount: async () => entities.length,
    getRawMany: async (): Promise<Record<string, unknown>[]> =>
      entities.map((e) => ({ name: e.groupName ?? null, guideChannelId: e.guideChannelId ?? null })),
  };
  return qb;
}

describe('LiveTvChannelsService', () => {
  let channelRepo: { createQueryBuilder: jest.Mock; findOne: jest.Mock; save: jest.Mock };
  let prefRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let dataSource: { query: jest.Mock };
  let access: { deniedGroups: jest.Mock };
  let service: LiveTvChannelsService;
  let builder: ReturnType<typeof fakeQueryBuilder>;

  beforeEach(() => {
    builder = fakeQueryBuilder([
      { id: 1, name: 'One', number: 1, logoPath: null, groupName: 'News', guideChannelId: null },
    ]);
    channelRepo = {
      createQueryBuilder: jest.fn(() => builder),
      findOne: jest.fn(),
      save: jest.fn(async (c) => c),
    };
    prefRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((x) => x),
      save: jest.fn(async (p) => p),
    };
    dataSource = { query: jest.fn().mockResolvedValue([]) };
    access = { deniedGroups: jest.fn(async () => [] as string[]) };
    service = new LiveTvChannelsService(
      channelRepo as never,
      {} as never,
      prefRepo as never,
      dataSource as never,
      access as never,
    );
  });

  describe('countForUser', () => {
    it('counts under the same group restrictions as the list', async () => {
      access.deniedGroups.mockResolvedValue(['Adult']);
      expect(await service.countForUser(makeUser())).toBe(1);
      expect(builder.conditions.some((c) => c.sql.includes('NOT IN (:...denied)'))).toBe(true);
    });
  });

  describe('listForUser', () => {
    it('adds no group condition when nothing is restricted', async () => {
      await service.listForUser(makeUser(), {});
      expect(builder.conditions.some((c) => c.sql.includes('NOT IN (:...denied)'))).toBe(
        false,
      );
    });

    it('excludes a restricted group the user was not granted', async () => {
      access.deniedGroups.mockResolvedValue(['XXX']);
      await service.listForUser(makeUser(), {});
      const clause = builder.conditions.find((c) => c.sql.includes('NOT IN (:...denied)'));
      // Folded (lower/trim) on both sides of the query, not the raw admin spelling.
      expect(clause?.sql).toContain('lower(btrim(channel."groupName"))');
      expect(clause?.params).toEqual({ denied: ['xxx'] });
    });

    it('keeps a channel with no group at all', async () => {
      access.deniedGroups.mockResolvedValue(['XXX']);
      await service.listForUser(makeUser(), {});
      const clause = builder.conditions.find((c) => c.sql.includes('NOT IN (:...denied)'));
      expect(clause?.sql).toContain('"groupName" IS NULL');
    });

    it('folds a restriction spelled with edge whitespace or a different case', async () => {
      // Whatever an admin restricted, or however a provider re-spelled it,
      // both sides fold to the same key before the comparison runs.
      access.deniedGroups.mockResolvedValue([' XXX ']);
      await service.listForUser(makeUser(), {});
      const clause = builder.conditions.find((c) => c.sql.includes('NOT IN (:...denied)'));
      expect(clause?.params).toEqual({ denied: ['xxx'] });
    });
  });

  describe('isGuideChannelVisibleToUser', () => {
    it('reuses the same group restriction as the list', async () => {
      access.deniedGroups.mockResolvedValue(['XXX']);
      builder.getCount = async () => 0;
      await expect(
        service.isGuideChannelVisibleToUser(makeUser(), 'bbc1'),
      ).resolves.toBe(false);
      expect(
        builder.conditions.some((c) => c.sql.includes('"guideChannelId" = :guideChannelId')),
      ).toBe(true);
    });

    it('is visible when a matching channel passes the filters', async () => {
      builder.getCount = async () => 1;
      await expect(
        service.isGuideChannelVisibleToUser(makeUser(), 'bbc1'),
      ).resolves.toBe(true);
    });
  });

  describe('scopeToAuthorizedGuideChannels', () => {
    it('adds a correlated EXISTS condition against the given column, not an IN list', async () => {
      const target = { andWhere: jest.fn() };
      await service.scopeToAuthorizedGuideChannels(
        target as never,
        makeUser(7),
        'p."guideChannelId"',
      );
      expect(target.andWhere).toHaveBeenCalledTimes(1);
      const [sql, params] = target.andWhere.mock.calls[0];
      expect(sql).toContain('EXISTS');
      expect(sql).toContain('c."guideChannelId" = p."guideChannelId"');
      expect(params).toEqual({ guideAuthUserId: 7 });
    });

    it('excludes denied groups the same way the list does', async () => {
      access.deniedGroups.mockResolvedValue(['XXX']);
      const target = { andWhere: jest.fn() };
      await service.scopeToAuthorizedGuideChannels(target as never, makeUser(), 'p."guideChannelId"');
      const [sql, params] = target.andWhere.mock.calls[0];
      expect(sql).toContain('NOT IN (:...guideAuthDenied)');
      expect(params).toEqual({ guideAuthUserId: 1, guideAuthDenied: ['xxx'] });
    });
  });

  describe('findPlayable', () => {
    it('returns the channel when its group is not restricted', async () => {
      channelRepo.findOne.mockResolvedValue({ id: 7, groupName: 'News', streams: [] });
      await expect(service.findPlayable(7, makeUser())).resolves.toMatchObject({ id: 7 });
    });

    it('answers not found for a restricted group, never a distinguishable error', async () => {
      channelRepo.findOne.mockResolvedValue({ id: 8, groupName: 'XXX', streams: [] });
      access.deniedGroups.mockResolvedValue(['XXX']);
      // Same exception as a missing id: knowing the channel exists is itself a leak.
      await expect(service.findPlayable(8, makeUser())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('answers not found when the channel is disabled or absent', async () => {
      channelRepo.findOne.mockResolvedValue(null);
      await expect(service.findPlayable(9, makeUser())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('a restriction covers a case/whitespace variant of the same group', async () => {
      channelRepo.findOne.mockResolvedValue({ id: 10, groupName: 'Xxx', streams: [] });
      access.deniedGroups.mockResolvedValue([' XXX ']);
      await expect(service.findPlayable(10, makeUser())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('a restriction on the ungrouped sentinel hides a channel with no provider group', async () => {
      channelRepo.findOne.mockResolvedValue({ id: 11, groupName: UNGROUPED_SENTINEL, streams: [] });
      access.deniedGroups.mockResolvedValue([UNGROUPED_SENTINEL]);
      await expect(service.findPlayable(11, makeUser())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('groupCounts (via listForAdmin)', () => {
    it('no longer excludes any group from the facet, including the ungrouped sentinel', async () => {
      builder.getRawMany = async () => [{ name: UNGROUPED_SENTINEL, count: '3' }];
      const result = await service.listForAdmin({});
      expect(result.groups).toEqual([{ name: UNGROUPED_SENTINEL, count: 3 }]);
      expect(builder.conditions.some((c) => c.sql.includes('IS NOT NULL'))).toBe(false);
    });
  });

  describe('updateOne', () => {
    it('trims and sentinel-substitutes a manually entered group, and stamps it manual', async () => {
      channelRepo.findOne.mockResolvedValue({ id: 5, groupName: 'Old' });
      const saved = await service.updateOne(5, { groupName: '  Sports  ' } as never);
      expect(saved.groupName).toBe('Sports');
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('"groupNameSource" = \'manual\''),
        [5],
      );
    });

    it('an empty group becomes the ungrouped sentinel, not null', async () => {
      channelRepo.findOne.mockResolvedValue({ id: 5, groupName: 'Old' });
      const saved = await service.updateOne(5, { groupName: '   ' } as never);
      expect(saved.groupName).toBe(UNGROUPED_SENTINEL);
    });

    it('never stamps groupNameSource when the patch leaves the group alone', async () => {
      channelRepo.findOne.mockResolvedValue({ id: 5, groupName: 'Old' });
      await service.updateOne(5, { enabled: false } as never);
      expect(dataSource.query).not.toHaveBeenCalled();
    });
  });

  describe('bulkUpdate', () => {
    it('normalises the group and stamps every selected channel manual', async () => {
      builder.getMany = async () => [{ id: 1, name: 'One' }, { id: 2, name: 'Two' }];
      await service.bulkUpdate({ selection: {}, groupName: '  Sports  ' } as never);
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('"groupNameSource" = \'manual\''),
        [[1, 2]],
      );
    });
  });

  describe('setPrefs', () => {
    it('refuses a channel the caller cannot see (restricted group)', async () => {
      channelRepo.findOne.mockResolvedValue({ id: 12, groupName: 'XXX' });
      access.deniedGroups.mockResolvedValue(['XXX']);
      await expect(
        service.setPrefs(makeUser(), 12, { favorite: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prefRepo.save).not.toHaveBeenCalled();
    });

    it('refuses a disabled or absent channel the same way', async () => {
      channelRepo.findOne.mockResolvedValue(null);
      await expect(
        service.setPrefs(makeUser(), 13, { favorite: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('writes the pref for a channel the caller can see', async () => {
      channelRepo.findOne.mockResolvedValue({ id: 14, groupName: 'News' });
      await service.setPrefs(makeUser(), 14, { favorite: true });
      expect(prefRepo.save).toHaveBeenCalledWith(expect.objectContaining({ favorite: true }));
    });
  });
});
