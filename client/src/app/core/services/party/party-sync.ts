import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { MediaService } from '../api/media.service';
import type { PartyItem } from '../api/party-api.service';
import { ClockService } from './clock.service';
import { PartyService, type PartyLiveState } from './party.service';
import { DeviceService } from '../device.service';
import { PlayerStateService } from '../player-state.service';
import type { PlaybackEngine } from '../playback-engine/playback-engine';
import { PlaybackQueueService, type QueueItem } from '../playback-queue.service';
import { ToastService } from '../toast.service';
import { VoiceService } from './voice.service';
import { VoiceDucker } from './party-ducking';
import { PlaybackSession, type PlaybackCommand } from '../playback/playback-session';
import type { PlaybackOutput } from '../playback/playback-output';
import { resolvePlayableFile } from '../../../shared/utils/media-play.util';
import { DRIFT_CHECK_MS, driftAction, driftProfile, groupPosition } from './party-drift';

/** What a mounted player lends the party sync; cleared when the player goes. */
export interface PartyHost {
  engine(): PlaybackEngine | null;
  /** The `party=` of the player's URL, 0 when absent. */
  urlPartyId(): number;
  /** The party no longer drives playback (its rejoin failed): play as a solo player would. */
  releasePlayback(): void;
  onBack(): void;
  showControls(): void;
  /** Loads the item the party moved to on the player's output; false when it cannot be opened. */
  openItem(item: PartyItem): Promise<boolean>;
}

const READY_TIMEOUT_MS = 60_000;
const UNLOCK_TIMEOUT_MS = 35_000;
const POLL_MS = 100;

/** Keeps the active output on the party's timeline: user transport actions become intents, `party.state` drives the
 *  output directly (never through `onTogglePlay`/`onSeek`, so nothing echoes back). Outlives the player route. */
@Injectable({ providedIn: 'root' })
export class PartySync {
  private readonly party = inject(PartyService);
  private readonly clock = inject(ClockService);
  private readonly state = inject(PlayerStateService);
  private readonly queue = inject(PlaybackQueueService);
  private readonly device = inject(DeviceService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly voice = inject(VoiceService);
  private readonly router = inject(Router);
  private readonly session = inject(PlaybackSession);
  private readonly mediaService = inject(MediaService);
  private readonly host = signal<PartyHost | null>(null);
  private readonly ducker = new VoiceDucker(
    () => this.host()?.engine() ?? null,
    () => this.state.volume(),
    (level) => this.state.noteDuckWrite(level),
  );

  private generation = 0;
  private playTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCorrectiveSeek = 0;
  private applying = false;
  private lastReported: 'ready' | 'buffering' = 'ready';
  /** The party this device last drove an output for: only then may it release a waiting phase without one. */
  private droveParty: number | undefined;

  readonly active = this.party.active;

  /** A reload's `party=` being rejoined: the party already drives playback. */
  private readonly resuming = signal(false);

  constructor() {
    this.session.setPartyRouter(this.takeCommand);
    this.party.closed.subscribe(() => this.host() && this.goHome());
    const drift = setInterval(() => this.checkDrift(), DRIFT_CHECK_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(drift));
  }

  /** A party drives playback: its player always opens paused and plays when the group does. */
  startsPaused(): boolean {
    return this.party.active() || this.resuming();
  }

  /** The active output, or null once the player closed and nothing else plays. */
  private out(): PlaybackOutput | null {
    return this.session.output();
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

  /** A player registers while mounted; the disposer only clears its own registration. */
  attach(host: PartyHost): () => void {
    this.host.set(host);
    void this.resumeFromUrl(host);
    return () => {
      if (this.host() !== host) return;
      this.host.set(null);
      this.ducker.stop();
    };
  }

  /** A reloaded player carries `party=<id>` while the in-memory party is gone: rejoin it, else play solo. */
  private async resumeFromUrl(host: PartyHost): Promise<void> {
    const id = host.urlPartyId();
    if (!id || this.party.party()?.id === id) return;
    this.resuming.set(true);
    const ok = await this.party.resume(id).finally(() => this.resuming.set(false));
    if (this.host() !== host) {
      if (ok) await this.party.leave();
      return;
    }
    if (ok) return;
    this.toast.error(this.translate.instant('party.error_resume'));
    host.releasePlayback();
    void this.router.navigate([], { queryParams: { party: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  /** A member leaves the party (the host ends it instead) and goes home. */
  async leave(): Promise<void> {
    await this.party.leave();
    this.goHome();
  }

  private goHome(): void {
    void this.router.navigateByUrl('/', { replaceUrl: true });
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
    const out = this.out();
    if (live.state === 'idle' && out?.ended()) void this.replay();
    else void this.party.sendIntent(out?.uiPaused() ? 'play' : 'pause');
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
    const item = this.queue.items()[index];
    if (item && index !== this.queue.index()) await this.requestItem(item);
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
    const host = this.host();
    untracked(() => (host ? this.ducker.set(duck) : undefined));
  });

  /** A new output (a handoff, a reopened player) is brought to the group's position; none left, the group stops waiting on us. */
  private lastOutput: PlaybackOutput | null = null;
  private readonly outputEffect = effect(() => {
    const out = this.session.output();
    untracked(() => {
      const previous = this.lastOutput;
      this.lastOutput = out;
      const live = this.party.live();
      if (!this.party.active() || !live || out === previous) return;
      if (out) void this.apply(live, !!previous);
      else this.stopDriving(live);
    });
  });

  /** Without an output the member stays in the party, ready at the group's position: only `ready` releases a waiting phase. */
  private stopDriving(live: PartyLiveState): void {
    this.generation++;
    this.clearPlayTimer();
    this.applying = false;
    this.reportReady(groupPosition(live.state, live.anchor, this.clock.serverNow()));
  }

  private lastLiveState: PartyLiveState['state'] | null = null;
  private readonly liveEffect = effect(() => {
    const live = this.party.live();
    if (!live) return;
    // Whoever paused, everyone gets the bar, as after their own pause.
    if (live.state === 'paused' && this.lastLiveState === 'playing') untracked(() => this.host()?.showControls());
    this.lastLiveState = live.state;
    untracked(() => void this.apply(live, false));
  });

  /** Reports buffering/ready on engine changes; silent while an apply is settling, which reports `ready` itself. */
  private readonly bufferingEffect = effect(() => {
    const out = this.out();
    const status = out?.buffering() ? 'buffering' : 'ready';
    untracked(() => {
      if (!out || !this.party.active() || this.applying || status === this.lastReported) return;
      this.lastReported = status;
      void this.party.reportStatus(status, out.position());
    });
  });

  /** The host's natural end: the server idles the party and moves it on along its queue. */
  private readonly endedEffect = effect(() => {
    const out = this.out();
    if (!out?.ended()) return;
    untracked(() => {
      if (!this.party.active() || !this.party.isHost()) return;
      const { mediaId, episodeId } = out.item();
      void this.party.sendIntent('ended', { item: { mediaId, ...(episodeId != null && { episodeId }) } });
    });
  });

  private async apply(live: PartyLiveState, force: boolean): Promise<void> {
    const gen = ++this.generation;
    this.clearPlayTimer();
    if (!this.out()) {
      const id = this.party.party()?.id;
      if (live.state === 'waiting' && id !== undefined && id === this.droveParty) this.stopDriving(live);
      return;
    }
    this.droveParty = this.party.party()?.id;
    this.applying = true;
    try {
      if (!(await this.untilReady(gen))) return;
      if (this.itemDiffers(live)) {
        if (!(await this.openItem(live.item))) {
          // This device cannot open it: the group must not wait on us.
          if (gen !== this.generation) return;
          this.reportReady(live.anchor.position);
          this.host()?.onBack();
          return;
        }
        if (!(await this.untilReady(gen))) return;
      }
      const out = this.out();
      if (!out?.ready()) return;
      if (live.state === 'playing') await this.applyPlaying(out, live, gen, force);
      else await this.applyHeld(out, live, gen, force);
    } finally {
      if (gen === this.generation) this.applying = false;
    }
  }

  /** The player's queue opens it where one is mounted; a Cast output without a player is handed the file directly. */
  private async openItem(item: PartyItem): Promise<boolean> {
    const host = this.host();
    if (host) return host.openItem(item);
    const media = await this.mediaService.getOne(item.mediaId).catch(() => null);
    const fileId = item.mediaFileId ?? (media ? (resolvePlayableFile(media, item.episodeId ?? undefined)?.id ?? null) : null);
    if (fileId == null) {
      this.toast.error(this.translate.instant('player.next_unavailable'));
      return false;
    }
    await this.session.play(
      { fileId, mediaId: item.mediaId, episodeId: item.episodeId ?? undefined, title: media?.title ?? '', fanartUrl: media?.fanartUrl ?? null },
      { fromStart: true, expand: false },
    );
    return true;
  }

  private itemDiffers(live: PartyLiveState): boolean {
    const cur = this.out()?.item();
    return !cur || live.item.mediaId !== cur.mediaId || (live.item.episodeId ?? undefined) !== cur.episodeId;
  }

  /** idle, paused and waiting all hold the engine paused at the anchor; waiting then reports `ready` once the seek has landed. */
  private async applyHeld(out: PlaybackOutput, live: PartyLiveState, gen: number, force: boolean): Promise<void> {
    await out.pause();
    if (gen !== this.generation) return;
    if (!(await this.seekIfFar(out, live.anchor.position, gen, force))) return;
    this.reportReady(live.anchor.position);
  }

  private async applyPlaying(out: PlaybackOutput, live: PartyLiveState, gen: number, force: boolean): Promise<void> {
    const startAt = live.whenMs ?? live.anchor.serverTimeMs;
    const wait = startAt - this.clock.serverNow();
    if (wait > 0) {
      await out.pause();
      if (gen !== this.generation) return;
      if (!(await this.seekIfFar(out, live.anchor.position, gen, force))) return;
      this.reportReady(live.anchor.position);
      this.playTimer = setTimeout(() => out.play(), wait);
      return;
    }
    // Late (or joining mid-play): land on the extrapolated position, then play.
    const target = groupPosition('playing', live.anchor, this.clock.serverNow());
    if (!(await this.seekIfFar(out, target, gen, force || out.paused()))) return;
    out.play();
    this.reportReady(out.position());
  }

  /** False when a newer apply superseded this one while waiting. */
  private async seekIfFar(out: PlaybackOutput, target: number, gen: number, force: boolean): Promise<boolean> {
    if (force || Math.abs(out.position() - target) > out.sync.slackS + (out.sync.stepS?.() ?? 0)) {
      out.seek(target);
      this.lastCorrectiveSeek = Date.now();
      await this.untilUnlocked(out, gen);
    }
    return gen === this.generation;
  }

  private reportReady(position: number): void {
    this.lastReported = 'ready';
    void this.party.reportStatus('ready', position);
  }

  private async untilReady(gen: number): Promise<boolean> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (gen === this.generation && Date.now() < deadline) {
      if (this.out()?.ready()) return true;
      await new Promise<void>((r) => setTimeout(r, POLL_MS));
    }
    return false;
  }

  private async untilUnlocked(out: PlaybackOutput, gen: number): Promise<void> {
    const deadline = Date.now() + UNLOCK_TIMEOUT_MS;
    while (gen === this.generation && out.seekLocked() && Date.now() < deadline) {
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
    if (!live || !out?.ready() || live.state !== 'playing' || this.applying) return;
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
