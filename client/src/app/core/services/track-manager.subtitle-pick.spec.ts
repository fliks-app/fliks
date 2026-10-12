import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { TrackManagerService, pickSubtitle } from './track-manager.service';
import type { SubtitleOption } from './track-manager.service';
import { PlayerSettingsService } from './player-settings.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { AppSettingsService } from './app-settings.service';
import { TranslateService } from '@ngx-translate/core';

function sub(id: string, language: string, extra: Partial<SubtitleOption> = {}): SubtitleOption {
  return { id, label: id, url: `/${id}`, language, burnIn: false, ...extra };
}

/** Auto-selection used to rank `!forced` first at every level, so a forced track
 *  was unreachable, and it never ordered on the hearing-impaired flag at all. */
describe('pickSubtitle', () => {
  const full = sub('full', 'fra');
  const forced = sub('forced', 'fra', { forced: true });
  const sdh = sub('sdh', 'fra', { hearingImpaired: true });
  const machine = sub('machine', 'fra', { providerType: 'translated' });

  it('reaches the forced track when that is what is wanted', () => {
    expect(pickSubtitle([full, forced], 'fra', { forced: true, hi: 'any' })?.id).toBe('forced');
    expect(pickSubtitle([forced, full], 'fra', { forced: false, hi: 'any' })?.id).toBe('full');
  });

  it('takes nothing but a forced track under `only`', () => {
    expect(pickSubtitle([full, sdh], 'fra', { forced: true, hi: 'any', only: true })).toBeUndefined();
    expect(pickSubtitle([full, forced], 'fra', { forced: true, hi: 'any', only: true })?.id).toBe('forced');
  });

  it('orders on the hearing-impaired preference', () => {
    expect(pickSubtitle([sdh, full], 'fra', { forced: false, hi: 'avoid' })?.id).toBe('full');
    expect(pickSubtitle([full, sdh], 'fra', { forced: false, hi: 'prefer' })?.id).toBe('sdh');
    expect(pickSubtitle([sdh, full], 'fra', { forced: false, hi: 'any' })?.id).toBe('sdh');
  });

  it('prefers, never filters: an avoided flag still beats no subtitles', () => {
    expect(pickSubtitle([sdh], 'fra', { forced: false, hi: 'avoid' })?.id).toBe('sdh');
    expect(pickSubtitle([forced], 'fra', { forced: false, hi: 'avoid' })?.id).toBe('forced');
  });

  it('keeps a real track ahead of a machine-made one, and the flags ahead of both', () => {
    expect(pickSubtitle([machine, full], 'fra', { forced: false, hi: 'any' })?.id).toBe('full');
    // The wanted flags outrank origin: an SDH-avoiding pick takes the machine
    // translation over an SDH track, since the flag penalty is the heavier one.
    expect(pickSubtitle([sdh, machine], 'fra', { forced: false, hi: 'avoid' })?.id).toBe('machine');
  });

  it('never crosses languages', () => {
    expect(pickSubtitle([sub('eng', 'eng')], 'fra', { forced: false, hi: 'any' })).toBeUndefined();
  });
});

describe('TrackManagerService.autoSelectSubtitle — mode routing', () => {
  afterEach(() => TestBed.resetTestingModule());

  const full = sub('full', 'fra');
  const forced = sub('forced', 'fra', { forced: true });

  /** Picks from `subs` under `settings`, with one audio track in `audioLang`, or, when `streamLang`
   *  is given, with no track listed yet and that language read from the stream that will play. */
  async function pick(
    settings: Partial<{ subtitleMode: string; preferredSubtitleLanguage: string; rememberSubtitleSelections: boolean }>,
    subs: SubtitleOption[],
    audioLang: string,
    streamLang?: string,
    remembered: string | null = null,
  ) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: PlayerSettingsService,
          useValue: {
            get: () => ({
              subtitleMode: 'intelligent',
              preferredSubtitleLanguage: 'fra',
              subtitleHearingImpaired: 'avoid',
              rememberSubtitleSelections: false,
              ...settings,
            }),
            getRememberedSubtitleTrack: () => remembered,
          },
        },
        { provide: SubtitlesApiService, useValue: {} },
        { provide: AppSettingsService, useValue: {} },
        { provide: TranslateService, useValue: { instant: (k: string) => k } },
      ],
    });
    const selected: (SubtitleOption | null)[] = [];
    await TestBed.inject(TrackManagerService).autoSelectSubtitle(
      subs,
      streamLang ? [] : [{ id: 'a1', language: audioLang }],
      streamLang ? null : 'a1',
      1,
      async (s) => void selected.push(s),
      1,
      streamLang,
    );
    return selected[0]?.id;
  }

  it('shows only the forced track when the audio is already understood', async () => {
    expect(await pick({}, [full, forced], 'fra')).toBe('forced');
    // No forced track to fall back on: a full one would translate dialogue the
    // viewer already follows.
    expect(await pick({}, [full], 'fra')).toBeUndefined();
  });

  it('shows a full track when the audio is foreign or untagged', async () => {
    expect(await pick({}, [forced, full], 'eng')).toBe('full');
    expect(await pick({}, [forced, full], 'und')).toBe('full');
  });

  it('reaches the forced track in onlyForced, whatever the audio', async () => {
    expect(await pick({ subtitleMode: 'onlyForced' }, [full, forced], 'eng')).toBe('forced');
    expect(await pick({ subtitleMode: 'onlyForced' }, [full], 'eng')).toBeUndefined();
  });

  it('falls back to the audio language when onlyForced has no preferred one', async () => {
    const engForced = sub('eng-forced', 'eng', { forced: true });
    const settings = { subtitleMode: 'onlyForced', preferredSubtitleLanguage: '' };
    expect(await pick(settings, [engForced], 'eng')).toBe('eng-forced');
    expect(await pick(settings, [engForced], 'und')).toBeUndefined();
  });

  it('reads the audio language from the stream that will play when no track is listed yet', async () => {
    const fr = sub('fr-full', 'fr');
    const frForced = sub('fr-forced', 'fr', { forced: true });
    const settings = { preferredSubtitleLanguage: 'fr' };
    // French audio in a French viewer's hands: only the forced track, not a full one.
    expect(await pick(settings, [fr, frForced], 'und', 'fra')).toBe('fr-forced');
    expect(await pick(settings, [fr], 'und', 'fra')).toBeUndefined();
    // Foreign audio: a full track.
    expect(await pick(settings, [fr, frForced], 'und', 'eng')).toBe('fr-full');
  });

  /** Remembered picks are keyed by the normalized language, as the track options carry it. */
  describe('with a remembered pick', () => {
    const settings = { rememberSubtitleSelections: true, subtitleMode: 'off' };
    const fullFr = sub('full', 'fr');
    const forcedFr = sub('forced', 'fr', { forced: true });

    it('never turns a remembered forced choice into a full track', async () => {
      expect(await pick(settings, [fullFr], 'eng', undefined, 'fr:forced')).toBeUndefined();
      expect(await pick(settings, [fullFr, forcedFr], 'eng', undefined, 'fr:forced')).toBe('forced');
    });

    it('never turns a remembered full choice into a forced track', async () => {
      expect(await pick(settings, [forcedFr], 'eng', undefined, 'fr')).toBeUndefined();
      expect(await pick(settings, [forcedFr, fullFr], 'eng', undefined, 'fr')).toBe('full');
    });
  });

  it('leaves `off` and `always` as they were', async () => {
    expect(await pick({ subtitleMode: 'off' }, [full], 'eng')).toBeUndefined();
    expect(await pick({ subtitleMode: 'always' }, [forced, full], 'fra')).toBe('full');
  });
});

describe('TrackManagerService.loadSubtitles: bitmap delivery', () => {
  afterEach(() => TestBed.resetTestingModule());

  const row = (id: number, codec: string, extra: Record<string, unknown> = {}) => ({
    id, mediaFileId: 1, language: 'eng', codec, ...extra,
  });

  async function load(rows: unknown[]) {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: PlayerSettingsService, useValue: {} },
        { provide: SubtitlesApiService, useValue: { getForMedia: async () => rows } },
        { provide: AppSettingsService, useValue: { hideBurnInSubtitles: () => false, showSubtitleFormat: () => false } },
        { provide: TranslateService, useValue: { instant: (k: string) => k, currentLang: () => 'en' } },
      ],
    });
    const streamingApi = {
      getSubtitleUrl: (_f: number, id: number) => `/ext/${id}`,
      getEmbeddedSubtitleUrl: (_f: number, i: number) => `/emb/${i}`,
    };
    return TestBed.inject(TrackManagerService).loadSubtitles(1, 1, streamingApi as never, null);
  }

  it('flags every bitmap subtitle, embedded or sidecar, as a burn-in candidate, and no text one', async () => {
    const options = await load([
      row(1, 'hdmv_pgs_subtitle', { streamIndex: 3 }),
      row(2, 'hdmv_pgs_subtitle', { relativePath: 'a.sup' }),
      row(3, 'dvd_subtitle', { relativePath: 'a.sub' }),
      row(4, 'subrip', { relativePath: 'a.srt' }),
      row(5, 'subrip', { streamIndex: 4 }),
    ]);

    expect(options.map((o) => [o.id, o.burnIn])).toEqual([
      ['emb-3', true],
      ['ext-2', true],
      ['ext-3', true],
      ['ext-4', false],
      ['emb-4', false],
    ]);
  });
});
