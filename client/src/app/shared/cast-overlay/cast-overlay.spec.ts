import { Component, computed, input, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceService } from '../../core/services/device.service';
import { PlaybackSession } from '../../core/services/playback/playback-session';
import { RemotePlaybackTarget } from '../../core/services/remote-playback-target';
import { PlaybackDevice } from '../../core/services/playback-device.service';
import { SessionSyncService, type AccountSession } from '../../core/services/session-sync.service';
import { MusicApiService } from '../../core/services/api/music-api.service';
import { RemoteService } from '../../core/services/remote.service';
import { AudioPlayerService } from '../../core/services/audio-player/audio-player.service';
import { RemoteAudioOutput } from '../../core/services/audio-player/remote-audio-output';
import { deviceIdOf } from '../../core/services/remote-target-id';
import { SseService } from '../../core/services/sse.service';
import { DropdownMenuComponent } from '../components/dropdown-menu';
import { RemotePickerListComponent } from '../remote-picker/remote-picker-list';
import { CastOverlayComponent } from './cast-overlay';

@Component({ selector: 'app-dropdown-menu', template: '<ng-content select="[trigger]" />' })
class DropdownStub {
  readonly placement = input('');
  readonly heading = input('');
}

@Component({ selector: 'app-remote-picker-list', template: '' })
class PickerListStub {
  readonly transferOnly = input(false);
  readonly card = input(false);
}

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

function setup(over: { local?: boolean; tv?: boolean; fileId?: number; account?: AccountSession | null; canPlayHere?: boolean; live?: boolean; localTrack?: number } = {}) {
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
    playHere: vi.fn(),
    enabled: signal(true),
    localPlaying: signal(false),
    claimPending: signal(false),
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
    command: vi.fn(),
  };
  const audioView = { expand: vi.fn() };
  const audio = { active: signal(false), track: signal(over.localTrack ? { itemId: over.localTrack } : null) };
  TestBed.configureTestingModule({
    providers: [
      provideTranslateService(),
      provideZonelessChangeDetection(),
      { provide: PlaybackSession, useValue: session },
      { provide: SessionSyncService, useValue: sync },
      { provide: RemotePlaybackTarget, useValue: target },
      { provide: DeviceService, useValue: { isTv: () => !!over.tv } },
      { provide: AudioPlayerService, useValue: audio },
      { provide: RemoteAudioOutput, useValue: audioView },
      { provide: PlaybackDevice, useValue: { icon: signal('tv') } },
      { provide: SseService, useValue: { targetId: signal('phone#1') } },
      { provide: MusicApiService, useValue: { trackRequests: vi.fn(async () => []) } },
      { provide: RemoteService, useValue: { observedTargetId: signal('pc#1'), send: vi.fn() } },
    ],
  });
  TestBed.overrideComponent(CastOverlayComponent, {
    remove: { imports: [DropdownMenuComponent, RemotePickerListComponent] },
    add: { imports: [DropdownStub, PickerListStub] },
  });
  const fixture = TestBed.createComponent(CastOverlayComponent);
  fixture.detectChanges();
  return { el: fixture.nativeElement as HTMLElement, fixture, session, output, sync, target, audioView, audio };
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

    it('pauses the owner without selecting it, and offers to play here', () => {
      const { el, target, sync } = setup({ local: true, account: accountSession(), canPlayHere: true });
      const buttons = Array.from(el.querySelectorAll('button'));
      buttons[0].click();
      buttons[1].click();
      expect(target.pause).toHaveBeenCalled();
      expect(sync.playHere).toHaveBeenCalled();
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
      expect(el.querySelector('progress')).not.toBeNull();
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

    it('shows a reader as read on its device with the percentage, opens here and has no transport', () => {
      const book = { ...accountSession().item, kind: 'book' as const, family: 'text' as const };
      const { el, sync } = setup({ local: true, canPlayHere: true, live: false, account: accountSession({ item: book, state: 'parked', playing: false, positionSeconds: 0.4, durationSeconds: 1 }) });
      expect(el.textContent).toContain('session.read_on');
      expect(el.textContent).toContain('40%');
      expect(el.textContent).toContain('session.open_here');
      expect(el.querySelector('[aria-label="session.transfer"]')).toBeNull();
      (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('session.open_here')) as HTMLButtonElement).click();
      expect(sync.playHere).toHaveBeenCalled();
    });

    it('hides the strip of a book read on this very device', () => {
      const book = { ...accountSession().item, kind: 'book' as const, family: 'text' as const };
      const { el } = setup({ local: true, account: accountSession({ item: book, state: 'parked', playing: false, owner: { targetId: 'phone#1', deviceName: 'Phone', formFactor: 'phone' } }) });
      expect(el.querySelector('button')).toBeNull();
    });

    it('hides the strip of a session parked by an earlier page load of this device while its player holds the track', () => {
      const track = { ...accountSession().item, kind: 'album' as const, family: 'audio' as const };
      const parked = accountSession({ item: track, state: 'parked', playing: false, owner: { targetId: 'phone#old', deviceName: null, formFactor: 'phone' } });
      expect(setup({ local: true, canPlayHere: true, live: false, account: parked, localTrack: 5 }).el.querySelector('button')).toBeNull();
    });

    it('words a session parked by this device as this device, and still offers to resume it', () => {
      const track = { ...accountSession().item, kind: 'album' as const, family: 'audio' as const };
      const parked = accountSession({ item: track, state: 'parked', playing: false, owner: { targetId: 'phone#old', deviceName: null, formFactor: 'phone' } });
      const { el } = setup({ local: true, canPlayHere: true, live: false, account: parked });
      expect(el.textContent).toContain('session.parked_here');
      expect(el.textContent).not.toContain('session.another_device');
      expect(el.textContent).toContain('session.resume');
    });

    it('hides a parked reader strip here without deleting the session', () => {
      const book = { ...accountSession().item, kind: 'book' as const, family: 'text' as const };
      const { el, fixture } = setup({ local: true, canPlayHere: true, live: false, account: accountSession({ item: book, state: 'parked', playing: false }) });
      Array.from(el.querySelectorAll('button')).at(-1)!.click();
      fixture.detectChanges();
      expect(el.querySelector('button')).toBeNull();
    });

    it('offers the device list to transfer the session to', () => {
      const { el } = setup({ local: true, account: accountSession() });
      expect(el.querySelector('[aria-label="session.transfer"]')).not.toBeNull();
    });

    it('is hidden on a TV, and for the owner', () => {
      expect(setup({ local: true, tv: true, account: accountSession() }).el.querySelector('button')).toBeNull();
      TestBed.resetTestingModule();
      expect(setup({ local: true }).el.querySelector('button')).toBeNull();
    });

    it('reads parked as offline with the stored position and hides it on this device only', () => {
      const parked = accountSession({ state: 'parked', playing: false, positionSeconds: 640 });
      const { el, fixture } = setup({ local: true, account: parked, live: false, canPlayHere: true });
      expect(el.textContent).toContain('session.parked_device');
      const buttons = Array.from(el.querySelectorAll('button'));
      expect(buttons).toHaveLength(3);
      buttons[2].click();
      fixture.detectChanges();
      expect(el.querySelector('button')).toBeNull();
    });

    it('hides a live session here until its owner changes', () => {
      const { el, fixture } = setup({ local: true, account: accountSession() });
      Array.from(el.querySelectorAll('button')).at(-1)!.click();
      fixture.detectChanges();
      expect(el.querySelector('button')).toBeNull();
    });

    it('shows a new session of the same owner again, even at the same epoch', () => {
      const { el, fixture, sync } = setup({ local: true, account: accountSession() });
      Array.from(el.querySelectorAll('button')).at(-1)!.click();
      fixture.detectChanges();
      expect(el.querySelector('button')).toBeNull();
      sync.session.set(null);
      fixture.detectChanges();
      sync.session.set(accountSession());
      fixture.detectChanges();
      expect(el.textContent).toContain('Observed title');
    });

    it('keeps the stored position when the report names another file than the session', () => {
      const { el } = setup({ local: true, account: accountSession({ positionSeconds: 65 }), live: false });
      expect(el.textContent).toContain('1:05');
      expect(el.textContent).not.toContain('2:05');
    });

    it('never shows with the audio mini-player, which holds the same slot', () => {
      const { el, audio } = setup({ local: true, account: accountSession() });
      expect(el.querySelector('button')).not.toBeNull();
      audio.active.set(true);
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
