import { Injectable } from '@nestjs/common';
import type { TonemapAlgo } from './transcoding';

/**
 * Cross-cutting bookkeeping for streaming. Per-playback session state lives on
 * {@link LiveSession} — including DirectPlay presence, which the admin "now
 * watching" view reads straight off the registry (`kind === 'directplay'`).
 * This service holds only the bits that don't vary per playback session:
 *
 *  - Human-readable device name per (user, file) — a dashboard fallback for
 *    when the LiveSession carries no raw User-Agent label
 *  - Intrinsic file dimensions (identical across users, kept here for cheap
 *    reads in HLS routes)
 *  - Global admin settings (segment duration, QSV options, tonemap algo)
 */
@Injectable()
export class ActiveStreamTracker {
  /** Human-readable client device captured at playback-info ("Chrome — macOS",
   *  "iPhone", "Chromecast — Living Room"). Keyed per (user, file) so two users
   *  watching the same file from different devices don't collide. Shown on the
   *  admin streams dashboard as a fallback when the LiveSession has no raw
   *  User-Agent label. Cleared on stop ({@link unregister}); a playback that
   *  never sends a clean stop leaves one small string entry until restart —
   *  bounded by distinct (user, file) pairs and overwritten per key. */
  private readonly deviceNameCache = new Map<string, string>();

  setDeviceName(userId: number, mediaFileId: number, name: string) {
    if (name) this.deviceNameCache.set(`${userId}-${mediaFileId}`, name);
  }

  getDeviceName(userId: number, mediaFileId: number): string | null {
    return this.deviceNameCache.get(`${userId}-${mediaFileId}`) ?? null;
  }

  /** Release a (user, file)'s cached device name when its playback stops. */
  unregister(userId: number, mediaFileId: number) {
    this.deviceNameCache.delete(`${userId}-${mediaFileId}`);
  }

  // ── Global admin streaming settings forwarded to transcode sessions ──
  private qsvLowPowerCache = false;

  /** QSV advanced options are global (driven by admin streaming settings). */
  setQsvOptions(opts: { lowPower: boolean }) {
    this.qsvLowPowerCache = opts.lowPower;
  }
  getQsvOptions(): { lowPower: boolean } {
    return { lowPower: this.qsvLowPowerCache };
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

  private segmentDurationCache = 3;

  setStreamingDuration(segDuration: number) {
    this.segmentDurationCache = segDuration;
  }

  getSegmentDuration(): number {
    return this.segmentDurationCache;
  }

  // Source dimensions describe the underlying file — identical across
  // users, kept here for cheap lookups in HLS routes.
  private readonly sourceWidthCache = new Map<number, number>();
  private readonly sourceHeightCache = new Map<number, number>();

  setSourceDimensions(mediaFileId: number, width: number, height: number) {
    this.sourceWidthCache.set(mediaFileId, width);
    this.sourceHeightCache.set(mediaFileId, height);
  }
  getSourceWidth(mediaFileId: number): number {
    return this.sourceWidthCache.get(mediaFileId) ?? 0;
  }
  getSourceHeight(mediaFileId: number): number {
    return this.sourceHeightCache.get(mediaFileId) ?? 0;
  }
}
