import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import type { MediaType } from '../enums/media-type.enum';
import { SKIP_ERROR_TOAST } from '../interceptors/error.interceptor';
import { formatTime } from '../utils/player.utils';
import { KIND_REGISTRY, type MediaFamily } from '../media-kinds';
import { AuthService } from './auth.service';
import { ClockService } from './party/clock.service';
import { ConfirmationService } from './confirmation.service';
import { DeviceService } from './device.service';
import { SseService, type SessionEvent } from './sse.service';

export type SessionState = 'playing' | 'paused' | 'buffering' | 'parked';

/** `GET /api/session`: the one playback of the account. */
export interface AccountSession {
  epoch: number;
  item: {
    id: number;
    mediaFileId: number | null;
    kind: MediaType;
    title: string | null;
    subtitle: string | null;
    posterUrl: string | null;
  };
  owner: { targetId: string | null; deviceName: string | null; formFactor: string | null };
  state: SessionState;
  positionSeconds: number;
  positionAt: string;
  playing: boolean;
  durationSeconds: number | null;
  queue: { itemIds: number[]; index: number; shuffle: boolean; repeat: 'off' | 'all' | 'one' } | null;
}

/** `owner` plays it here, `observer` sees it elsewhere (or parked), `none` when the account has no session. */
export type SessionRole = 'owner' | 'observer' | 'none';

/** What a player hands back once it has stopped because another device took over. */
export interface SupersededPlayback {
  title: string | null;
  positionSeconds: number;
  /** Claims the session again: replays the stopped item where it was left. */
  resume: () => Promise<void> | void;
}

/** A local player (video, music) that holds an engine session and can be stopped by a takeover. */
export interface SessionPlayer {
  sessionId(): string | undefined;
  /** This device plays something itself (also what does not claim the session: live TV, a party, a download). */
  active(): boolean;
  /** Stops playback after saving the position; null when it had nothing to resume. */
  yield(): Promise<SupersededPlayback | null>;
}

/** What the owner's own report adds to the stored session, which names no media or episode. */
export interface LiveReport {
  mediaFileId: number;
  mediaId: number | null;
  episodeId: number | null;
}

/** Where the media of a session stands, ready to start from. */
export interface ResumePoint extends LiveReport {
  positionSeconds: number;
}

/** Starts `session` on this device, one per family of kind; the video one is registered by the player module. */
export type SessionResumer = (session: AccountSession, at: ResumePoint) => Promise<void>;

const HANDLED_MAX = 32;

/** The account's playback session as this device sees it: bootstrap, role, takeover. */
@Injectable({ providedIn: 'root' })
export class SessionSyncService {
  private readonly http = inject(HttpClient);
  private readonly sse = inject(SseService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly device = inject(DeviceService);
  private readonly clock = inject(ClockService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private liveSource: () => LiveReport | null = () => null;
  private livePosition: () => number = () => 0;

  private readonly _session = signal<AccountSession | null>(null);
  readonly session = this._session.asReadonly();

  readonly enabled = computed(() => this.auth.user()?.sessionSync === true);

  readonly role = computed<SessionRole>(() => {
    const s = this._session();
    if (!s) return 'none';
    const mine = s.state !== 'parked' && !!s.owner.targetId && s.owner.targetId === this.sse.targetId();
    return mine ? 'owner' : 'observer';
  });

  /** The device to read state from and send commands to without selecting it; null on a TV, which only ever owns. */
  readonly observedOwnerTargetId = computed<string | null>(() => {
    const s = this._session();
    if (!s || this.role() !== 'observer' || s.state === 'parked' || this.device.isTv() || this.localPlaying()) return null;
    return s.owner.targetId;
  });

  /** Whether a local player is busy: it then wins over observing the other device. */
  readonly localPlaying = computed(() => {
    this.registered();
    return [...this.players].some((p) => p.active());
  });

  /** The owner is gone: position kept, resumable anywhere. */
  readonly parked = computed(() => this._session()?.state === 'parked');

  private readonly players = new Set<SessionPlayer>();
  private readonly registered = signal(0);
  private readonly resumers: Partial<Record<MediaFamily, SessionResumer>> = {};
  private readonly handled: string[] = [];
  private fetching = false;
  private refetch = false;

  constructor() {
    effect(() => {
      const connected = this.sse.connectionId() !== null;
      const on = this.enabled();
      untracked(() => {
        if (on && connected) void this.refresh();
        else if (!on) this._session.set(null);
      });
    });

    effect(() => {
      const r = this.live();
      if (r) untracked(() => this.known.set(r));
    });

    this.registerResumer('video', async (_s, at) => {
      if (!at.mediaId) return;
      const episode = at.episodeId ? { episodeId: at.episodeId } : {};
      await this.router.navigate(['/watch', at.mediaFileId], {
        queryParams: { mediaId: at.mediaId, ...episode, t: Math.floor(at.positionSeconds) },
      });
    });

    this.sse.sessionEvents.subscribe((e) => this.onEvent(e));
  }

  private onEvent(e: SessionEvent): void {
    if (e.type === 'session.changed') {
      if (this.enabled()) void this.refresh();
    }
    else void this.handleSuperseded(e.sessionId, e.byDeviceName);
  }

  /** Re-reads the session; a burst of events costs one request in flight and at most one more. */
  async refresh(): Promise<void> {
    if (this.fetching) {
      this.refetch = true;
      return;
    }
    this.fetching = true;
    try {
      do {
        this.refetch = false;
        const s = await firstValueFrom(
          this.http.get<AccountSession | null>('/api/session', { context: new HttpContext().set(SKIP_ERROR_TOAST, true) }),
        );
        if (this.enabled()) this._session.set(s);
      } while (this.refetch);
    } catch (err) {
      console.warn('[session] failed to read the account session', err);
    } finally {
      this.fetching = false;
    }
  }

  /** RemoteService lends the report of the observed owner, which it already ingests. */
  setLiveSource(report: () => LiveReport | null, position: () => number): void {
    this.liveSource = report;
    this.livePosition = position;
  }

  registerPlayer(p: SessionPlayer): () => void {
    this.players.add(p);
    this.registered.update((n) => n + 1);
    return () => {
      this.players.delete(p);
      this.registered.update((n) => n + 1);
    };
  }

  registerResumer(family: MediaFamily, resumer: SessionResumer): () => void {
    this.resumers[family] = resumer;
    return () => {
      if (this.resumers[family] === resumer) delete this.resumers[family];
    };
  }

  /** The player has stopped on a takeover (event or beat flag): hand back the device, then offer to take it again. */
  async handleSuperseded(sessionId: string, byDeviceName?: string | null): Promise<void> {
    if (this.handled.includes(sessionId)) return;
    const player = [...this.players].find((p) => p.sessionId() === sessionId);
    if (!player) return;
    this.handled.push(sessionId);
    if (this.handled.length > HANDLED_MAX) this.handled.shift();
    const stopped = await player.yield();
    if (!stopped) return;
    if (!byDeviceName) await this.refresh();
    const device = byDeviceName ?? this._session()?.owner.deviceName ?? this.translate.instant('session.another_device');
    const resume = await this.confirmation.confirm({
      title: this.translate.instant('session.superseded_title', { device }),
      message: [
        stopped.title,
        this.translate.instant('session.superseded_message', { position: formatTime(stopped.positionSeconds) }),
      ]
        .filter(Boolean)
        .join('. '),
      confirmLabel: this.translate.instant('session.resume_here'),
      cancelLabel: this.translate.instant('session.close'),
      variant: 'info',
    });
    if (resume) await stopped.resume();
  }

  /** The owner's own report of this very file, while it is being observed. */
  private readonly live = computed(() => {
    const s = this._session();
    const r = s && this.liveSource();
    return r && r.mediaFileId === s.item.mediaFileId ? r : null;
  });

  /** Last report seen for the session's file: the stored session names neither media nor episode, and a parked owner no longer reports. */
  private readonly known = signal<LiveReport | null>(null);

  /** The session's position now: the owner's report when observed, else the stored anchor. */
  positionNow(s: AccountSession): number {
    if (this.live()) return this.livePosition();
    if (!s.playing) return s.positionSeconds;
    const elapsed = (this.clock.serverNow() - Date.parse(s.positionAt)) / 1000;
    return s.positionSeconds + Math.max(0, elapsed);
  }

  private resumerFor(s: AccountSession): SessionResumer | undefined {
    const family = KIND_REGISTRY[s.item.kind].families.find((f) => this.resumers[f]);
    return family && this.resumers[family];
  }

  /** What a start needs beyond the stored session: the media pair for video, the queue alone for an album. */
  private knownFor(s: AccountSession): LiveReport | null {
    const k = this.known();
    if (k && k.mediaFileId === s.item.mediaFileId) return k;
    return s.item.kind === 'album' ? { mediaFileId: s.item.mediaFileId ?? 0, mediaId: null, episodeId: null } : null;
  }

  /** Whether this device can start the item: it has an adapter for the kind and has seen the media the session omits. */
  readonly canPlayHere = computed(() => {
    const s = this._session();
    return !!s && this.role() !== 'owner' && !!this.resumerFor(s) && this.knownFor(s) !== null;
  });

  /** Takes the session over on this device, at its position now; the first beat claims it and the old owner is superseded. */
  async playHere(): Promise<void> {
    const s = this._session();
    const known = s && this.knownFor(s);
    const resumer = s && this.resumerFor(s);
    if (!s || !known || !resumer || this.role() === 'owner') return;
    await resumer(s, { ...known, positionSeconds: this.positionNow(s) });
  }

  /** Masks a parked session; a live one is stopped through its owner instead. */
  async dismiss(): Promise<void> {
    if (!this.parked()) return;
    try {
      await firstValueFrom(this.http.delete<void>('/api/session'));
      this._session.set(null);
    } catch (err) {
      console.warn('[session] failed to dismiss the session', err);
    }
  }
}
