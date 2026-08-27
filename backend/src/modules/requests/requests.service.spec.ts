import { BadRequestException, ConflictException } from '@nestjs/common';
import { RequestsService } from './requests.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { MediaType, RequestStatus, RequestKind } from '../../common/enums';
import { User } from '../users/entities/user.entity';

/**
 * Build a chainable query-builder stub whose terminal `getOne` resolves to the
 * supplied row — enough for `findResolvedRow` after a delete approval.
 */
function fakeResolvedRowBuilder(row: unknown) {
  const builder: any = {
    leftJoin: () => builder,
    addSelect: () => builder,
    leftJoinAndMapOne: () => builder,
    where: () => builder,
    getOne: () => Promise.resolve(row),
  };
  return builder;
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    username: 'requester',
    avatar: null,
    isAdmin: true,
    permissions: ['manage:all'],
    ...overrides,
  } as unknown as User;
}

describe('RequestsService delete requests', () => {
  let requestRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let notifications: { dispatch: jest.Mock };
  let mediaService: {
    findByTmdbId: jest.Mock;
    remove: jest.Mock;
    deleteMediaFolder: jest.Mock;
    assertImportTarget: jest.Mock;
    importFromTmdb: jest.Mock;
    applyMonitoredForRequestScope: jest.Mock;
  };
  let events: { emitDomain: jest.Mock };
  let casl: { createForUser: jest.Mock };
  let libraries: { getAccessibleLibraryIds: jest.Mock };
  let service: RequestsService;

  beforeEach(() => {
    requestRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((p: unknown) => p),
      save: jest.fn(async (r: any) => ({ id: r.id ?? 42, ...r })),
      // `approve` reads the row back through a builder before returning it.
      createQueryBuilder: jest.fn(() => {
        const qb: Record<string, unknown> = {};
        for (const m of [
          'leftJoin',
          'addSelect',
          'leftJoinAndMapOne',
          'where',
          'andWhere',
          'orderBy',
        ]) {
          qb[m] = () => qb;
        }
        qb.getOne = () => Promise.resolve({ id: 7, user: null, approvedBy: null });
        return qb;
      }),
    };
    notifications = { dispatch: jest.fn().mockResolvedValue(undefined) };
    mediaService = {
      findByTmdbId: jest.fn(),
      remove: jest.fn(),
      deleteMediaFolder: jest.fn().mockResolvedValue(undefined),
      assertImportTarget: jest.fn().mockResolvedValue(undefined),
      importFromTmdb: jest.fn(),
      applyMonitoredForRequestScope: jest.fn().mockResolvedValue(undefined),
    };
    casl = { createForUser: jest.fn(() => ({ can: () => true })) };
    libraries = { getAccessibleLibraryIds: jest.fn().mockResolvedValue([]) };

    events = { emitDomain: jest.fn() };

    service = new RequestsService(
      requestRepo as never,
      {} as never,
      {} as never,
      notifications as never,
      mediaService as never,
      {} as never,
      casl as never,
      {} as never,
      {} as never,
      libraries as never,
      events as never,
    );
  });

  const deleteDto: CreateRequestDto = {
    mediaType: MediaType.MOVIE,
    tmdbId: 555,
    title: 'A Placeholder Title',
    kind: RequestKind.DELETE,
  };

  describe('create (delete)', () => {
    it('rejects when the target media is not in the library', async () => {
      mediaService.findByTmdbId.mockResolvedValue(null);

      await expect(service.create(makeUser(), deleteDto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(requestRepo.save).not.toHaveBeenCalled();
    });

    it('dedups only against a PENDING delete request for the same title', async () => {
      mediaService.findByTmdbId.mockResolvedValue({ id: 9, libraryId: 3 });
      requestRepo.findOne.mockResolvedValue({ id: 7 });

      await expect(service.create(makeUser(), deleteDto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      const where = requestRepo.findOne.mock.calls[0][0].where;
      expect(where.kind).toBe(RequestKind.DELETE);
      expect(where.tmdbId).toBe(555);
      expect(where.mediaType).toBe(MediaType.MOVIE);
    });

    it('creates a pending delete request without touching the add quota', async () => {
      mediaService.findByTmdbId.mockResolvedValue({
        id: 9,
        libraryId: 3,
        posterUrl: '/api/images/media/movie-555/poster.webp',
        fanartUrl: '/api/images/media/movie-555/fanart.webp',
      });
      requestRepo.findOne.mockResolvedValue(null);

      const saved = await service.create(makeUser(), deleteDto);

      // The quota check builds a query — a delete request must skip it.
      expect(requestRepo.createQueryBuilder).not.toHaveBeenCalled();

      const created = requestRepo.create.mock.calls[0][0];
      expect(created.kind).toBe(RequestKind.DELETE);
      expect(created.status).toBe(RequestStatus.PENDING);
      expect(created.approvedBy).toBeNull();
      expect(created.seasons).toBeNull();
      expect(created.media).toEqual({ id: 9 });
      expect(created.library).toEqual({ id: 3 });
      expect(created.posterUrl).toBe('/api/images/media/movie-555/poster.webp');
      expect(created.fanartUrl).toBe('/api/images/media/movie-555/fanart.webp');

      expect(notifications.dispatch).toHaveBeenCalledWith(
        'request.delete.created',
        expect.objectContaining({ title: 'A Placeholder Title' }),
      );
      expect(saved.kind).toBe(RequestKind.DELETE);
    });
  });

  describe('approve (delete)', () => {
    it('removes the media, purges its folder, and resolves to APPROVED', async () => {
      const admin = makeUser({ id: 2, username: 'admin' } as Partial<User>);
      const row = {
        id: 42,
        kind: RequestKind.DELETE,
        status: RequestStatus.PENDING,
        mediaType: MediaType.MOVIE,
        tmdbId: 555,
        title: 'A Placeholder Title',
        libraryId: null,
        userId: 1,
      };
      requestRepo.findOne.mockResolvedValue({ ...row });
      mediaService.findByTmdbId.mockResolvedValue({ id: 9 });
      mediaService.remove.mockResolvedValue({
        title: 'A Placeholder Title',
        diskPath: '/library/movies/A Placeholder Title',
      });
      const resolved = {
        ...row,
        status: RequestStatus.APPROVED,
        user: null,
        approvedBy: null,
      };
      requestRepo.createQueryBuilder.mockReturnValue(
        fakeResolvedRowBuilder(resolved),
      );

      const result = await service.approve(42, admin);

      expect(mediaService.remove).toHaveBeenCalledWith(9);
      expect(mediaService.deleteMediaFolder).toHaveBeenCalledWith(
        '/library/movies/A Placeholder Title',
      );
      // APPROVED is the terminal done-state for a delete request.
      const savedRow = requestRepo.save.mock.calls[0][0];
      expect(savedRow.status).toBe(RequestStatus.APPROVED);
      expect(savedRow.approvedBy).toBe(admin);
      expect(notifications.dispatch).toHaveBeenCalledWith(
        'request.delete.approved',
        expect.objectContaining({ title: 'A Placeholder Title' }),
      );
      expect(result.status).toBe(RequestStatus.APPROVED);
    });

    it('rolls back to PENDING when the media removal fails', async () => {
      const admin = makeUser({ id: 2 } as Partial<User>);
      requestRepo.findOne.mockResolvedValue({
        id: 42,
        kind: RequestKind.DELETE,
        status: RequestStatus.PENDING,
        mediaType: MediaType.MOVIE,
        tmdbId: 555,
        title: 'A Placeholder Title',
        libraryId: null,
        userId: 1,
      });
      mediaService.findByTmdbId.mockResolvedValue({ id: 9 });
      mediaService.remove.mockRejectedValue(new Error('disk busy'));

      await expect(service.approve(42, admin)).rejects.toThrow('disk busy');

      const lastSave =
        requestRepo.save.mock.calls[requestRepo.save.mock.calls.length - 1][0];
      expect(lastSave.status).toBe(RequestStatus.PENDING);
      expect(lastSave.approvedBy).toBeNull();
      expect(notifications.dispatch).not.toHaveBeenCalledWith(
        'request.delete.approved',
        expect.anything(),
      );
    });
  });

  describe('add path ignores delete rows', () => {
    it('duplicate guard only considers add requests', async () => {
      requestRepo.find.mockResolvedValue([]);

      await expect(
        (service as never as RequestsService)['assertNoActiveDuplicate']({
          tmdbId: 555,
          mediaType: MediaType.MOVIE,
        } as CreateRequestDto),
      ).resolves.toBeUndefined();

      expect(requestRepo.find.mock.calls[0][0].where.kind).toBe(
        RequestKind.ADD,
      );
    });

    it('quota counts only add requests', async () => {
      const andWhereCalls: [string, unknown][] = [];
      const builder: any = {
        where: () => builder,
        andWhere: (clause: string, params: unknown) => {
          andWhereCalls.push([clause, params]);
          return builder;
        },
        getCount: () => Promise.resolve(0),
      };
      requestRepo.createQueryBuilder.mockReturnValue(builder);

      await (service as never as RequestsService)['checkQuota'](
        makeUser({ movieQuotaLimit: 3, quotaPeriodDays: 7 } as Partial<User>),
        MediaType.MOVIE,
      );

      expect(andWhereCalls).toContainEqual([
        'r.kind = :kind',
        { kind: RequestKind.ADD },
      ]);
    });

    it('title-state ignores delete rows', async () => {
      requestRepo.find.mockResolvedValue([]);

      const state = await service.getTitleState(555, MediaType.MOVIE);

      expect(requestRepo.find.mock.calls[0][0].where.kind).toBe(
        RequestKind.ADD,
      );
      expect(state.requested).toBe(false);
    });
  });

  describe('decline (delete)', () => {
    it('dispatches the delete-declined event and sets DECLINED', async () => {
      const admin = makeUser({ id: 2 } as Partial<User>);
      requestRepo.findOne.mockResolvedValue({
        id: 42,
        kind: RequestKind.DELETE,
        status: RequestStatus.PENDING,
        title: 'A Placeholder Title',
        libraryId: null,
        userId: 1,
        user: makeUser(),
        approvedBy: null,
      });

      const result = await service.decline(42, admin, 'keep it');

      expect(result.status).toBe(RequestStatus.DECLINED);
      expect(result.declinedReason).toBe('keep it');
      expect(notifications.dispatch).toHaveBeenCalledWith(
        'request.delete.declined',
        expect.objectContaining({ title: 'A Placeholder Title' }),
      );
    });
  });

  // #886 gated the announcement behind `requests_auto_grab_on_approval` and #1015 removed both
  // the key and the gate: core states the fact and the acquisition owner decides. Untested either
  // way until now, and the failure is silent — an approval that announces nothing downloads
  // nothing, with a green check to say it worked.
  describe('approve (add) — acquisition announcement', () => {
    const addRow = {
      id: 7,
      kind: RequestKind.ADD,
      status: RequestStatus.PENDING,
      mediaType: MediaType.MOVIE,
      tmdbId: 555,
      userId: 3,
      libraryId: null,
      qualityProfileId: null,
      languageProfileId: null,
      seasons: null,
    };

    const announcements = () =>
      events.emitDomain.mock.calls
        .map(([e]) => e as { type: string; mediaIds?: number[]; reason?: string })
        .filter((e) => e.type === 'media.acquisition.requested');

    it('VERDICT: announces the acquisition once the media is linked', async () => {
      requestRepo.findOne.mockResolvedValue({ ...addRow });
      mediaService.findByTmdbId.mockResolvedValue(null);
      mediaService.importFromTmdb.mockResolvedValue({ id: 91 });

      await service.approve(7, makeUser());

      expect(announcements()).toEqual([
        { type: 'media.acquisition.requested', mediaIds: [91], reason: 'request-approved' },
      ]);
    });

    it('says nothing when the approval produced no media', async () => {
      requestRepo.findOne.mockResolvedValue({ ...addRow });
      mediaService.findByTmdbId.mockResolvedValue(null);
      // The 409 branch: the title exists elsewhere, and no row comes back for it.
      mediaService.importFromTmdb.mockRejectedValue({ status: 409 });

      await service.approve(7, makeUser());

      expect(announcements()).toEqual([]);
    });
  });
});
