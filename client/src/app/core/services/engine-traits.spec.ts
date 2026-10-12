import { TvPlatform } from './device.service';
import { ENGINE_TRAITS, EngineKind, EngineTraits, engineKindFor } from './engine-traits';

/** The seven engine traits transcribed from the audited schema. `undefined`
 *  (an omitted key) is asserted via `toEqual`, so a stray `false` would fail. */
const EXPECTED: Record<EngineKind, EngineTraits> = {
  [EngineKind.WEB]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: true,
    supportsImageSubtitles: false,
    sideloadsDirectPlaySubtitles: true,
    probesSegZero: true,
    supportsDirectPlay: true,
    supportsAbr: true,
  },
  [EngineKind.ANDROID]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: true,
    supportsImageSubtitles: true,
    sideloadsDirectPlaySubtitles: true,
    probesSegZero: false,
    supportsDirectPlay: true,
    supportsAbr: true,
  },
  [EngineKind.IOS]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: true,
    supportsMuxedAudioRendition: true,
    supportsImageSubtitles: false,
    sideloadsDirectPlaySubtitles: false,
    probesSegZero: false,
    supportsDirectPlay: true,
    supportsAbr: true,
  },
  [EngineKind.DESKTOP]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: false,
    supportsImageSubtitles: true,
    sideloadsDirectPlaySubtitles: true,
    probesSegZero: true,
    supportsDirectPlay: true,
    supportsAbr: false,
  },
  [EngineKind.ANDROID_TV]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: true,
    supportsImageSubtitles: true,
    sideloadsDirectPlaySubtitles: true,
    probesSegZero: false,
    supportsDirectPlay: true,
    supportsAbr: true,
  },
  [EngineKind.TIZEN]: {
    useTsOnSingleAudio: true,
    supportsHlsSubtitles: false,
    supportsIFrameTrickPlay: true,
    supportsImageSubtitles: false,
    sideloadsDirectPlaySubtitles: true,
    probesSegZero: false,
    supportsDirectPlay: true,
    supportsAbr: true,
  },
  [EngineKind.WEBOS]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: false,
    dedupesAudioByLanguage: true,
    supportsImageSubtitles: false,
    sideloadsDirectPlaySubtitles: true,
    probesSegZero: false,
    supportsDirectPlay: true,
    supportsAbr: true,
  },
  [EngineKind.CAST]: {
    probesSegZero: true,
    supportsAbr: true,
  },
};

describe('engineKindFor', () => {
  it('maps null + isNative=false to WEB', () => {
    expect(engineKindFor(null, false)).toBe(EngineKind.WEB);
  });

  it('maps null + isNative=true to ANDROID', () => {
    expect(engineKindFor(null, true)).toBe(EngineKind.ANDROID);
  });

  it('maps null + isNative=true + isIos to IOS', () => {
    expect(engineKindFor(null, true, false, true)).toBe(EngineKind.IOS);
  });

  it('keeps the TV platforms ahead of the iOS split', () => {
    expect(engineKindFor('tizen', true, false, true)).toBe(EngineKind.TIZEN);
  });

  it('maps androidtv to ANDROID_TV', () => {
    expect(engineKindFor('androidtv', true)).toBe(EngineKind.ANDROID_TV);
  });

  it('maps tizen to TIZEN', () => {
    expect(engineKindFor('tizen', true)).toBe(EngineKind.TIZEN);
  });

  it('maps webos to WEBOS', () => {
    expect(engineKindFor('webos', true)).toBe(EngineKind.WEBOS);
  });

  it('maps isDesktop=true to DESKTOP, ahead of the native split', () => {
    // Electron is also isNative (its UA matches), so isDesktop must win.
    expect(engineKindFor(null, true, true)).toBe(EngineKind.DESKTOP);
  });
});

describe('ENGINE_TRAITS', () => {
  for (const kind of Object.values(EngineKind)) {
    it(`row for ${kind} deep-equals the audited expectation`, () => {
      expect(ENGINE_TRAITS[kind]).toEqual(EXPECTED[kind]);
    });
  }

  it('only iOS lacks bitmap rendering and DirectPlay sideloading among the mobile engines', () => {
    expect(ENGINE_TRAITS[EngineKind.IOS].supportsImageSubtitles).toBe(false);
    expect(ENGINE_TRAITS[EngineKind.IOS].sideloadsDirectPlaySubtitles).toBe(false);
    expect(ENGINE_TRAITS[EngineKind.ANDROID].supportsImageSubtitles).toBe(true);
    expect(ENGINE_TRAITS[EngineKind.ANDROID].sideloadsDirectPlaySubtitles).toBe(true);
  });

  it('only iOS opts in to the URI-less muxed audio rendition', () => {
    for (const kind of Object.values(EngineKind)) {
      expect(ENGINE_TRAITS[kind].supportsMuxedAudioRendition).toBe(
        kind === EngineKind.IOS ? true : undefined,
      );
    }
  });

  it('CAST omits the three non-seg-zero traits (undefined on the wire)', () => {
    const cast = ENGINE_TRAITS[EngineKind.CAST];
    expect(cast.probesSegZero).toBe(true);
    expect(cast.useTsOnSingleAudio).toBeUndefined();
    expect(cast.supportsHlsSubtitles).toBeUndefined();
    expect(cast.supportsDirectPlay).toBeUndefined();
    expect(cast.sideloadsDirectPlaySubtitles).toBeUndefined();
  });
});

/**
 * Behaviour-preserving oracle: recompute the four flags with the ORIGINAL
 * inline ternaries from `browser-device-profile.service.ts` and assert the
 * table reproduces them byte-for-byte for every REACHABLE (tvPlatform,
 * isNative) combination. If anyone touches a row, this fails.
 *
 * Reachable set (see device.service.ts + server-config.service.ts): a non-null
 * tvPlatform is only ever set by UA markers that also match the `isNative`
 * regex, so the three TV platforms are always isNative=true. A null tvPlatform
 * splits both ways (web vs Capacitor mobile).
 */
describe('ENGINE_TRAITS reproduces the original ternaries', () => {
  const reachable: { tvPlatform: TvPlatform; isNative: boolean }[] = [
    { tvPlatform: null, isNative: false },
    { tvPlatform: null, isNative: true },
    { tvPlatform: 'androidtv', isNative: true },
    { tvPlatform: 'tizen', isNative: true },
    { tvPlatform: 'webos', isNative: true },
  ];

  for (const { tvPlatform, isNative } of reachable) {
    it(`tvPlatform=${tvPlatform} isNative=${isNative}`, () => {
      const traits = ENGINE_TRAITS[engineKindFor(tvPlatform, isNative)];
      expect(traits.useTsOnSingleAudio).toBe(tvPlatform === 'tizen');
      expect(traits.supportsHlsSubtitles).toBe(
        tvPlatform !== 'tizen' && tvPlatform !== 'webos',
      );
      expect(traits.probesSegZero).toBe(!isNative);
      expect(traits.supportsDirectPlay).toBe(true);
    });
  }
});
