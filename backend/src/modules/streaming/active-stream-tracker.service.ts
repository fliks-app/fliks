import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { BurnInSubtitle } from './transcoding.service';

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

@Injectable()
export class ActiveStreamTracker implements OnModuleInit, OnModuleDestroy {
  private readonly sessions = new Map<string, DirectPlaySession>();
  /** Cache transcode reasons per mediaFileId (set during playback-info, read by dashboard) */
  private readonly transcodeReasonsCache = new Map<
    number,
    { flag: string; message: string }[]
  >();
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
    this.sessions.delete(`${userId}-${mediaFileId}`);
  }

  private readonly tonemappingCache = new Map<number, boolean>();

  setTranscodeReasons(
    mediaFileId: number,
    reasons: { flag: string; message: string }[],
  ) {
    this.transcodeReasonsCache.set(mediaFileId, reasons);
  }

  getTranscodeReasons(
    mediaFileId: number,
  ): { flag: string; message: string }[] {
    return this.transcodeReasonsCache.get(mediaFileId) ?? [];
  }

  private readonly burnInCache = new Map<number, BurnInSubtitle>();

  setTonemapping(mediaFileId: number, value: boolean) {
    this.tonemappingCache.set(mediaFileId, value);
  }

  getTonemapping(mediaFileId: number): boolean {
    return this.tonemappingCache.get(mediaFileId) ?? false;
  }

  setBurnIn(mediaFileId: number, info: BurnInSubtitle | undefined) {
    if (info) {
      this.burnInCache.set(mediaFileId, info);
    } else {
      this.burnInCache.delete(mediaFileId);
    }
  }

  getBurnIn(mediaFileId: number): BurnInSubtitle | undefined {
    return this.burnInCache.get(mediaFileId) ?? undefined;
  }

  private readonly audioStreamIndexCache = new Map<
    number,
    number | undefined
  >();

  /** Number of audio streams per media file — used to decide multi-audio HLS mode */
  private readonly audioStreamCountCache = new Map<number, number>();

  setAudioStreamCount(mediaFileId: number, count: number) {
    this.audioStreamCountCache.set(mediaFileId, count);
  }

  getAudioStreamCount(mediaFileId: number): number {
    return this.audioStreamCountCache.get(mediaFileId) ?? 0;
  }

  /** Whether the client handles multi-audio from muxed TS (ExoPlayer/AVPlayer) */
  private readonly multiAudioMuxedCache = new Map<number, boolean>();

  setMultiAudioMuxed(mediaFileId: number, value: boolean) {
    this.multiAudioMuxedCache.set(mediaFileId, value);
  }

  getMultiAudioMuxed(mediaFileId: number): boolean {
    return this.multiAudioMuxedCache.get(mediaFileId) ?? false;
  }

  private readonly fmp4SupportedCache = new Map<number, boolean>();

  setFmp4Supported(mediaFileId: number, value: boolean) {
    this.fmp4SupportedCache.set(mediaFileId, value);
  }

  getFmp4Supported(mediaFileId: number): boolean {
    return this.fmp4SupportedCache.get(mediaFileId) ?? true;
  }

  private segmentDurationCache = 3;
  private initTimeCache = 1;

  setStreamingDurations(segDuration: number, initTime: number) {
    this.segmentDurationCache = segDuration;
    this.initTimeCache = initTime;
  }

  getSegmentDuration(): number {
    return this.segmentDurationCache;
  }
  getInitTime(): number {
    return this.initTimeCache;
  }

  setAudioStreamIndex(mediaFileId: number, index: number | undefined) {
    if (index != null) this.audioStreamIndexCache.set(mediaFileId, index);
    else this.audioStreamIndexCache.delete(mediaFileId);
  }

  getAudioStreamIndex(mediaFileId: number): number | undefined {
    return this.audioStreamIndexCache.get(mediaFileId);
  }

  // ── Admin streaming settings forwarded to transcode sessions ──
  private readonly encoderPresetCache = new Map<number, string>();
  private qsvLookaheadCache = false;
  private qsvLowPowerCache = false;
  private qsvAdaptiveCache = true;

  setEncoderPreset(mediaFileId: number, preset: string) {
    this.encoderPresetCache.set(mediaFileId, preset);
  }

  getEncoderPreset(mediaFileId: number): string {
    return this.encoderPresetCache.get(mediaFileId) ?? 'faster';
  }

  /** QSV advanced options are global (driven by admin streaming settings). */
  setQsvOptions(opts: {
    lookahead: boolean;
    lowPower: boolean;
    adaptive: boolean;
  }) {
    this.qsvLookaheadCache = opts.lookahead;
    this.qsvLowPowerCache = opts.lowPower;
    this.qsvAdaptiveCache = opts.adaptive;
  }
  getQsvOptions(): {
    lookahead: boolean;
    lowPower: boolean;
    adaptive: boolean;
  } {
    return {
      lookahead: this.qsvLookaheadCache,
      lowPower: this.qsvLowPowerCache,
      adaptive: this.qsvAdaptiveCache,
    };
  }

  // ── Source-vs-client compat captured at playback-info time, read at
  //    master.m3u8 time to decide whether to emit a smart-remux variant ──
  private readonly canCopyVideoCache = new Map<number, boolean>();
  private readonly canCopyAudioCache = new Map<number, boolean>();
  private readonly sourceWidthCache = new Map<number, number>();
  private readonly sourceHeightCache = new Map<number, number>();

  setCanCopyVideo(mediaFileId: number, value: boolean) {
    this.canCopyVideoCache.set(mediaFileId, value);
  }
  getCanCopyVideo(mediaFileId: number): boolean {
    return this.canCopyVideoCache.get(mediaFileId) ?? false;
  }

  setCanCopyAudio(mediaFileId: number, value: boolean) {
    this.canCopyAudioCache.set(mediaFileId, value);
  }
  getCanCopyAudio(mediaFileId: number): boolean {
    return this.canCopyAudioCache.get(mediaFileId) ?? false;
  }

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
      }
    }
  }
}
