import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TranscodingService } from './transcoding.service';
import type { RemuxSegmentAssembler } from './remux-assembler';
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
 *  slower sibling must never stall the run a faster one still needs. Null
 *  when nothing is watching, cleanup reaps the run on its own schedule. */
export function jobPlayheadSeconds(
  live: readonly Pick<LiveSession, 'position' | 'lastRequestedSegment'>[],
  segmentDuration: number,
  sourceFps: number | undefined,
  // Remux indices sit on the keyframe grid, not a uniform one: convert
  // through the assembler's own grid when there is one, the ladder's
  // uniform segmentIndexToSeconds otherwise.
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
        await this.checkOne(session, settings.throttleThresholdSeconds);
      } catch (err) {
        this.log.warn(`[${session.id}] throttle check failed: ${(err as Error).message}`);
      }
    }
  }

  private async checkOne(session: TranscodeSession, thresholdSeconds: number): Promise<void> {
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
    const frontier = await this.frontierSeconds(session, segmentDuration);
    if (frontier == null) return;
    const decision = decideThrottle({
      aheadSeconds: frontier - playhead,
      paused: !!session.throttlePaused,
      thresholdSeconds,
    });
    if (decision === 'pause') this.pause(session, frontier, playhead);
    else if (decision === 'resume') this.resume(session, frontier, playhead);
  }

  /** Remux: the assembler's own content-time frontier. Transcode ladder: the
   *  highest segment number on disk, there is no assembler, ffmpeg writes
   *  its own segments straight to the session dir. */
  private async frontierSeconds(
    session: TranscodeSession,
    segmentDuration: number,
  ): Promise<number | null> {
    if (session.remuxAssembler) return session.remuxAssembler.frontierSeconds();
    const latest = await latestSegmentNumber(session.cachePath);
    if (latest < 0) return null;
    return segmentIndexToSeconds(latest + 1, segmentDuration, session.sourceFps);
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
