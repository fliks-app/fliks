import { Injectable, signal } from '@angular/core';
import { Capacitor, PluginListenerHandle, registerPlugin } from '@capacitor/core';

interface AirPlayState {
  available: boolean;
  active: boolean;
  deviceName?: string;
}

interface AirPlayPlugin {
  getState(): Promise<AirPlayState>;
  showPicker(): Promise<void>;
  addListener(event: 'stateChanged', cb: (state: AirPlayState) => void): Promise<PluginListenerHandle>;
}

const AirPlay = registerPlugin<AirPlayPlugin>('AirPlay');

/** Safari's AirPlay surface on a media element. */
interface WebKitVideoElement extends HTMLVideoElement {
  webkitShowPlaybackTargetPicker(): void;
  readonly webkitCurrentPlaybackTargetIsWireless: boolean;
}

/**
 * AirPlay destination for the "play on another device" list. Unlike Cast, the
 * running player keeps the session: the system picker only reroutes it, so
 * there is no handoff to do. iOS routes the native AVPlayer app-wide; Safari
 * routes one `<video>`, so the web side only exists while the player is open.
 */
@Injectable({ providedIn: 'root' })
export class AirPlayService {
  private readonly native = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';

  /** A receiver can be picked. */
  readonly available = signal(false);
  /** The audio route points at a receiver. iOS only. */
  readonly routeActive = signal(false);
  /** Receiver the audio route points at. iOS only: Safari never names it. */
  readonly deviceName = signal<string | null>(null);
  /** The video plays on the receiver, not on this screen. */
  readonly videoActive = signal(false);

  private video: WebKitVideoElement | null = null;

  constructor() {
    if (this.native) void this.initNative();
  }

  private async initNative(): Promise<void> {
    const apply = (s: AirPlayState) => {
      this.available.set(s.available);
      this.routeActive.set(s.active);
      this.deviceName.set(s.active ? (s.deviceName ?? null) : null);
    };
    try {
      await AirPlay.addListener('stateChanged', apply);
      apply(await AirPlay.getState());
    } catch (err) {
      console.warn('[airplay] native plugin unavailable', err);
    }
    window.addEventListener('nativePlayerExternalPlaybackChanged', ((e: CustomEvent) => {
      this.videoActive.set(!!e.detail?.active);
    }) as EventListener);
  }

  /** Must run inside the user gesture on the web: Safari refuses otherwise. */
  showPicker(): void {
    if (this.native) {
      AirPlay.showPicker().catch((err) => console.warn('[airplay] showPicker failed', err));
    } else {
      this.video?.webkitShowPlaybackTargetPicker();
    }
  }

  /** Safari only, a no-op elsewhere. Returns the detach callback. */
  attachVideo(el: HTMLVideoElement): () => void {
    if (this.native || !('WebKitPlaybackTargetAvailabilityEvent' in window)) return () => {};
    const video = el as WebKitVideoElement;
    this.video = video;
    const onAvailability = (e: Event) =>
      this.available.set((e as Event & { availability: string }).availability === 'available');
    const onWireless = () => this.videoActive.set(video.webkitCurrentPlaybackTargetIsWireless);
    video.addEventListener('webkitplaybacktargetavailabilitychanged', onAvailability);
    video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', onWireless);
    return () => {
      video.removeEventListener('webkitplaybacktargetavailabilitychanged', onAvailability);
      video.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', onWireless);
      if (this.video !== video) return;
      this.video = null;
      this.available.set(false);
      this.videoActive.set(false);
    };
  }
}
