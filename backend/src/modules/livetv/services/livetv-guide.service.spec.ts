import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { LiveTvGuideService } from './livetv-guide.service';
import { UpdateLiveTvGuideSourceDto } from '../dto/update-livetv-guide-source.dto';
import type { User } from '../../users/entities/user.entity';

function makeUser(id = 1): User {
  return { id, permissions: [] } as unknown as User;
}

/** Captures the conditions a query builder was given, so a spec can assert on
 *  the filtering without standing up Postgres. Mirrors the helper already
 *  used by livetv-channels.service.spec.ts. */
function fakeProgramQueryBuilder(rows: unknown[]) {
  const conditions: { sql: string; params?: Record<string, unknown> }[] = [];
  const qb = {
    where: (sql: string, params?: Record<string, unknown>) => {
      conditions.push({ sql, params });
      return qb;
    },
    andWhere: (sql: string, params?: Record<string, unknown>) => {
      conditions.push({ sql, params });
      return qb;
    },
    orderBy: () => qb,
    take: () => qb,
    getMany: async () => rows,
  };
  return Object.assign(qb, { conditions });
}

describe('LiveTvGuideService', () => {
  let guideSourceRepo: { findOne: jest.Mock; save: jest.Mock };
  let programRepo: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let channels: {
    isGuideChannelVisibleToUser: jest.Mock;
    scopeToAuthorizedGuideChannels: jest.Mock;
    listPageForUser: jest.Mock;
  };
  let settings: { get: jest.Mock };
  let service: LiveTvGuideService;

  beforeEach(() => {
    guideSourceRepo = { findOne: jest.fn(), save: jest.fn(async (row) => row) };
    programRepo = { findOne: jest.fn(), createQueryBuilder: jest.fn() };
    channels = {
      isGuideChannelVisibleToUser: jest.fn(),
      scopeToAuthorizedGuideChannels: jest.fn(),
      listPageForUser: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    };
    settings = { get: jest.fn().mockResolvedValue(null) };

    service = new LiveTvGuideService(
      guideSourceRepo as never,
      {} as never,
      {} as never,
      programRepo as never,
      {} as never,
      settings as never,
      {} as never,
      channels as never,
    );
  });

  describe('program', () => {
    it('returns the program when its channel is visible to the caller', async () => {
      programRepo.findOne.mockResolvedValue({ id: 5, guideChannelId: 'bbc1' });
      channels.isGuideChannelVisibleToUser.mockResolvedValue(true);

      await expect(service.program(5, makeUser())).resolves.toMatchObject({ id: 5 });
      expect(channels.isGuideChannelVisibleToUser).toHaveBeenCalledWith(
        expect.anything(),
        'bbc1',
      );
    });

    // IDOR: sequential ids must not expose a program on a channel the caller
    // is denied (adult groups, groups they were never granted).
    it('answers not found for a program on a channel the caller cannot see', async () => {
      programRepo.findOne.mockResolvedValue({ id: 6, guideChannelId: 'xxx1' });
      channels.isGuideChannelVisibleToUser.mockResolvedValue(false);

      await expect(service.program(6, makeUser())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers not found when the program id does not exist', async () => {
      programRepo.findOne.mockResolvedValue(null);
      await expect(service.program(999, makeUser())).rejects.toBeInstanceOf(NotFoundException);
      expect(channels.isGuideChannelVisibleToUser).not.toHaveBeenCalled();
    });
  });

  describe('search', () => {
    it('scopes the program query through the shared authorization helper', async () => {
      const builder = fakeProgramQueryBuilder([]);
      programRepo.createQueryBuilder.mockReturnValue(builder);

      await service.search(makeUser(), 'news');

      expect(channels.scopeToAuthorizedGuideChannels).toHaveBeenCalledWith(
        builder,
        expect.anything(),
        'p."guideChannelId"',
      );
    });

    // Same IDOR shape as `program`: an empty q ("ILIKE '%%'") must not skip
    // scoping and fall back to scanning every channel's programs.
    it('scopes the query even for an empty q', async () => {
      const builder = fakeProgramQueryBuilder([]);
      programRepo.createQueryBuilder.mockReturnValue(builder);

      await service.search(makeUser(), '');

      expect(channels.scopeToAuthorizedGuideChannels).toHaveBeenCalledWith(
        builder,
        expect.anything(),
        'p."guideChannelId"',
      );
    });
  });

  describe('update', () => {
    it('keeps every field a partial PATCH left out (no Object.assign amputation)', async () => {
      guideSourceRepo.findOne.mockResolvedValue({
        id: 1,
        name: 'Guide',
        kind: 'xmltv',
        url: 'http://guide.example/xmltv',
        refreshIntervalHours: 12,
        timezoneOffsetMinutes: 0,
        language: 'en',
        priority: 0,
        enabled: true,
        source: null,
      });

      // A real class instance ([[Define]] semantics), not a plain object literal:
      // matches what the global ValidationPipe actually hands the service.
      const dto = plainToInstance(UpdateLiveTvGuideSourceDto, { enabled: false });
      const result = await service.update(1, dto);

      expect(result).toMatchObject({
        name: 'Guide',
        kind: 'xmltv',
        url: 'http://guide.example/xmltv',
        refreshIntervalHours: 12,
        language: 'en',
        enabled: false,
      });
      expect(result.url).not.toBeUndefined();
      expect(result.name).not.toBeUndefined();
    });
  });
});
