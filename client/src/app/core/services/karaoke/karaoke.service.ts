import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import type { StructuredLyrics } from '../api/lyrics.models';
import type { AudioOutput } from '../audio-player/audio-output';
import { AudioPlayerService } from '../audio-player/audio-player.service';
import { RemoteAudioOutput } from '../audio-player/remote-audio-output';
import { AuthService } from '../auth.service';
import { DeviceService } from '../device.service';
import { PartyService } from '../party/party.service';
import { readStored, writeStored } from '../../utils/local-flag';
import type { Difficulty, PitchFrame } from './karaoke-score';
import { FrameStore, calibrate, scoreAll, type SingerResult } from './karaoke-session';
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

export interface BoardRow extends SingerResult {
  name: string;
}

export interface Board {
  title: string;
  rows: BoardRow[];
}

/** Karaoke of the current party or device: this device's mic out as pitch frames over the party relay, the singers' frames in, scores. */
@Injectable({ providedIn: 'root' })
export class KaraokeService {
  private readonly local = inject(AudioPlayerService);
  private readonly remoteOut = inject(RemoteAudioOutput);
  private readonly relay = inject(KaraokeRelayService);
  private readonly party = inject(PartyService);
  private readonly auth = inject(AuthService);
  private readonly translate = inject(TranslateService);
  private readonly device = inject(DeviceService);

  readonly store = new FrameStore();
  /** The karaoke view of the full player, kept while the lyrics are hidden; the cast receiver follows it. */
  readonly stage = signal(false);
  readonly singing = signal(false);
  /** The mic is being opened: the permission prompt can keep it pending for seconds. */
  readonly starting = signal(false);
  readonly micIssue = signal<'denied' | 'unavailable' | null>(null);
  readonly latencyMs = signal(Number(readStored(LATENCY_KEY)) || 0);
  readonly difficulty = signal<Difficulty>(['easy', 'medium', 'hard'].includes(readStored(DIFFICULTY_KEY) ?? '') ? (readStored(DIFFICULTY_KEY) as Difficulty) : 'medium');
  readonly board = signal<Board | null>(null);

  private readonly capture = new MicCapture();
  private pending: PitchFrame[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private startGen = 0;
  private anchor = { pos: 0, at: 0 };
  private anchoredState: { playing: boolean; rate: number; itemId: number | undefined } | null = null;

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
      });
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
        this.anchoredState = state;
        this.anchor = { pos, at: performance.now() };
      });
    });
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
      await this.capture.start((f) => {
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
      this.micIssue.set(err instanceof DOMException && err.name === 'NotAllowedError' ? 'denied' : 'unavailable');
    } finally {
      this.starting.set(false);
    }
  }

  stopSinging(): void {
    this.startGen++;
    this.capture.stop();
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

  setLatency(ms: number): void {
    this.latencyMs.set(ms);
    writeStored(LATENCY_KEY, String(ms));
  }

  /** Sets the capture delay from this device's take on the song; false when too few notes matched. */
  calibrate(doc: StructuredLyrics): boolean {
    const me = this.auth.user()?.id;
    const ms = me == null ? null : calibrate(doc, this.store.frames(me));
    if (ms === null) return false;
    this.setLatency(Math.round(ms));
    return true;
  }

  results(doc: StructuredLyrics): BoardRow[] {
    return scoreAll(doc, this.store, this.difficulty(), this.latencyMs(), undefined, this.audio.pitch?.() ?? 0).map((r) => ({ ...r, name: this.nameOf(r.userId) }));
  }

  /** Ends the song for the scoreboard: nothing is shown when nobody sang. */
  finish(doc: StructuredLyrics, title: string): void {
    const rows = this.results(doc).sort((a, b) => b.score - a.score);
    if (!rows.length || this.board()) return;
    this.board.set({ title, rows });
  }

  dismissBoard(): void {
    this.board.set(null);
    this.store.clear();
  }

  private nameOf(userId: number): string {
    return (
      this.party.members().find((m) => m.userId === userId)?.username ??
      (this.auth.user()?.id === userId ? this.auth.user()!.username : this.translate.instant('karaoke.singer', { n: userId }))
    );
  }
}
