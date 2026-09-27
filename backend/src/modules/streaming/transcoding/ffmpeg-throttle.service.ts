import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TranscodingService } from './transcoding.service';
import type { TranscodeSession } from './types';
import { LiveSessionRegistry, type LiveSession } from '../live-session.service';
import { StreamingSettingsCache } from '../streaming-settings-cache.service';
import { DEFAULT_SEGMENT_DURATION, segmentIndexToSeconds } from './constants';
import { latestSegmentNumber } from './segment-utils';
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

/** Furthest-ahead viewer across every LiveSession sharing this job: a
 *  slower sibling must never stall the run a faster one still needs
 *. Null when nothing is watching, cleanup reaps the run on its
 *  own schedule, this service leaves it alone. */
export function jobPlayheadSeconds(
  live: readonly Pick<LiveSession, 'position' | 'lastRequestedSegment'>[],
  segmentDuration: number,
  sourceFps: number | undefined,
): number | null {
  if (live.length === 0) return null;
  let max = 0;
  for (const s of live) {
    const requested =
      s.lastRequestedSegment != null
        ? segmentIndexToSeconds(s.lastRequestedSegment, segmentDuration, sourceFps)
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

/**
 * Paces every remux and transcode-ladder run against its viewers' playhead
 *: a run that has produced far more than anyone is watching is
 * paused (stdin `p`/`u` on the bundled jellyfin-ffmpeg, SIGSTOP/SIGCONT
 * fallback otherwise) instead of burning CPU/GPU encoding a stop or a seek
 * will throw away. Live TV is realtime-paced already and never reaches
 * this service (its own session registry, not `TranscodingService`);
 * trick-play segments are one-shot ffmpeg calls, never a tracked session.
 */
@Injectable()
export class FfmpegThrottleService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(FfmpegThrottleService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

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
    if (getPauseCapability() === 'none') return;
    const settings = await this.settings.get();
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
    const playhead = jobPlayheadSeconds(live, segmentDuration, session.sourceFps);
    if (playhead == null) return;
    const frontier = this.frontierSeconds(session, segmentDuration);
    if (frontier == null) return;
    const decision = decideThrottle({
      aheadSeconds: frontier - playhead,
      paused: !!session.throttlePaused,
      thresholdSeconds,
    });
    if (decision === 'pause') this.pause(session);
    else if (decision === 'resume') this.resume(session);
  }

  /** Remux: the assembler's own source-time frontier. Transcode ladder: the
   *  highest segment number on disk, there is no assembler, ffmpeg writes
   *  its own segments straight to the session dir. */
  private frontierSeconds(session: TranscodeSession, segmentDuration: number): number | null {
    if (session.remuxAssembler) return session.remuxAssembler.frontierSeconds();
    const latest = latestSegmentNumber(session.cachePath);
    if (latest < 0) return null;
    return segmentIndexToSeconds(latest + 1, segmentDuration, session.sourceFps);
  }

  private pause(session: TranscodeSession): void {
    pauseProcess(session.process, this.log);
    session.throttlePaused = true;
    session.remuxAssembler?.pause();
    this.log.log(`Throttle: paused [${session.id}], ahead of every viewer's playhead`);
  }

  private resume(session: TranscodeSession): void {
    resumeProcess(session.process, this.log);
    session.throttlePaused = false;
    session.remuxAssembler?.resume();
    this.log.log(`Throttle: resumed [${session.id}]`);
  }
}
