import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { BurnInSubtitle } from './transcoding';
import type { CodecVariant } from './transcoding/codec/types';

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

  /** HDR ladder eligibility — set at playback-info by stream-builder
   *  (`isSourceHdr && clientSupportsHdr && sourceVideoCodec==='hevc'
   *  && !FLIKS_DISABLE_HEVC_HDR`). Read at master.m3u8 time so the
   *  playlist can emit the HEVC HDR ladder instead of the H.264 SDR
   *  ladder. Default false keeps the existing behaviour for callers
   *  that never reach playback-info (e.g. legacy direct URLs). */
  private readonly hdrLadderCache = new Map<number, boolean>();
  setHdrLadder(mediaFileId: number, value: boolean) {
    this.hdrLadderCache.set(mediaFileId, value);
  }
  getHdrLadder(mediaFileId: number): boolean {
    return this.hdrLadderCache.get(mediaFileId) ?? false;
  }

  /** Output codec variant chosen by stream-builder's selector. Read by
   *  the controller when building the SessionContext so ffmpeg-args
   *  resolves the right encoder descriptor. Single-codec-per-master
   *  rule: only one variant per file at a time. */
  private readonly videoVariantCache = new Map<number, CodecVariant>();
  setVideoVariant(mediaFileId: number, variant: CodecVariant | null) {
    if (variant) this.videoVariantCache.set(mediaFileId, variant);
    else this.videoVariantCache.delete(mediaFileId);
  }
  getVideoVariant(mediaFileId: number): CodecVariant | undefined {
    return this.videoVariantCache.get(mediaFileId);
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

  /** Client device category ('mobile' | 'desktop') captured at playback-info.
   *  Used by hlsMaster and HLS segment endpoints to pick the right bitrate ladder. */
  private readonly deviceTypeCache = new Map<number, 'mobile' | 'desktop'>();

  setDeviceType(mediaFileId: number, value: 'mobile' | 'desktop') {
    this.deviceTypeCache.set(mediaFileId, value);
  }

  getDeviceType(mediaFileId: number): 'mobile' | 'desktop' {
    return this.deviceTypeCache.get(mediaFileId) ?? 'desktop';
  }

  /** Whether master.m3u8 decided to use separate audio renditions (EXT-X-MEDIA). */
  private readonly useExtXMediaCache = new Map<number, boolean>();

  setUseExtXMedia(mediaFileId: number, value: boolean) {
    this.useExtXMediaCache.set(mediaFileId, value);
  }

  getUseExtXMedia(mediaFileId: number): boolean {
    return this.useExtXMediaCache.get(mediaFileId) ?? false;
  }

  /** Set when the playback target is a Chromecast receiver. Drives the
   *  HLS segment container choice (mpegts vs fmp4) in `buildFfmpegArgs`. */
  private readonly useTsCache = new Map<number, boolean>();

  setUseTs(mediaFileId: number, value: boolean) {
    this.useTsCache.set(mediaFileId, value);
  }

  getUseTs(mediaFileId: number): boolean {
    return this.useTsCache.get(mediaFileId) ?? false;
  }

  private segmentDurationCache = 3;

  setStreamingDuration(segDuration: number) {
    this.segmentDurationCache = segDuration;
  }

  getSegmentDuration(): number {
    return this.segmentDurationCache;
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
  private qsvLowPowerCache = false;

  setEncoderPreset(mediaFileId: number, preset: string) {
    this.encoderPresetCache.set(mediaFileId, preset);
  }

  getEncoderPreset(mediaFileId: number): string {
    return this.encoderPresetCache.get(mediaFileId) ?? 'faster';
  }

  /** QSV advanced options are global (driven by admin streaming settings). */
  setQsvOptions(opts: { lowPower: boolean }) {
    this.qsvLowPowerCache = opts.lowPower;
  }
  getQsvOptions(): { lowPower: boolean } {
    return { lowPower: this.qsvLowPowerCache };
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

  /** Canonical audio output decision computed by `stream-builder` at
   *  `playback-info` time. Every consumer (ffmpeg-args, master-playlist,
   *  admin dashboard) reads from here — no re-derivation downstream. */
  private readonly audioPlanCache = new Map<
    number,
    | { mode: 'copy'; codec: string }
    | {
        mode: 'transcode';
        codec: 'aac' | 'ac3' | 'eac3';
        bitrateBps: number;
      }
  >();

  setAudioPlan(
    mediaFileId: number,
    plan:
      | { mode: 'copy'; codec: string }
      | {
          mode: 'transcode';
          codec: 'aac' | 'ac3' | 'eac3';
          bitrateBps: number;
        },
  ) {
    this.audioPlanCache.set(mediaFileId, plan);
  }
  getAudioPlan(mediaFileId: number) {
    return this.audioPlanCache.get(mediaFileId) ?? null;
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
