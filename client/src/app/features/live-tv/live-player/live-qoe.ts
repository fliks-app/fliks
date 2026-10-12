import type { PlaybackEngine, PlaybackState, QoeSample } from '../../../core/services/playback-engine/playback-engine';
import type { QoeReporter } from '../../../core/services/qoe-reporter.service';
import { PlayerQoe } from '../../player/player-qoe';

export const LIVE_HEARTBEAT_MS = 10_000;
const TICK_MS = 1_000;
const FROZEN_AFTER_MS = 1_000;
const SEEK_GRACE_MS = 2_000;

/** Stall accounting and the QoE heartbeat of one live channel tune-in. */
export class LiveQoe {
  private readonly qoe: PlayerQoe;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sid: string | undefined;
  private engine: (() => PlaybackEngine | null) | null = null;
  private started = false;
  private buffering = false;
  private paused = false;
  private frozenSince = 0;
  private lastPos = -1;
  private lastAdvanceAt = 0;
  private lastSeekAt = 0;
  private lastBeatAt = 0;

  constructor(
    reporter: QoeReporter,
    private readonly beat: (sessionId: string, qoe: QoeSample) => Promise<unknown>,
  ) {
    this.qoe = new PlayerQoe(reporter);
  }

  /** A new tune-in: fresh counters and playbackId, the previous one is closed first. */
  begin(sessionId: string, engine: () => PlaybackEngine | null): void {
    this.end();
    this.qoe.reset();
    this.sid = sessionId;
    this.engine = engine;
    this.started = this.buffering = this.paused = false;
    this.frozenSince = 0;
    this.lastPos = -1;
    this.lastAdvanceAt = this.lastBeatAt = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  onState(state: PlaybackState): void {
    if (!this.sid) return;
    this.buffering = state === 'buffering';
    this.paused = state === 'paused';
    if (state === 'playing' && !this.started) {
      this.started = true;
      this.refresh();
    }
    this.syncStall();
  }

  onSeek(): void {
    this.lastSeekAt = Date.now();
  }

  onError(err: { code?: number; message?: string; category?: string }): void {
    this.qoe.onError(this.sid, this.engine?.()?.currentTime ?? 0, err);
  }

  /** `keepalive` for a page going away, where an Angular request would be cancelled. */
  end(keepalive = false): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const sid = this.sid;
    if (!sid) return;
    this.qoe.setStalled(false, { sessionId: sid, position: this.engine?.()?.currentTime ?? 0 });
    if (keepalive) this.qoe.flushKeepalive(sid);
    else this.qoe.flush(sid);
    this.sid = undefined;
  }

  private refresh(): void {
    const engine = this.engine?.();
    if (engine) void this.qoe.refresh(engine, this.sid);
  }

  private tick(): void {
    const now = Date.now();
    const pos = this.engine?.()?.currentTime ?? 0;
    const active = this.started && !this.paused && !(typeof document !== 'undefined' && document.hidden);
    if (!active || Math.abs(pos - this.lastPos) >= 0.05) {
      this.lastAdvanceAt = now;
      this.frozenSince = 0;
    } else if (!this.frozenSince && now - this.lastAdvanceAt >= FROZEN_AFTER_MS) {
      this.frozenSince = this.lastAdvanceAt;
    }
    this.lastPos = pos;
    this.syncStall();
    if (now - this.lastBeatAt < LIVE_HEARTBEAT_MS) return;
    this.lastBeatAt = now;
    const sid = this.sid;
    const sample = this.qoe.current(sid);
    this.refresh();
    if (sid && sample) void this.beat(sid, sample).catch(() => {});
    this.qoe.flush(sid);
  }

  private syncStall(): void {
    const stalled = !this.paused && ((this.buffering && this.started) || this.frozenSince > 0);
    this.qoe.setStalled(stalled, {
      sessionId: this.sid,
      position: this.engine?.()?.currentTime ?? 0,
      ignored: Date.now() - this.lastSeekAt < SEEK_GRACE_MS,
      since: this.frozenSince || undefined,
    });
  }
}
