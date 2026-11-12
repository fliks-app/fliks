import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { AudioPlayerService } from '../audio-player/audio-player.service';
import { DeviceService } from '../device.service';
import { RemoteService } from '../remote.service';
import { SKIP_ERROR_TOAST } from '../../interceptors/error.interceptor';
import { SseService } from '../sse.service';
import { SessionSyncService, type AccountSession } from '../session-sync.service';
import { SERVER_SINCE, ServerVersionService } from '../server-version.service';
import { PlaybackSession } from './playback-session';

/** `local`: only this device's player shows. `remote`: another device plays, one bar. `parked`: stopped elsewhere, no bar. */
export type SurfaceState = 'idle' | 'local' | 'remote' | 'parked';

/** The server stops listing a stream whose client has not said it is reading it for 120 s. */
const KEEPALIVE_MS = 30_000;

/** How long an idle phone stays listed as a target once in the background. */
const IDLE_BACKGROUND_MS = 120_000;

/** The one surface an account shows on this device, as a function of the account session and this device's pending claim. */
@Injectable({ providedIn: 'root' })
export class PlaybackSurface {
  private readonly sync = inject(SessionSyncService);
  private readonly session = inject(PlaybackSession);
  private readonly device = inject(DeviceService);
  private readonly audio = inject(AudioPlayerService);
  private readonly remote = inject(RemoteService);
  private readonly sse = inject(SseService);
  private readonly http = inject(HttpClient);
  private readonly serverVersion = inject(ServerVersionService);
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The stream was dropped for idleness and the app has not come back to the foreground yet. */
  private streamDropped = false;

  /** The session already sits on this device: a reader's position it saved, or the track its own player holds. */
  readonly here = computed(() => {
    const s = this.sync.session();
    return !!s && this.sync.ownedHere() && (this.sync.isReading(s) || this.audio.track()?.itemId === s.item.id);
  });

  readonly state = computed<SurfaceState>(() => {
    const s = this.sync.session();
    if (!s) return 'idle';
    if (this.sync.localPlaying() || this.sync.claimPending() || this.here()) return 'local';
    const owner = this.sync.role() === 'owner';
    // The owner after a reload holds no player yet: it shows the session as parked until one mounts.
    if (owner && this.sync.holdsPlayer()) return 'local';
    return owner || s.state === 'parked' ? 'parked' : 'remote';
  });

  /** Re-reading the session and the targets after a resume: the surface stays up, marked stale. */
  readonly syncing = signal(false);

  /** The session the bar shows; the audio mini-player holds the same slot, so it never shows with it. */
  readonly bar = computed<AccountSession | null>(() => {
    const s = this.sync.session();
    const state = this.state();
    // Only another device's live playback, which the bar can pause; it replaces a paused local track.
    if (!s || state !== 'remote' || this.sync.isReading(s) || this.device.isTv() || !this.session.isLocal() || this.session.partyActive()) return null;
    return s;
  });

  private readonly musicParked = computed(() => {
    const s = this.sync.session();
    return s?.state === 'parked' && s.item.kind === 'album';
  });

  /** A parked music session is every device's own paused mini-player while nothing else holds it, never a bar. */
  readonly parkedMusic = computed(
    () => this.musicParked() && !this.device.isTv() && this.session.isLocal() && !this.session.partyActive() && !this.audio.track(),
  );

  /** Whether the audio mini-player gives way to the bar of another device's playback. */
  readonly miniHidden = computed(() => this.state() === 'remote' && this.bar() !== null);

  /** Another bar (cast, remote output) rises above the audio mini-player at the same place. */
  readonly aboveAudio = computed(() => (this.audio.active() || this.parkedMusic()) && !this.miniHidden());

  constructor() {
    // A frozen WebView runs no timer, so its silence is what unlists it.
    effect((onCleanup) => {
      const connectionId = this.sse.connectionId();
      if (!connectionId || !this.serverVersion.supports(SERVER_SINCE.keepalive)) return;
      const ping = () => this.http
        .post('/api/system/events/keepalive', { connectionId }, { context: new HttpContext().set(SKIP_ERROR_TOAST, true) })
        .subscribe({ error: () => undefined });
      ping();
      const timer = setInterval(ping, KEEPALIVE_MS);
      onCleanup(() => clearInterval(timer));
    });

    // A player that starts while the stream is dropped (lock screen, background audio) lists the device again.
    effect(() => {
      const holds = this.sync.holdsPlayer();
      if (this.streamDropped && holds) {
        this.streamDropped = false;
        untracked(() => void this.sse.connect());
      }
    });
  }

  /** Nothing here plays, is followed or controlled: a suspended WebView would only time out on a command sent to it. */
  private readonly idle = computed(() => {
    const state = this.state();
    return (
      this.sync.enabled() &&
      (state === 'idle' || state === 'parked') &&
      this.session.isLocal() &&
      !this.session.partyActive() &&
      !this.remote.isRemoting() &&
      !this.sync.holdsPlayer()
    );
  });

  /** Called when a native shell goes to the background: an idle one drops its stream after a grace, so remotes stop listing it. */
  backgrounded(): void {
    this.cancelIdleDrop();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.idle()) return;
      this.streamDropped = true;
      this.sse.close();
    }, IDLE_BACKGROUND_MS);
  }

  private cancelIdleDrop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Back in the foreground: the last surface stays, stale, while the session and the targets are read again and the report is replaced. */
  async resync(): Promise<void> {
    this.cancelIdleDrop();
    this.streamDropped = false;
    if (!this.sync.enabled()) return;
    this.syncing.set(true);
    try {
      await Promise.all([this.sync.refresh(), this.remote.refreshTargets(true)]);
    } finally {
      this.syncing.set(false);
    }
  }
}
