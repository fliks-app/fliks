import { buildPlayerStats, computeVideoCropStyle, deliveredKindFromVariant, type BuildPlayerStatsParams } from './player.utils';
import type { PlaybackInfoResponse } from '../services/api/streaming-api.service';

const translate = { instant: (k: string) => k } as BuildPlayerStatsParams['translate'];

function basePi(overrides: Partial<PlaybackInfoResponse> = {}): PlaybackInfoResponse {
  return {
    mediaFileId: 1,
    playMethod: 'DirectPlay',
    playUrl: '/api/stream/1?token=x',
    contentType: 'video/mp4',
    transcodeReasons: [],
    videoCopyStream: true,
    audioCopyStream: true,
    outputVideoCodec: 'h264',
    outputAudioCodec: 'aac',
    outputContainer: 'mp4',
    hwAccel: 'none',
    tonemapping: false,
    source: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac' },
    ...overrides,
  };
}

function baseParams(overrides: Partial<BuildPlayerStatsParams> = {}): BuildPlayerStatsParams {
  return {
    quality: 'auto',
    pi: basePi(),
    engineStats: undefined,
    hwAccel: 'none',
    isOfflinePlayback: false,
    lastStreamUrl: '/api/stream/1?token=x',
    activeVariantOriginalVideoId: null,
    availableQualities: [],
    resolutionLabel: () => '1080p',
    transcodeTierFromVariantHeight: () => null,
    translate,
    sourceVideoStream: undefined,
    cropAppliedByPlayer: false,
    isDesktopNative: false,
    pipOrFullscreenActive: false,
    activeAudioTrackId: null,
    availableAudioTracks: [],
    activeAudioStreamIndex: undefined,
    sourceAudioStreams: undefined,
    ...overrides,
  };
}

describe('buildPlayerStats', () => {
  it('a DirectPlay decision reads as direct playback with no transcode reasons', () => {
    const stats = buildPlayerStats(baseParams());
    expect(stats.streamTypeKey).toBe('player.stats_stream_type_direct');
    expect(stats.videoPlaybackMode).toBe('player.stats_direct_playback');
    expect(stats.audioPlaybackMode).toBe('player.stats_direct_playback');
    expect(stats.videoTranscodeReasons).toEqual([]);
    expect(stats.mismatch).toBeUndefined();
  });

  it('flags a mismatch when the delivered kind disagrees with the server decision', () => {
    // Decision says DirectStream (remux), but the URL actually delivered a
    // transcoded rung (e.g. a stale variant from before a pinned-quality switch).
    const stats = buildPlayerStats(baseParams({
      pi: basePi({ playMethod: 'DirectStream', playUrl: '/api/stream/1/master.m3u8?token=x&remux=1' }),
      lastStreamUrl: '/api/stream/1/master.m3u8?token=x&remux=1&startQuality=720p',
    }));
    expect(stats.mismatch).toBe('player.stats_delivery_mismatch');
  });

  it('a transcode delivery surfaces video/audio transcode reason labels', () => {
    const stats = buildPlayerStats(baseParams({
      pi: basePi({
        playMethod: 'Transcode',
        videoCopyStream: false,
        audioCopyStream: false,
        transcodeReasons: [
          { flag: 'VideoCodecUnsupported', message: 'x' },
          { flag: 'AudioChannelsUnsupported', message: 'x' },
        ],
      }),
      lastStreamUrl: '/api/stream/1/master.m3u8?token=x&startQuality=720p',
    }));
    // reasonLabel falls back to the raw flag when the translation is missing
    // (the fake translate echoes the key, so every flag "misses" here).
    expect(stats.videoTranscodeReasons).toEqual(['VideoCodecUnsupported']);
    expect(stats.audioTranscodeReasons).toEqual(['AudioChannelsUnsupported']);
  });

  it('hasAudio falls back to the source streamInfo when playback-info carries no audioTracks', () => {
    const noAudio = buildPlayerStats(baseParams({ sourceAudioStreams: [] }));
    expect(noAudio.hasAudio).toBe(false);

    const unknownAudio = buildPlayerStats(baseParams({ sourceAudioStreams: undefined }));
    expect(unknownAudio.hasAudio).toBe(true);
  });

  it('an undelivered (offline) negotiation reports no playback mode, only the container', () => {
    const stats = buildPlayerStats(baseParams({ isOfflinePlayback: true, lastStreamUrl: '' }));
    expect(stats.videoPlaybackMode).toBe('');
    expect(stats.audioPlaybackMode).toBe('');
    expect(stats.streamTypeKey).toBe('');
  });

  it('tags a Dolby Vision base layer with its profile/compat when the source is untagged HDR', () => {
    const stats = buildPlayerStats(baseParams({
      pi: basePi({ dolbyVision: true }),
      sourceVideoStream: { streamIndex: 0, codec: 'hevc', dvProfile: 8, dvBlSignalCompatId: 4 } as any,
    }));
    expect(stats.videoLabel).toContain('player.stats_dolby_vision_base');
  });

  it('crop is bypassed only when the player applied it and PiP/fullscreen is active', () => {
    const bypassed = buildPlayerStats(baseParams({
      pi: basePi({ source: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', crop: { width: 1920, height: 800, x: 0, y: 140 } } }),
      cropAppliedByPlayer: true,
      pipOrFullscreenActive: true,
    }));
    expect(bypassed.cropBypassed).toBe(true);

    const notBypassed = buildPlayerStats(baseParams({
      cropAppliedByPlayer: true,
      pipOrFullscreenActive: false,
    }));
    expect(notBypassed.cropBypassed).toBe(false);
  });
});

describe('deliveredKindFromVariant', () => {
  it('is direct for a non-HLS raw stream URL', () => {
    expect(deliveredKindFromVariant('/api/stream/123?token=x&sid=y')).toBe('direct');
  });

  it('is remux for a Shaka active variant whose id carries /remux/', () => {
    expect(
      deliveredKindFromVariant(
        '/api/stream/123/master.m3u8?token=x&remux=1',
        '/api/stream/123/remux/index.m3u8?token=x',
      ),
    ).toBe('remux');
  });

  it('is transcode for a Shaka active variant on a rung, even alongside remux=1', () => {
    expect(
      deliveredKindFromVariant(
        '/api/stream/123/master.m3u8?token=x&remux=1&startQuality=original',
        '/api/stream/123/1080p/index.m3u8?token=x',
      ),
    ).toBe('transcode');
  });

  it('ignores a variant left over from the previous session while the next one loads', () => {
    expect(
      deliveredKindFromVariant(
        '/api/stream/123/master.m3u8?token=x&sid=new&startQuality=480p',
        '/api/stream/123/remux/index.m3u8?token=x&sid=old',
      ),
    ).toBe('transcode');
  });

  it('falls back to the query string when no variant id is available (native/Tizen/webOS/desktop)', () => {
    expect(
      deliveredKindFromVariant('/api/stream/123/master.m3u8?token=x&remux=1'),
    ).toBe('remux');
  });

  it('treats remux=1 + startQuality as a collapsed transcode rung (the trap)', () => {
    expect(
      deliveredKindFromVariant(
        '/api/stream/123/master.m3u8?token=x&remux=1&startQuality=original',
      ),
    ).toBe('transcode');
  });

  it('is transcode for a plain ladder URL with no remux flag', () => {
    expect(
      deliveredKindFromVariant('/api/stream/123/master.m3u8?token=x&startQuality=720p'),
    ).toBe('transcode');
  });
});

describe('computeVideoCropStyle', () => {
  it('contain: crop AR matches container AR, no pillarbox around the crop', () => {
    const style = computeVideoCropStyle({
      sourceWidth: 1920,
      sourceHeight: 1080,
      crop: { width: 1920, height: 800, x: 0, y: 140 },
      containerWidth: 2400,
      containerHeight: 1000,
      fit: 'contain',
    });
    expect(style).toEqual({ width: 2400, height: 1350, translateX: 0, translateY: -175 });
  });

  it('contain: crop narrower than the container AR, pillarboxed like a true server crop would be', () => {
    // Margin shows the source's own bars, not the container bg, same
    // pixels either way, since a detected crop's surround is black.
    const style = computeVideoCropStyle({
      sourceWidth: 1000,
      sourceHeight: 1000,
      crop: { width: 600, height: 1000, x: 200, y: 0 },
      containerWidth: 800,
      containerHeight: 400,
      fit: 'contain',
    });
    expect(style).toEqual({ width: 400, height: 400, translateX: 200, translateY: 0 });
  });

  it('cover: fills the container and clips the crop rectangle symmetrically', () => {
    const style = computeVideoCropStyle({
      sourceWidth: 3840,
      sourceHeight: 2160,
      crop: { width: 3840, height: 1620, x: 0, y: 270 },
      containerWidth: 1920,
      containerHeight: 1080,
      fit: 'cover',
    });
    expect(style).toEqual({ width: 2560, height: 1440, translateX: -320, translateY: -180 });
  });

  it('is null when the crop covers the whole frame (nothing to remove)', () => {
    const style = computeVideoCropStyle({
      sourceWidth: 1920,
      sourceHeight: 1080,
      crop: { width: 1920, height: 1080, x: 0, y: 0 },
      containerWidth: 1920,
      containerHeight: 1080,
      fit: 'contain',
    });
    expect(style).toBeNull();
  });

  it('is null for a zero-sized container (not yet laid out)', () => {
    const style = computeVideoCropStyle({
      sourceWidth: 3840,
      sourceHeight: 2160,
      crop: { width: 3840, height: 1648, x: 0, y: 256 },
      containerWidth: 0,
      containerHeight: 0,
      fit: 'contain',
    });
    expect(style).toBeNull();
  });

  it('is null for a degenerate (zero-sized) crop rectangle', () => {
    const style = computeVideoCropStyle({
      sourceWidth: 1920,
      sourceHeight: 1080,
      crop: { width: 0, height: 0, x: 0, y: 0 },
      containerWidth: 1920,
      containerHeight: 1080,
      fit: 'contain',
    });
    expect(style).toBeNull();
  });

  it('anamorphic: rescales a coded-grid crop onto the decoded display grid (1440x1080 -> 1920x1080)', () => {
    const style = computeVideoCropStyle({
      sourceWidth: 1440,
      sourceHeight: 1080,
      displayWidth: 1920,
      displayHeight: 1080,
      crop: { width: 1440, height: 900, x: 0, y: 90 },
      containerWidth: 1920,
      containerHeight: 1000,
      fit: 'contain',
    });
    expect(style).toEqual({ width: 1920, height: 1080, translateX: 0, translateY: -40 });
  });

  it('anamorphic: a PAL DVD (720x576 coded, 4:3 display 768x576) crops the coded bars correctly', () => {
    const style = computeVideoCropStyle({
      sourceWidth: 720,
      sourceHeight: 576,
      displayWidth: 768,
      displayHeight: 576,
      crop: { width: 720, height: 480, x: 0, y: 48 },
      containerWidth: 768,
      containerHeight: 480,
      fit: 'contain',
    });
    expect(style).toEqual({ width: 768, height: 576, translateX: 0, translateY: -48 });
  });
});
