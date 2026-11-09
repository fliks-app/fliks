import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceService } from '../../core/services/device.service';
import { PlaybackSession } from '../../core/services/playback/playback-session';
import { RemotePlaybackTarget } from '../../core/services/remote-playback-target';
import { SessionSyncService, type AccountSession } from '../../core/services/session-sync.service';
import { CastOverlayComponent } from './cast-overlay';

function accountSession(over: Partial<AccountSession> = {}): AccountSession {
  return {
    epoch: 1,
    item: { id: 5, mediaFileId: 9, kind: 'movie', title: 'Observed title', subtitle: null, posterUrl: '/p.jpg' },
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

function setup(over: { local?: boolean; tv?: boolean; fileId?: number; account?: AccountSession | null; canPlayHere?: boolean; live?: boolean } = {}) {
  const sync = {
    session: signal(over.account ?? null),
    role: signal(over.account ? 'observer' : 'none'),
    parked: signal(over.account?.state === 'parked'),
    canPlayHere: signal(over.canPlayHere ?? false),
    playHere: vi.fn(),
    dismiss: vi.fn(),
  };
  const target = {
    isIdle: signal(!(over.live ?? true)),
    uiPaused: signal(false),
    position: signal(125),
    duration: signal(3600),
    togglePlayPause: vi.fn(),
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
  TestBed.configureTestingModule({
    providers: [
      provideTranslateService(),
      provideZonelessChangeDetection(),
      { provide: PlaybackSession, useValue: session },
      { provide: SessionSyncService, useValue: sync },
      { provide: RemotePlaybackTarget, useValue: target },
      { provide: DeviceService, useValue: { isTv: () => !!over.tv } },
    ],
  });
  const fixture = TestBed.createComponent(CastOverlayComponent);
  fixture.detectChanges();
  return { el: fixture.nativeElement as HTMLElement, fixture, session, output, sync, target };
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
      expect(target.togglePlayPause).toHaveBeenCalled();
      expect(sync.playHere).toHaveBeenCalled();
    });

    it('is hidden on a TV, and for the owner', () => {
      expect(setup({ local: true, tv: true, account: accountSession() }).el.querySelector('button')).toBeNull();
      TestBed.resetTestingModule();
      expect(setup({ local: true }).el.querySelector('button')).toBeNull();
    });

    it('reads parked as offline with the stored position and masks it through the server', () => {
      const parked = accountSession({ state: 'parked', playing: false, positionSeconds: 640 });
      const { el, sync } = setup({ local: true, account: parked, live: false, canPlayHere: true });
      expect(el.textContent).toContain('session.parked_device');
      const buttons = Array.from(el.querySelectorAll('button'));
      expect(buttons).toHaveLength(2);
      buttons[1].click();
      expect(sync.dismiss).toHaveBeenCalled();
    });

    it('hides a live session here until its owner changes', () => {
      const { el, fixture } = setup({ local: true, account: accountSession() });
      Array.from(el.querySelectorAll('button')).at(-1)!.click();
      fixture.detectChanges();
      expect(el.querySelector('button')).toBeNull();
    });

    it('leaves the output strip to a selected target', () => {
      const { el } = setup({ local: false, account: accountSession() });
      expect(el.textContent).toContain('Title');
      expect(el.textContent).not.toContain('Observed title');
    });
  });
});
