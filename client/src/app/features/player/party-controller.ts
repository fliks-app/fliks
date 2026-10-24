import { Injectable, effect, inject, untracked } from '@angular/core';
import type { Subscription } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { ClockService } from '../../core/services/party/clock.service';
import { PartyService, type PartyLiveState } from '../../core/services/party/party.service';
import { DeviceService } from '../../core/services/device.service';
import { PlayerStateService } from '../../core/services/player-state.service';
import type { PlaybackEngine } from '../../core/services/playback-engine/playback-engine';
import { ToastService } from '../../core/services/toast.service';
import { QueueController } from './queue-controller';
import { DRIFT_CHECK_MS, driftAction, groupPosition } from './party-sync';

export interface PartyHost {
  engine(): PlaybackEngine | null;
  mediaId(): number;
  episodeId(): number | undefined;
  /** Locked seek that does not go through the user path, so nothing is re-emitted. */
  seekTo(time: number): void;
  pausePlayback(): Promise<void>;
  playLocal(): void;
  position(): number;
  onBack(): void;
}

const READY_TIMEOUT_MS = 60_000;
const UNLOCK_TIMEOUT_MS = 35_000;
const POLL_MS = 100;
/** Close enough to the anchor that a seek would only restart a transcode for nothing. */
const SEEK_SLACK_S = 0.25;

/** Keeps the local engine on the party's timeline: user transport actions become intents, `party.state` drives the engine
 *  directly (never through `onTogglePlay`/`onSeek`, so nothing echoes back). */
@Injectable()
export class PartyController {
  private readonly party = inject(PartyService);
  private readonly clock = inject(ClockService);
  private readonly state = inject(PlayerStateService);
  private readonly queueCtl = inject(QueueController);
  private readonly device = inject(DeviceService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private host!: PartyHost;

  private generation = 0;
  private playTimer: ReturnType<typeof setTimeout> | null = null;
  private driftTimer: ReturnType<typeof setInterval> | null = null;
  private lastCorrectiveSeek = 0;
  private applying = false;
  private lastReported: 'ready' | 'buffering' = 'ready';
  private destroyed = false;
  private closedSub: Subscription | null = null;

  readonly active = this.party.active;

  attach(host: PartyHost): void {
    this.host = host;
    this.queueCtl.interceptAdvance = (auto) => {
      if (!this.party.active()) return false;
      if (!auto) void this.requestNext();
      return true;
    };
    this.closedSub = this.party.closed.subscribe(() => host.onBack());
    this.driftTimer = setInterval(() => this.checkDrift(), DRIFT_CHECK_MS);
  }

  dispose(): void {
    this.destroyed = true;
    this.generation++;
    this.clearPlayTimer();
    if (this.driftTimer) clearInterval(this.driftTimer);
    this.queueCtl.interceptAdvance = null;
    this.closedSub?.unsubscribe();
    // Closing the player is leaving the party.
    if (this.party.active()) void this.party.leave();
  }

  // ── Local intent routing (called by the player in place of acting on the engine) ──

  /** True when the party took the action. */
  togglePlay(): boolean {
    if (!this.party.active()) return false;
    if (!this.gate()) return true;
    const live = this.party.live()!;
    // A tap during a wait would race the phase it is already in.
    if (live.state === 'waiting') return true;
    if (live.state === 'idle' && this.state.ended()) void this.replay();
    else void this.party.sendIntent(this.state.uiPaused() ? 'play' : 'pause');
    return true;
  }

  /** Past the end of the item the group would play from the end: restart it. */
  private async replay(): Promise<void> {
    await this.party.sendIntent('seek', { position: 0 });
    await this.party.sendIntent('play');
  }

  seek(time: number): boolean {
    if (!this.party.active()) return false;
    // The drag locked the seekbar; the engine does not move until the server answers.
    this.state.seekLocked.set(false);
    if (this.gate()) void this.party.sendIntent('seek', { position: time });
    return true;
  }

  async requestNext(): Promise<void> {
    if (!this.gate()) return;
    const next = this.queueCtl.upNext();
    if (!next) return;
    await this.party.sendIntent('setItem', {
      item: {
        mediaId: next.mediaId,
        ...(next.mediaFileId != null && { mediaFileId: next.mediaFileId }),
        ...(next.episodeId != null && { episodeId: next.episodeId }),
      },
    });
  }

  /** Forced seek to wherever the group is. */
  resync(): void {
    const live = this.party.live();
    if (live) void this.apply(live, true);
  }

  private gate(): boolean {
    if (this.party.canControl()) return true;
    this.toast.info(this.translate.instant('party.error_host_only'));
    return false;
  }

  // ── Party state -> engine ──

  private readonly liveEffect = effect(() => {
    const live = this.party.live();
    if (!live || !this.host) return;
    untracked(() => void this.apply(live, false));
  });

  /** Reports buffering/ready on engine changes; silent while an apply is settling, which reports `ready` itself. */
  private readonly bufferingEffect = effect(() => {
    const status = this.state.buffering() ? 'buffering' : 'ready';
    untracked(() => {
      if (!this.party.active() || this.applying || status === this.lastReported) return;
      this.lastReported = status;
      void this.party.reportStatus(status, this.host.position());
    });
  });

  /** The host's natural end: `ended`, then the next episode of the queue as an item switch. */
  private readonly endedEffect = effect(() => {
    if (!this.state.ended()) return;
    untracked(() => {
      if (!this.party.active() || !this.party.isHost()) return;
      void this.party.sendIntent('ended').then(() => this.requestNext());
    });
  });

  private async apply(live: PartyLiveState, force: boolean): Promise<void> {
    const gen = ++this.generation;
    this.clearPlayTimer();
    this.applying = true;
    try {
      if (!(await this.untilReady(gen))) return;
      if (this.itemDiffers(live)) {
        await this.queueCtl.openPartyItem(live.item);
        if (!(await this.untilReady(gen))) return;
      }
      const engine = this.host.engine();
      if (!engine) return;
      if (live.state === 'playing') await this.applyPlaying(live, gen, force);
      else await this.applyHeld(live, gen, force);
    } finally {
      if (gen === this.generation) this.applying = false;
    }
  }

  private itemDiffers(live: PartyLiveState): boolean {
    return live.item.mediaId !== this.host.mediaId() || (live.item.episodeId ?? undefined) !== this.host.episodeId();
  }

  /** idle, paused and waiting all hold the engine paused at the anchor; waiting then reports `ready` once the seek has landed. */
  private async applyHeld(live: PartyLiveState, gen: number, force: boolean): Promise<void> {
    await this.host.pausePlayback();
    if (gen !== this.generation) return;
    if (!(await this.seekIfFar(live.anchor.position, gen, force))) return;
    this.reportReady(live.anchor.position);
  }

  private async applyPlaying(live: PartyLiveState, gen: number, force: boolean): Promise<void> {
    const startAt = live.whenMs ?? live.anchor.serverTimeMs;
    const wait = startAt - this.clock.serverNow();
    if (wait > 0) {
      await this.host.pausePlayback();
      if (gen !== this.generation) return;
      if (!(await this.seekIfFar(live.anchor.position, gen, force))) return;
      this.reportReady(live.anchor.position);
      this.playTimer = setTimeout(() => this.host.playLocal(), wait);
      return;
    }
    // Late (or joining mid-play): land on the extrapolated position, then play.
    const target = groupPosition('playing', live.anchor, this.clock.serverNow());
    if (!(await this.seekIfFar(target, gen, force || this.host.engine()?.paused === true))) return;
    this.host.playLocal();
    this.reportReady(this.host.position());
  }

  /** False when a newer apply superseded this one while waiting. */
  private async seekIfFar(target: number, gen: number, force: boolean): Promise<boolean> {
    if (force || Math.abs(this.host.position() - target) > SEEK_SLACK_S) {
      this.host.seekTo(target);
      this.lastCorrectiveSeek = Date.now();
      await this.untilUnlocked(gen);
    }
    return gen === this.generation;
  }

  private reportReady(position: number): void {
    this.lastReported = 'ready';
    void this.party.reportStatus('ready', position);
  }

  private async untilReady(gen: number): Promise<boolean> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!this.destroyed && gen === this.generation && Date.now() < deadline) {
      if (this.host.engine() && this.state.videoStarted()) return true;
      await new Promise<void>((r) => setTimeout(r, POLL_MS));
    }
    return false;
  }

  private async untilUnlocked(gen: number): Promise<void> {
    const deadline = Date.now() + UNLOCK_TIMEOUT_MS;
    while (!this.destroyed && gen === this.generation && this.state.seekLocked() && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, POLL_MS));
    }
  }

  private clearPlayTimer(): void {
    if (this.playTimer) clearTimeout(this.playTimer);
    this.playTimer = null;
  }

  // ── Drift ──

  private rateSupported(): boolean {
    const tv = this.device.tvPlatform();
    return tv !== 'tizen' && tv !== 'webos';
  }

  private checkDrift(): void {
    const live = this.party.live();
    const engine = this.host?.engine();
    if (!live || !engine || live.state !== 'playing' || this.applying) return;
    const now = this.clock.serverNow();
    if (engine.paused || this.state.buffering() || now < (live.whenMs ?? live.anchor.serverTimeMs)) return;
    const drift = this.host.position() - groupPosition('playing', live.anchor, now);
    const action = driftAction(drift, {
      rateSupported: this.rateSupported(),
      msSinceSeek: Date.now() - this.lastCorrectiveSeek,
      seekLocked: this.state.seekLocked(),
    });
    if (action.kind === 'seek') {
      this.lastCorrectiveSeek = Date.now();
      this.host.seekTo(groupPosition('playing', live.anchor, now));
      return;
    }
    const rate = action.kind === 'rate' ? action.rate : 1;
    if (engine.playbackRate !== rate && (action.kind === 'rate' || this.rateSupported())) engine.playbackRate = rate;
  }
}
