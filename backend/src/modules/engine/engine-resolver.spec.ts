import {
  ExecutionContext,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { EngineHostGuard } from './engine-resolver.controller';
import {
  EngineResolverService,
  type ResolveRequestDto,
} from './engine-resolver.service';
import { EngineService } from './engine.service';

const jwt = new JwtService({ secret: 'test' });
const token = (over = {}, opts = {}) =>
  jwt.sign({ sub: 3, username: 'u', ...over }, opts);

function make(enabled = true) {
  const userRepo = {
    findOne: jest.fn(async () => (enabled ? { id: 3 } : null)),
  };
  const streaming = {
    resolveFile: jest.fn(async () => ({ absolutePath: '/m/a.mkv' })),
  };
  const subtitles = {
    getSubtitleFileForDownload: jest.fn(async () => ({
      path: '/m/a.fr.SRT',
      filename: 'a.fr.SRT',
    })),
  };
  const thumbnails = { getSpritePath: jest.fn(() => '/c/7/sprite.jpg') };
  const liveSessions = {
    viewer: jest.fn(() => ({ channelId: 9 })),
  };
  const channels = { findPlayable: jest.fn(async () => ({})) };
  const service = new EngineResolverService(
    userRepo as never,
    jwt,
    streaming as never,
    subtitles as never,
    thumbnails as never,
    liveSessions as never,
    channels as never,
  );
  return { service, userRepo, streaming, subtitles, liveSessions, channels };
}

const req = (over: Partial<ResolveRequestDto> = {}): ResolveRequestDto => ({
  mediaId: 7,
  credential: `Bearer ${token()}`,
  purpose: 'stream',
  ...over,
});
const DENIED = { allow: false, ttlS: 60 };

describe('EngineResolverService', () => {
  it.each([
    ['bearer', `Bearer ${token()}`],
    ['bare ?token=', token()],
    ['cookie', `x=1; fliks_access=${token()}`],
    ['stream-scoped token', token({ scope: 'stream' })],
  ])('allows stream with a %s credential', async (_n, credential) => {
    const { service, streaming } = make();
    await expect(service.resolve(req({ credential }))).resolves.toEqual({
      allow: true,
      path: '/m/a.mkv',
      ownerId: '3',
      ttlS: 60,
    });
    expect(streaming.resolveFile).toHaveBeenCalledWith(7, { id: 3 });
  });

  it('serves download like stream', async () => {
    const { service } = make();
    expect(await service.resolve(req({ purpose: 'download' }))).toMatchObject({
      allow: true,
      path: '/m/a.mkv',
    });
  });

  it('answers the sprite path after the file ACL', async () => {
    const { service, streaming } = make();
    expect(await service.resolve(req({ purpose: 'sprite' }))).toMatchObject({
      allow: true,
      path: '/c/7/sprite.jpg',
    });
    expect(streaming.resolveFile).toHaveBeenCalled();
  });

  it('answers an external subtitle with its path and format', async () => {
    const { service, subtitles } = make();
    const out = await service.resolve(
      req({ purpose: 'subtitle', subtitleId: 4 }),
    );
    expect(out).toMatchObject({
      allow: true,
      path: '/m/a.fr.SRT',
      format: 'srt',
    });
    expect(subtitles.getSubtitleFileForDownload).toHaveBeenCalledWith(4, {
      id: 3,
    });
  });

  it('answers an embedded subtitle with the media path', async () => {
    const { service } = make();
    expect(
      await service.resolve(req({ purpose: 'subtitle', streamIndex: 2 })),
    ).toMatchObject({ allow: true, path: '/m/a.mkv', format: 'embedded' });
  });

  it('denies a subtitle request naming neither track', async () => {
    const { service } = make();
    expect(await service.resolve(req({ purpose: 'subtitle' }))).toEqual(DENIED);
  });

  it('allows a live viewer after the channel check, re-checked on every request', async () => {
    const { service, channels, liveSessions } = make();
    const out = await service.resolve(
      req({ purpose: 'live', mediaId: 'sid-1' }),
    );
    expect(out).toEqual({ allow: true, ownerId: '3', ttlS: 0 });
    expect(liveSessions.viewer).toHaveBeenCalledWith('sid-1');
    expect(channels.findPlayable).toHaveBeenCalledWith(9, { id: 3 });
  });

  it.each(['stream', 'download', 'sprite', 'subtitle', 'live'] as const)(
    'denies %s when the route ACL refuses, without a path',
    async (purpose) => {
      const m = make();
      const refuse = async () => {
        throw new NotFoundException();
      };
      m.streaming.resolveFile.mockImplementation(refuse);
      m.subtitles.getSubtitleFileForDownload.mockImplementation(refuse);
      m.channels.findPlayable.mockImplementation(refuse);
      const out = await m.service.resolve(
        req({
          purpose,
          subtitleId: 4,
          mediaId: purpose === 'live' ? 'sid' : 7,
        }),
      );
      expect(out).toEqual(DENIED);
    },
  );

  it('denies an inactive or unknown user', async () => {
    const m = make(false);
    expect(await m.service.resolve(req())).toEqual(DENIED);
    expect(m.streaming.resolveFile).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a forged token',
      `Bearer ${new JwtService({ secret: 'other' }).sign({ sub: 3 })}`,
    ],
    ['an expired token', `Bearer ${token({}, { expiresIn: -10 })}`],
    ['garbage', 'Bearer nope'],
    ['an empty credential', ''],
    ['a cookie without the access token', 'a=b'],
  ])('denies %s', async (_n, credential) => {
    const { service, userRepo } = make();
    expect(await service.resolve(req({ credential }))).toEqual(DENIED);
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('denies a non-numeric media id', async () => {
    const { service } = make();
    expect(await service.resolve(req({ mediaId: 'abc' }))).toEqual(DENIED);
  });

  it('lets a host fault surface instead of caching a denial', async () => {
    const m = make();
    m.streaming.resolveFile.mockRejectedValue(new Error('db down'));
    await expect(m.service.resolve(req())).rejects.toThrow('db down');
  });
});

describe('EngineHostGuard', () => {
  const ctx = (authorization?: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization } }),
      }),
    }) as ExecutionContext;
  const engine = new EngineService();
  const guard = new EngineHostGuard(engine);

  it('passes the engine host token', () => {
    expect(guard.canActivate(ctx(`Bearer ${engine.hostToken}`))).toBe(true);
  });

  it.each([
    undefined,
    '',
    'Bearer',
    'Bearer wrong',
    engine.hostToken,
    'Basic abc',
  ])('rejects %p with 401', (header) => {
    expect(() => guard.canActivate(ctx(header))).toThrow(UnauthorizedException);
  });
});
