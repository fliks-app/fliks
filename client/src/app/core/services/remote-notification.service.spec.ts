import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslateService } from '@ngx-translate/core';
import { RemoteNotificationService } from './remote-notification.service';
import { DeviceService } from './device.service';
import { RemoteService } from './remote.service';
import { RemotePlaybackTarget, remoteOverlayOpen } from './remote-playback-target';
import { ServerConfigService } from './server-config.service';
import { AuthService } from './auth.service';
import { SseService } from './sse.service';
import { LikesApiService } from './api/likes-api.service';

const plugin = vi.hoisted(() => ({
  update: vi.fn((_options: Record<string, unknown>) => Promise.resolve()),
  clear: vi.fn(() => Promise.resolve()),
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => plugin,
  Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
}));

function setup(ios = true) {
  const state = signal<Record<string, unknown> | null>({
    mediaId: 7,
    episodeId: 70,
    posterUrl: '/api/images/p.jpg',
    fanartUrl: null,
  });
  const remote = {
    targetState: state,
    isRemoting: signal(true),
    selectedTargetId: signal('tv#1'),
    selectedTarget: signal({ targetId: 'tv#1', userAgent: null, systemName: null, deviceName: 'Living room' }),
    noteStopSent: vi.fn(),
  };
  const target = {
    hasMedia: () => true,
    isIdle: () => false,
    isStarting: () => false,
    isConnected: () => true,
    isPaused: () => false,
    buffering: () => false,
    currentTime: () => 12,
    duration: () => 100,
    canSetVolume: () => false,
    volume: () => 1,
    muted: () => false,
    canPlayNext: () => true,
    episodeTitle: () => 'An episode',
    mediaTitle: () => 'A series',
    fanartUrl: () => null,
    togglePlayPause: vi.fn(),
    seek: vi.fn(),
    playNext: vi.fn(),
    stopPlayback: vi.fn(),
  };
  const likes = {
    state: vi.fn().mockResolvedValue({ media: false, seasonIds: [], episodeIds: [70] }),
    like: vi.fn(),
    unlike: vi.fn(),
    changed: signal<{ mediaId: number } | null>(null),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: DeviceService, useValue: { isIosNative: () => ios, isAndroidNative: () => !ios, isTv: () => false } },
      { provide: RemoteService, useValue: remote },
      { provide: RemotePlaybackTarget, useValue: target },
      { provide: ServerConfigService, useValue: { serverUrl: () => 'https://srv', resolveUrl: (u: string) => `https://srv${u}` } },
      { provide: AuthService, useValue: { accessToken: 'tok' } },
      { provide: SseService, useValue: { targetId: signal('phone#1') } },
      { provide: TranslateService, useValue: { instant: (k: string, p?: { device?: string }) => (p?.device ? `${k}:${p.device}` : k) } },
      { provide: LikesApiService, useValue: likes },
    ],
  });
  const service = TestBed.inject(RemoteNotificationService);
  service.init();
  TestBed.tick();
  return { remote, target, likes };
}

const send = (detail: Record<string, unknown>) =>
  window.dispatchEvent(new CustomEvent('remoteNotificationCommand', { detail }));

describe('RemoteNotificationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    remoteOverlayOpen.set(false);
  });

  it('hands the Live Activity the connection and translated copy', () => {
    setup();
    expect(plugin.update).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'https://srv',
      accessToken: 'tok',
      targetId: 'tv#1',
      byTargetId: 'phone#1',
      mediaId: 7,
      episodeId: 70,
      thumbnailUrl: 'https://srv/api/images/p.jpg?size=thumb',
      deviceName: 'remote.notification_on_device:system.device_named',
      staleLabel: 'remote.notification_stale',
    }));
  });

  it('keeps the connection out of the Android payload', () => {
    setup(false);
    const payload = plugin.update.mock.lastCall?.[0];
    expect(payload?.['title']).toBe('An episode');
    expect(payload).not.toHaveProperty('accessToken');
    expect(payload).not.toHaveProperty('serverUrl');
  });

  it('still sends a stop the notification did not send itself', () => {
    const { target } = setup(false);
    send({ action: 'stop', value: 0 });
    expect(target.stopPlayback).toHaveBeenCalled();
  });

  it('does not re-send a stop that already went out natively', () => {
    const { remote, target } = setup();
    remoteOverlayOpen.set(true);
    send({ action: 'stop', value: 0, sent: true });
    expect(remote.noteStopSent).toHaveBeenCalled();
    expect(remoteOverlayOpen()).toBe(false);
    expect(target.stopPlayback).not.toHaveBeenCalled();
  });

  it('follows a like sent natively without calling the API', async () => {
    const { likes } = setup();
    await likes.state.mock.results[0].value;
    await Promise.resolve();
    send({ action: 'like', value: 0, sent: true });
    expect(likes.unlike).not.toHaveBeenCalled();
    expect(likes.like).not.toHaveBeenCalled();
    expect(likes.changed()).toEqual({ mediaId: 7 });
  });

  it('leaves play, pause, seek and next alone when they were sent natively', () => {
    const { target } = setup();
    for (const action of ['play', 'pause', 'seek', 'next']) send({ action, value: 5, sent: true });
    expect(target.togglePlayPause).not.toHaveBeenCalled();
    expect(target.seek).not.toHaveBeenCalled();
    expect(target.playNext).not.toHaveBeenCalled();
  });
});
