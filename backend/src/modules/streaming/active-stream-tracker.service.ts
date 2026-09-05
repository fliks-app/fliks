import { Injectable } from '@nestjs/common';
import type { TonemapAlgo } from './transcoding';
import { DEFAULT_SEGMENT_DURATION } from './transcoding/constants';

/**
 * Global admin streaming settings forwarded to transcode sessions. Everything
 * that varies per playback lives on {@link LiveSession}.
 */
@Injectable()
export class ActiveStreamTracker {
  private qsvLowPowerCache = false;

  /** QSV advanced options are global (driven by admin streaming settings). */
  setQsvOptions(opts: { lowPower: boolean }) {
    this.qsvLowPowerCache = opts.lowPower;
  }
  getQsvOptions(): { lowPower: boolean } {
    return { lowPower: this.qsvLowPowerCache };
  }

  /** HLS segment duration in seconds (admin-configurable, global). Read once
   *  per session when the context is built and frozen onto the session, so a
   *  later change never re-grids a session mid-playback against segments
   *  already cut on its old grid. */
  private segmentDurationCache = DEFAULT_SEGMENT_DURATION;
  setSegmentDuration(seconds: number) {
    this.segmentDurationCache = seconds;
  }
  getSegmentDuration(): number {
    return this.segmentDurationCache;
  }

  /** HDR → SDR tone-mapping algorithm (admin-configurable, global). */
  private tonemapAlgoCache: TonemapAlgo = 'auto';
  setTonemapAlgo(algo: TonemapAlgo) {
    this.tonemapAlgoCache = algo;
  }
  getTonemapAlgo(): TonemapAlgo {
    return this.tonemapAlgoCache;
  }

  /** Whether detected black bars are cropped (admin-configurable, global).
   *  Cropping forces a re-encode; disabling it lets letterboxed sources
   *  Direct Play / remux untouched on low-power servers. Default on. */
  private autoCropEnabledCache = true;
  setAutoCropEnabled(enabled: boolean) {
    this.autoCropEnabledCache = enabled;
  }
  getAutoCropEnabled(): boolean {
    return this.autoCropEnabledCache;
  }
}
