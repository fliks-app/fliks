import { NotFoundException } from '@nestjs/common';
import { LiveTvChannelsService } from './livetv-channels.service';
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
    getRawAndEntities: async () => ({ entities, raw: entities.map(() => ({})) }),
    getCount: async () => entities.length,
    getRawMany: async () =>
      entities.map((e) => ({ guideChannelId: e.guideChannelId ?? null })),
  };
  return qb;
}

describe('LiveTvChannelsService', () => {
  let channelRepo: { createQueryBuilder: jest.Mock; findOne: jest.Mock };
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
    };
    access = { deniedGroups: jest.fn(async () => [] as string[]) };
    service = new LiveTvChannelsService(
      channelRepo as never,
      {} as never,
      {} as never,
      {} as never,
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
      expect(clause?.params).toEqual({ denied: ['XXX'] });
    });

    it('keeps a channel with no group at all', async () => {
      access.deniedGroups.mockResolvedValue(['XXX']);
      await service.listForUser(makeUser(), {});
      const clause = builder.conditions.find((c) => c.sql.includes('NOT IN (:...denied)'));
      expect(clause?.sql).toContain('"groupName" IS NULL');
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
      expect(params).toEqual({ guideAuthUserId: 1, guideAuthDenied: ['XXX'] });
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
  });
});
