import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CastService } from './cast.service';
import { CastSettingsService } from './cast-settings.service';
import { ToastService } from './toast.service';

vi.mock('@capacitor/core', async () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
  registerPlugin: () => ({
    initialize: async () => ({ available: false }),
    getCastDevices: async () => ({ devices: [] }),
  }),
}));

const AUDIO = 'AUDIO';
const TEXT = 'TEXT';

class Stub {
  constructor(..._args: unknown[]) {}
}

/** The slice of the Cast web SDK the sender touches, with a media session that records its edits. */
function stubCastSdk(tracks: { trackId: number; type: string; name: string; language: string }[]) {
  const editTracksInfo = vi.fn();
  const mediaSession = { media: { tracks }, activeTrackIds: [] as number[], editTracksInfo };
  const session = { loadMedia: vi.fn(async (_req: unknown) => {}), getMediaSession: () => mediaSession };
  vi.stubGlobal('chrome', {
    cast: {
      Image: Stub,
      media: {
        MediaInfo: Stub,
        GenericMediaMetadata: Stub,
        Track: class { constructor(public trackId: number, public type: string) {} },
        TrackType: { TEXT, AUDIO },
        TextTrackType: { SUBTITLES: 'SUBTITLES' },
        StreamType: { BUFFERED: 'BUFFERED' },
        TextTrackStyle: Stub,
        TextTrackEdgeType: { NONE: 'NONE', DROP_SHADOW: 'DROP_SHADOW' },
        LoadRequest: class { constructor(public media: unknown) {} },
        EditTracksInfoRequest: class { constructor(public activeTrackIds: number[]) {} },
      },
    },
  });
  vi.stubGlobal('cast', {
    framework: { CastContext: { getInstance: () => ({ getCurrentSession: () => session }) } },
  });
  return { session, editTracksInfo };
}

const lastActive = (edit: ReturnType<typeof vi.fn>): number[] =>
  edit.mock.calls.at(-1)![0].activeTrackIds;

const TEXT_TRACKS = [{ trackId: 1, type: TEXT, name: 'French', language: 'fr' }];

function make(session: unknown) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
      { provide: ToastService, useValue: { error: vi.fn() } },
      {
        provide: CastSettingsService,
        useValue: {
          get: () => ({ subtitleStyle: { size: 'normal', color: 'white', background: 'transparent', shadow: 'drop' } }),
        },
      },
    ],
  });
  const svc = TestBed.inject(CastService);
  (svc as unknown as { session: unknown }).session = session;
  return svc;
}

const load = (activeSubtitleTrackId?: number) => ({
  url: 'u',
  contentType: 'application/x-mpegURL',
  title: 't',
  subtitles: [{ url: 's', language: 'fr', label: 'French' }],
  activeSubtitleTrackId,
});

describe('CastService text track picks', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it('keeps an Off tapped right after the LOAD from being undone by the re-apply', async () => {
    const { session, editTracksInfo } = stubCastSdk(TEXT_TRACKS);
    const svc = make(session);
    await svc.loadMedia(load(1));

    await svc.setActiveSubtitle(0);
    await vi.advanceTimersByTimeAsync(3000);

    expect(lastActive(editTracksInfo)).toEqual([]);
    expect(editTracksInfo).toHaveBeenCalledTimes(1);
  });

  it('re-applies the LOAD subtitle when nothing else was asked for', async () => {
    const { session, editTracksInfo } = stubCastSdk(TEXT_TRACKS);
    const svc = make(session);
    await svc.loadMedia(load(1));
    await vi.advanceTimersByTimeAsync(3000);
    expect(lastActive(editTracksInfo)).toEqual([1]);
  });

  it('applies a pick made during a LOAD to the media session that LOAD creates', async () => {
    const { session, editTracksInfo } = stubCastSdk(TEXT_TRACKS);
    let finish!: () => void;
    session.loadMedia.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    const svc = make(session);
    const loading = svc.loadMedia(load(1));

    const pick = svc.setActiveSubtitle(0);
    await Promise.resolve();
    expect(editTracksInfo).not.toHaveBeenCalled();

    finish();
    await loading;
    await pick;
    await vi.advanceTimersByTimeAsync(3000);
    expect(editTracksInfo).toHaveBeenCalledTimes(1);
    expect(lastActive(editTracksInfo)).toEqual([]);
  });

  it('lets the latest of two picks made during a LOAD win', async () => {
    const { session, editTracksInfo } = stubCastSdk([
      ...TEXT_TRACKS,
      { trackId: 2, type: TEXT, name: 'English', language: 'en' },
    ]);
    let finish!: () => void;
    session.loadMedia.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    const svc = make(session);
    const loading = svc.loadMedia(load());

    const first = svc.setActiveSubtitle(1);
    const second = svc.setActiveSubtitle(2);
    finish();
    await Promise.all([loading, first, second]);

    expect(editTracksInfo).toHaveBeenCalledTimes(1);
    expect(lastActive(editTracksInfo)).toEqual([2]);
  });
});

describe('CastService audio switch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  const TWINS = [
    { trackId: 5, type: AUDIO, name: 'en', language: 'en' },
    { trackId: 6, type: AUDIO, name: 'en #2', language: 'en' },
    { trackId: 7, type: AUDIO, name: 'VF', language: 'fr' },
  ];

  it('picks the second same-language track by its unique name', async () => {
    const { session, editTracksInfo } = stubCastSdk(TWINS);
    const svc = make(session);
    expect(await svc.setActiveAudioLanguage('en', 'en #2')).toBe(true);
    expect(lastActive(editTracksInfo)).toEqual([6]);
  });

  it('does not guess between tracks of one language when the name is unknown', async () => {
    const { session, editTracksInfo } = stubCastSdk(TWINS);
    const svc = make(session);
    expect(await svc.setActiveAudioLanguage('en', 'Nonexistent')).toBe(false);
    expect(editTracksInfo).not.toHaveBeenCalled();
  });

  it('falls back to an unambiguous language when the name does not match', async () => {
    const { session, editTracksInfo } = stubCastSdk(TWINS);
    const svc = make(session);
    expect(await svc.setActiveAudioLanguage('fr', 'Nonexistent')).toBe(true);
    expect(lastActive(editTracksInfo)).toEqual([7]);
  });
});

describe('CastService LOAD failure', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it('rejects when the receiver refuses the LOAD and clears the pending load', async () => {
    const { session } = stubCastSdk(TEXT_TRACKS);
    session.loadMedia.mockRejectedValue(new Error('Invalid Request'));
    const svc = make(session);

    await expect(svc.loadMedia(load(1))).rejects.toThrow('Invalid Request');
    expect((svc as unknown as { pendingLoad: unknown }).pendingLoad).toBeNull();
    await expect(svc.setActiveSubtitle(0)).resolves.toBeUndefined();
  });

  it('rejects the native path too, without the success side effects', async () => {
    const svc = make(null);
    (svc as unknown as { hasCastBridge: boolean }).hasCastBridge = true;

    await expect(svc.loadMedia(load())).rejects.toBeDefined();
    expect(svc.mediaTitle()).toBe('');
  });

  it('rejects when there is no session', async () => {
    const svc = make(null);
    await expect(svc.loadMedia(load())).rejects.toThrow('No Cast session');
  });
});

describe('CastService receiver messages', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('stores a qoe sample and signals a recoverable player_error', () => {
    const svc = make(null);
    const handle = (m: unknown) =>
      (svc as unknown as { handleReceiverMessage(raw: string): void }).handleReceiverMessage(JSON.stringify(m));
    const errors: unknown[] = [];
    svc.playbackError$.subscribe((e) => errors.push(e));
    handle({ kind: 'qoe', at: 1, sample: { engine: 'cast', playbackId: 'p' } });
    expect(svc.receiverQoe()?.sample).toMatchObject({ engine: 'cast', playbackId: 'p' });
    handle({ kind: 'player_error', httpStatus: 410 });
    expect(errors).toEqual([{}]);
  });

  it('feeds castReceiverMessage window events through the namespace filter', async () => {
    const svc = make(null);
    vi.stubGlobal('chrome', { cast: {} });
    (svc as unknown as { hasCastBridge: boolean }).hasCastBridge = true;
    await (svc as unknown as { initNative(): Promise<void> }).initNative();
    const send = (namespace: string, sample: object) =>
      window.dispatchEvent(
        new CustomEvent('castReceiverMessage', {
          detail: { namespace, message: JSON.stringify({ kind: 'qoe', at: 1, sample }) },
        }),
      );
    send('urn:x-cast:other', { engine: 'x' });
    expect(svc.receiverQoe()).toBeNull();
    send('urn:x-cast:media.fliks.app', { engine: 'cast' });
    expect(svc.receiverQoe()?.sample).toMatchObject({ engine: 'cast' });
    window.dispatchEvent(new CustomEvent('castStateChanged', { detail: { connected: false } }));
    expect(svc.receiverQoe()).toBeNull();
  });
});
