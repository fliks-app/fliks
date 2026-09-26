import { Logger } from '@nestjs/common';
import type {
  MediaFileInfo,
  VideoStreamInfo,
} from '../../subtitles/ffprobe.service';

const log = new Logger('SourceTimeline');
const reported = new Set<string>();
/** Files reported before the set starts over. */
const MAX_REPORTED = 1000;

/** The source times every served timeline and seek is derived from. */
export interface SourceTimeline {
  /** Source time of the first presented video frame: where every run's output
   *  timeline, the audio alignment and the segment grid start. */
  origin: number;
  /** Container start: what an input `-ss` counts from, and what a `-copyts`-less
   *  extract, and the sidecars authored against one, count cues from. */
  formatStart: number;
  /** Where the video ends or its clock breaks: every playlist ends there, since
   *  ffmpeg cuts on the video. Undefined when unprobed. */
  end?: number;
  /** Source time an MPEG-TS clock breaks at, where every run stops. */
  clockBreak?: number;
}

type TimelineProbe = Pick<
  MediaFileInfo,
  'video' | 'formatStartSeconds' | 'durationSeconds' | 'timestampBreakSeconds'
>;

/** Where a video stream's picture starts, falling back to its first packet. */
export function videoPresentationStart(
  v: Pick<VideoStreamInfo, 'firstFrameSeconds' | 'startTimeSeconds'> | undefined,
): number | undefined {
  return v?.firstFrameSeconds ?? v?.startTimeSeconds;
}

/** The timeline of a probed file. Without a probed first frame or container
 *  start, the video `start_time` stands in for both, reported once per file. */
export function sourceTimeline(
  si: TimelineProbe | null | undefined,
  label = 'unknown file',
): SourceTimeline {
  const v = si?.video?.[0];
  const streamStart = v?.startTimeSeconds ?? 0;
  if (v && (v.firstFrameSeconds === undefined || si?.formatStartSeconds === undefined)) {
    if (!reported.has(label)) {
      if (reported.size >= MAX_REPORTED) reported.clear();
      reported.add(label);
      log.warn(
        `${label}: stream info has no first-frame or container start; using the video ` +
          `start_time (${streamStart}s) for both until the file is rescanned`,
      );
    }
  }
  const formatStart = si?.formatStartSeconds ?? streamStart;
  return {
    origin: videoPresentationStart(v) ?? 0,
    formatStart,
    clockBreak: si?.timestampBreakSeconds ?? undefined,
    end:
      si?.timestampBreakSeconds ??
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

/** What the served fMP4 timeline adds to source time: 0, or what lifts a video
 *  starting before 0 onto 0, since a tfdt can't go below 0. */
export function servedShift(timeline: Pick<SourceTimeline, 'origin'>): number {
  return Math.max(0, -timeline.origin);
}

/** Where the first frame sits on the served timeline. */
export function servedOrigin(timeline: Pick<SourceTimeline, 'origin'>): number {
  return timeline.origin + servedShift(timeline);
}

/** Where a cue at 0 of a subtitle counted from the container start sits on the
 *  served timeline (its X-TIMESTAMP-MAP). */
export function cueOffsetSeconds(timeline: SourceTimeline): number {
  return timeline.formatStart + servedShift(timeline);
}
