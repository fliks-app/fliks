import { provideHttpClient } from '@angular/common/http';
import { computed, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceService } from '../../core/services/device.service';
import { NowPlayingMetadataService } from '../../core/services/playback/now-playing-metadata.service';
import { PlaybackSession } from '../../core/services/playback/playback-session';
import { RemotePlaybackTarget } from '../../core/services/remote-playback-target';
import { PlaybackDevice } from '../../core/services/playback-device.service';
import { SessionSyncService, type AccountSession } from '../../core/services/session-sync.service';
import { MusicApiService } from '../../core/services/api/music-api.service';
import { RemoteService } from '../../core/services/remote.service';
import { AudioPlayerService } from '../../core/services/audio-player/audio-player.service';
import { RemoteAudioOutput } from '../../core/services/audio-player/remote-audio-output';
import { deviceIdOf } from '../../core/services/remote-target-id';
import { ServerVersionService } from '../../core/services/server-version.service';
import { SseService } from '../../core/services/sse.service';
import { CastOverlayComponent } from './cast-overlay';

// jsdom has no ResizeObserver (the title marquee).
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  disconnect() {}
};

function accountSession(over: Partial<AccountSession> = {}): AccountSession {
  return {
    epoch: 1,
    item: { id: 5, mediaId: 3, episodeId: null, mediaFileId: 9, kind: 'movie', family: 'video', title: 'Observed title', subtitle: null, posterUrl: '/p.jpg' },
    owner: { targetId: 'pc#1', deviceName: 'Desk', formFactor: 'desktop' },
    state: 'playing',
    positionSeconds: 65,
    positionAt: '2026-01-01T00:00:00.000Z',
    playing: true,
    durationSeconds: 3600,
    queue: null,
    ...over,
  };
}

function setup(over: { local?: boolean; tv?: boolean; fileId?: number; account?: AccountSession | null; canPlayHere?: boolean; live?: boolean; localTrack?: number; trackMeta?: { title: string; artist: string } } = {}) {
  const account = signal(over.account ?? null);
  const parked = signal(over.account?.state === 'parked');
  const ownedHere = computed(() => {
    const t = account()?.owner.targetId;
    return !!t && deviceIdOf(t) === 'phone';
  });
  const sync = {
    session: account,
    ownedHere,
    parkedHere: computed(() => parked() && ownedHere()),
    role: signal(over.account ? 'observer' : 'none'),
    parked,
    ownerName: (a: AccountSession) => a.owner.deviceName ?? 'session.another_device',
    line: (a: AccountSession) =>
      ownedHere() && parked() ? 'session.parked_here' : `${a.item.family === 'text' ? 'session.read_on' : parked() ? 'session.parked_device' : 'session.playing_on'} ${a.owner.deviceName ?? ''}`,
    canPlayHere: signal(over.canPlayHere ?? false),
    isReading: (s: AccountSession) => s.item.family === 'text' || s.item.family === 'image',
    isAudio: SessionSyncService.prototype.isAudio,
    playHere: vi.fn(),
    enabled: signal(true),
    observedOwnerTargetId: () => (over.account?.state === 'parked' ? null : (over.account?.owner.targetId ?? null)),
    localPlaying: signal(false),
    claimPending: signal(false),
    holdsPlayer: signal(false),
    liveReport: computed(() => (over.live ?? true ? { mediaFileId: 9, durationSeconds: 3600 } : null)),
    positionNow: (a: AccountSession) => (over.live ?? true ? 125 : a.positionSeconds),
    durationNow: (a: AccountSession) => a.durationSeconds ?? 0,
  };
  const target = {
    isIdle: signal(!(over.live ?? true)),
    uiPaused: signal(false),
    position: signal(125),
    duration: signal(3600),
    play: vi.fn(),
    pause: vi.fn(),
  };
  const output = {
    isIdle: signal(false),
    targetOffline: signal(false),
    uiPaused: signal(false),
    disconnect: vi.fn(),
  };
  const session = {
    isLocal: signal(over.local ?? false),
    output: signal(output),
    deviceName: signal('Living room'),
    nowPlaying: signal<{ title: string; fanartUrl: string | null; posterUrl: string | null } | null>({ title: 'Title', fanartUrl: '/f.jpg', posterUrl: null }),
    playing: signal(over.fileId === 0 ? null : { fileId: 7, mediaId: 3 }),
    openPlayer: vi.fn(),
    viewObserved: vi.fn(),
    command: vi.fn(),
    partyActive: signal(false),
  };
  const audioView = { expand: vi.fn(), track: signal(null), position: () => sync.positionNow(account()!), duration: () => sync.durationNow(account()!), queue: signal([]), neighbour: () => null, next: vi.fn(), previous: vi.fn() };
  const audio = { active: signal(false), track: signal(over.localTrack ? { itemId: over.localTrack } : null) };
  TestBed.configureTestingModule({
    providers: [
      provideTranslateService(),
      provideZonelessChangeDetection(),
      provideHttpClient(),
      { provide: PlaybackSession, useValue: session },
      { provide: NowPlayingMetadataService, useValue: { track: () => signal(over.trackMeta ?? null) } },
      { provide: SessionSyncService, useValue: sync },
      { provide: RemotePlaybackTarget, useValue: target },
      { provide: DeviceService, useValue: { isTv: () => !!over.tv } },
      { provide: AudioPlayerService, useValue: audio },
      { provide: RemoteAudioOutput, useValue: audioView },
      { provide: PlaybackDevice, useValue: { icon: signal('tv') } },
      { provide: ServerVersionService, useValue: { supports: () => true, supportsWhenKnown: async () => true } },
      { provide: SseService, useValue: { targetId: signal('phone#1'), connectionId: signal(null) } },
      { provide: MusicApiService, useValue: { trackRequests: vi.fn(async () => []) } },
      { provide: RemoteService, useValue: { observedTargetId: signal('pc#1'), send: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(CastOverlayComponent);
  fixture.detectChanges();
  return { el: fixture.nativeElement as HTMLElement, strip: (fixture.nativeElement as HTMLElement).querySelector('.fixed'), fixture, session, output, sync, target, audioView, audio };
}

describe('CastOverlayComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows the device and title while playing elsewhere', () => {
    const { el } = setup();
    expect(el.textContent).toContain('Title');
    expect(el.textContent).toContain('Living room');
    expect(el.querySelector('img')).not.toBeNull();
  });

  it('is absent while playing locally and on a TV', () => {
    expect(setup({ local: true }).el.querySelector('button')).toBeNull();
    TestBed.resetTestingModule();
    expect(setup({ tv: true }).el.querySelector('button')).toBeNull();
  });

  it('opens the player on a tap, pauses and disconnects from its own buttons', () => {
    const { el, session, output } = setup();
    const [open, play, close] = Array.from(el.querySelectorAll('button'));
    open.click();
    play.click();
    close.click();
    expect(session.openPlayer).toHaveBeenCalled();
    expect(session.command).toHaveBeenCalledWith({ type: 'toggle' });
    expect(output.disconnect).toHaveBeenCalled();
  });

  it('is absent while the selected output is idle', () => {
    const { el, output, fixture } = setup();
    output.isIdle.set(true);
    fixture.detectChanges();
    expect(el.querySelector('.fixed')).toBeNull();
  });

  it('shows no poster from the account session when the output reports none', () => {
    const { el, session, fixture } = setup({ account: accountSession() });
    session.nowPlaying.set(null);
    fixture.detectChanges();
    expect(el.querySelector('img')).toBeNull();
  });

  it('cannot open the player while nothing plays', () => {
    const { el } = setup({ fileId: 0 });
    expect(el.querySelector('button')!.disabled).toBe(true);
  });

  describe('observing the account session', () => {
    it('shows the owner device, title and live position with no output selected', () => {
      const { el } = setup({ local: true, account: accountSession() });
      expect(el.textContent).toContain('Observed title');
      expect(el.textContent).toContain('Desk');
      expect(el.textContent).toContain('2:05');
    });

    it('pauses the owner without selecting it, next to the button that opens its player', () => {
      const { el, target } = setup({ local: true, account: accountSession(), canPlayHere: true });
      const buttons = Array.from(el.querySelectorAll('button'));
      expect(buttons).toHaveLength(2);
      buttons[1].click();
      expect(target.pause).toHaveBeenCalled();
    });

    it('shows an observed album session as track and artist, and as the track title while it loads', () => {
      const album = { ...accountSession().item, kind: 'album' as const, family: 'audio' as const, title: 'Album A', subtitle: 'Track A' };
      const loaded = setup({ local: true, account: accountSession({ item: album }), trackMeta: { title: 'Track A', artist: 'Artist A' } });
      expect(loaded.el.textContent).toContain('Track A · Artist A');
      TestBed.resetTestingModule();
      const loading = setup({ local: true, account: accountSession({ item: album }) });
      expect(loading.el.textContent).toContain('Track A');
      expect(loading.el.textContent).not.toContain('Album A');
    });

    it('plays a paused owner that has not reported since this device started following it', () => {
      const { el, target } = setup({ local: true, account: accountSession({ state: 'paused', playing: false }), live: false });
      el.querySelector<HTMLButtonElement>('[aria-label="player.play"]')!.click();
      expect(target.play).toHaveBeenCalled();
    });

    it('keeps pause and a progress bar for a playing session whose owner has not reported yet', () => {
      const { el, sync } = setup({ local: true, account: accountSession(), live: false });
      sync.session.set(accountSession({ positionSeconds: 1800 }));
      expect(el.querySelector('[aria-label="player.pause"]')).not.toBeNull();
      expect(el.querySelector('[data-testid="observed-progress"]')).not.toBeNull();
    });

    it('opens the full audio player on the session from the strip of an audio session only', () => {
      const audio = setup({ local: true, account: accountSession({ item: { ...accountSession().item, kind: 'album', family: 'audio' } }) });
      audio.el.querySelector('button')!.click();
      expect(audio.audioView.expand).toHaveBeenCalled();
      TestBed.resetTestingModule();
      const video = setup({ local: true, account: accountSession() });
      video.el.querySelector('button')!.click();
      expect(video.audioView.expand).not.toHaveBeenCalled();
    });

    it('shows no strip for a reader, read here or elsewhere', () => {
      const book = { ...accountSession().item, kind: 'book' as const, family: 'text' as const };
      const { strip } = setup({ local: true, account: accountSession({ item: book, state: 'parked', playing: false, owner: { targetId: 'phone#1', deviceName: 'Phone', formFactor: 'phone' } }) });
      expect(strip).toBeNull();
      TestBed.resetTestingModule();
      expect(setup({ local: true, account: accountSession({ item: book }) }).strip).toBeNull();
    });

    it('opens nothing from the strip of a video session without a file', () => {
      const bare = setup({ local: true, account: accountSession({ item: { ...accountSession().item, mediaFileId: null } }) });
      bare.el.querySelector<HTMLButtonElement>('button.text-left')!.click();
      expect(bare.session.viewObserved).not.toHaveBeenCalled();
    });

    it('opens the video player on the observed session from the strip, selecting no device', () => {
      const { el, session } = setup({ local: true, account: accountSession() });
      el.querySelector('button')!.click();
      expect(session.viewObserved).toHaveBeenCalledWith({ fileId: 9, mediaId: 3, episodeId: undefined });
    });

    it('hides the strip of a session parked by an earlier page load of this device while its player holds the track', () => {
      const track = { ...accountSession().item, kind: 'album' as const, family: 'audio' as const };
      const parked = accountSession({ item: track, state: 'parked', playing: false, owner: { targetId: 'phone#old', deviceName: null, formFactor: 'phone' } });
      expect(setup({ local: true, canPlayHere: true, live: false, account: parked, localTrack: 5 }).strip).toBeNull();
    });

    it('shows no strip for a parked session: music is left to the mini-player', () => {
      const track = { ...accountSession().item, kind: 'album' as const, family: 'audio' as const };
      const parked = accountSession({ item: track, state: 'parked', playing: false, owner: { targetId: 'phone#old', deviceName: null, formFactor: 'phone' } });
      expect(setup({ local: true, canPlayHere: true, live: false, account: parked }).strip).toBeNull();
      TestBed.resetTestingModule();
      expect(setup({ local: true, live: false, account: accountSession({ state: 'parked', playing: false }) }).strip).toBeNull();
    });

    it('is hidden on a TV, and for the owner', () => {
      expect(setup({ local: true, tv: true, account: accountSession() }).el.querySelector('button')).toBeNull();
      TestBed.resetTestingModule();
      expect(setup({ local: true }).el.querySelector('button')).toBeNull();
    });

    it('keeps the stored position when the report names another file than the session', () => {
      const { el } = setup({ local: true, account: accountSession({ positionSeconds: 65 }), live: false });
      expect(el.textContent).toContain('1:05');
      expect(el.textContent).not.toContain('2:05');
    });

    it('replaces a paused local track while another device plays', () => {
      const live = setup({ local: true, account: accountSession() });
      live.audio.active.set(true);
      TestBed.tick();
      expect(live.el.querySelector('button')).not.toBeNull();
    });

    it('stays away from a party', () => {
      const { el, session } = setup({ local: true, account: accountSession() });
      session.partyActive.set(true);
      TestBed.tick();
      expect(el.querySelector('button')).toBeNull();
    });

    it('leaves the output strip to a selected target', () => {
      const { el } = setup({ local: false, account: accountSession() });
      expect(el.textContent).toContain('Title');
      expect(el.textContent).not.toContain('Observed title');
    });
  });
});
