import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppSettingsService } from './app-settings.service';
import { AuthService } from './auth.service';
import { MediaService } from './api/media.service';
import { StreamingApiService } from './api/streaming-api.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { CastService } from './cast.service';
import { CastSettingsService } from './cast-settings.service';
import { buildCastAudioOptions, CastPlayerService } from './cast-player.service';
import { PlayerSettingsService } from './player-settings.service';
import { ServerConfigService } from './server-config.service';
import { ToastService } from './toast.service';
import { TrackManagerService, type SubtitleOption } from './track-manager.service';

const MEDIA_FILE_ID = 7;
const MEDIA_ID = 3;

const translate = {
  instant: (k: string) => k,
  currentLang: () => 'en',
  fallbackLang: () => 'en',
} as unknown as TranslateService;

const sub = (over: Partial<SubtitleOption> & { id: string }): SubtitleOption => ({
  label: over.id,
  url: '',
  language: 'en',
  burnIn: false,
  ...over,
});

const TEXT_FR = sub({ id: 'ext-11', language: 'fr', subtitleDbId: 11, forced: false });
const PGS_EN = sub({ id: 'emb-4', isImage: true, subtitleDbId: 12 });
const SUP_EN = sub({ id: 'ext-13', isImage: true, subtitleDbId: 13 });
const STREAMINFO_ONLY = sub({ id: 'emb-9', language: 'de' });

function setup(over: { autoSelect?: (subs: SubtitleOption[]) => SubtitleOption | null } = {}) {
  const cast = {
    isConnected: signal(true),
    resumedState: signal(null),
    playbackError$: new Subject<{ position?: number }>(),
    saveResumeState: vi.fn(),
    setActiveSubtitle: vi.fn(async () => {}),
    setActiveAudioLanguage: vi.fn(async () => false),
    setCastStreamBase: vi.fn(),
    loadMedia: vi.fn(async () => {}),
    currentTime: () => 0,
    duration: () => 0,
    isPaused: () => false,
    buffering: { set: vi.fn() },
  };
  const trackManager = {
    autoSelectSubtitle: vi.fn(async (...args: unknown[]) => {
      const subs = args[0] as SubtitleOption[];
      const onSelect = args[4] as (s: SubtitleOption | null) => Promise<unknown>;
      const picked = over.autoSelect?.(subs);
      if (picked) await onSelect(picked);
    }),
    saveSubtitleSelection: vi.fn(),
    saveAudioSelection: vi.fn(),
    describeSubtitle: vi.fn((t: { language: string; forced?: boolean }) => ({
      label: t.language, menuHead: t.language, menuSub: t.forced ? 'forced' : '',
    })),
  };
  const streamingApi = {
    getPlaybackInfo: vi.fn(async (..._args: unknown[]) => ({
      playMethod: 'Transcode',
      playUrl: '',
      sessionId: 'sid',
      qualities: [{ id: '1080p', label: '1080p', height: 1080 }],
    })),
    stopSession: vi.fn(async () => {}),
    buildAbsolutePlayUrl: vi.fn(() => ({ url: 'cast://x', contentType: 'application/x-mpegURL' })),
    getAbsoluteSubtitleUrl: vi.fn((mf: number, id: number) => `ext/${mf}/${id}`),
    getAbsoluteEmbeddedSubtitleUrl: vi.fn((mf: number, idx: number) => `emb/${mf}/${idx}`),
    getSubtitleUrl: vi.fn(() => ''),
    getEmbeddedSubtitleUrl: vi.fn(() => ''),
    getThumbnailMetadataUrl: vi.fn(() => ''),
    getThumbnailSpriteUrl: vi.fn(() => ''),
    getPlaybackState: vi.fn(async () => null),
    updatePlaybackState: vi.fn(async () => ({})),
  };
  const playerSettings = {
    get: () => ({ audioSelectionMode: 'default' }),
    resolveAudioStreamIndex: vi.fn((..._args: unknown[]): number | undefined => 1),
  };
  const subtitlesApi = { getForMedia: vi.fn(async () => [] as unknown[]) };

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: TranslateService, useValue: translate },
      { provide: CastService, useValue: cast },
      { provide: CastSettingsService, useValue: { get: () => ({ maxQuality: 'auto' }), getDeviceCapabilities: () => null } },
      { provide: StreamingApiService, useValue: streamingApi },
      { provide: SubtitlesApiService, useValue: subtitlesApi },
      { provide: AppSettingsService, useValue: { hideBurnInSubtitles: () => false, showSubtitleFormat: () => true } },
      { provide: AuthService, useValue: { getCastInfo: async () => ({ token: 't', streamBaseUrl: 'b' }), user: () => ({}) } },
      { provide: ServerConfigService, useValue: { resolveUrl: (u: string) => u } },
      { provide: PlayerSettingsService, useValue: playerSettings },
      { provide: TrackManagerService, useValue: trackManager },
      { provide: MediaService, useValue: { getOne: vi.fn(async () => null) } },
      { provide: ToastService, useValue: { error: vi.fn() } },
    ],
  });
  const svc = TestBed.inject(CastPlayerService);
  return { svc, cast, trackManager, streamingApi, subtitlesApi, playerSettings };
}

const base = {
  mediaFileId: MEDIA_FILE_ID,
  mediaId: MEDIA_ID,
  mediaTitle: 't',
  episodeTitle: '',
  fanartUrl: null,
  playbackMode: 'transcode' as const,
  qualities: [],
  audioTracks: [],
  activeQualityId: '1080p',
  activeAudioStreamIndex: 0,
};

const priv = (svc: CastPlayerService) =>
  svc as unknown as { activeBurnInId: number | null; reloadCastStream: () => Promise<void> };

describe('cast audio options', () => {
  it('gives same-named tracks the unique NAME the backend writes in master.m3u8', () => {
    const opts = buildCastAudioOptions(
      [{ language: 'en' }, { language: 'en' }, { language: 'fr', title: 'VF' }, { language: 'en' }],
      translate,
    );
    expect(opts.map((o) => o.name)).toEqual(['en', 'en #2', 'VF', 'en #3']);
  });
});

describe('cast session start', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('puts the active audio in the cast id space, whatever the sender called it', () => {
    const { svc } = setup();
    svc.startCast({ ...base, subtitles: [], activeSubtitleId: null, activeAudioStreamIndex: 2 });
    expect(svc.activeAudioTrackId()).toBe('audio-2');
    expect(svc.activeAudioStreamIndex()).toBe(2);
  });

  it('classifies bitmap subtitles for the receiver, embedded or sidecar', () => {
    const { svc } = setup();
    svc.startCast({ ...base, subtitles: [TEXT_FR, PGS_EN, SUP_EN], activeSubtitleId: null });
    const [text, pgs, sup] = svc.availableSubtitles();
    expect([text.burnIn, pgs.burnIn, sup.burnIn]).toEqual([false, true, true]);
    expect([pgs.castTrackId, sup.castTrackId]).toEqual([12, 13]);
  });

  it('burns in a bitmap pick the local device rendered itself', () => {
    const { svc } = setup();
    svc.startCast({ ...base, subtitles: [PGS_EN], activeSubtitleId: 'emb-4' });
    expect(priv(svc).activeBurnInId).toBe(12);
  });

  it('keeps the flags a later pick is remembered with', () => {
    const { svc } = setup();
    const forced = sub({ id: 'emb-2', forced: true, hearingImpaired: true });
    svc.startCast({ ...base, subtitles: [forced], activeSubtitleId: null });
    expect(svc.availableSubtitles()[0]).toMatchObject({ forced: true, hearingImpaired: true });
  });

  it('carries the two-line menu labels to the cast picker', () => {
    const { svc } = setup();
    svc.startCast({
      ...base,
      subtitles: [sub({ id: 'emb-2', menuHead: 'French', menuSub: 'SRT' })],
      activeSubtitleId: null,
    });
    expect(svc.availableSubtitles()[0]).toMatchObject({ head: 'French', sub: 'SRT' });
  });
});

describe('cast subtitle tracks sent with the LOAD', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('numbers exactly the tracks it sends, streamInfo-only ones included', async () => {
    const { svc, cast } = setup();
    svc.startCast({
      ...base,
      subtitles: [STREAMINFO_ONLY, PGS_EN, TEXT_FR],
      activeSubtitleId: 'ext-11',
    });
    await svc.reloadCastStream();
    const load = (cast.loadMedia.mock.calls as unknown as [Record<string, unknown>][])[0][0];
    expect((load['subtitles'] as { language: string }[]).map((s) => s.language)).toEqual(['de', 'fr']);
    expect(load['activeSubtitleTrackId']).toBe(2);
    expect(svc.availableSubtitles().map((s) => s.castTrackId)).toEqual([1, 12, 2]);
  });
});

describe('cast subtitle pick', () => {
  afterEach(() => TestBed.resetTestingModule());

  function startOnBurnIn() {
    const h = setup();
    h.svc.startCast({ ...base, subtitles: [PGS_EN, TEXT_FR], activeSubtitleId: 'emb-4' });
    const reload = vi.spyOn(priv(h.svc), 'reloadCastStream').mockResolvedValue();
    return { ...h, reload };
  }

  it('drops the burned-in bitmap when a text track is picked', async () => {
    const { svc, reload, cast } = startOnBurnIn();
    await svc.selectSubtitle('ext-11');
    expect(priv(svc).activeBurnInId).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(cast.setActiveSubtitle).not.toHaveBeenCalled();
    expect(svc.activeSubtitleId()).toBe('ext-11');
  });

  it('drops the burned-in bitmap on Off', async () => {
    const { svc, reload } = startOnBurnIn();
    await svc.selectSubtitle(null);
    expect(priv(svc).activeBurnInId).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(svc.activeSubtitleId()).toBeNull();
  });

  it('switches text tracks without a reload', async () => {
    const h = setup();
    h.svc.startCast({ ...base, subtitles: [TEXT_FR, STREAMINFO_ONLY], activeSubtitleId: 'ext-11' });
    const reload = vi.spyOn(priv(h.svc), 'reloadCastStream').mockResolvedValue();
    await h.svc.selectSubtitle('emb-9');
    expect(reload).not.toHaveBeenCalled();
    expect(h.cast.setActiveSubtitle).toHaveBeenCalledWith(2);
    await h.svc.selectSubtitle(null);
    expect(h.cast.setActiveSubtitle).toHaveBeenLastCalledWith(0);
  });

  it('refuses an id the receiver does not have', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { svc, reload } = startOnBurnIn();
    expect(await svc.selectSubtitle('emb-99')).toBe(false);
    expect(svc.activeSubtitleId()).toBe('emb-4');
    expect(reload).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('remembers the pick with its flags', async () => {
    const h = setup();
    const hi = sub({ id: 'emb-5', forced: true, hearingImpaired: true });
    h.svc.startCast({ ...base, subtitles: [hi, SUP_EN], activeSubtitleId: null });
    vi.spyOn(priv(h.svc), 'reloadCastStream').mockResolvedValue();
    await h.svc.selectSubtitle('emb-5');
    expect(h.trackManager.saveSubtitleSelection).toHaveBeenLastCalledWith(MEDIA_ID, 'en', true, true, false, true, undefined);
    await h.svc.selectSubtitle('ext-13');
    expect(h.trackManager.saveSubtitleSelection).toHaveBeenLastCalledWith(MEDIA_ID, 'en', undefined, false, true, undefined, undefined);
    await h.svc.selectSubtitle(null);
    expect(h.trackManager.saveSubtitleSelection).toHaveBeenLastCalledWith(MEDIA_ID, null, undefined, false, false, undefined, undefined);
  });

  it('remembers the variant of an embedded pick', async () => {
    const h = setup();
    h.svc.startCast({ ...base, subtitles: [sub({ id: 'emb-6', language: 'pt', languageTag: 'pt-PT' }), SUP_EN], activeSubtitleId: null });
    vi.spyOn(priv(h.svc), 'reloadCastStream').mockResolvedValue();
    await h.svc.selectSubtitle('emb-6');
    expect(h.trackManager.saveSubtitleSelection).toHaveBeenLastCalledWith(MEDIA_ID, 'pt', undefined, true, false, undefined, 'pt-PT');
  });
});

describe('cast picks handed back to a player that outlives the session', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('reports the picks for the file they were made on, even after the session cleared', async () => {
    const { svc } = setup();
    svc.startCast({ ...base, subtitles: [TEXT_FR], activeSubtitleId: 'ext-11', activeAudioStreamIndex: 1 });
    svc.clear();
    expect(svc.selectionFor(MEDIA_FILE_ID)).toEqual({ subtitleId: 'ext-11', audioStreamIndex: 1 });
    expect(svc.selectionFor(MEDIA_FILE_ID + 1)).toBeNull();
  });
});

describe('cast quick start', () => {
  afterEach(() => TestBed.resetTestingModule());

  const rows = (...ids: number[]) =>
    ids.map((id) => ({
      id,
      mediaFileId: MEDIA_FILE_ID,
      language: 'en',
      codec: 'hdmv_pgs_subtitle',
      relativePath: 'a.sup',
      streamIndex: null,
    }));

  it('starts on what the player rules pick, and burns in a bitmap sidecar', async () => {
    const h = setup({ autoSelect: (subs) => subs[0] });
    h.subtitlesApi.getForMedia.mockResolvedValue(rows(21));
    const startCast = vi.spyOn(h.svc, 'startCast');

    await h.svc.quickStart({
      mediaFileId: MEDIA_FILE_ID,
      mediaId: MEDIA_ID,
      title: 't',
      streamInfo: { audio: [{ language: 'en' }, { language: 'fr' }] },
      startTime: 0,
    });

    expect(h.trackManager.autoSelectSubtitle.mock.calls[0][6]).toBe('fr');
    expect(startCast.mock.calls[0][0]).toMatchObject({ activeSubtitleId: 'ext-21', activeAudioStreamIndex: 1 });
    expect(h.streamingApi.getPlaybackInfo.mock.calls[0][2]).toBe(21);
    expect(priv(h.svc).activeBurnInId).toBe(21);
  });

  describe('with the picks made on the detail page', () => {
    const start = (h: ReturnType<typeof setup>, tracks: { fileId: number; audioStreamIndex?: number; subtitleId?: string | null }) =>
      h.svc.quickStart({
        mediaFileId: MEDIA_FILE_ID,
        mediaId: MEDIA_ID,
        title: 't',
        streamInfo: { audio: [{ language: 'en' }, { language: 'fr' }] },
        startTime: 0,
        tracks,
      });

    it('hands them to the audio and subtitle resolvers, and starts on them', async () => {
      const h = setup({ autoSelect: (subs) => subs[0] });
      h.subtitlesApi.getForMedia.mockResolvedValue(rows(21));
      h.playerSettings.resolveAudioStreamIndex.mockImplementation((...a) => (a[4] as number | undefined) ?? 1);
      const startCast = vi.spyOn(h.svc, 'startCast');

      await start(h, { fileId: MEDIA_FILE_ID, audioStreamIndex: 0, subtitleId: null });

      expect(h.playerSettings.resolveAudioStreamIndex.mock.calls[0][4]).toBe(0);
      expect(h.trackManager.autoSelectSubtitle.mock.calls[0][7]).toBeNull();
      expect(startCast.mock.calls[0][0]).toMatchObject({ activeAudioStreamIndex: 0 });
      expect(h.trackManager.saveSubtitleSelection).not.toHaveBeenCalled();
      expect(h.trackManager.saveAudioSelection).not.toHaveBeenCalled();
    });

    it('ignores picks made on another file', async () => {
      const h = setup();
      await start(h, { fileId: MEDIA_FILE_ID + 1, audioStreamIndex: 0, subtitleId: 'ext-21' });
      expect(h.playerSettings.resolveAudioStreamIndex.mock.calls[0][4]).toBeUndefined();
      expect(h.trackManager.autoSelectSubtitle.mock.calls[0][7]).toBeUndefined();
    });
  });

  it('gives the quick-start subtitle rows the two-line menu labels', async () => {
    const h = setup();
    h.subtitlesApi.getForMedia.mockResolvedValue(rows(21));
    await h.svc.quickStart({
      mediaFileId: MEDIA_FILE_ID,
      mediaId: MEDIA_ID,
      title: 't',
      streamInfo: { audio: [{ language: 'en' }] },
      startTime: 0,
    });
    const [row] = h.svc.availableSubtitles();
    expect([row.head, row.sub]).toEqual([row.language, '']);
  });

  it('opens the overlay before the receiver answers the LOAD', async () => {
    const h = setup();
    h.subtitlesApi.getForMedia.mockResolvedValue(rows(21));
    let answer!: () => void;
    h.cast.loadMedia.mockImplementation(() => new Promise<void>((r) => (answer = r)));
    const started = h.svc.quickStart({
      mediaFileId: MEDIA_FILE_ID,
      mediaId: MEDIA_ID,
      title: 't',
      streamInfo: { audio: [{ language: 'en' }] },
      startTime: 0,
      expand: true,
    });
    await vi.waitFor(() => expect(h.cast.loadMedia).toHaveBeenCalled());

    expect(h.svc.expanded()).toBe(true);
    answer();
    await started;
  });

  it('starts without subtitles when the rules pick none', async () => {
    const h = setup();
    h.subtitlesApi.getForMedia.mockResolvedValue(rows(21));
    await h.svc.quickStart({
      mediaFileId: MEDIA_FILE_ID,
      mediaId: MEDIA_ID,
      title: 't',
      streamInfo: { audio: [{ language: 'en' }] },
      startTime: 0,
    });
    expect(h.svc.activeSubtitleId()).toBeNull();
    expect(h.streamingApi.getPlaybackInfo.mock.calls[0][2]).toBeUndefined();
  });
});
