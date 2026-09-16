import { describe, expect, it } from 'vitest';
import { EngineKind } from '../../../core/services/engine-traits';
import { liveNeedsTs, supportsLiveDirectPlay } from './live-direct-play.util';

describe('supportsLiveDirectPlay', () => {
  it('opens the raw upstream on every engine that demuxes an endless transport stream', () => {
    expect(supportsLiveDirectPlay(EngineKind.TIZEN, false)).toBe(true);
    expect(supportsLiveDirectPlay(EngineKind.DESKTOP, false)).toBe(true);
    expect(supportsLiveDirectPlay(EngineKind.NATIVE, false)).toBe(true);
  });

  it('refuses it in a browser and on iOS, which cannot open one', () => {
    expect(supportsLiveDirectPlay(EngineKind.WEB, false)).toBe(false);
    expect(supportsLiveDirectPlay(EngineKind.NATIVE, true)).toBe(false);
  });
});

describe('liveNeedsTs', () => {
  it('asks for MPEG-TS on Tizen, whose AVPlay stalls on a single-audio fMP4', () => {
    expect(liveNeedsTs(EngineKind.TIZEN)).toBe(true);
  });

  it('leaves every other engine on fMP4', () => {
    for (const kind of [EngineKind.WEB, EngineKind.NATIVE, EngineKind.DESKTOP, EngineKind.ANDROID_TV, EngineKind.WEBOS]) {
      expect(liveNeedsTs(kind)).toBe(false);
    }
  });
});
