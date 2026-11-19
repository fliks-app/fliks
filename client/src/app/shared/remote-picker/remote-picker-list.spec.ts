import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AirPlayService } from '../../core/services/airplay.service';
import { CastPlaybackTarget } from '../../core/services/cast-playback-target';
import { CastService } from '../../core/services/cast.service';
import { DeviceService } from '../../core/services/device.service';
import { PlaybackDevice } from '../../core/services/playback-device.service';
import { NowPlayingMetadataService } from '../../core/services/playback/now-playing-metadata.service';
import { PlaybackSession } from '../../core/services/playback/playback-session';
import { RemoteService } from '../../core/services/remote.service';
import { SessionSyncService } from '../../core/services/session-sync.service';
import { ToastService } from '../../core/services/toast.service';
import { PlaybackSurface } from '../../core/services/playback/playback-surface';
import { RemotePickerListComponent } from './remote-picker-list';

function setup(
  over: { name?: string | null; card?: boolean; transferOnly?: boolean; sync?: object; remote?: object; session?: object } = {},
) {
  const playing = {
    name: signal(over.name === undefined ? 'Living room' : over.name),
    icon: signal('tv'),
  };
  TestBed.configureTestingModule({
    providers: [
      provideTranslateService(),
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: PlaybackDevice, useValue: playing },
      { provide: RemoteService, useValue: { targets: signal([]), selectedTargetId: signal(null), observedTargetId: signal(null), observedTarget: signal(null), refreshTargets: vi.fn(), canLoad: vi.fn(() => true), watchable: () => false, ...over.remote } },
      { provide: CastService, useValue: { enumerates: false, isAvailable: signal(false), isConnected: signal(false), castDevices: signal([]), getCastDevices: vi.fn() } },
      { provide: AirPlayService, useValue: { available: signal(false) } },
      { provide: CastPlaybackTarget, useValue: {} },
      { provide: PlaybackSession, useValue: { isLocal: signal(false), kind: () => 'remote', observing: () => false, nowPlaying: signal({ title: 'Film' }), transfersTo: () => false, moveTo: vi.fn(), openPlayer: vi.fn(), ...over.session } },
      { provide: SessionSyncService, useValue: { session: signal(null), role: signal('none'), canPlayHere: signal(false), observedOwnerTargetId: () => null, ...over.sync } },
      { provide: DeviceService, useValue: { isTouch: () => false } },
      { provide: PlaybackSurface, useValue: { here: signal(false), open: vi.fn(), canOpen: () => true } },
      { provide: ToastService, useValue: {} },
      { provide: NowPlayingMetadataService, useValue: { track: () => signal(null) } },
    ],
  });
  const fixture = TestBed.createComponent(RemotePickerListComponent);
  fixture.componentRef.setInput('card', over.card ?? true);
  fixture.componentRef.setInput('transferOnly', over.transferOnly ?? false);
  fixture.detectChanges();
  return { el: fixture.nativeElement as HTMLElement, playing, component: fixture.componentInstance };
}

describe('RemotePickerListComponent device card', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('names the current device and what it plays', () => {
    const { el } = setup();
    const card = el.querySelector('[data-testid="device-card"]')!;
    expect(card.textContent).toContain('Living room');
    expect(card.textContent).toContain('Film');
  });

  it('is absent unless asked for, and on this device', () => {
    expect(setup({ card: false }).el.querySelector('[data-testid="device-card"]')).toBeNull();
    TestBed.resetTestingModule();
    expect(setup({ name: null }).el.querySelector('[data-testid="device-card"]')).toBeNull();
  });

  const resumable = (playHere = vi.fn()) => ({
    sync: { session: signal({ owner: { targetId: 'tv#1' }, state: 'playing', item: { kind: 'album', title: 'Album', subtitle: 'Track' } }), canPlayHere: signal(true), isReading: () => false, playHere },
    session: { isLocal: signal(true) },
  });

  it('is followed by the take-back button, which replaces the this-device row', () => {
    const playHere = vi.fn();
    const { el } = setup(resumable(playHere));
    expect(el.querySelector('[data-testid="device-card"] [data-testid="picker-take-here"]')).toBeNull();
    const button = el.querySelector<HTMLButtonElement>('[data-testid="picker-take-here"]')!;
    expect(button).not.toBeNull();
    expect(el.textContent).not.toContain('remote.this_device');
    button.click();
    expect(playHere).toHaveBeenCalled();
  });

  it('shows the take-back button without a card too', () => {
    const { el } = setup({ ...resumable(), card: false });
    expect(el.querySelector('[data-testid="picker-take-here"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="device-card"]')).toBeNull();
  });
});

describe('RemotePickerListComponent parked session', () => {
  afterEach(() => TestBed.resetTestingModule());

  const parked = (state = 'parked') => signal({ owner: { targetId: 'pc#1' }, state, positionSeconds: 0, durationSeconds: 10, item: { id: 7, mediaId: 3, kind: 'movie', title: 'Parked film', subtitle: null, mediaFileId: 9 } });
  const sync = (role: string, state?: string) => ({ session: parked(state), role: signal(role), isReading: () => false, positionNow: () => 0, line: () => '' });

  it('shows only the output now playing on the card, never the parked session', () => {
    const { el } = setup({ sync: sync('none'), name: 'Living room' });
    const card = el.querySelector('[data-testid="device-card"]')!;
    expect(card.textContent).not.toContain('Parked film');
  });

  it('keeps the followed row beside the card when another device owns the session', () => {
    const { el } = setup({ sync: sync('observer'), remote: { observedTargetId: signal('tv#2') } });
    expect(el.textContent).toContain('Parked film');
  });

  it('folds the followed row into the card of the owning device', () => {
    const { el } = setup({ sync: sync('observer', 'playing'), remote: { observedTargetId: signal('pc#1') } });
    expect(el.textContent).not.toContain('Parked film');
  });

  it('keeps the followed row for a parked session even on the owning device', () => {
    const { el } = setup({ sync: sync('observer'), remote: { observedTargetId: signal('pc#1') } });
    expect(el.textContent).toContain('Parked film');
  });
});

describe('RemotePickerListComponent while controlling a device', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('moves the session to another device through the session instead of selecting it', () => {
    const moveTo = vi.fn();
    const selectTarget = vi.fn();
    const { component } = setup({
      session: { transfersTo: (id: string) => id === 'pc#1', moveTo },
      remote: { selectTarget },
    });
    component.selectRow({ kind: 'remote', id: 'pc#1', icon: 'monitor', label: 'Desk', subtitle: null, connected: false });
    expect(moveTo).toHaveBeenCalledWith('remote', 'pc#1');
    expect(selectTarget).not.toHaveBeenCalled();
  });

  it('opens the player on the device that owns the session instead of selecting it', () => {
    const selectTarget = vi.fn();
    const open = vi.fn();
    const owned = { owner: { targetId: 'tv#1' }, state: 'playing', item: { title: 'Film', subtitle: null } };
    const { component } = setup({
      sync: { session: signal(owned), role: signal('observer'), observedOwnerTargetId: () => 'tv#1', isReading: () => false, positionNow: () => 0, line: () => '', parked: () => false },
      remote: { selectTarget, watchable: (id: string) => id === 'tv#1' },
    });
    (TestBed.inject(PlaybackSurface) as unknown as { open: typeof open }).open = open;
    component.selectRow({ kind: 'remote', id: 'tv#1', icon: 'tv', label: 'TV', subtitle: null, connected: false });
    expect(open).toHaveBeenCalledWith(owned);
    expect(selectTarget).not.toHaveBeenCalled();
  });

  it('never selects the device it watches, even when its player cannot open here', () => {
    const selectTarget = vi.fn();
    const moveTo = vi.fn();
    const owned = { owner: { targetId: 'tv#1' }, state: 'playing', item: { title: 'Film', subtitle: null } };
    const { component } = setup({
      sync: { session: signal(owned), role: signal('observer'), observedOwnerTargetId: () => 'tv#1', isReading: () => false, positionNow: () => 0, line: () => '', parked: () => false },
      remote: { selectTarget, watchable: (id: string) => id === 'tv#1' },
      session: { moveTo },
    });
    const surface = TestBed.inject(PlaybackSurface) as unknown as { canOpen: () => boolean; open: ReturnType<typeof vi.fn> };
    surface.canOpen = () => false;
    component.selectRow({ kind: 'remote', id: 'tv#1', icon: 'tv', label: 'TV', subtitle: null, connected: false });
    expect(surface.open).not.toHaveBeenCalled();
    expect(selectTarget).not.toHaveBeenCalled();
    expect(moveTo).not.toHaveBeenCalled();
  });

  it('selects the device that owns the session while this device cannot watch it', () => {
    const selectTarget = vi.fn();
    const owned = { owner: { targetId: 'tv#1' }, state: 'playing', item: { title: 'Film', subtitle: null } };
    const { component } = setup({
      sync: { session: signal(owned), role: signal('observer'), observedOwnerTargetId: () => null, isReading: () => false, positionNow: () => 0, line: () => '', parked: () => false },
      remote: { selectTarget },
    });
    component.selectRow({ kind: 'remote', id: 'tv#1', icon: 'tv', label: 'TV', subtitle: null, connected: false });
    expect(TestBed.inject(PlaybackSurface).open).not.toHaveBeenCalled();
    expect(selectTarget).toHaveBeenCalledWith('tv#1');
  });

  it('moves to a Cast device from this device, so what plays or the account session starts there', () => {
    const moveTo = vi.fn();
    const selectTarget = vi.fn();
    const { component } = setup({ session: { isLocal: signal(true), moveTo }, remote: { selectTarget } });
    component.selectRow({ kind: 'cast', id: 'cc#1', icon: 'cast', label: 'Lounge', subtitle: null, connected: false });
    expect(moveTo).toHaveBeenCalledWith('cast', 'cc#1');
    component.selectRow({ kind: 'cast-web', id: 'web-chromecast', icon: 'cast', label: 'Chromecast', subtitle: null, connected: false });
    expect(moveTo).toHaveBeenLastCalledWith('cast', undefined);
  });

  it('selects the device when the session does not move there, and opens the player on what it plays', () => {
    const moveTo = vi.fn();
    const openPlayer = vi.fn();
    const selectTarget = vi.fn();
    const { component } = setup({ session: { moveTo, openPlayer }, remote: { selectTarget } });
    component.selectRow({ kind: 'remote', id: 'pc#1', icon: 'monitor', label: 'Desk', subtitle: null, connected: false });
    expect(selectTarget).toHaveBeenCalledWith('pc#1');
    expect(openPlayer).toHaveBeenCalledWith();
    expect(moveTo).not.toHaveBeenCalled();
  });
});

describe('RemotePickerListComponent twin tabs', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('keeps the tab suffix apart from the label', () => {
    const twin = (targetId: string) => ({ targetId, userAgent: null, deviceName: 'Desk', systemName: null, formFactor: 'desktop', tvPlatform: null, nowPlaying: null });
    const { component } = setup({ remote: { targets: signal([twin('pc#abcd1234'), twin('pc#wxyz5678'), { ...twin('tv#1'), deviceName: null, systemName: 'tvOS 18' }]) } });
    const rows = component['pickerRows']().filter((r: { kind: string }) => r.kind === 'remote');
    expect(rows.map((r: { tab?: string }) => r.tab)).toEqual(['abcd', 'wxyz', undefined]);
  });
});

describe('RemotePickerListComponent transfer sheet', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows the observed session once, on the device card, and lists only devices it can move to', () => {
    const target = (targetId: string, deviceName: string) => ({ targetId, userAgent: null, deviceName, systemName: null, formFactor: 'desktop', tvPlatform: null, nowPlaying: null });
    const { el, component } = setup({
      transferOnly: true,
      session: { transfersTo: (id: string) => id !== 'pc#1' },
      sync: {
        session: signal({ owner: { targetId: 'pc#1' }, state: 'playing', item: { id: 7, mediaId: 3, kind: 'album', title: 'Album', subtitle: 'Track', mediaFileId: 9 } }),
        role: signal('observer'),
        canPlayHere: signal(false),
        canTransfer: signal(true),
        isReading: () => false,
        positionNow: () => 0,
        line: () => '',
        parked: () => false,
      },
      remote: { targets: signal([target('pc#1', 'Desk'), target('tv#2', 'Lounge')]), observedTargetId: signal('pc#1'), observedTarget: signal({ targetId: 'pc#1' }) },
    });
    expect(el.textContent).not.toContain('session.current');
    const remotes = component['pickerRows']().filter((r: { kind: string }) => r.kind === 'remote');
    expect(remotes.map((r: { id: string }) => r.id)).toEqual(['tv#2']);
  });
});
