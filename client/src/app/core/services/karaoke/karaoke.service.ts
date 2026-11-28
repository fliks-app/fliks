import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { KaraokeApiService } from '../api/karaoke-api.service';
import type { KaraokeItemState, KaraokeJobChanged, KaraokeStatus } from '../api/karaoke.models';
import type { StructuredLyrics } from '../api/lyrics.models';
import type { AudioOutput } from '../audio-player/audio-output';
import { AudioPlayerService } from '../audio-player/audio-player.service';
import { RemoteAudioOutput } from '../audio-player/remote-audio-output';
import { AuthService } from '../auth.service';
import { DeviceService } from '../device.service';
import { PartyService } from '../party/party.service';
import { SseService } from '../sse.service';
import { readStored, writeStored } from '../../utils/local-flag';
import type { Difficulty, PitchFrame } from './karaoke-score';
import { FrameStore, calibrate, scoreAll, type SingerResult } from './karaoke-session';
import { failureText } from './karaoke-failure';
import { singKind, stemsReady, weightedProgress } from './karaoke-prep';
import { VoiceRange } from './key-analysis';
import { KaraokeRelayService } from './karaoke-relay.service';
import { MicCapture } from './mic-capture';
import { MAX_FRAMES_PER_BATCH, encodeBatch } from './pitch-frames';

const LATENCY_KEY = 'karaoke.latency';
const DIFFICULTY_KEY = 'karaoke.difficulty';
const FLUSH_MS = 250;
/** Above the 200 ms steps webOS reports currentTime in, so only a real jump re-anchors the clock. */
const REANCHOR_DRIFT_MS = 250;
/** Share of the gap to the reported position closed per update: drift is absorbed without a visible step. */
const SLEW = 0.1;
/** A playhead this far behind the last frame started another take: the frames after it are dropped. */
const RETAKE_MS = 2000;
const READY_FLASH_MS = 6000;
const BOARD_MS = 15000;
const LATENCY_STEP_MS = 10;

export interface BoardRow extends SingerResult {
  name: string;
}

export interface Board {
  title: string;
  rows: BoardRow[];
}

/** Karaoke of the displayed track: its preparation, the stage, this device's mic out as pitch frames over the party relay, the singers' frames in, scores. */
@Injectable({ providedIn: 'root' })
export class KaraokeService {
  private readonly api = inject(KaraokeApiService);
  private readonly local = inject(AudioPlayerService);
  private readonly remoteOut = inject(RemoteAudioOutput);
  private readonly relay = inject(KaraokeRelayService);
  private readonly party = inject(PartyService);
  private readonly auth = inject(AuthService);
  private readonly translate = inject(TranslateService);
  private readonly device = inject(DeviceService);

  readonly store = new FrameStore();
  /** The karaoke view of the full player, kept while the lyrics are hidden; the cast receiver follows it. A stem mode lasts as long. */
  readonly stage = signal(false);
  readonly status = signal<KaraokeStatus | null>(null);
  /** The displayed track's karaoke state; null until known. */
  readonly itemState = signal<KaraokeItemState | null>(null);
  /** A preparation request is in flight. */
  readonly busy = signal(false);
  /** The "ready, sing" bubble, shown for a few seconds once a preparation made the stems. */
  readonly readyFlash = signal(false);
  /** Item ids whose preparation ended: their generated lyrics changed. */
  readonly prepared = new Subject<number>();
  /** The displayed music track, while karaoke is on. */
  readonly itemId = computed(() => (this.status()?.enabled && this.audio.musicMode() ? this.audio.track()?.itemId : undefined));
  /** Karaoke drives the displayed track: an output that applies stems, and a server that can prepare it or stems already made. */
  readonly available = computed(
    () => this.itemId() !== undefined && (!this.remoteOut.expanded() || this.remoteOut.supports('karaoke')) && (!!this.status()?.ready || stemsReady(this.itemState())),
  );
  /** The Sing button's state; null where karaoke does not apply. */
  readonly singKind = computed(() => (this.available() ? singKind(this.itemState(), this.stage()) : null));
  /** Overall preparation progress 0..100 while running. */
  readonly prepPct = computed(() => weightedProgress(this.itemState()?.stage, this.itemState()?.progress));
  readonly failedReason = computed(() => {
    const e = this.itemState()?.error;
    return e ? failureText(this.translate, e) : '';
  });
  /** The MP3+G graphics of the displayed track: they need karaoke on, not a separation model. */
  readonly cdgFile = computed(() => {
    const s = this.itemState();
    return this.itemId() !== undefined && s?.cdg ? s.fileId : null;
  });
  /** Karaoke is on but this server cannot prepare a track: shown to those who can install a model. */
  readonly needsModel = computed(() => this.itemId() !== undefined && !this.available() && !!this.status() && !this.status()!.ready && this.auth.hasPermission('settings.access'));
  readonly singing = signal(false);
  /** The mic is being opened: the permission prompt can keep it pending for seconds. */
  readonly starting = signal(false);
  readonly micIssue = signal<'denied' | 'unavailable' | null>(null);
  readonly latencyMs = signal(Number(readStored(LATENCY_KEY)) || 0);
  readonly difficulty = signal<Difficulty>(['easy', 'medium', 'hard'].includes(readStored(DIFFICULTY_KEY) ?? '') ? (readStored(DIFFICULTY_KEY) as Difficulty) : 'medium');
  readonly board = signal<Board | null>(null);
  private readonly voice = new VoiceRange();
  /** The range this device's singer sang in, learned from the mic; null until enough was sung. */
  readonly voiceRange = signal(this.voice.range());

  private readonly capture = new MicCapture();
  private pending: PitchFrame[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private startGen = 0;
  private anchor = { pos: 0, at: 0 };
  private anchoredState: { playing: boolean; rate: number; itemId: number | undefined } | null = null;
  private statusLoad: Promise<void> | null = null;
  private stateRun = 0;
  private jobKey = '';
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private boardTimer: ReturnType<typeof setTimeout> | null = null;
  private finishedFor: number | undefined;

  /** What the full player shows: another device's session in remote view, else the local player. */
  private get audio(): AudioOutput {
    return this.remoteOut.expanded() ? this.remoteOut : this.local;
  }

  constructor() {
    this.relay.received.subscribe(({ userId, frames }) => this.ingest(userId, frames));
    effect(() => {
      this.audio.track()?.itemId;
      untracked(() => {
        this.store.clear();
        this.finishedFor = undefined;
        void this.loadStatus();
      });
    });
    effect(() => {
      const id = this.itemId();
      untracked(() => {
        this.itemState.set(null);
        this.jobKey = '';
        this.clearFlash();
        if (id !== undefined) void this.loadState(id);
      });
    });
    // The stage and its stem mode end with the music they sang over.
    effect(() => {
      const live = this.audio.musicMode() && this.audio.track() !== null;
      untracked(() => {
        if (!live) this.stage.set(false);
      });
    });
    let staged = false;
    effect(() => {
      const on = this.stage();
      untracked(() => {
        if (staged && !on) this.audio.setStemMode?.('original');
        staged = on;
      });
    });
    inject(SseService).karaokeEvents.subscribe((e) => {
      const id = this.itemId();
      const j = e as unknown as KaraokeJobChanged;
      if (e.type === 'sse.connected') {
        void this.loadStatus();
        if (id !== undefined) void this.loadState(id);
      } else if (e.type === 'karaoke.job_changed' && j.itemId === id) this.onJob(j);
      this.refreshLocalStems(e.type === 'sse.connected' ? undefined : j);
    });
    effect(() => {
      const state = { playing: this.audio.playing(), rate: this.audio.rate(), itemId: this.audio.track()?.itemId };
      const pos = this.audio.position() * 1000;
      untracked(() => {
        const prev = this.anchoredState;
        const free = prev && prev.playing === state.playing && prev.rate === state.rate && prev.itemId === state.itemId;
        const now = this.mediaMs();
        if (free && state.playing && Math.abs(pos - now) <= REANCHOR_DRIFT_MS) {
          this.anchor = { pos: now + (pos - now) * SLEW, at: performance.now() };
          return;
        }
        if (prev?.itemId === state.itemId && pos < now - RETAKE_MS) this.store.truncate(pos);
        this.anchoredState = state;
        this.anchor = { pos, at: performance.now() };
      });
    });
  }

  private loadStatus(): Promise<void> {
    return (this.statusLoad ??= this.api
      .status()
      .then((s) => this.status.set(s), () => undefined)
      .finally(() => (this.statusLoad = null)));
  }

  /** On the stage the request is a preparation: it marks the stems as sung (eviction) and runs a step left to run. */
  private async loadState(id: number): Promise<void> {
    const run = ++this.stateRun;
    try {
      const s = this.stage() ? await this.api.prepare(id, {}, true).catch(() => this.api.itemState(id)) : await this.api.itemState(id);
      if (run === this.stateRun && this.itemId() === id) this.itemState.set(s);
      if (this.stage()) this.prepareNext();
    } catch {
      // No state: the controls stay hidden.
    }
  }

  /** The next track of a solo queue is prepared while one sings; a party's programme is prepared by the server. */
  private prepareNext(): void {
    const next = this.party.party() ? null : this.audio.neighbour(1);
    if (next && this.status()?.ready) void this.api.prepare(next.itemId, {}, true).catch(() => undefined);
  }

  private onJob(j: KaraokeJobChanged): void {
    const key = `${j.state}:${j.stage ?? ''}`;
    if (key === this.jobKey) return void this.itemState.update((s) => s && { ...s, progress: j.progress });
    this.jobKey = key;
    const had = stemsReady(this.itemState());
    this.itemState.update((s) => s && { ...s, state: j.state, stage: j.stage, progress: j.progress });
    const id = j.itemId;
    const run = ++this.stateRun;
    void this.api.itemState(id).then(
      (s) => {
        if (run !== this.stateRun || this.itemId() !== id) return;
        this.itemState.set(s);
        if (!had && stemsReady(s)) this.flash();
        if (j.state === 'ready' || j.state === 'failed') this.prepared.next(id);
      },
      () => undefined,
    );
  }

  /** The local player looks its stems up again once a job made them, or after a gap in the events; it may play another track than the one shown. */
  private refreshLocalStems(j?: KaraokeJobChanged): void {
    const id = this.local.musicMode() && !this.local.stemsAvailable() ? this.local.track()?.itemId : undefined;
    if (id === undefined) return;
    if (!j || (j.itemId === id && (j.state === 'ready' || (j.state === 'running' && j.stage !== 'separate')))) void this.local.refreshStems();
  }

  /** The Sing button: prepare or retry, else enter or leave the stage. */
  sing(): void {
    switch (this.singKind()) {
      case 'prepare':
      case 'retry':
        void this.prepare({});
        break;
      case 'enter':
        this.enter();
        break;
      case 'exit':
        this.stage.set(false);
    }
  }

  enter(): void {
    this.clearFlash();
    this.stage.set(true);
    const id = this.itemId();
    if (id !== undefined) void this.loadState(id);
  }

  /** Prepares the displayed track; `force` redoes steps of a prepared one. */
  async prepare(body: { align?: boolean; melody?: boolean; force?: boolean }): Promise<void> {
    const id = this.itemId();
    if (id === undefined) return;
    this.busy.set(true);
    try {
      const s = await this.api.prepare(id, body);
      if (this.itemId() !== id) return;
      const had = stemsReady(this.itemState());
      this.itemState.set(s);
      if (!had && stemsReady(s)) this.flash();
    } catch {
      // The interceptor toasts the reason.
    } finally {
      this.busy.set(false);
    }
  }

  /** Cancels the displayed track's preparation and drops its stems and generated lyrics (`media.edit`). */
  async remove(): Promise<void> {
    const id = this.itemId();
    if (id === undefined) return;
    this.busy.set(true);
    try {
      await this.api.remove(id);
      this.stage.set(false);
      if (this.local.track()?.itemId === id) void this.local.refreshStems();
      if (this.itemId() === id) await this.loadState(id);
      this.prepared.next(id);
    } catch {
      // The interceptor toasts the reason.
    } finally {
      this.busy.set(false);
    }
  }

  private flash(): void {
    if (this.stage()) return;
    this.clearFlash();
    this.readyFlash.set(true);
    this.readyTimer = setTimeout(() => this.readyFlash.set(false), READY_FLASH_MS);
  }

  private clearFlash(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.readyFlash.set(false);
  }

  /** Media time in ms, interpolated between the player's position updates. */
  mediaMs(): number {
    return this.anchor.pos + (this.audio.playing() ? (performance.now() - this.anchor.at) * this.audio.rate() : 0);
  }

  get canSing(): boolean {
    return !this.device.isTv() && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== 'undefined';
  }

  private ingest(userId: number, frames: readonly PitchFrame[]): void {
    if (!frames.length) return;
    const key = this.audio.pitch?.() ?? 0;
    this.store.add(userId, frames.map((f) => ({ ...f, key })));
  }

  async startSinging(): Promise<void> {
    const me = this.auth.user()?.id;
    if (this.singing() || this.starting() || me == null || !this.canSing) return;
    this.micIssue.set(null);
    this.starting.set(true);
    const gen = this.startGen;
    try {
      await this.capture.start((raw) => {
        const lag = this.latencyMs();
        const f = { ...raw, t: raw.t - lag, lag };
        // No echo cancelling: only Instrumental keeps the record's voice out of the learned range.
        if (f.midi !== null && this.audio.stemMode?.() === 'instrumental' && this.voice.add(f.midi)) this.voiceRange.set(this.voice.range());
        this.ingest(me, [f]);
        this.pending.push(f);
        if (this.pending.length >= MAX_FRAMES_PER_BATCH) this.flush();
      }, () => this.mediaMs());
      if (gen !== this.startGen) {
        this.capture.stop();
        return;
      }
      if (this.party.party() && !this.relay.isDisplay()) this.relay.open('singer');
      this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
      this.singing.set(true);
    } catch (err) {
      if (gen === this.startGen) this.micIssue.set(err instanceof DOMException && err.name === 'NotAllowedError' ? 'denied' : 'unavailable');
    } finally {
      this.starting.set(false);
    }
  }

  stopSinging(): void {
    this.startGen++;
    this.capture.stop();
    this.voice.save();
    this.voiceRange.set(this.voice.range());
    this.relay.close('singer');
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.pending = [];
    this.singing.set(false);
  }

  private flush(): void {
    if (!this.pending.length) return;
    const batch = this.pending.splice(0, MAX_FRAMES_PER_BATCH);
    this.relay.send(encodeBatch(batch));
  }

  setDifficulty(d: Difficulty): void {
    this.difficulty.set(d);
    writeStored(DIFFICULTY_KEY, d);
  }

  /** This device's capture delay, removed from its frames as they are captured, so every display scores them alike. */
  setLatency(ms: number): void {
    const v = Math.round(Math.min(2000, Math.max(-2000, ms)));
    this.latencyMs.set(v);
    writeStored(LATENCY_KEY, String(v));
  }

  nudgeLatency(steps: number): void {
    this.setLatency(this.latencyMs() + steps * LATENCY_STEP_MS);
  }

  /** Sets the capture delay from this device's take as it was stamped; false when too few notes matched. */
  calibrate(doc: StructuredLyrics): boolean {
    const me = this.auth.user()?.id;
    const raw = me == null ? [] : this.store.frames(me).map((f) => ({ ...f, t: f.t + (f.lag ?? 0) }));
    const ms = calibrate(doc, raw);
    if (ms === null) return false;
    this.setLatency(ms);
    return true;
  }

  results(doc: StructuredLyrics): BoardRow[] {
    return scoreAll(doc, this.store, this.difficulty(), undefined, this.audio.pitch?.() ?? 0).map((r) => ({ ...r, name: this.nameOf(r.userId) }));
  }

  /** Ends the song for the scoreboard, once per track: nothing is shown when nobody sang. */
  finish(doc: StructuredLyrics, title: string): void {
    const id = this.audio.track()?.itemId;
    if (id === undefined || this.finishedFor === id) return;
    const rows = this.results(doc).sort((a, b) => b.score - a.score);
    if (!rows.length) return;
    this.finishedFor = id;
    this.board.set({ title, rows });
    if (this.boardTimer) clearTimeout(this.boardTimer);
    this.boardTimer = setTimeout(() => this.dismissBoard(), BOARD_MS);
  }

  dismissBoard(): void {
    if (this.boardTimer) clearTimeout(this.boardTimer);
    this.boardTimer = null;
    this.board.set(null);
  }

  private nameOf(userId: number): string {
    return (
      this.party.members().find((m) => m.userId === userId)?.username ??
      (this.auth.user()?.id === userId ? this.auth.user()!.username : this.translate.instant('karaoke.singer', { n: userId }))
    );
  }
}
