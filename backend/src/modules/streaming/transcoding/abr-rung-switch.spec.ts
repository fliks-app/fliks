import * as path from 'path';
import { TranscodingService } from './transcoding.service';
import { sessionKey } from './session-key';
import type { TranscodeSession } from './types';
import { VARIANT_EARLY, VARIANT_MAIN, remuxVariant } from './variant';

describe('TranscodingService ABR rung switch', () => {
  const svc = new TranscodingService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const internals = svc as unknown as {
    sessions: Map<string, TranscodeSession>;
    doGetOrCreateSession: jest.Mock;
  };

  it('locates a sibling rung of a main run only', () => {
    const main = {
      cachePath: '/c/u7/42/abc/2160p',
      variant: VARIANT_MAIN,
    } as TranscodeSession;
    expect(svc.rungCacheDir(main, '720p')).toBe(
      path.join('/c/u7/42/abc', '720p'),
    );
    expect(svc.rungCacheDir(main, 'remux')).toBeNull();
    expect(
      svc.rungCacheDir({ ...main, variant: VARIANT_EARLY }, '720p'),
    ).toBeNull();
    const remux = {
      ...main,
      remux: true,
      variant: remuxVariant({ audioIndex: 0, keyframeGrid: true }),
    };
    expect(svc.rungCacheDir(remux as TranscodeSession, '720p')).toBeNull();
  });

  describe('anyRung', () => {
    // computeProfileHashForCtx(undefined) is the key a ctx-less call resolves.
    const key = sessionKey(
      42,
      undefined,
      svc.computeProfileHashForCtx(undefined),
    );
    const running = {
      id: key,
      quality: '480p',
      process: { exitCode: null, signalCode: null },
    } as unknown as TranscodeSession;
    const spawned = {
      id: key,
      quality: '2160p',
    } as unknown as TranscodeSession;

    beforeEach(() => {
      internals.sessions.clear();
      internals.sessions.set(key, running);
      internals.doGetOrCreateSession = jest.fn().mockResolvedValue(spawned);
    });

    it('keeps the rung already producing instead of switching to the guessed one', async () => {
      const got = await svc.getOrCreateSession(
        42,
        '2160p',
        '/src.mkv',
        0,
        undefined,
        true,
        true,
      );
      expect(got).toBe(running);
      expect(internals.doGetOrCreateSession).not.toHaveBeenCalled();
    });

    it('still switches rungs for a request the player made itself', async () => {
      const got = await svc.getOrCreateSession(
        42,
        '2160p',
        '/src.mkv',
        0,
        undefined,
        true,
      );
      expect(got).toBe(spawned);
      expect(internals.doGetOrCreateSession).toHaveBeenCalled();
    });
  });
});
