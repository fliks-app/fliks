import { Logger } from '@nestjs/common';
import type {
  MediaFileInfo,
  VideoStreamInfo,
} from '../../subtitles/ffprobe.service';

const log = new Logger('SourceTimeline');
const reported = new Set<string>();

/** The two source times every served timeline and seek is derived from. */
export interface SourceTimeline {
  /** Source time of the first presented video frame: where every run's output
   *  timeline, the audio alignment and the segment grid start. */
  origin: number;
  /** Container start: what an input `-ss` counts from, and what timestamps
   *  ffmpeg rebases to 0 without `-copyts` (subtitle extracts, and the sidecars
   *  authored against them or against a player's clock) count from. */
  formatStart: number;
  /** Source time the video ends at, where every playlist ends: ffmpeg cuts on
   *  the video, so audio past it gets no segment. Undefined when unprobed. */
  end?: number;
}

type TimelineProbe = Pick<
  MediaFileInfo,
  'video' | 'formatStartSeconds' | 'durationSeconds'
>;

/** Where a video stream's picture starts, falling back to its first packet. */
export function videoPresentationStart(
  v: Pick<VideoStreamInfo, 'firstFrameSeconds' | 'startTimeSeconds'> | undefined,
): number | undefined {
  return v?.firstFrameSeconds ?? v?.startTimeSeconds;
}

/**
 * The timeline of a probed file. A row probed before `firstFrameSeconds` /
 * `formatStartSeconds` existed keeps the video `start_time` for both, which is
 * the behaviour it was served with, and is reported once so it gets rescanned.
 */
export function sourceTimeline(
  si: TimelineProbe | null | undefined,
  label = 'unknown file',
): SourceTimeline {
  const v = si?.video?.[0];
  const legacy = v?.startTimeSeconds ?? 0;
  if (v && (v.firstFrameSeconds === undefined || si?.formatStartSeconds === undefined)) {
    if (!reported.has(label)) {
      reported.add(label);
      log.warn(
        `${label}: stream info has no first-frame or container start; using the video ` +
          `start_time (${legacy}s) for both until the file is rescanned`,
      );
    }
  }
  const formatStart = si?.formatStartSeconds ?? legacy;
  return {
    origin: videoPresentationStart(v) ?? 0,
    formatStart,
    end:
      v?.endSeconds ??
      (si?.durationSeconds != null ? formatStart + si.durationSeconds : undefined),
  };
}

/** Input `-ss` value that lands on content position `contentSeconds`: ffmpeg
 *  adds the container start to an input seek. */
export function inputSeekSeconds(
  contentSeconds: number,
  timeline: SourceTimeline,
): number {
  return contentSeconds + (timeline.origin - timeline.formatStart);
}
