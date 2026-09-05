import { Injectable, signal, inject, effect, untracked, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { ToastService } from './toast.service';
import { ServerConfigService } from './server-config.service';
import { AuthService } from './auth.service';
import { DownloadProgressService } from './download-progress.service';
import { MediaType } from '../enums/media-type.enum';
import { DownloadProgressState } from '../enums/download-progress-state.enum';
import { invalidatePrefix } from '../interceptors/cache.interceptor';
import { getOrCreateDeviceId } from '../utils/device-info';
import { DeviceService } from './device.service';
import { SystemInfoService } from './system-info.service';
import { currentTargetId } from './remote-target-id';

export interface SseEvent {
  type: string;
  [key: string]: unknown;
}

/** One rung of a target's quality ladder. `lowBandwidth` marks an eco rung, of
 *  which there is one per height, so a list without it shows the label twice. */
export interface RemoteQualityRung {
  id: string;
  label: string;
  lowBandwidth?: boolean;
}

/** Absolute, state-setting playback command aimed at this device. */
export interface RemoteCommand {
  type: 'remote.command';
  cmdId: string;
  expiresAt: number;
  byTargetId: string | null;
  action:
    | 'load' | 'play' | 'pause' | 'playpause' | 'stop'
    | 'seek' | 'volume' | 'mute' | 'next' | 'audio' | 'subtitle' | 'quality';
  mediaId?: number;
  mediaFileId?: number;
  episodeId?: number;
  positionSeconds?: number;
  level?: number;
  muted?: boolean;
  trackId?: string;
  subtitleId?: string | null;
  qualityId?: string;
}

export interface RemoteState {
  type: 'remote.state';
  targetId: string;
  sessionId: string;
  mediaId: number | null;
  mediaFileId: number;
  episodeId?: number | null;
  mediaTitle: string | null;
  episodeLabel: string | null;
  posterUrl: string | null;
  positionSeconds: number;
  durationSeconds: number;
  state: 'playing' | 'paused' | 'buffering';
  volume: number | null;
  muted: boolean | null;
  supportsVolume: boolean;
  subtitleId: string | null;
  quality: string | null;
  qualities: RemoteQualityRung[] | null;
  /** The target has something queued after the current item. */
  hasNext: boolean;
  /** The target's browser refused to start without a gesture on that device. */
  autoplayBlocked: boolean;
  audioTrackIndex: number | null;
  subtitleTrackIndex: number | null;
  lastCmdId: string | null;
}

/** `sessionStorage` key for the per-tab half of this device's target id. */
const TAB_NONCE_KEY = 'fliks.remote.tabNonce';

/** Series/movie title plus episode identity, kept as separate fields so a season
 *  import can lay them out rather than parsing a flattened string. `seasonNumber`
 *  alone (no `episodeNumber`) describes a whole-season task. */
export interface MediaProgressSubject {
  title: string;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string;
}

export interface TaskProgress {
  type: 'task.progress';
  command: string;
  current: number;
  total: number;
  message: string;
  /** Absent for a subject with no media behind it (an orphan-scan path): `message`
   *  alone carries it then. */
  subject?: MediaProgressSubject;
}

/** Flat display label for a task.progress row: the series/movie title plus episode
 *  identity when present, falling back to the plain `message` otherwise. */
export function formatProgressSubject(progress: TaskProgress): string {
  const s = progress.subject;
  if (!s) return progress.message;
  if (s.seasonNumber == null) return s.title;
  const season = `S${String(s.seasonNumber).padStart(2, '0')}`;
  const code = s.episodeNumber != null ? `${season}E${String(s.episodeNumber).padStart(2, '0')}` : season;
  return s.episodeTitle ? `${s.title} · ${code} · ${s.episodeTitle}` : `${s.title} · ${code}`;
}

@Injectable({ providedIn: 'root' })
export class SseService implements OnDestroy {
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly auth = inject(AuthService);
  private readonly downloadProgress = inject(DownloadProgressService);
  private readonly device = inject(DeviceService);
  private readonly systemInfo = inject(SystemInfoService);

  readonly activeProgress = signal<Map<string, TaskProgress>>(new Map());
  readonly lastEvent = signal<SseEvent | null>(null);
  /** Live machine-translation progress keyed by the PROCESSING subtitle id
   *  (0–100). Read by the subtitle modal to show a per-row percentage. */
  readonly translationProgress = signal<Record<number, number>>({});
  /** Issued by the backend on SSE connect — bound to live sessions so admin
   *  remote-control reaches only this device/tab. */
  readonly connectionId = signal<string | null>(null);
  /** `deviceId#tabNonce`. Stable across this tab's SSE reconnects: unlike
   *  `connectionId`, reminted server-side every time: and unique per screen,
   *  unlike the device id, which two tabs of one browser share. */
  readonly targetId = signal<string | null>(null);
  /** Commands are transient intent: a last-value signal would let a state
   *  frame overwrite one before its consumer ran, losing it with no trace. */
  readonly commands = new Subject<RemoteCommand>();
  /** A target leaving its player. A transient fact, so it cannot ride on
   *  `lastEvent`: the same handler emits `remote.targets_changed` right after
   *  it, which replaced the value before any effect had run. */
  readonly stopped = new Subject<string>();
  /** Own signal rather than `lastEvent`: this fires every 10s per playing
   *  session for every device of the account, and `lastEvent` is read inside
   *  effects by a dozen unrelated components. */
  readonly remoteState = signal<RemoteState | null>(null);
  private eventSource: EventSource | null = null;
  private deviceIdPromise: Promise<string> | null = null;
  /** Bumped by `close()`. `connect()` awaits the device id, so a logout during
   *  that await would otherwise open a stream for the previous session. */
  private generation = 0;
  private retryDelay = 5000;
  private retryHandle: ReturnType<typeof setTimeout> | null = null;
  private readonly onOnline = () => void this.connect();

  constructor() {
    // The stream is authenticated as one account: detach on a session change
    // and let the layout re-open it for the next one.
    effect(() => {
      this.auth.sessionEpoch();
      untracked(() => {
        this.close();
        // Progress is keyed by media, not by account. Dropping it with the
        // stream that fed it also stops the sweep timer of a session nobody
        // is watching any more.
        this.downloadProgress.reset();
      });
    });
  }

  /** Force reconnect (e.g. after app resume from background) */
  reconnect() {
    this.close();
    void this.connect();
  }

  /** Detach: the source, its pending retry and the offline one-shot would all
   *  otherwise re-open the stream against the previous session. */
  close() {
    if (this.retryHandle) {
      clearTimeout(this.retryHandle);
      this.retryHandle = null;
    }
    window.removeEventListener('online', this.onOnline);
    this.generation++;
    this.eventSource?.close();
    this.eventSource = null;
    this.connectionId.set(null);
    this.retryDelay = 5000;
  }

  async connect() {
    if (this.eventSource) return;

    const generation = this.generation;
    const targetId = await this.resolveTargetId();
    // A logout or account switch during the await would otherwise leave this
    // continuation opening a stream: and registering a target: for the
    // session that just ended.
    if (generation !== this.generation || this.eventSource) return;
    this.targetId.set(targetId);
    currentTargetId.set(targetId);

    // One builder for both branches: the web path has no query string while
    // the native path carries `?token=`, so appending by hand yields
    // `?token=...?device=...` and breaks exactly the TV and mobile targets.
    const params = new URLSearchParams();
    params.set('device', targetId);
    params.set('ff', this.device.formFactor());
    const tvPlatform = this.device.tvPlatform();
    if (tvPlatform) params.set('tvPlatform', tvPlatform);
    // A name its owner chose beats anything derivable from the User-Agent, and
    // it is a proper noun, so it travels verbatim like the browser and OS do.
    await this.systemInfo.ready();
    const deviceName = this.systemInfo.deviceName();
    if (deviceName) params.set('name', deviceName);

    let base = '/api/system/events';
    if (this.serverConfig.isNative) {
      base = this.serverConfig.resolveUrl(base);
      const token = this.auth.accessToken;
      if (token) params.set('token', token);
    }
    const url = `${base}?${params.toString()}`;

    this.eventSource = new EventSource(url);
    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as SseEvent;
        if (data.type === 'sse.connected') {
          const id = data['connectionId'];
          if (typeof id === 'string' && id) {
            this.connectionId.set(id);
          }
          // The server replays its live leaves right after this event, so the
          // burst that follows is a full snapshot. Everything else finished
          // while we were disconnected: nothing announces that, and a leaf kept
          // here shows a download badge that never goes away.
          this.downloadProgress.reset();
          return;
        }
        if (data.type === 'remote.command') {
          this.commands.next(data as unknown as RemoteCommand);
          return;
        }
        if (data.type === 'remote.stopped') {
          this.stopped.next(String(data['targetId'] ?? ''));
          return;
        }
        if (data.type === 'remote.state') {
          this.remoteState.set(data as unknown as RemoteState);
          return;
        }
        this.handleEvent(data);
        // Don't update lastEvent for high-frequency progress events
        // (handled via dedicated signals/stores instead)
        if (
          data.type !== 'task.progress' &&
          data.type !== 'download.progress' &&
          data.type !== 'subtitle.translation_progress'
        ) {
          this.lastEvent.set(data);
        }
      } catch { /* ignore parse errors */ }
    };
    this.retryDelay = 5000; // Reset on successful connection
    this.eventSource.onopen = () => { this.retryDelay = 5000; };
    this.eventSource.onerror = () => {
      this.eventSource?.close();
      this.eventSource = null;
      this.connectionId.set(null);
      if (!navigator.onLine) {
        // Offline — wait for online event instead of polling
        window.addEventListener('online', this.onOnline, { once: true });
        return;
      }
      // Exponential backoff: 5s → 10s → 20s → 30s max. On native the token is
      // baked into the URL, so rotate it first or a long background leaves every
      // retry replaying the same expired one.
      this.retryHandle = setTimeout(() => {
        if (this.serverConfig.isNative && this.auth.refreshToken) {
          void this.auth.refreshAccessToken().finally(() => void this.connect());
        } else {
          void this.connect();
        }
      }, this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
    };
  }

  /** Cached: the device id is a persisted async read, so only the very first
   *  connect pays for it.
   *
   *  A standalone shell (Capacitor, TV, desktop) has exactly one webview, so it
   *  gets a bare device id. That makes its target id survive a relaunch, which
   *  is what lets the server evict the previous, already-dead connection: a
   *  killed webview sends no FIN, so the socket alone never reveals it. Only a
   *  browser needs the per-tab suffix, because only a browser has tabs. */
  private async resolveTargetId(): Promise<string> {
    this.deviceIdPromise ??= getOrCreateDeviceId();
    const deviceId = await this.deviceIdPromise;
    if (this.serverConfig.isNative) return deviceId;
    let nonce: string | null = null;
    try {
      nonce = sessionStorage.getItem(TAB_NONCE_KEY);
      if (!nonce) {
        nonce = crypto.randomUUID().slice(0, 8);
        sessionStorage.setItem(TAB_NONCE_KEY, nonce);
      }
    } catch {
      // Private mode / blocked storage: a per-load nonce still separates two
      // tabs, it just doesn't survive a reload.
      nonce ??= crypto.randomUUID().slice(0, 8);
    }
    return `${deviceId}#${nonce}`;
  }

  private handleEvent(event: SseEvent) {
    switch (event.type) {
      case 'task.progress': {
        const tp = event as unknown as TaskProgress;
        this.activeProgress.update((m) => {
          const next = new Map(m);
          if (tp.current >= tp.total) {
            next.delete(tp.command);
          } else {
            next.set(tp.command, tp);
          }
          return next;
        });
        break;
      }
      case 'subtitle.synced':
      case 'subtitle.downloaded':
      case 'subtitle.failed':
      case 'subtitle.list_changed':
        // These land asynchronously (an import storing embedded tracks, an OCR run starting
        // or ending minutes after the request returned), so no client mutation invalidated
        // the cached subtitle list — drop the media cache here so the next fetch is fresh.
        void invalidatePrefix('/api/media');
        // Toasts are handled by the media-detail component (only on the right page).
        break;
      case 'subtitle.translation_progress': {
        const id = Number(event['subtitleId']);
        const progress = Number(event['progress']);
        if (Number.isFinite(id)) {
          this.translationProgress.update((m) => ({ ...m, [id]: progress }));
        }
        break;
      }
      case 'download.progress': {
        // An empty `downloads` retires the media, so an event that carries no array at all must
        // be ignored rather than read as one: "said nothing" and "said nothing is running" are
        // opposite statements, and only the second may erase what is on screen.
        const downloads = event['downloads'];
        if (!Array.isArray(downloads)) break;
        this.downloadProgress.applyProgress({
          mediaId: Number(event['mediaId']),
          mediaType: event['mediaType'] as MediaType,
          downloads: downloads.map(
            (d: Record<string, unknown>) => ({
              ref: String(d['ref'] ?? ''),
              seasonNumber: d['seasonNumber'] as number | undefined,
              episodeNumber: d['episodeNumber'] as number | undefined,
              progress: Number(d['progress']),
              dlspeed: Number(d['dlspeed'] ?? 0),
              eta: Number(d['eta'] ?? 0),
              state: (d['state'] as DownloadProgressState | undefined) ?? 'active',
            }),
          ),
        });
        break;
      }
      case 'import.complete':
        // The download finished → retire its live progress (just the imported
        // season for a series; the whole entry otherwise).
        this.downloadProgress.clearMedia(
          Number(event['mediaId']),
          event['seasonNumber'] as number | undefined,
          event['episodeNumber'] as number | undefined,
        );
        // A file landed with no client mutation behind it, so the cached media
        // body still says the episode has none.
        void invalidatePrefix('/api/media');
        // Import always finishes unattended (completion is polled by
        // a scheduler) — no toast, just retire the live progress above.
        break;
      case 'import.failed':
        this.toast.error(
          this.translate.instant('sse.import_failed', { title: event['title'] ?? '' }),
        );
        break;
      case 'stalled.removed':
        // Unattended cleanup of a stalled download — no toast.
        break;
      case 'social.followed':
        this.toast.info(
          this.translate.instant('social.toast_new_follower', {
            username: event['username'] ?? '',
          }),
        );
        break;
      case 'social.follow_request':
        this.toast.info(
          this.translate.instant('social.toast_follow_request', {
            username: event['username'] ?? '',
          }),
        );
        break;
      case 'social.follow_accepted':
        this.toast.info(
          this.translate.instant('social.toast_follow_accepted', {
            username: event['username'] ?? '',
          }),
        );
        break;
      case 'social.content_recommended':
        this.toast.info(
          this.translate.instant('recommend.toast_received', {
            username: event['username'] ?? '',
            title: event['mediaTitle'] ?? '',
          }),
        );
        break;
      case 'rescan.started':
        // Toast shown from media-detail / episode-detail when POST /rescan returns
        break;
      case 'rescan.completed': {
        const base = this.translate.instant('sse.rescan_completed', {
          title: event['title'] ?? '',
          added: event['added'] ?? 0,
          removed: event['removed'] ?? 0,
          updated: event['updated'] ?? 0,
        });
        const sm = Number(event['subtitleRemovedMissing'] ?? 0);
        const sd = Number(event['subtitleRemovedDuplicates'] ?? 0);
        let msg = base;
        if (sm || sd) {
          msg +=
            ' — ' +
            this.translate.instant('sse.rescan_subtitles_cleaned', {
              missing: sm,
              duplicates: sd,
            });
        }
        this.toast.success(msg);
        break;
      }
      case 'rescan.failed':
        this.toast.error(
          this.translate.instant('sse.rescan_failed', { title: event['title'] ?? '' }),
        );
        break;
      case 'media.files.delete_failed':
        this.toast.error(
          this.translate.instant('sse.media_files_delete_failed', {
            title: event['title'] ?? '',
          }),
        );
        break;
    }
  }

  /** Keep only the given subtitle ids in the translation-progress map — called
   *  after the modal reloads on a terminal event so finished/failed runs don't
   *  leave orphan entries behind. */
  retainTranslationProgress(activeIds: number[]) {
    this.translationProgress.update((m) => {
      const next: Record<number, number> = {};
      for (const id of activeIds) if (id in m) next[id] = m[id];
      return next;
    });
  }

  ngOnDestroy() {
    this.close();
  }
}
