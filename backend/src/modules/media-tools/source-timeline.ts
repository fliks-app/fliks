import { Logger } from '@nestjs/common';
import type {
  MediaFileInfo,
  VideoStreamInfo,
} from '../media-probe/ffprobe.service';

const log = new Logger('SourceTimeline');
const reported = new Set<string>();
/** Files reported before the set starts over. */
const MAX_REPORTED = 1000;

/** The source times a burn-in subtitle's cues are counted from. */
export interface SourceTimeline {
  /** Source time of the first presented video frame. */
  origin: number;
  /** Container start: what an input `-ss` counts from, and what a `-copyts`-less
   *  extract, and the sidecars authored against one, count cues from. */
  formatStart: number;
}

type TimelineProbe = Pick<MediaFileInfo, 'video' | 'formatStartSeconds'>;

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
  return { origin: videoPresentationStart(v) ?? 0, formatStart };
}
