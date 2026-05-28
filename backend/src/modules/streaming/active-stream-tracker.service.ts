import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { TonemapAlgo } from './transcoding';

export interface DirectPlaySession {
  userId: number;
  username: string;
  mediaFileId: number;
  mediaTitle: string;
  mediaType: string;
  posterUrl: string | null;
  startedAt: Date;
  lastActivity: Date;
}

const STALE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Dashboard / global-settings bookkeeping for streaming. Per-playback
 * session state (mux flavour, audio plan, device type, picked tracks,
 * etc.) used to live here but has moved onto {@link LiveSession} —
 * this service now holds only:
 *
 *  - DirectPlay session presence for the admin "now watching" view
 *    (`register` / `getActive` / `unregister`)
 *  - Human-readable device name per (user, file)
 *  - Intrinsic file dimensions (identical across users, kept here for
 *    cheap reads in HLS routes)
 *  - Global admin settings (segment duration, QSV options, tonemap algo)
 */
@Injectable()
export class ActiveStreamTracker implements OnModuleInit, OnModuleDestroy {
  private readonly sessions = new Map<string, DirectPlaySession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  onModuleInit() {
    this.cleanupTimer = setInterval(() => this.cleanup(), 30_000);
  }

  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  register(
    userId: number,
    username: string,
    mediaFileId: number,
    mediaTitle: string,
    mediaType: string,
    posterUrl: string | null,
  ) {
    const key = `${userId}-${mediaFileId}`;
    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastActivity = new Date();
      return;
    }
    this.sessions.set(key, {
      userId,
      username,
      mediaFileId,
      mediaTitle,
      mediaType,
      posterUrl,
      startedAt: new Date(),
      lastActivity: new Date(),
    });
  }

  unregister(userId: number, mediaFileId: number) {
    const key = `${userId}-${mediaFileId}`;
    this.sessions.delete(key);
    this.deviceNameCache.delete(key);
  }

  /** Human-readable client device captured at playback-info ("Chrome — macOS",
   *  "iPhone", "Chromecast — Living Room"). Keyed per (user, file) so two users
   *  watching the same file from different devices don't collide. Shown only on
   *  the admin streams dashboard. */
  private readonly deviceNameCache = new Map<string, string>();

  setDeviceName(userId: number, mediaFileId: number, name: string) {
    if (name) this.deviceNameCache.set(`${userId}-${mediaFileId}`, name);
  }

  getDeviceName(userId: number, mediaFileId: number): string | null {
    return this.deviceNameCache.get(`${userId}-${mediaFileId}`) ?? null;
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

  getActive(): DirectPlaySession[] {
    const cutoff = Date.now() - STALE_TIMEOUT_MS;
    return Array.from(this.sessions.values()).filter(
      (s) => s.lastActivity.getTime() > cutoff,
    );
  }

  private cleanup() {
    const cutoff = Date.now() - STALE_TIMEOUT_MS;
    for (const [key, session] of this.sessions) {
      if (session.lastActivity.getTime() <= cutoff) {
        this.sessions.delete(key);
        this.deviceNameCache.delete(key);
      }
    }
  }
}
