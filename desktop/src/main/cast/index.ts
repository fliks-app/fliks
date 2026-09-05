import { BrowserWindow, ipcMain } from 'electron';
import { CAST_IPC } from '../../shared/contract';
import type {
  DesktopCastDevice,
  DesktopCastEvent,
  DesktopCastLoadOptions,
} from '../../shared/contract';
import { CastDiscovery, type DiscoveredDevice } from './mdns';
import {
  mediaStatusEvent,
  mergeActiveTracks,
  pickAudioTrack,
  type CastTrack,
} from './status';
import {
  CastChannel,
  NS_MEDIA,
  NS_RECEIVER,
  PLATFORM_RECEIVER,
} from './protocol';

/** Receiver → sender bus the Fliks CAF receiver pushes player errors on.
 *  Kept in sync with `cast-receiver/receiver.js` and the web sender. */
const NS_FLIKS = 'urn:x-cast:media.fliks.app';

/** MEDIA_STATUS only arrives on receiver-side transitions, so the playhead is
 *  polled to keep the renderer's seekbar moving — the same job the web SDK's
 *  RemotePlayer does for itself. 1Hz is what a cast progress bar needs. */
const STATUS_POLL_MS = 1_000;

function broadcast(event: DesktopCastEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CAST_IPC.event, event);
  }
}

/**
 * Cast sender for the desktop client: mDNS discovery plus a CASTV2 session,
 * exposing the same method surface the mobile `NativeCast` Capacitor plugin
 * does so the Angular `CastService` drives all three senders identically.
 */
class CastSender {
  private readonly discovery = new CastDiscovery((devices) => this.onDevices(devices));
  private channel: CastChannel | null = null;
  private devices: DiscoveredDevice[] = [];
  private appId = '';
  private deviceId: string | null = null;
  private transportId = '';
  private sessionId = '';
  private mediaSessionId: number | null = null;
  private tracks: CastTrack[] = [];
  private media: Record<string, unknown> | undefined;
  private activeTrackIds: number[] = [];
  private poll: ReturnType<typeof setInterval> | null = null;

  initialize(appId: string): { available: boolean } {
    this.appId = appId;
    this.discovery.start();
    return { available: this.devices.length > 0 };
  }

  listDevices(): DesktopCastDevice[] {
    return this.devices.map((d) => ({
      id: d.id,
      name: d.name,
      modelName: d.modelName,
      connected: d.id === this.deviceId && this.isConnected(),
    }));
  }

  refresh(): void {
    this.discovery.query();
  }

  isConnected(): boolean {
    return !!this.channel?.isOpen && !!this.transportId;
  }

  private onDevices(devices: DiscoveredDevice[]): void {
    this.devices = devices;
    broadcast({ name: 'castAvailabilityChanged', detail: { available: devices.length > 0 } });
    broadcast({ name: 'castDevicesChanged', detail: {} });
  }

  async select(id: string): Promise<void> {
    const device = this.devices.find((d) => d.id === id);
    if (!device) throw new Error(`unknown cast device: ${id}`);
    this.teardown();

    const channel = new CastChannel();
    this.channel = channel;
    channel.on('message', (ns: string, data: Record<string, unknown>) =>
      this.onMessage(ns, data),
    );
    channel.on('close', () => {
      if (this.channel === channel) this.teardown();
    });

    await channel.connect(device.host, device.port);
    const status = await channel.request(NS_RECEIVER, PLATFORM_RECEIVER, {
      type: 'LAUNCH',
      appId: this.appId,
    }, 30_000);
    if (!this.adoptReceiverStatus(status)) {
      this.teardown();
      throw new Error('receiver did not launch the Fliks app');
    }
    this.deviceId = device.id;
    channel.virtualConnect(this.transportId);
    this.startPolling();
    broadcast({ name: 'castStateChanged', detail: { connected: true } });
    broadcast({ name: 'castDevicesChanged', detail: {} });
  }

  /** Pull our app's transport out of a RECEIVER_STATUS. Returns false when the
   *  Fliks receiver isn't among the running applications. */
  private adoptReceiverStatus(message: Record<string, unknown>): boolean {
    const status = message['status'] as Record<string, unknown> | undefined;
    const volume = status?.['volume'] as { level?: number; muted?: boolean } | undefined;
    if (volume) {
      broadcast({
        name: 'castMediaUpdate',
        detail: { volume: volume.level, muted: volume.muted },
      });
    }
    const apps = (status?.['applications'] ?? []) as Record<string, unknown>[];
    const app = apps.find((a) => a['appId'] === this.appId);
    if (!app) return false;
    this.transportId = String(app['transportId'] ?? '');
    this.sessionId = String(app['sessionId'] ?? '');
    return !!this.transportId;
  }

  private onMessage(ns: string, data: Record<string, unknown>): void {
    if (ns === NS_RECEIVER && data['type'] === 'RECEIVER_STATUS') {
      const status = data['status'] as Record<string, unknown> | undefined;
      const apps = (status?.['applications'] ?? []) as Record<string, unknown>[];
      // The user can stop the app from the TV or another sender; the session is
      // over even though the TCP channel is still up.
      if (this.transportId && !apps.some((a) => a['appId'] === this.appId)) {
        this.teardown();
        return;
      }
      this.adoptReceiverStatus(data);
      return;
    }
    if (ns === NS_MEDIA && data['type'] === 'MEDIA_STATUS') {
      this.onMediaStatus((data['status'] ?? []) as Record<string, unknown>[]);
      return;
    }
    if (ns === NS_FLIKS && data['kind'] === 'player_error') {
      broadcast({ name: 'castError', detail: { position: Number(data['at']) || undefined } });
    }
  }

  private onMediaStatus(statuses: Record<string, unknown>[]): void {
    const status = statuses[0];
    if (!status) return;
    this.mediaSessionId = Number(status['mediaSessionId']) || this.mediaSessionId;
    if (Array.isArray(status['activeTrackIds'])) {
      this.activeTrackIds = status['activeTrackIds'] as number[];
    }
    const media = status['media'] as Record<string, unknown> | undefined;
    // `media` rides only the first status after a LOAD; later ones omit it.
    if (Array.isArray(media?.['tracks'])) this.tracks = media['tracks'] as CastTrack[];
    if (media) this.media = media;
    broadcast(mediaStatusEvent(status, this.media));
  }

  private startPolling(): void {
    if (this.poll) return;
    this.poll = setInterval(() => {
      if (!this.isConnected()) return;
      this.mediaSend({ type: 'GET_STATUS' });
    }, STATUS_POLL_MS);
  }

  private mediaSend(payload: Record<string, unknown>): void {
    if (!this.channel || !this.transportId) return;
    const withSession =
      this.mediaSessionId != null ? { ...payload, mediaSessionId: this.mediaSessionId } : payload;
    this.channel.send(NS_MEDIA, this.transportId, {
      ...withSession,
      requestId: Math.floor(Math.random() * 1e6),
    });
  }

  load(opts: DesktopCastLoadOptions): void {
    if (!this.channel || !this.transportId) return;
    const tracks = opts.subtitles.map((sub, i) => ({
      trackId: i + 1,
      type: 'TEXT',
      trackContentId: sub.url,
      trackContentType: 'text/vtt',
      subtype: 'SUBTITLES',
      name: sub.label,
      language: sub.language,
    }));
    // A fresh LOAD invalidates the previous session's tracks and id; the
    // MEDIA_STATUS that answers this one repopulates them.
    this.mediaSessionId = null;
    this.tracks = [];
    this.activeTrackIds = [];
    this.media = undefined;
    this.channel.send(NS_MEDIA, this.transportId, {
      type: 'LOAD',
      requestId: Math.floor(Math.random() * 1e6),
      sessionId: this.sessionId,
      autoplay: opts.autoplay,
      currentTime: opts.currentTime,
      activeTrackIds: opts.activeSubtitleTrackId ? [opts.activeSubtitleTrackId] : [],
      media: {
        contentId: opts.url,
        contentType: opts.contentType,
        streamType: 'BUFFERED',
        metadata: {
          metadataType: 0,
          title: opts.title,
          subtitle: opts.subtitle,
          images: opts.posterUrl ? [{ url: opts.posterUrl }] : [],
        },
        tracks,
        textTrackStyle: opts.castTextTrackStyle,
        customData: opts.customData,
      },
    });
  }

  play(): void { this.mediaSend({ type: 'PLAY' }); }
  pause(): void { this.mediaSend({ type: 'PAUSE' }); }
  seek(time: number): void { this.mediaSend({ type: 'SEEK', currentTime: time }); }
  stop(): void { this.mediaSend({ type: 'STOP' }); }

  setVolume(level: number): void {
    this.channel?.send(NS_RECEIVER, PLATFORM_RECEIVER, {
      type: 'SET_VOLUME',
      requestId: Math.floor(Math.random() * 1e6),
      volume: { level },
    });
  }

  setMuted(muted: boolean): void {
    this.channel?.send(NS_RECEIVER, PLATFORM_RECEIVER, {
      type: 'SET_VOLUME',
      requestId: Math.floor(Math.random() * 1e6),
      volume: { muted },
    });
  }

  setActiveSubtitle(trackId: number): void {
    this.editTracks({ textId: trackId > 0 ? trackId : null });
  }

  /** Match the audio rendition by name first: Shaka rewrites HLS LANGUAGE from
   *  ISO 639-2 to 639-1, so language equality misses 3-letter sources. */
  setActiveAudioLanguage(language: string, name: string): boolean {
    const target = pickAudioTrack(this.tracks, language, name);
    if (!target) return false;
    return this.editTracks({ audioId: target.trackId });
  }

  private editTracks(update: { audioId?: number | null; textId?: number | null }): boolean {
    if (!this.channel || !this.transportId || this.mediaSessionId == null) return false;
    const activeTrackIds = mergeActiveTracks(this.tracks, this.activeTrackIds, update);
    this.mediaSend({ type: 'EDIT_TRACKS_INFO', activeTrackIds });
    this.activeTrackIds = activeTrackIds;
    return true;
  }

  disconnect(): void {
    if (this.channel && this.transportId) {
      this.channel.send(NS_RECEIVER, PLATFORM_RECEIVER, {
        type: 'STOP',
        requestId: Math.floor(Math.random() * 1e6),
        sessionId: this.sessionId,
      });
    }
    this.teardown();
  }

  private teardown(): void {
    const wasConnected = this.isConnected();
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.channel?.removeAllListeners();
    this.channel?.close();
    this.channel = null;
    this.deviceId = null;
    this.transportId = '';
    this.sessionId = '';
    this.mediaSessionId = null;
    this.tracks = [];
    this.activeTrackIds = [];
    this.media = undefined;
    if (wasConnected) {
      broadcast({ name: 'castStateChanged', detail: { connected: false } });
      broadcast({ name: 'castDevicesChanged', detail: {} });
    }
  }
}

export function registerCastIpc(): void {
  const sender = new CastSender();
  ipcMain.handle(CAST_IPC.initialize, (_e, appId: string) => sender.initialize(appId));
  ipcMain.handle(CAST_IPC.isConnected, () => ({ connected: sender.isConnected() }));
  ipcMain.handle(CAST_IPC.getDevices, () => {
    sender.refresh();
    return sender.listDevices();
  });
  ipcMain.handle(CAST_IPC.selectDevice, (_e, id: string) => sender.select(id));
  // Desktop has no OS-level route picker to open — the app's own picker lists
  // the discovered devices — so end the caller's "connecting" state at once.
  ipcMain.handle(CAST_IPC.requestSession, () =>
    broadcast({ name: 'castPickerDismissed', detail: {} }),
  );
  ipcMain.handle(CAST_IPC.load, (_e, opts: DesktopCastLoadOptions) => sender.load(opts));
  ipcMain.handle(CAST_IPC.play, () => sender.play());
  ipcMain.handle(CAST_IPC.pause, () => sender.pause());
  ipcMain.handle(CAST_IPC.seek, (_e, time: number) => sender.seek(time));
  ipcMain.handle(CAST_IPC.stop, () => sender.stop());
  ipcMain.handle(CAST_IPC.disconnect, () => sender.disconnect());
  ipcMain.handle(CAST_IPC.setVolume, (_e, level: number) => sender.setVolume(level));
  ipcMain.handle(CAST_IPC.setMuted, (_e, muted: boolean) => sender.setMuted(muted));
  ipcMain.handle(CAST_IPC.setActiveSubtitle, (_e, trackId: number) =>
    sender.setActiveSubtitle(trackId),
  );
  ipcMain.handle(CAST_IPC.setActiveAudioLanguage, (_e, language: string, name: string) => ({
    success: sender.setActiveAudioLanguage(language, name),
  }));
}
