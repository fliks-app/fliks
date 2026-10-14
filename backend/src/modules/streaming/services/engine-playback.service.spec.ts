import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFileSync } from 'fs';
import { EngineError } from '../../engine/engine.service';
import { LiveSessionRegistry } from '../live-session.service';
import {
  EnginePlaybackService,
  type PlaybackQuery,
} from './engine-playback.service';

// Recorded from fliks-engine (m3/remux) for a 1280x720 h264/aac mkv, web device, startQuality=360p:
// `engine` is its POST /v1/sessions answer, `host` the playback-info body Node returned for it.
const recorded = JSON.parse(
  readFileSync(join(__dirname, 'engine-playback.recorded.json'), 'utf8'),
) as { engine: any; host: Record<string, unknown> };

const streamInfo = {
  formatName: 'matroska,webm',
  formatStartSeconds: 0,
  durationSeconds: 10.023,
  video: [
    {
      streamIndex: 0,
      codec: 'h264',
      width: 1280,
      height: 720,
      frameRate: '24',
      startTimeSeconds: 0,
      firstFrameSeconds: 0,
    },
  ],
  audio: [{ streamIndex: 1, codec: 'aac', channels: 2, language: 'und' }],
  subtitles: [],
};
const settings = {
  segmentDuration: 3,
  qsvPreset: 'faster',
  tonemapAlgo: 'auto',
  tonemapCurve: 'mobius',
  autoCropEnabled: true,
};
const user = { id: 1, username: 'admin', edlEnabled: true } as never;
const query: PlaybackQuery = {
  tokenParam: '?token=tok',
  startQuality: '360p',
  download: false,
  sseConnectionId: 'conn-9',
  userAgent: 'livecheck/1.0',
};
const device = {
  directPlayProfiles: [],
  deviceType: 'desktop',
  deviceName: 'live-check',
  systemName: 'Linux',
  supportsAbr: true,
};

function setup(
  over: {
    info?: object;
    file?: Partial<Record<string, unknown>>;
    engine?: object;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'engine-playback-'));
  const resolved = {
    absolutePath: join(dir, 'clip.mkv'),
    ext: '.mkv',
    contentType: 'video/x-matroska',
    mediaFile: {
      id: 1,
      mediaId: 5,
      episodeId: null,
      streamInfo: over.info ?? streamInfo,
      ...over.file,
    },
    media: {
      id: 5,
      title: 'Clip',
      type: 'movie',
      posterUrl: null,
      fanartUrl: null,
    },
  };
  const engine = {
    runtime: true,
    openSession: jest.fn().mockResolvedValue(recorded.engine),
    ...over.engine,
  };
  const qoe = {
    register: jest.fn(),
    setPipeline: jest.fn(),
    sessionEnded: jest.fn(),
  };
  const liveSessions = new LiveSessionRegistry(qoe as never);
  const deps = {
    streamingService: { resolveFile: jest.fn().mockResolvedValue(resolved) },
    subtitleBurnIn: { resolve: jest.fn(), buildFilter: jest.fn() },
    subtitleStreamService: {
      listTextSubtitleRenditions: jest
        .fn()
        .mockResolvedValue([{ kind: 'embedded', key: 3, name: 'en' }]),
    },
    sourceScans: {
      lookup: jest.fn().mockResolvedValue({ scan: null, version: '99-1' }),
      scheduleIfNeeded: jest.fn(),
    },
    staleProbeRescan: { schedule: jest.fn() },
    settingsCache: { get: jest.fn().mockResolvedValue(settings) },
    hardware: { apply: jest.fn().mockResolvedValue(undefined) },
    markersService: {
      findIntroForEpisode: jest.fn(),
      findOutroForEpisode: jest.fn(),
    },
    playbackService: {
      getState: jest.fn().mockResolvedValue(null),
      markSessionStarted: jest.fn().mockResolvedValue(undefined),
    },
    pluginPreRoll: { ask: jest.fn().mockResolvedValue([]) },
    events: {
      takeAttribution: jest.fn().mockReturnValue(null),
      claimAttribution: jest.fn(),
      targetIdFor: jest.fn().mockReturnValue('tv#1'),
    },
  };
  const svc = new EnginePlaybackService(
    engine as never,
    deps.streamingService as never,
    deps.subtitleBurnIn as never,
    deps.subtitleStreamService as never,
    deps.sourceScans as never,
    deps.staleProbeRescan as never,
    deps.settingsCache as never,
    deps.hardware as never,
    deps.markersService as never,
    deps.playbackService as never,
    deps.pluginPreRoll as never,
    deps.events as never,
    qoe as never,
    liveSessions,
  );
  return {
    svc,
    engine,
    deps,
    qoe,
    liveSessions,
    dir,
    resolved,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('EnginePlaybackService.playbackInfo', () => {
  it('answers the recorded playback-info JSON for a recorded engine decision', async () => {
    const t = setup();
    const out = await t.svc.playbackInfo(user, 1, device as never, query);
    expect(JSON.parse(JSON.stringify(out))).toEqual(recorded.host);
    t.cleanup();
  });

  it('opens the session with what the engine needs to decide', async () => {
    const t = setup();
    await t.svc.playbackInfo(
      user,
      1,
      { ...device, supportsHlsSubtitles: true } as never,
      { ...query, startAt: 42 },
    );
    const req = t.engine.openSession.mock.calls[0][0];
    expect(req).toMatchObject({
      decide: {
        media: {
          mediaFileId: 1,
          path: t.resolved.absolutePath,
          ext: '.mkv',
          contentType: 'video/x-matroska',
        },
        selection: {
          tokenParam: '?token=tok',
          requestedQuality: '360p',
          burnInIsText: false,
        },
        scan: null,
      },
      ownerId: '1',
      startAtS: 42,
      pinned: false,
      sourceVersion: '99-1',
      client: {
        deviceName: 'live-check',
        systemName: 'Linux',
        userAgent: 'livecheck/1.0',
      },
      tags: {
        username: 'admin',
        mediaTitle: 'Clip',
        sseConnectionId: 'conn-9',
      },
      subtitleRenditions: [{ kind: 'embedded', key: 3, name: 'en' }],
    });
    expect(t.deps.hardware.apply).toHaveBeenCalledWith(settings);
    t.cleanup();
  });

  it('keeps the presence of the session under the engine sid, with the engine hash', async () => {
    const t = setup();
    await t.svc.playbackInfo(user, 1, device as never, query);
    const live = t.liveSessions.peek(recorded.engine.sessionId)!;
    expect(live).toMatchObject({
      userId: 1,
      username: 'admin',
      mediaTitle: 'Clip',
      kind: 'transcode',
      profileHash: recorded.engine.profileHash,
      quality: '360p',
      sseConnectionId: 'conn-9',
      deviceLabel: 'livecheck/1.0',
    });
    expect(t.qoe.register).toHaveBeenCalledWith(live);
    expect(t.qoe.setPipeline.mock.calls[0][1]).toEqual({
      ...recorded.engine.qoePipeline,
      source: { ...recorded.engine.qoePipeline.source, hdr: null },
    });
    t.cleanup();
  });

  it('tags the attribution of a remote launch', async () => {
    const t = setup();
    t.deps.events.takeAttribution.mockReturnValue(9);
    await t.svc.playbackInfo(user, 1, device as never, query);
    expect(t.deps.events.takeAttribution).toHaveBeenCalledWith('tv#1', 1);
    expect(t.engine.openSession.mock.calls[0][0].tags.attributedUserId).toBe(
      '9',
    );
    expect(
      t.liveSessions.peek(recorded.engine.sessionId)!.attributedUserId,
    ).toBe(9);
    t.cleanup();
  });

  it('gives the attribution back when the engine fails to open the session', async () => {
    const t = setup();
    t.deps.events.takeAttribution.mockReturnValue(9);
    t.engine.openSession.mockRejectedValue(new Error('down'));
    await expect(
      t.svc.playbackInfo(user, 1, device as never, query),
    ).rejects.toThrow('unavailable');
    expect(t.deps.events.claimAttribution).toHaveBeenCalledWith('tv#1', 9, 1);
    t.cleanup();
  });

  it('claims nothing back when there was no attribution', async () => {
    const t = setup();
    t.engine.openSession.mockRejectedValue(new Error('down'));
    await expect(
      t.svc.playbackInfo(user, 1, device as never, query),
    ).rejects.toThrow();
    expect(t.deps.events.claimAttribution).not.toHaveBeenCalled();
    t.cleanup();
  });

  it('resumes from the saved position, and pins a download without marking history', async () => {
    const t = setup();
    t.deps.playbackService.getState.mockResolvedValue({
      completed: false,
      positionSeconds: 300,
    });
    await t.svc.playbackInfo(user, 1, device as never, {
      ...query,
      download: true,
    });
    expect(t.engine.openSession.mock.calls[0][0]).toMatchObject({
      startAtS: 300,
      pinned: true,
    });
    expect(t.deps.playbackService.markSessionStarted).not.toHaveBeenCalled();
    t.cleanup();
  });

  it('marks a watch-history entry, adds markers, pre-roll and chapters', async () => {
    const t = setup({
      file: { episodeId: 7 },
      info: {
        ...streamInfo,
        chapters: [{ title: 'one', startSeconds: 0, endSeconds: 5 }],
      },
    });
    t.deps.markersService.findIntroForEpisode.mockResolvedValue({
      startSeconds: 1,
      endSeconds: 9,
    });
    t.deps.markersService.findOutroForEpisode.mockResolvedValue(null);
    t.deps.pluginPreRoll.ask.mockResolvedValue([{ mediaFileId: 1 }]);
    const out = await t.svc.playbackInfo(user, 1, device as never, query);
    expect(t.deps.playbackService.markSessionStarted).toHaveBeenCalledWith(
      1,
      5,
      1,
      7,
    );
    expect(out.markers).toEqual({
      intro: { startSeconds: 1, endSeconds: 9 },
      outro: undefined,
    });
    expect(out.preRoll).toEqual([{ mediaFileId: 1 }]);
    expect(out.chapters).toHaveLength(1);
    t.cleanup();
  });

  it('shifts the EDL by the engine clock offset of an HLS session, not of a direct play', async () => {
    const info = {
      ...streamInfo,
      formatStartSeconds: 1.4,
      video: [
        {
          ...streamInfo.video[0],
          startTimeSeconds: 1.4,
          firstFrameSeconds: 0.4,
        },
      ],
    };
    const t = setup({ info });
    writeFileSync(join(t.dir, 'clip.edl'), '10 20 0\n');
    t.engine.openSession.mockResolvedValue({
      ...recorded.engine,
      playbackClockOffsetS: 2,
    });
    const hls = await t.svc.playbackInfo(user, 1, device as never, query);
    expect(hls.edl).toEqual([{ start: 12, end: 22, action: 'cut' }]);

    const direct = structuredClone(recorded.engine);
    direct.decision.response.playMethod = 'DirectPlay';
    t.engine.openSession.mockResolvedValue(direct);
    expect(
      (await t.svc.playbackInfo(user, 1, device as never, query)).edl,
    ).toEqual([{ start: 10, end: 20, action: 'cut' }]);
    t.cleanup();
  });

  it('relays the engine tone-map report', async () => {
    const t = setup();
    t.engine.openSession.mockResolvedValue({
      ...recorded.engine,
      tonemapAlgo: 'opencl',
      tonemapCurve: 'hable',
    });
    const out = await t.svc.playbackInfo(user, 1, device as never, query);
    expect(out).toMatchObject({ tonemapAlgo: 'opencl', tonemapCurve: 'hable' });
    t.cleanup();
  });

  it('skips the EDL for a user who turned it off', async () => {
    const t = setup();
    writeFileSync(join(t.dir, 'clip.edl'), '10 20 0\n');
    const out = await t.svc.playbackInfo(
      { ...(user as object), edlEnabled: false } as never,
      1,
      device as never,
      query,
    );
    expect(out.edl).toBeUndefined();
    t.cleanup();
  });

  describe('hints', () => {
    const withHints = (hints: object) => ({ ...recorded.engine, hints });

    it('re-probes a stale probe, which chains the scan', async () => {
      const t = setup({
        engine: {
          openSession: jest
            .fn()
            .mockResolvedValue(
              withHints({ probeStale: true, scanMissing: true }),
            ),
        },
      });
      await t.svc.playbackInfo(user, 1, device as never, query);
      expect(t.deps.staleProbeRescan.schedule).toHaveBeenCalledWith(
        1,
        t.resolved.absolutePath,
      );
      expect(t.deps.sourceScans.scheduleIfNeeded).not.toHaveBeenCalled();
      t.cleanup();
    });

    it('scans a file without a scan', async () => {
      const t = setup({
        engine: {
          openSession: jest
            .fn()
            .mockResolvedValue(
              withHints({ probeStale: false, scanMissing: true }),
            ),
        },
      });
      await t.svc.playbackInfo(user, 1, device as never, query);
      expect(t.deps.sourceScans.scheduleIfNeeded).toHaveBeenCalledWith(
        1,
        t.resolved.absolutePath,
        streamInfo,
        'high',
      );
      expect(t.deps.staleProbeRescan.schedule).not.toHaveBeenCalled();
      t.cleanup();
    });

    it('does nothing when the engine has no complaint', async () => {
      const t = setup();
      await t.svc.playbackInfo(user, 1, device as never, query);
      expect(t.deps.sourceScans.scheduleIfNeeded).not.toHaveBeenCalled();
      expect(t.deps.staleProbeRescan.schedule).not.toHaveBeenCalled();
      t.cleanup();
    });
  });

  describe('burn-in', () => {
    it('sends the resolved text burn-in as the selection and the session spec', async () => {
      const t = setup();
      t.deps.subtitleBurnIn.resolve.mockResolvedValue({
        type: 'text',
        streamIndex: 4,
      });
      t.deps.subtitleBurnIn.buildFilter.mockReturnValue("subtitles='/a.srt'");
      await t.svc.playbackInfo(user, 1, device as never, {
        ...query,
        burnInSubtitleId: 12,
      });
      const req = t.engine.openSession.mock.calls[0][0];
      expect(req.decide.selection).toMatchObject({
        burnInSubtitleId: 12,
        burnInIsText: true,
      });
      expect(req.burnIn).toEqual({
        type: 'text',
        filter: "subtitles='/a.srt'",
        streamIndex: 4,
      });
      t.cleanup();
    });

    it('plays without one when the subtitle cannot be resolved', async () => {
      const t = setup();
      t.deps.subtitleBurnIn.resolve.mockRejectedValue(new Error('nope'));
      await t.svc.playbackInfo(user, 1, device as never, {
        ...query,
        burnInSubtitleId: 12,
      });
      const req = t.engine.openSession.mock.calls[0][0];
      expect(req.decide.selection.burnInSubtitleId).toBeUndefined();
      expect(req.burnIn).toBeNull();
      t.cleanup();
    });
  });

  describe('engine failures', () => {
    it('answers 400 to a request the engine refuses', async () => {
      const t = setup({
        engine: {
          openSession: jest
            .fn()
            .mockRejectedValue(new EngineError(400, 'POST /v1/sessions')),
        },
      });
      await expect(
        t.svc.playbackInfo(user, 1, device as never, query),
      ).rejects.toThrow(BadRequestException);
      t.cleanup();
    });

    it('answers 503 when the engine cannot be reached, and keeps no presence', async () => {
      const t = setup({
        engine: {
          openSession: jest
            .fn()
            .mockRejectedValue(new TypeError('fetch failed')),
        },
      });
      await expect(
        t.svc.playbackInfo(user, 1, device as never, query),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(t.liveSessions.size()).toBe(0);
      t.cleanup();
    });

    it('answers 503 without opening anything when the engine does not run playback', async () => {
      const t = setup({ engine: { runtime: false } });
      await expect(
        t.svc.playbackInfo(user, 1, device as never, query),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(t.engine.openSession).not.toHaveBeenCalled();
      expect(t.deps.streamingService.resolveFile).not.toHaveBeenCalled();
      t.cleanup();
    });
  });
});
