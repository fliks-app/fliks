import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TranscodingService } from './transcoding.service';
import type { RemuxSegmentAssembler } from './remux-assembler';
import type { TranscodeSession } from './types';
import { LiveSessionRegistry, type LiveSession } from '../live-session.service';
import { StreamingSettingsCache } from '../streaming-settings-cache.service';
import { DEFAULT_SEGMENT_DURATION, segmentIndexToSeconds } from './constants';
import { firstMissingSegment } from './segment-utils';
import type { SessionVariant } from './variant';
import {
  detectPauseCapability,
  getPauseCapability,
  pauseProcess,
  resumeProcess,
} from './ffmpeg-pause';

/** How often the throttle service re-checks every active run. Well under the
 *  admin threshold's resume-at-half margin, so a viewer catching up never
 *  waits much longer than this for its run to resume. */
const CHECK_INTERVAL_MS = 5_000;

/** Pause/resume decision for one run, given how far ahead of the viewer its
 *  frontier is. Pure so the thresholds and hysteresis are unit-tested without
 *  a running ffmpeg. */
export function decideThrottle(o: {
  aheadSeconds: number;
  paused: boolean;
  thresholdSeconds: number;
}): 'pause' | 'resume' | 'noop' {
  if (!o.paused && o.aheadSeconds > o.thresholdSeconds) return 'pause';
  if (o.paused && o.aheadSeconds <= o.thresholdSeconds / 2) return 'resume';
  return 'noop';
}

/** Span this run has produced itself, in content seconds: from its first
 *  segment to the start of the first one it has yet to write. */
export interface RunSpan {
  startSeconds: number;
  frontierSeconds: number;
}

/** How far the run's own output leads the viewer. A playhead behind the run's
 *  first segment is either consuming older cached output or has not reported
 *  yet (a resume starts at 0): it says nothing about this run, so it leads by
 *  nothing and the run is never paused against it. */
export function runLeadSeconds(span: RunSpan, playhead: number): number {
  if (playhead < span.startSeconds) return 0;
  return span.frontierSeconds - playhead;
}

/** Furthest-ahead viewer across every LiveSession sharing this job: a
 *  slower sibling must never stall the run a faster one still needs. Null
 *  when nothing is watching, cleanup reaps the run on its own schedule. */
export function jobPlayheadSeconds(
  live: readonly Pick<LiveSession, 'position' | 'lastRequestedSegment'>[],
  segmentDuration: number,
  sourceFps: number | undefined,
  // Remux indices sit on the keyframe grid, not a uniform one: convert
  // through the assembler's grid when there is one, else segmentIndexToSeconds.
  remuxAssembler?: Pick<RemuxSegmentAssembler, 'segmentContentSeconds'> | null,
): number | null {
  if (live.length === 0) return null;
  let max = 0;
  for (const s of live) {
    const requested =
      s.lastRequestedSegment != null
        ? (remuxAssembler
            ? remuxAssembler.segmentContentSeconds(s.lastRequestedSegment)
            : segmentIndexToSeconds(s.lastRequestedSegment, segmentDuration, sourceFps))
        : 0;
    max = Math.max(max, s.position, requested);
  }
  return max;
}

/** Sessions this feature must never touch: a bounded early companion (exits
 *  on its own within a couple of segments) and any run backing a pinned
 *  download/offline-prep session. */
export function isThrottleEligible(
  variantKind: SessionVariant['kind'] | undefined,
  live: readonly Pick<LiveSession, 'pinned'>[],
): boolean {
  if (variantKind === 'early') return false;
  if (live.some((s) => s.pinned)) return false;
  return true;
}

/** Pauses a remux/ladder run once it's far enough ahead of every viewer's
 *  playhead to save CPU/GPU; skips Live TV and trick-play (untracked here). */
@Injectable()
export class FfmpegThrottleService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(FfmpegThrottleService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Set once a settings-load failure has been logged, so a hiccup doesn't
   *  spam a warning on every 5s tick until it recovers. */
  private settingsErrorLogged = false;
  /** Guards against an overlapping tick when one runs past CHECK_INTERVAL_MS. */
  private ticking = false;

  constructor(
    private readonly transcoding: TranscodingService,
    private readonly liveSessions: LiveSessionRegistry,
    private readonly settings: StreamingSettingsCache,
  ) {}

  onModuleInit(): void {
    void detectPauseCapability(this.log);
    this.timer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickOnce();
    } finally {
      this.ticking = false;
    }
  }

  private async tickOnce(): Promise<void> {
    if (getPauseCapability() === 'none') return;
    let settings: Awaited<ReturnType<StreamingSettingsCache['get']>>;
    try {
      settings = await this.settings.get();
      this.settingsErrorLogged = false;
    } catch (err) {
      if (!this.settingsErrorLogged) {
        this.settingsErrorLogged = true;
        this.log.warn(`throttle tick: settings unavailable, skipping: ${(err as Error).message}`);
      }
      return;
    }
    for (const session of this.transcoding.getActiveSessions()) {
      if (!settings.throttleEnabled) {
        if (session.throttlePaused) this.resume(session);
        continue;
      }
      try {
        this.checkOne(session, settings.throttleThresholdSeconds);
      } catch (err) {
        this.log.warn(`[${session.id}] throttle check failed: ${(err as Error).message}`);
      }
    }
  }

  private checkOne(session: TranscodeSession, thresholdSeconds: number): void {
    if (session.process.exitCode !== null) return;
    const live = session.baseProfileHash
      ? this.liveSessions.listForJob(
          session.userId ?? null,
          session.mediaFileId,
          session.baseProfileHash,
        )
      : [];
    if (!isThrottleEligible(session.variant?.kind, live)) {
      if (session.throttlePaused) this.resume(session);
      return;
    }
    const segmentDuration = session.segmentDuration ?? DEFAULT_SEGMENT_DURATION;
    const playhead = jobPlayheadSeconds(live, segmentDuration, session.sourceFps, session.remuxAssembler);
    if (playhead == null) return;
    const span = this.runSpan(session, segmentDuration);
    if (span == null) return;
    const decision = decideThrottle({
      aheadSeconds: runLeadSeconds(span, playhead),
      paused: !!session.throttlePaused,
      thresholdSeconds,
    });
    if (decision === 'pause') this.pause(session, span.frontierSeconds, playhead);
    else if (decision === 'resume') this.resume(session, span.frontierSeconds, playhead);
  }

  /** Only what this run wrote counts: the cache dir can also hold segments
   *  from earlier runs or from an ffmpeg outliving a crashed backend, and
   *  measuring those would pause a run before it wrote the viewer's segment.
   *  Remux: the assembler's own frontier. Transcode ladder: the unbroken
   *  sequence from the run's `-start_number`, which the spawn purged first.
   *  Null until the run's first segment lands. */
  private runSpan(session: TranscodeSession, segmentDuration: number): RunSpan | null {
    const assembler = session.remuxAssembler;
    if (assembler) {
      const startSeconds = assembler.runStartSeconds();
      const frontierSeconds = assembler.frontierSeconds();
      return startSeconds == null || frontierSeconds == null
        ? null
        : { startSeconds, frontierSeconds };
    }
    const start = session.startSegment ?? 0;
    const next = firstMissingSegment(session.cachePath, session.throttleFrontierSegment ?? start);
    if (next == null) return null;
    session.throttleFrontierSegment = next;
    if (next === start) return null;
    return {
      startSeconds: segmentIndexToSeconds(start, segmentDuration, session.sourceFps),
      frontierSeconds: segmentIndexToSeconds(next, segmentDuration, session.sourceFps),
    };
  }

  private pause(session: TranscodeSession, frontier: number, playhead: number): void {
    pauseProcess(session.process, this.log);
    session.throttlePaused = true;
    session.remuxAssembler?.pause();
    const msg = `Throttle: paused [${session.id}], frontier ${frontier.toFixed(1)}s vs playhead ${playhead.toFixed(1)}s`;
    if (session.throttlePausedOnce) this.log.debug(msg);
    else {
      session.throttlePausedOnce = true;
      this.log.log(msg);
    }
  }

  private resume(session: TranscodeSession, frontier?: number, playhead?: number): void {
    resumeProcess(session.process, this.log);
    session.throttlePaused = false;
    session.remuxAssembler?.resume();
    const detail = frontier != null && playhead != null
      ? `, frontier ${frontier.toFixed(1)}s vs playhead ${playhead.toFixed(1)}s`
      : '';
    this.log.debug(`Throttle: resumed [${session.id}]${detail}`);
  }
}
