import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import type { Subscription } from 'rxjs';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { ClockService } from '../../core/services/party/clock.service';
import { PartyService, type PartyLiveState } from '../../core/services/party/party.service';
import { DeviceService } from '../../core/services/device.service';
import { PlayerStateService } from '../../core/services/player-state.service';
import type { PlaybackEngine } from '../../core/services/playback-engine/playback-engine';
import { ToastService } from '../../core/services/toast.service';
import { NativeEngine } from '../../core/services/playback-engine/native-engine';
import { NativePlayer } from '../../core/plugins/native-player.plugin';
import { VoiceService } from '../../core/services/party/voice.service';
import { QueueController } from './queue-controller';
import type { QueueItem } from '../../core/services/playback-queue.service';
import { VoiceDucker } from './party-ducking';
import { PlaybackSession, type PlaybackCommand } from '../../core/services/playback/playback-session';
import type { PlaybackOutput } from '../../core/services/playback/playback-output';
import { DRIFT_CHECK_MS, driftAction, driftProfile, groupPosition } from './party-sync';

export interface PartyHost {
  engine(): PlaybackEngine | null;
  /** The party no longer drives playback (its rejoin failed): play as a solo player would. */
  releasePlayback(): void;
  onBack(): void;
  showControls(): void;
}

const READY_TIMEOUT_MS = 60_000;
const UNLOCK_TIMEOUT_MS = 35_000;
const POLL_MS = 100;

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
  private readonly voice = inject(VoiceService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly session = inject(PlaybackSession);
  private host!: PartyHost;
  private readonly ducker = new VoiceDucker(
    () => this.host?.engine() ?? null,
    () => this.state.volume(),
    (level) => this.state.noteDuckWrite(level),
  );

  private generation = 0;
  private playTimer: ReturnType<typeof setTimeout> | null = null;
  private driftTimer: ReturnType<typeof setInterval> | null = null;
  private lastCorrectiveSeek = 0;
  private applying = false;
  private lastReported: 'ready' | 'buffering' = 'ready';
  private destroyed = false;
  private closedSub: Subscription | null = null;
  private unroute: (() => void) | null = null;

  readonly active = this.party.active;

  /** A reload's `party=` being rejoined: the party already drives playback. */
  private readonly resuming = signal(false);

  /** A party drives playback: its player always opens paused and plays when the group does. */
  startsPaused(): boolean {
    return this.party.active() || this.resuming();
  }

  /** The active output: the receiver while a Cast session is up, else the local engine. */
  private out(): PlaybackOutput {
    return this.session.output()!;
  }

  private readonly takeCommand = (c: PlaybackCommand): boolean => {
    switch (c.type) {
      case 'toggle':
        return this.togglePlay();
      case 'seek':
        return this.seek(c.at);
      case 'next':
        void this.requestNext();
        return true;
      case 'prev':
        void this.requestPrevious();
        return true;
      case 'item':
        void this.requestQueueItem(c.index);
        return true;
    }
  };

  attach(host: PartyHost): void {
    this.host = host;
    this.unroute = this.session.setPartyRouter(this.takeCommand);
    this.closedSub = this.party.closed.subscribe(() => this.goHome());
    this.driftTimer = setInterval(() => this.checkDrift(), DRIFT_CHECK_MS);
    void this.resumeFromUrl();
  }

  /** A reloaded player carries `party=<id>` while the in-memory party is gone: rejoin it, else play solo. */
  private async resumeFromUrl(): Promise<void> {
    const id = Number(this.route.snapshot.queryParams['party']);
    if (!id || this.party.party()?.id === id) return;
    this.resuming.set(true);
    const ok = await this.party.resume(id).finally(() => this.resuming.set(false));
    if (ok || this.destroyed) return;
    this.toast.error(this.translate.instant('party.error_resume'));
    this.host.releasePlayback();
    void this.router.navigate([], { relativeTo: this.route, queryParams: { party: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  /** Explicit leave: a host's ends the party (the `party.closed` event exits), a member's goes home here. */
  async leave(): Promise<void> {
    const wasHost = this.party.isHost();
    if ((await this.party.leaveOrEnd()) && !wasHost) this.goHome();
  }

  private goHome(): void {
    void this.router.navigateByUrl('/', { replaceUrl: true });
  }

  dispose(): void {
    this.destroyed = true;
    this.generation++;
    this.clearPlayTimer();
    if (this.driftTimer) clearInterval(this.driftTimer);
    this.ducker.stop();
    this.unroute?.();
    this.closedSub?.unsubscribe();
    // Closing the player is leaving the party.
    if (this.party.active()) void this.party.leave();
  }

  // ── Local intent routing (called by the player in place of acting on the engine) ──

  /** True when the party took the action. */
  togglePlay(): boolean {
    if (!this.party.active()) return false;
    if (!this.gate()) return true;
    const live = this.party.live();
    if (!live) return true;
    // A tap during a wait would race the phase it is already in.
    if (live.state === 'waiting') return true;
    if (live.state === 'idle' && this.out().ended()) void this.replay();
    else void this.party.sendIntent(this.out().uiPaused() ? 'play' : 'pause');
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

  /** The server picks the item, skipping what a member cannot open, and refuses where there is no queue. */
  async requestNext(): Promise<void> {
    if (this.gate()) await this.party.sendIntent('next');
  }

  async requestPrevious(): Promise<void> {
    if (this.gate()) await this.party.sendIntent('previous');
  }

  /** An item picked from the queue menu: the server moves everyone, this device included. */
  async requestQueueItem(index: number): Promise<void> {
    const item = this.queueCtl.queueItems()[index];
    if (item && index !== this.queueCtl.queueIndex()) await this.requestItem(item);
  }

  private async requestItem(item: QueueItem): Promise<void> {
    if (!this.gate()) return;
    await this.party.sendIntent('setItem', {
      item: {
        mediaId: item.mediaId,
        ...(item.mediaFileId != null && { mediaFileId: item.mediaFileId }),
        ...(item.episodeId != null && { episodeId: item.episodeId }),
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

  private readonly duckEffect = effect(() => {
    const duck = this.voice.duck() && this.voice.othersSpeaking();
    untracked(() => (this.host ? this.ducker.set(duck) : undefined));
  });

  /** The native audio session must record and play while the WebView holds the mic. */
  private readonly voiceSessionEffect = effect(() => {
    const active = this.voice.joined();
    untracked(() => {
      if (this.host?.engine() instanceof NativeEngine) NativePlayer.setVoiceActive({ active }).catch(() => {});
    });
  });

  /** A handoff changes which output the party drives: bring the new one to the group's position. */
  private lastOutput: PlaybackOutput | null = null;
  private readonly outputEffect = effect(() => {
    const out = this.session.output();
    untracked(() => {
      const moved = !!this.lastOutput && !!out && out !== this.lastOutput;
      this.lastOutput = out;
      if (moved && this.host && this.party.active()) this.resync();
    });
  });

  private lastLiveState: PartyLiveState['state'] | null = null;
  private readonly liveEffect = effect(() => {
    const live = this.party.live();
    if (!live || !this.host) return;
    // Whoever paused, everyone gets the bar, as after their own pause.
    if (live.state === 'paused' && this.lastLiveState === 'playing') untracked(() => this.host!.showControls());
    this.lastLiveState = live.state;
    untracked(() => void this.apply(live, false));
  });

  /** Reports buffering/ready on engine changes; silent while an apply is settling, which reports `ready` itself. */
  private readonly bufferingEffect = effect(() => {
    const status = this.out().buffering() ? 'buffering' : 'ready';
    untracked(() => {
      if (!this.party.active() || this.applying || status === this.lastReported) return;
      this.lastReported = status;
      void this.party.reportStatus(status, this.out().position());
    });
  });

  /** The host's natural end: the server idles the party and moves it on along its queue. */
  private readonly endedEffect = effect(() => {
    if (!this.out().ended()) return;
    untracked(() => {
      if (!this.party.active() || !this.party.isHost()) return;
      const { mediaId, episodeId } = this.out().item();
      void this.party.sendIntent('ended', { item: { mediaId, ...(episodeId != null && { episodeId }) } });
    });
  });

  private async apply(live: PartyLiveState, force: boolean): Promise<void> {
    const gen = ++this.generation;
    this.clearPlayTimer();
    this.applying = true;
    try {
      if (!(await this.untilReady(gen))) return;
      if (this.itemDiffers(live)) {
        if (!(await this.queueCtl.openPartyItem(live.item))) {
          // This device cannot open it: the group must not wait on us.
          if (gen === this.generation) this.host.onBack();
          return;
        }
        if (!(await this.untilReady(gen))) return;
      }
      if (!this.out().ready()) return;
      if (live.state === 'playing') await this.applyPlaying(live, gen, force);
      else await this.applyHeld(live, gen, force);
    } finally {
      if (gen === this.generation) this.applying = false;
    }
  }

  private itemDiffers(live: PartyLiveState): boolean {
    const cur = this.out().item();
    return live.item.mediaId !== cur.mediaId || (live.item.episodeId ?? undefined) !== cur.episodeId;
  }

  /** idle, paused and waiting all hold the engine paused at the anchor; waiting then reports `ready` once the seek has landed. */
  private async applyHeld(live: PartyLiveState, gen: number, force: boolean): Promise<void> {
    await this.out().pause();
    if (gen !== this.generation) return;
    if (!(await this.seekIfFar(live.anchor.position, gen, force))) return;
    this.reportReady(live.anchor.position);
  }

  private async applyPlaying(live: PartyLiveState, gen: number, force: boolean): Promise<void> {
    const startAt = live.whenMs ?? live.anchor.serverTimeMs;
    const wait = startAt - this.clock.serverNow();
    if (wait > 0) {
      await this.out().pause();
      if (gen !== this.generation) return;
      if (!(await this.seekIfFar(live.anchor.position, gen, force))) return;
      this.reportReady(live.anchor.position);
      this.playTimer = setTimeout(() => this.out().play(), wait);
      return;
    }
    // Late (or joining mid-play): land on the extrapolated position, then play.
    const target = groupPosition('playing', live.anchor, this.clock.serverNow());
    if (!(await this.seekIfFar(target, gen, force || this.out().paused()))) return;
    this.out().play();
    this.reportReady(this.out().position());
  }

  /** False when a newer apply superseded this one while waiting. */
  private async seekIfFar(target: number, gen: number, force: boolean): Promise<boolean> {
    const out = this.out();
    if (force || Math.abs(out.position() - target) > out.sync.slackS + (out.sync.stepS?.() ?? 0)) {
      out.seek(target);
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
      if (this.out().ready()) return true;
      await new Promise<void>((r) => setTimeout(r, POLL_MS));
    }
    return false;
  }

  private async untilUnlocked(gen: number): Promise<void> {
    const deadline = Date.now() + UNLOCK_TIMEOUT_MS;
    while (!this.destroyed && gen === this.generation && this.out().seekLocked() && Date.now() < deadline) {
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
    const out = this.out();
    if (!live || !this.host || !out.ready() || live.state !== 'playing' || this.applying) return;
    const now = this.clock.serverNow();
    if (out.paused() || out.buffering() || now < (live.whenMs ?? live.anchor.serverTimeMs)) return;
    const drift = out.position() - groupPosition('playing', live.anchor, now);
    const rate = out.sync.rate;
    const rateOk = !!rate && this.rateSupported();
    const positionStepS = out.sync.stepS?.() ?? 0;
    const action = driftAction(drift, {
      rateSupported: rateOk,
      msSinceSeek: Date.now() - this.lastCorrectiveSeek,
      seekLocked: out.seekLocked(),
      ...(out.sync.drift ?? driftProfile({ positionStepS, rateSupported: rateOk })),
    });
    if (action.kind === 'seek') {
      this.lastCorrectiveSeek = Date.now();
      out.seek(groupPosition('playing', live.anchor, now));
      return;
    }
    if (!rate) return;
    const target = action.kind === 'rate' ? action.rate : 1;
    if (rate.get() !== target && (action.kind === 'rate' || this.rateSupported())) rate.set(target);
  }
}
