/**
 * Tests for the per-(user, file) keying contract on ActiveStreamTracker.
 * Asserts the isolation flagged in #291: two users on the same media
 * file must never clobber each other's audio plan, mux flavour, audio
 * track pick, etc. Source-dimension caches stay file-scoped because
 * they describe the file itself, identical across users.
 */
import { ActiveStreamTracker } from './active-stream-tracker.service';

describe('ActiveStreamTracker — per-(user, file) keying', () => {
  let tracker: ActiveStreamTracker;
  const FILE_ID = 7;
  const ALICE = 1;
  const BOB = 2;

  beforeEach(() => {
    tracker = new ActiveStreamTracker();
    tracker.onModuleInit();
  });

  afterEach(() => {
    tracker.onModuleDestroy();
  });

  it('useTs is isolated per user (Tizen vs browser on the same file)', () => {
    tracker.setUseTs(ALICE, FILE_ID, true);
    tracker.setUseTs(BOB, FILE_ID, false);
    expect(tracker.getUseTs(ALICE, FILE_ID)).toBe(true);
    expect(tracker.getUseTs(BOB, FILE_ID)).toBe(false);
  });

  it('audioPlan is isolated per user (different bitrates / codecs)', () => {
    tracker.setAudioPlan(ALICE, FILE_ID, {
      mode: 'transcode',
      codec: 'aac',
      bitrateBps: 128_000,
    });
    tracker.setAudioPlan(BOB, FILE_ID, { mode: 'copy', codec: 'eac3' });
    expect(tracker.getAudioPlan(ALICE, FILE_ID)).toEqual({
      mode: 'transcode',
      codec: 'aac',
      bitrateBps: 128_000,
    });
    expect(tracker.getAudioPlan(BOB, FILE_ID)).toEqual({
      mode: 'copy',
      codec: 'eac3',
    });
  });

  it('audioStreamCount is isolated per user (device-driven cap)', () => {
    tracker.setAudioStreamCount(ALICE, FILE_ID, 3);
    tracker.setAudioStreamCount(BOB, FILE_ID, 1);
    expect(tracker.getAudioStreamCount(ALICE, FILE_ID)).toBe(3);
    expect(tracker.getAudioStreamCount(BOB, FILE_ID)).toBe(1);
  });

  it('deviceType and hdrLadder are isolated per user', () => {
    tracker.setDeviceType(ALICE, FILE_ID, 'mobile');
    tracker.setDeviceType(BOB, FILE_ID, 'desktop');
    tracker.setHdrLadder(ALICE, FILE_ID, true);
    tracker.setHdrLadder(BOB, FILE_ID, false);
    expect(tracker.getDeviceType(ALICE, FILE_ID)).toBe('mobile');
    expect(tracker.getDeviceType(BOB, FILE_ID)).toBe('desktop');
    expect(tracker.getHdrLadder(ALICE, FILE_ID)).toBe(true);
    expect(tracker.getHdrLadder(BOB, FILE_ID)).toBe(false);
  });

  it('useExtXMedia and canCopy{Video,Audio} are isolated per user', () => {
    tracker.setUseExtXMedia(ALICE, FILE_ID, true);
    tracker.setUseExtXMedia(BOB, FILE_ID, false);
    tracker.setCanCopyVideo(ALICE, FILE_ID, true);
    tracker.setCanCopyVideo(BOB, FILE_ID, false);
    tracker.setCanCopyAudio(ALICE, FILE_ID, true);
    tracker.setCanCopyAudio(BOB, FILE_ID, false);

    expect(tracker.getUseExtXMedia(ALICE, FILE_ID)).toBe(true);
    expect(tracker.getUseExtXMedia(BOB, FILE_ID)).toBe(false);
    expect(tracker.getCanCopyVideo(ALICE, FILE_ID)).toBe(true);
    expect(tracker.getCanCopyVideo(BOB, FILE_ID)).toBe(false);
    expect(tracker.getCanCopyAudio(ALICE, FILE_ID)).toBe(true);
    expect(tracker.getCanCopyAudio(BOB, FILE_ID)).toBe(false);
  });

  it('audioStreamIndex and burnIn are isolated per user', () => {
    tracker.setAudioStreamIndex(ALICE, FILE_ID, 0);
    tracker.setAudioStreamIndex(BOB, FILE_ID, 2);
    tracker.setBurnIn(ALICE, FILE_ID, {
      filter: "subtitles=':si=0'",
      streamIndex: 3,
      type: 'pgs',
    });
    tracker.setBurnIn(BOB, FILE_ID, undefined);
    expect(tracker.getAudioStreamIndex(ALICE, FILE_ID)).toBe(0);
    expect(tracker.getAudioStreamIndex(BOB, FILE_ID)).toBe(2);
    expect(tracker.getBurnIn(ALICE, FILE_ID)?.streamIndex).toBe(3);
    expect(tracker.getBurnIn(BOB, FILE_ID)).toBeUndefined();
  });

  it('transcodeReasons, tonemapping, encoderPreset, videoVariant are isolated per user', () => {
    tracker.setTranscodeReasons(ALICE, FILE_ID, [{ flag: 'codec', message: 'hevc' }]);
    tracker.setTranscodeReasons(BOB, FILE_ID, []);
    tracker.setTonemapping(ALICE, FILE_ID, true);
    tracker.setTonemapping(BOB, FILE_ID, false);
    tracker.setEncoderPreset(ALICE, FILE_ID, 'fast');
    tracker.setEncoderPreset(BOB, FILE_ID, 'medium');
    tracker.setVideoVariant(ALICE, FILE_ID, {
      codec: 'h264',
      profile: 'high',
      level: '40',
      hdr: null,
    });
    tracker.setVideoVariant(BOB, FILE_ID, null);

    expect(tracker.getTranscodeReasons(ALICE, FILE_ID)).toHaveLength(1);
    expect(tracker.getTranscodeReasons(BOB, FILE_ID)).toHaveLength(0);
    expect(tracker.getTonemapping(ALICE, FILE_ID)).toBe(true);
    expect(tracker.getTonemapping(BOB, FILE_ID)).toBe(false);
    expect(tracker.getEncoderPreset(ALICE, FILE_ID)).toBe('fast');
    expect(tracker.getEncoderPreset(BOB, FILE_ID)).toBe('medium');
    expect(tracker.getVideoVariant(ALICE, FILE_ID)?.codec).toBe('h264');
    expect(tracker.getVideoVariant(BOB, FILE_ID)).toBeUndefined();
  });

  it('source dimensions stay file-scoped (a file property identical across users)', () => {
    // Source W/H describe the underlying file; both users see the same
    // value regardless of which one set it last. Kept mediaFileId-keyed
    // by design.
    tracker.setSourceDimensions(FILE_ID, 1920, 1080);
    expect(tracker.getSourceWidth(FILE_ID)).toBe(1920);
    expect(tracker.getSourceHeight(FILE_ID)).toBe(1080);
  });

  it('unregister drops every per-(user, file) cache entry for that pair', () => {
    tracker.setUseTs(ALICE, FILE_ID, true);
    tracker.setAudioPlan(ALICE, FILE_ID, { mode: 'copy', codec: 'aac' });
    tracker.setDeviceType(ALICE, FILE_ID, 'mobile');
    // Bob shares the same file but unregister(Alice) must not touch him.
    tracker.setUseTs(BOB, FILE_ID, false);

    tracker.unregister(ALICE, FILE_ID);

    expect(tracker.getUseTs(ALICE, FILE_ID)).toBe(false); // default
    expect(tracker.getAudioPlan(ALICE, FILE_ID)).toBeNull();
    expect(tracker.getDeviceType(ALICE, FILE_ID)).toBe('desktop'); // default
    // Bob untouched.
    expect(tracker.getUseTs(BOB, FILE_ID)).toBe(false);
  });

  it('register tracks (user, file) so two users coexist on the same file', () => {
    tracker.register(ALICE, 'alice', FILE_ID, 'movie', 'movie', null);
    tracker.register(BOB, 'bob', FILE_ID, 'movie', 'movie', null);
    const active = tracker.getActive();
    expect(active).toHaveLength(2);
    expect(active.map((s) => s.userId).sort()).toEqual([ALICE, BOB]);
  });
});
