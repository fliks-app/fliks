import { hasQoeData, type EngineQoeSample, type PlaybackEngine, type QoeSample } from '../../core/services/playback-engine/playback-engine';
import type { QoeEvent, QoeReloadReason } from '../../core/services/api/qoe-api.service';
import { newPlaybackId, type QoeReporter } from '../../core/services/qoe-reporter.service';

/** Why a reload re-negotiates playback; `from`/`to` name what changed. */
export interface ReloadWhy {
  reason: QoeReloadReason;
  from?: string;
  to?: string;
}

/** Buffering blips shorter than this are decoder hiccups, not a stall the viewer saw. */
export const MIN_STALL_MS = 250;
export const SAMPLE_TIMEOUT_MS = 500;

/** Engine-agnostic stall accounting; an episode flagged `ignored` (seek, reload) is never counted. */
export class StallTracker {
  count = 0;
  totalMs = 0;
  private lastEndAt = 0;
  private open: {
    at: number;
    position: number;
    bufferAheadS: number | null;
    variantBitrate: number | null;
    ignored: boolean;
  } | null = null;

  begin(
    now: number,
    position: number,
    ignored: boolean,
    bufferAheadS: number | null = null,
    variantBitrate: number | null = null,
  ): void {
    this.open ??= { at: Math.max(now, this.lastEndAt), position, bufferAheadS, variantBitrate, ignored };
  }

  /** Closes the open episode; returns it when it counted. */
  end(now: number): {
    durationMs: number;
    position: number;
    bufferAheadS: number | null;
    variantBitrate: number | null;
  } | null {
    const o = this.open;
    this.open = null;
    if (o) this.lastEndAt = now;
    if (!o || o.ignored) return null;
    const durationMs = now - o.at;
    if (durationMs < MIN_STALL_MS) return null;
    this.count++;
    this.totalMs += durationMs;
    return { durationMs, position: o.position, bufferAheadS: o.bufferAheadS, variantBitrate: o.variantBitrate };
  }

  /** Counters including an episode still open, so a stall in progress shows up. */
  snapshot(now: number): { stallCount: number; stallMs: number } {
    const o = this.open && !this.open.ignored && now - this.open.at >= MIN_STALL_MS ? this.open : null;
    return {
      stallCount: this.count + (o ? 1 : 0),
      stallMs: this.totalMs + (o ? now - o.at : 0),
    };
  }

  reset(): void {
    this.count = 0;
    this.totalMs = 0;
    this.open = null;
    this.lastEndAt = 0;
  }
}

/** The playhead did not move for this long while it should have. */
export const FROZEN_AFTER_MS = 1_000;
/** A tick this late means the process was frozen (sleep), not the playhead. */
const MAX_TICK_GAP_MS = 3_000;

/** Detects a playhead frozen while it should advance, even when the engine never says `buffering`. */
export class PlayheadWatch {
  /** Start of the frozen episode, 0 when none. */
  frozenSince = 0;
  private lastPos = -1;
  private lastAdvanceAt: number;
  private lastTickAt: number;

  constructor(now = Date.now()) {
    this.lastAdvanceAt = this.lastTickAt = now;
  }

  reset(now = Date.now()): void {
    this.frozenSince = 0;
    this.lastPos = -1;
    this.lastAdvanceAt = this.lastTickAt = now;
  }

  /** `active`: the viewer should be seeing the playhead move. */
  tick(pos: number, active: boolean, now = Date.now()): void {
    const gapOk = now - this.lastTickAt < MAX_TICK_GAP_MS;
    this.lastTickAt = now;
    if (!active || !gapOk || Math.abs(pos - this.lastPos) >= 0.05) {
      this.lastAdvanceAt = now;
      this.frozenSince = 0;
    } else if (!this.frozenSince && now - this.lastAdvanceAt >= FROZEN_AFTER_MS) {
      this.frozenSince = this.lastAdvanceAt;
    }
    this.lastPos = pos;
  }

  /** The engine stopped buffering but the playhead never moved: keep the episode open from its start. */
  carryOver(now: number, startAt: number, startPos: number, pos: number): boolean {
    this.lastAdvanceAt = now;
    if (this.frozenSince || now - startAt < MIN_STALL_MS || Math.abs(pos - startPos) >= 0.05) return false;
    this.lastPos = pos;
    this.frozenSince = startAt;
    return true;
  }
}

/** Per-playback QoE state owned by the player: counters, events and the heartbeat sample. */
export class PlayerQoe {
  private readonly stalls = new StallTracker();
  private recoveryReloads = 0;
  private last: EngineQoeSample | null = null;
  private refreshing = false;
  private generation = 0;
  private sid: string | undefined;
  /** One per viewing: survives sid changes, renewed by {@link reset}. */
  playbackId = newPlaybackId();

  constructor(
    private readonly reporter: QoeReporter,
    private readonly now: () => number = Date.now,
  ) {}

  /** New media: counters restart, the session's events stay with their own sid. */
  reset(): void {
    this.stalls.reset();
    this.recoveryReloads = 0;
    this.last = null;
    this.sid = undefined;
    this.playbackId = newPlaybackId();
    this.generation++;
  }

  /** Counters are per session id: a reload that mints a new one starts them over. */
  private bind(sessionId: string | undefined): void {
    if (!sessionId || sessionId === this.sid) return;
    if (this.sid) {
      this.closeStall(this.sid);
      this.flush(this.sid);
      this.stalls.reset();
      this.recoveryReloads = 0;
      this.last = null;
      this.generation++;
    }
    this.sid = sessionId;
  }

  setStalled(
    stalled: boolean,
    ctx: { sessionId?: string; position: number; ignored?: boolean; bufferAheadS?: number | null; since?: number },
  ): void {
    if (stalled) {
      this.stalls.begin(
        ctx.since ?? this.now(),
        ctx.position,
        !!ctx.ignored,
        ctx.bufferAheadS ?? null,
        this.last?.variantBitrate ?? null,
      );
      return;
    }
    this.closeStall(ctx.sessionId);
  }

  private closeStall(sessionId: string | undefined): void {
    const done = this.stalls.end(this.now());
    if (done && sessionId) {
      this.record(sessionId, {
        type: 'stall',
        position: done.position,
        durationMs: done.durationMs,
        bufferAheadS: done.bufferAheadS,
        bandwidthBps: this.last?.bandwidthBps ?? null,
        variantBitrate: done.variantBitrate,
      });
    }
  }

  onRecovery(sessionId: string | undefined, position: number): void {
    this.bind(sessionId);
    this.recoveryReloads++;
    if (sessionId) this.record(sessionId, { type: 'recovery', position });
  }

  onError(
    sessionId: string | undefined,
    position: number,
    err: { code?: number; message?: string; category?: string },
  ): void {
    if (!sessionId) return;
    this.record(
      sessionId,
      { type: 'error', position, code: err.code, message: err.message, category: err.category },
      true,
    );
  }

  onQualitySwitch(sessionId: string | undefined, position: number, to?: number, activeRung?: number): void {
    if (!sessionId) return;
    const from = activeRung ?? this.last?.variantBitrate ?? undefined;
    this.record(sessionId, { type: 'quality_switch', position, fromBitrate: from, toBitrate: to }, true);
  }

  /** A rung change already records its own quality_switch, so it adds nothing here. */
  onReload(sessionId: string | undefined, position: number, why: ReloadWhy): void {
    if (!sessionId || why.reason === 'quality') return;
    this.record(sessionId, { type: 'reload', position, reason: why.reason, from: why.from, to: why.to }, true);
  }

  /** Re-reads the engine for the next heartbeat; never awaited by it, so a slow engine delays nothing. */
  async refresh(engine: PlaybackEngine, sessionId?: string): Promise<void> {
    this.bind(sessionId);
    if (this.refreshing) return;
    this.refreshing = true;
    const gen = this.generation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        Promise.resolve().then(() => engine.getQoeSample()),
        new Promise<null>((r) => (timer = setTimeout(() => r(null), SAMPLE_TIMEOUT_MS))),
      ]);
      if (raw && gen === this.generation) this.last = raw;
    } catch {
      // keep the previous sample
    } finally {
      clearTimeout(timer);
      this.refreshing = false;
    }
  }

  /** Last engine sample plus our live counters; null until the engine has answered. */
  current(sessionId?: string): QoeSample | null {
    this.bind(sessionId);
    if (!this.last || !hasQoeData(this.last)) return null;
    return {
      ...this.last,
      ...this.stalls.snapshot(this.now()),
      recoveryReloads: this.recoveryReloads,
      playbackId: this.playbackId,
    };
  }

  flush(sessionId: string | undefined): void {
    if (sessionId) void this.reporter.flush(sessionId);
  }

  flushKeepalive(sessionId: string | undefined): void {
    if (sessionId) this.reporter.flushKeepalive(sessionId);
  }

  private record(sessionId: string, e: Omit<QoeEvent, 'at'>, immediate = false): void {
    this.reporter.record(sessionId, { ...e, at: this.now() }, immediate, this.playbackId);
  }
}
