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
import { PlaybackSession } from '../../core/services/playback/playback-session';
import { RemoteService } from '../../core/services/remote.service';
import { SessionSyncService } from '../../core/services/session-sync.service';
import { ToastService } from '../../core/services/toast.service';
import { PlaybackSurface } from '../../core/services/playback/playback-surface';
import { RemotePickerListComponent } from './remote-picker-list';

function setup(
  over: { name?: string | null; canSetVolume?: boolean; card?: boolean; volumeKnown?: boolean; sync?: object; remote?: object } = {},
) {
  const playing = {
    name: signal(over.name === undefined ? 'Living room' : over.name),
    icon: signal('tv'),
    canSetVolume: signal(over.canSetVolume ?? true),
    volume: signal(0.8),
    volumeKnown: signal(over.volumeKnown ?? true),
    setVolume: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      provideTranslateService(),
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: PlaybackDevice, useValue: playing },
      { provide: RemoteService, useValue: { targets: signal([]), selectedTargetId: signal(null), refreshTargets: vi.fn(), ...over.remote } },
      { provide: CastService, useValue: { enumerates: false, isAvailable: signal(false), isConnected: signal(false), castDevices: signal([]), getCastDevices: vi.fn() } },
      { provide: AirPlayService, useValue: { available: signal(false) } },
      { provide: CastPlaybackTarget, useValue: {} },
      { provide: PlaybackSession, useValue: { isLocal: signal(false), nowPlaying: signal({ title: 'Film' }) } },
      { provide: SessionSyncService, useValue: { session: signal(null), role: signal('none'), canPlayHere: signal(false), ...over.sync } },
      { provide: DeviceService, useValue: { isTouch: () => false } },
      { provide: PlaybackSurface, useValue: { here: signal(false) } },
      { provide: ToastService, useValue: {} },
    ],
  });
  const fixture = TestBed.createComponent(RemotePickerListComponent);
  fixture.componentRef.setInput('card', over.card ?? true);
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

  it('sends the slider level as a fraction to the device', () => {
    const { el, playing } = setup();
    const slider = el.querySelector<HTMLInputElement>('[data-testid="device-volume"]')!;
    slider.value = '40';
    slider.dispatchEvent(new Event('input'));
    expect(playing.setVolume).toHaveBeenCalledWith(0.4);
  });

  it('shows no level, not a full one, until the device has reported its volume', () => {
    const { el } = setup({ volumeKnown: false });
    const slider = el.querySelector<HTMLInputElement>('[data-testid="device-volume"]')!;
    expect(slider.disabled).toBe(true);
    expect(slider.value).toBe('0');
  });

  it('hides the slider when the device cannot set its volume', () => {
    const { el } = setup({ canSetVolume: false });
    expect(el.querySelector('[data-testid="device-volume"]')).toBeNull();
  });
});

describe('RemotePickerListComponent while controlling a device', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('moves the session to another device instead of selecting it', () => {
    const transferTo = vi.fn().mockResolvedValue(undefined);
    const selectTarget = vi.fn();
    const { component } = setup({
      sync: {
        session: signal({ owner: { targetId: 'tv#1' } }),
        role: signal('observer'),
        canTransfer: signal(true),
        parked: () => false,
        transferTo,
      },
      remote: { selectedTargetId: signal('tv#1'), selectTarget },
    });
    component.selectRow({ kind: 'remote', id: 'pc#1', icon: 'monitor', label: 'Desk', subtitle: null, connected: false });
    expect(transferTo).toHaveBeenCalledWith('pc#1');
    expect(selectTarget).not.toHaveBeenCalled();
  });
});
