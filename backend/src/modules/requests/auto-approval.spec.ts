import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { RequestsService } from './requests.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { CreateAutoApprovalRuleDto } from './dto/create-auto-approval-rule.dto';
import { MediaType, RequestStatus } from '../../common/enums';
import { User } from '../users/entities/user.entity';
import { AutoApprovalCriteria } from './entities/auto-approval-rule.entity';

function makeService(
  rules: { id: number; name: string; criteria: AutoApprovalCriteria }[],
  tmdb: Partial<{ getMovieDetails: jest.Mock; getTvShowDetails: jest.Mock }> = {},
  defaultLibrary: { id: number } | null = null,
) {
  const ruleRepo = { find: jest.fn().mockResolvedValue(rules) };
  return new RequestsService(
    {} as never,
    {} as never,
    ruleRepo as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    tmdb as never,
    { getDefaultForType: jest.fn().mockResolvedValue(defaultLibrary) } as never,
    {} as never,
  );
}

const user = { id: 4, userRole: { id: 2 } } as unknown as User;
const movie: CreateRequestDto = {
  mediaType: MediaType.MOVIE,
  tmdbId: 111,
  title: 'A Placeholder Title',
};

function decide(service: RequestsService, dto: CreateRequestDto, u: User = user) {
  return (service as never as { shouldAutoApprove(u: User, d: CreateRequestDto): Promise<boolean> })
    .shouldAutoApprove(u, dto);
}

describe('auto-approval criteria', () => {
  it('approves nothing when no rule is enabled', async () => {
    await expect(decide(makeService([]), movie)).resolves.toBe(false);
  });

  it('treats empty criteria as approve-everything', async () => {
    const s = makeService([{ id: 1, name: 'all', criteria: {} }]);
    await expect(decide(s, movie)).resolves.toBe(true);
  });

  it('matches on the requester role as well as on the user id', async () => {
    const byRole = makeService([{ id: 1, name: 'role', criteria: { roleIds: [2] } }]);
    await expect(decide(byRole, movie)).resolves.toBe(true);

    const byUser = makeService([{ id: 1, name: 'user', criteria: { userIds: [4] } }]);
    await expect(decide(byUser, movie)).resolves.toBe(true);

    const other = makeService([
      { id: 1, name: 'other', criteria: { userIds: [9], roleIds: [7] } },
    ]);
    await expect(decide(other, movie)).resolves.toBe(false);
  });

  it('requires the request to target one of the listed libraries', async () => {
    const rules = [{ id: 1, name: 'lib', criteria: { libraryIds: [3] } }];
    const s = makeService(rules);
    await expect(decide(s, { ...movie, libraryId: 3 })).resolves.toBe(true);
    await expect(decide(s, { ...movie, libraryId: 5 })).resolves.toBe(false);
    // No explicit target and no default library: the criterion cannot be satisfied.
    await expect(decide(s, movie)).resolves.toBe(false);
    // A request that will land in the default library matches on that library.
    await expect(decide(makeService(rules, {}, { id: 3 }), movie)).resolves.toBe(true);
    await expect(decide(makeService(rules, {}, { id: 9 }), movie)).resolves.toBe(false);
  });

  it('matches a genre by TMDB id and a release year inside the range', async () => {
    const getMovieDetails = jest
      .fn()
      .mockResolvedValue({ genreIds: [27, 53], year: 2010, seasonCount: null });
    const s = makeService(
      [{ id: 1, name: 'meta', criteria: { genreIds: [27], yearFrom: 2000, yearTo: 2020 } }],
      { getMovieDetails },
    );
    await expect(decide(s, movie)).resolves.toBe(true);
    expect(getMovieDetails).toHaveBeenCalledTimes(1);

    const wrongGenre = makeService(
      [{ id: 1, name: 'meta', criteria: { genreIds: [99] } }],
      { getMovieDetails },
    );
    await expect(decide(wrongGenre, movie)).resolves.toBe(false);

    const outOfRange = makeService(
      [{ id: 1, name: 'meta', criteria: { yearFrom: 2015 } }],
      { getMovieDetails },
    );
    await expect(decide(outOfRange, movie)).resolves.toBe(false);
  });

  it('fails closed when the metadata lookup a criterion needs fails', async () => {
    const s = makeService([{ id: 1, name: 'meta', criteria: { genreIds: [27] } }], {
      getMovieDetails: jest.fn().mockRejectedValue(new Error('TMDB down')),
    });
    await expect(decide(s, movie)).resolves.toBe(false);
  });

  it('skips the metadata call when no rule reads title metadata', async () => {
    const getMovieDetails = jest.fn();
    const s = makeService([{ id: 1, name: 'role', criteria: { roleIds: [2] } }], {
      getMovieDetails,
    });
    await expect(decide(s, movie)).resolves.toBe(true);
    expect(getMovieDetails).not.toHaveBeenCalled();
  });

  it('caps seasons on the requested scope, or on the show total for a whole-series request', async () => {
    const getTvShowDetails = jest
      .fn()
      .mockResolvedValue({ genreIds: [18], year: 2015, seasonCount: 8 });
    const s = makeService([{ id: 1, name: 'short', criteria: { maxSeasons: 3 } }], {
      getTvShowDetails,
    });
    const series: CreateRequestDto = { ...movie, mediaType: MediaType.SERIES };

    await expect(decide(s, { ...series, seasons: [1, 2] })).resolves.toBe(true);
    await expect(decide(s, { ...series, seasons: [1, 2, 3, 4] })).resolves.toBe(false);
    // Whole series: the show's own 8 seasons blow the cap.
    await expect(decide(s, series)).resolves.toBe(false);
  });

  it('ignores a season cap on a movie request', async () => {
    const s = makeService([{ id: 1, name: 'short', criteria: { maxSeasons: 3 } }], {
      getMovieDetails: jest
        .fn()
        .mockResolvedValue({ genreIds: [], year: 1999, seasonCount: null }),
    });
    await expect(decide(s, movie)).resolves.toBe(true);
  });

  it('honours the media type filter', async () => {
    const s = makeService([
      { id: 1, name: 'movies', criteria: { mediaType: MediaType.MOVIE } },
    ]);
    await expect(decide(s, movie)).resolves.toBe(true);
    await expect(decide(s, { ...movie, mediaType: MediaType.SERIES })).resolves.toBe(false);
  });
});

describe('auto-approval rule DTO', () => {
  // Mirrors main.ts: an undecorated property is what made every create a 400.
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const meta = { type: 'body' as const, metatype: CreateAutoApprovalRuleDto };
  const run = (body: unknown) => pipe.transform(body, meta);

  it('accepts a fully populated rule', async () => {
    const criteria = {
      userIds: [4],
      roleIds: [2],
      mediaType: 'series',
      libraryIds: [3],
      genreIds: [35, 16],
      maxSeasons: 3,
      yearFrom: 2000,
      yearTo: 2020,
    };
    await expect(run({ name: 'family', enabled: true, criteria })).resolves.toMatchObject({
      name: 'family',
      criteria,
    });
  });

  it('accepts empty criteria and rejects a missing one', async () => {
    await expect(run({ name: 'all', criteria: {} })).resolves.toMatchObject({ criteria: {} });
    await expect(run({ name: 'all' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a blank name, a bad media type, a non-numeric genre and an unknown key', async () => {
    await expect(run({ name: ' ', criteria: {} })).rejects.toBeInstanceOf(BadRequestException);
    await expect(run({ name: 'x', criteria: { mediaType: 'anime' } })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(run({ name: 'x', criteria: { genreIds: ['horror'] } })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(run({ name: 'x', criteria: { nope: 1 } })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('auto-approval through create()', () => {
  function makeFullService(
    rules: { id: number; name: string; criteria: AutoApprovalCriteria }[],
    libraries: { getDefaultForType?: jest.Mock } = {},
  ) {
    const requestRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((p: unknown) => p),
      save: jest.fn(async (r: Record<string, unknown>) => ({ id: 77, ...r })),
    };
    const mediaService = {
      importFromTmdb: jest.fn().mockResolvedValue({ id: 5 }),
      applyMonitoredForRequestScope: jest.fn().mockResolvedValue(undefined),
    };
    const events = { emitDomain: jest.fn() };
    const notifications = { dispatch: jest.fn().mockResolvedValue(undefined) };
    // hasImage true on both slots short-circuits the art fetch and its 5s race.
    const imageService = {
      hasImage: jest.fn(() => true),
      getApiPath: jest.fn(() => '/api/img'),
    };
    const service = new RequestsService(
      requestRepo as never,
      {} as never,
      { find: jest.fn().mockResolvedValue(rules) } as never,
      notifications as never,
      mediaService as never,
      {} as never,
      { createForUser: jest.fn(() => ({ can: () => true })) } as never,
      imageService as never,
      { getMovieDetails: jest.fn() } as never,
      {
        getAccessibleLibraryIds: jest.fn().mockResolvedValue([3]),
        getDefaultForType: jest.fn().mockResolvedValue(null),
        ...libraries,
      } as never,
      events as never,
    );
    return { service, requestRepo, mediaService, events, notifications };
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const addDto: CreateRequestDto = {
    mediaType: MediaType.MOVIE,
    tmdbId: 222,
    title: 'A Placeholder Title',
  };

  it('lands APPROVED, ensures the media and emits request.approved when a rule matches', async () => {
    const { service, requestRepo, mediaService, events } = makeFullService([
      { id: 1, name: 'role', criteria: { roleIds: [2] } },
    ]);

    await service.create(user, addDto);

    const saved = requestRepo.save.mock.calls[0][0];
    expect(saved.status).toBe(RequestStatus.APPROVED);
    expect(saved.approvedBy).toBe(user);
    expect(saved.media).toEqual({ id: 5 });
    expect(mediaService.importFromTmdb).toHaveBeenCalledTimes(1);
    expect(events.emitDomain.mock.calls.map((c) => c[0].type)).toEqual([
      'request.created',
      'request.approved',
    ]);
  });

  it('stays PENDING and imports nothing when no rule matches', async () => {
    const { service, requestRepo, mediaService, events } = makeFullService([
      { id: 1, name: 'other', criteria: { roleIds: [99] } },
    ]);

    await service.create(user, addDto);

    const saved = requestRepo.save.mock.calls[0][0];
    expect(saved.status).toBe(RequestStatus.PENDING);
    expect(saved.approvedBy).toBeNull();
    expect(saved.media).toBeNull();
    expect(mediaService.importFromTmdb).not.toHaveBeenCalled();
    expect(events.emitDomain.mock.calls.map((c) => c[0].type)).toEqual(['request.created']);
  });

  it('matches a library rule against the default library when the request omits one', async () => {
    const getDefaultForType = jest.fn().mockResolvedValue({ id: 3 });
    const { service, requestRepo } = makeFullService(
      [{ id: 1, name: 'lib', criteria: { libraryIds: [3] } }],
      { getDefaultForType },
    );

    await service.create(user, addDto);

    expect(getDefaultForType).toHaveBeenCalledWith(MediaType.MOVIE);
    expect(requestRepo.save.mock.calls[0][0].status).toBe(RequestStatus.APPROVED);
  });

  it('does not resolve the default library when no rule filters on one', async () => {
    const getDefaultForType = jest.fn();
    const { service } = makeFullService([{ id: 1, name: 'role', criteria: { roleIds: [2] } }], {
      getDefaultForType,
    });

    await service.create(user, addDto);

    expect(getDefaultForType).not.toHaveBeenCalled();
  });
});
