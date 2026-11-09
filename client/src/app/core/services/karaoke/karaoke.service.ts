import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import type { StructuredLyrics } from '../api/lyrics.models';
import { AudioPlayerService } from '../audio-player/audio-player.service';
import { AuthService } from '../auth.service';
import { DeviceService } from '../device.service';
import { PartyService } from '../party/party.service';
import { readStored, writeStored } from '../party/local-flag';
import type { Difficulty, PitchFrame } from './karaoke-score';
import { FrameStore, calibrate, scoreAll, type SingerResult } from './karaoke-session';
import { KaraokeRelayService } from './karaoke-relay.service';
import { MicCapture } from './mic-capture';
import { MAX_FRAMES_PER_BATCH, encodeBatch } from './pitch-frames';

const LATENCY_KEY = 'karaoke.latency';
const DIFFICULTY_KEY = 'karaoke.difficulty';
const FLUSH_MS = 250;
const HISTORY_MAX = 50;

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
  private readonly audio = inject(AudioPlayerService);
  private readonly relay = inject(KaraokeRelayService);
  private readonly party = inject(PartyService);
  private readonly auth = inject(AuthService);
  private readonly translate = inject(TranslateService);
  private readonly device = inject(DeviceService);

  readonly store = new FrameStore();
  readonly singing = signal(false);
  readonly micIssue = signal<'denied' | 'unavailable' | null>(null);
  readonly latencyMs = signal(Number(readStored(LATENCY_KEY)) || 0);
  readonly difficulty = signal<Difficulty>(['easy', 'medium', 'hard'].includes(readStored(DIFFICULTY_KEY) ?? '') ? (readStored(DIFFICULTY_KEY) as Difficulty) : 'medium');
  /** Frames arrived since the track started: bumped per batch so views can re-score. */
  readonly frameCount = signal(0);
  readonly board = signal<Board | null>(null);
  readonly history = signal<Board[]>([]);

  private readonly capture = new MicCapture();
  private pending: PitchFrame[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private anchor = { pos: 0, at: 0 };

  constructor() {
    this.relay.received.subscribe(({ userId, frames }) => this.ingest(userId, frames));
    effect(() => {
      this.audio.track()?.itemId;
      untracked(() => {
        this.store.clear();
        this.frameCount.set(0);
      });
    });
    effect(() => {
      this.anchor = { pos: this.audio.position() * 1000, at: performance.now() };
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
    this.store.add(userId, frames);
    this.frameCount.update((n) => n + frames.length);
  }

  async startSinging(): Promise<void> {
    const me = this.auth.user()?.id;
    if (this.singing() || me == null || !this.canSing) return;
    this.micIssue.set(null);
    try {
      await this.capture.start((f) => {
        this.ingest(me, [f]);
        this.pending.push(f);
        if (this.pending.length >= MAX_FRAMES_PER_BATCH) this.flush();
      }, () => this.mediaMs());
      if (this.party.party() && !this.relay.isDisplay()) this.relay.open('singer');
      this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
      this.singing.set(true);
    } catch (err) {
      this.micIssue.set(err instanceof DOMException && err.name === 'NotAllowedError' ? 'denied' : 'unavailable');
    }
  }

  stopSinging(): void {
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
    return scoreAll(doc, this.store, this.difficulty(), this.latencyMs()).map((r) => ({ ...r, name: this.nameOf(r.userId) }));
  }

  /** Ends the song for the scoreboard: nothing is shown when nobody sang. */
  finish(doc: StructuredLyrics, title: string): void {
    const rows = this.results(doc).sort((a, b) => b.score - a.score);
    if (!rows.length || this.board()) return;
    const board = { title, rows };
    this.board.set(board);
    this.history.update((h) => [...h, board].slice(-HISTORY_MAX));
  }

  dismissBoard(): void {
    this.board.set(null);
    this.store.clear();
    this.frameCount.set(0);
  }

  private nameOf(userId: number): string {
    return (
      this.party.members().find((m) => m.userId === userId)?.username ??
      (this.auth.user()?.id === userId ? this.auth.user()!.username : this.translate.instant('karaoke.singer', { n: userId }))
    );
  }
}
