import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { BurnInSubtitle, TonemapAlgo } from './transcoding';
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

function userFileKey(userId: number, mediaFileId: number): string {
  return `${userId}-${mediaFileId}`;
}

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
    const key = userFileKey(userId, mediaFileId);
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
    const key = userFileKey(userId, mediaFileId);
    this.sessions.delete(key);
    this.deviceNameCache.delete(key);
    this.transcodeReasonsCache.delete(key);
    this.tonemappingCache.delete(key);
    this.burnInCache.delete(key);
    this.audioStreamIndexCache.delete(key);
    this.audioStreamCountCache.delete(key);
    this.deviceTypeCache.delete(key);
    this.useExtXMediaCache.delete(key);
    this.useTsCache.delete(key);
    this.encoderPresetCache.delete(key);
    this.hdrLadderCache.delete(key);
    this.videoVariantCache.delete(key);
    this.canCopyVideoCache.delete(key);
    this.canCopyAudioCache.delete(key);
    this.audioPlanCache.delete(key);
  }

  /** Human-readable client device captured at playback-info ("Chrome — macOS",
   *  "iPhone", "Chromecast — Living Room"). Keyed per (user, file) so two users
   *  watching the same file from different devices don't collide. Shown only on
   *  the admin streams dashboard. */
  private readonly deviceNameCache = new Map<string, string>();

  setDeviceName(userId: number, mediaFileId: number, name: string) {
    if (name) this.deviceNameCache.set(userFileKey(userId, mediaFileId), name);
  }

  getDeviceName(userId: number, mediaFileId: number): string | null {
    return this.deviceNameCache.get(userFileKey(userId, mediaFileId)) ?? null;
  }

  /** Cache transcode reasons per (user, file) (set during playback-info, read by dashboard) */
  private readonly transcodeReasonsCache = new Map<
    string,
    { flag: string; message: string }[]
  >();

  setTranscodeReasons(
    userId: number,
    mediaFileId: number,
    reasons: { flag: string; message: string }[],
  ) {
    this.transcodeReasonsCache.set(userFileKey(userId, mediaFileId), reasons);
  }

  getTranscodeReasons(
    userId: number,
    mediaFileId: number,
  ): { flag: string; message: string }[] {
    return this.transcodeReasonsCache.get(userFileKey(userId, mediaFileId)) ?? [];
  }

  private readonly tonemappingCache = new Map<string, boolean>();

  setTonemapping(userId: number, mediaFileId: number, value: boolean) {
    this.tonemappingCache.set(userFileKey(userId, mediaFileId), value);
  }

  getTonemapping(userId: number, mediaFileId: number): boolean {
    return this.tonemappingCache.get(userFileKey(userId, mediaFileId)) ?? false;
  }

  private readonly burnInCache = new Map<string, BurnInSubtitle>();

  setBurnIn(
    userId: number,
    mediaFileId: number,
    info: BurnInSubtitle | undefined,
  ) {
    const key = userFileKey(userId, mediaFileId);
    if (info) {
      this.burnInCache.set(key, info);
    } else {
      this.burnInCache.delete(key);
    }
  }

  getBurnIn(userId: number, mediaFileId: number): BurnInSubtitle | undefined {
    return this.burnInCache.get(userFileKey(userId, mediaFileId)) ?? undefined;
  }

  /** HDR ladder eligibility — set at playback-info by stream-builder
   *  (`isSourceHdr && clientSupportsHdr && sourceVideoCodec==='hevc'
   *  && !FLIKS_DISABLE_HEVC_HDR`). Read at master.m3u8 time so the
   *  playlist can emit the HEVC HDR ladder instead of the H.264 SDR
   *  ladder. Default false keeps the existing behaviour for callers
   *  that never reach playback-info (e.g. legacy direct URLs). */
  private readonly hdrLadderCache = new Map<string, boolean>();
  setHdrLadder(userId: number, mediaFileId: number, value: boolean) {
    this.hdrLadderCache.set(userFileKey(userId, mediaFileId), value);
  }
  getHdrLadder(userId: number, mediaFileId: number): boolean {
    return this.hdrLadderCache.get(userFileKey(userId, mediaFileId)) ?? false;
  }

  /** Output codec variant chosen by stream-builder's selector. Read by
   *  the controller when building the SessionContext so ffmpeg-args
   *  resolves the right encoder descriptor. Single-codec-per-master
   *  rule: only one variant per (user, file) at a time. */
  private readonly videoVariantCache = new Map<string, CodecVariant>();
  setVideoVariant(
    userId: number,
    mediaFileId: number,
    variant: CodecVariant | null,
  ) {
    const key = userFileKey(userId, mediaFileId);
    if (variant) this.videoVariantCache.set(key, variant);
    else this.videoVariantCache.delete(key);
  }
  getVideoVariant(
    userId: number,
    mediaFileId: number,
  ): CodecVariant | undefined {
    return this.videoVariantCache.get(userFileKey(userId, mediaFileId));
  }

  private readonly audioStreamIndexCache = new Map<
    string,
    number | undefined
  >();

  /** Number of audio streams the user's device is exposed to — used to
   *  decide multi-audio HLS mode. Per-(user, file) because a profile
   *  that caps maxAudioStreams may see fewer streams than another. */
  private readonly audioStreamCountCache = new Map<string, number>();

  setAudioStreamCount(userId: number, mediaFileId: number, count: number) {
    this.audioStreamCountCache.set(userFileKey(userId, mediaFileId), count);
  }

  getAudioStreamCount(userId: number, mediaFileId: number): number {
    return this.audioStreamCountCache.get(userFileKey(userId, mediaFileId)) ?? 0;
  }

  /** Client device category ('mobile' | 'desktop') captured at playback-info.
   *  Used by hlsMaster and HLS segment endpoints to pick the right bitrate ladder. */
  private readonly deviceTypeCache = new Map<string, 'mobile' | 'desktop'>();

  setDeviceType(
    userId: number,
    mediaFileId: number,
    value: 'mobile' | 'desktop',
  ) {
    this.deviceTypeCache.set(userFileKey(userId, mediaFileId), value);
  }

  getDeviceType(userId: number, mediaFileId: number): 'mobile' | 'desktop' {
    return (
      this.deviceTypeCache.get(userFileKey(userId, mediaFileId)) ?? 'desktop'
    );
  }

  /** Whether master.m3u8 decided to use separate audio renditions (EXT-X-MEDIA). */
  private readonly useExtXMediaCache = new Map<string, boolean>();

  setUseExtXMedia(userId: number, mediaFileId: number, value: boolean) {
    this.useExtXMediaCache.set(userFileKey(userId, mediaFileId), value);
  }

  getUseExtXMedia(userId: number, mediaFileId: number): boolean {
    return (
      this.useExtXMediaCache.get(userFileKey(userId, mediaFileId)) ?? false
    );
  }

  /** Set when the playback target is a Tizen TV that needs the MPEG-TS
   *  fallback (issue #148 — AVPlay rejects HLS-fMP4 from the HLS muxer).
   *  Drives the HLS segment container choice (mpegts vs fmp4) in
   *  `buildFfmpegArgs`. Cast / browser / native mobile never set this.
   *  Per-(user, file) because two devices on the same file can disagree
   *  on the container — e.g. a Tizen + a browser session. */
  private readonly useTsCache = new Map<string, boolean>();

  setUseTs(userId: number, mediaFileId: number, value: boolean) {
    this.useTsCache.set(userFileKey(userId, mediaFileId), value);
  }

  getUseTs(userId: number, mediaFileId: number): boolean {
    return this.useTsCache.get(userFileKey(userId, mediaFileId)) ?? false;
  }

  private segmentDurationCache = 3;

  setStreamingDuration(segDuration: number) {
    this.segmentDurationCache = segDuration;
  }

  getSegmentDuration(): number {
    return this.segmentDurationCache;
  }

  setAudioStreamIndex(
    userId: number,
    mediaFileId: number,
    index: number | undefined,
  ) {
    const key = userFileKey(userId, mediaFileId);
    if (index != null) this.audioStreamIndexCache.set(key, index);
    else this.audioStreamIndexCache.delete(key);
  }

  getAudioStreamIndex(
    userId: number,
    mediaFileId: number,
  ): number | undefined {
    return this.audioStreamIndexCache.get(userFileKey(userId, mediaFileId));
  }

  // ── Admin streaming settings forwarded to transcode sessions ──
  private readonly encoderPresetCache = new Map<string, string>();
  private qsvLowPowerCache = false;

  setEncoderPreset(userId: number, mediaFileId: number, preset: string) {
    this.encoderPresetCache.set(userFileKey(userId, mediaFileId), preset);
  }

  getEncoderPreset(userId: number, mediaFileId: number): string {
    return (
      this.encoderPresetCache.get(userFileKey(userId, mediaFileId)) ?? 'faster'
    );
  }

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

  // ── Source-vs-client compat captured at playback-info time, read at
  //    master.m3u8 time to decide whether to emit a smart-remux variant ──
  private readonly canCopyVideoCache = new Map<string, boolean>();
  private readonly canCopyAudioCache = new Map<string, boolean>();
  // Source dimensions are a property of the file, identical across users.
  private readonly sourceWidthCache = new Map<number, number>();
  private readonly sourceHeightCache = new Map<number, number>();

  setCanCopyVideo(userId: number, mediaFileId: number, value: boolean) {
    this.canCopyVideoCache.set(userFileKey(userId, mediaFileId), value);
  }
  getCanCopyVideo(userId: number, mediaFileId: number): boolean {
    return (
      this.canCopyVideoCache.get(userFileKey(userId, mediaFileId)) ?? false
    );
  }

  setCanCopyAudio(userId: number, mediaFileId: number, value: boolean) {
    this.canCopyAudioCache.set(userFileKey(userId, mediaFileId), value);
  }
  getCanCopyAudio(userId: number, mediaFileId: number): boolean {
    return (
      this.canCopyAudioCache.get(userFileKey(userId, mediaFileId)) ?? false
    );
  }

  /** Canonical audio output decision computed by `stream-builder` at
   *  `playback-info` time. Every consumer (ffmpeg-args, master-playlist,
   *  admin dashboard) reads from here — no re-derivation downstream. */
  private readonly audioPlanCache = new Map<
    string,
    | { mode: 'copy'; codec: string }
    | {
        mode: 'transcode';
        codec: 'aac' | 'ac3' | 'eac3';
        bitrateBps: number;
      }
  >();

  setAudioPlan(
    userId: number,
    mediaFileId: number,
    plan:
      | { mode: 'copy'; codec: string }
      | {
          mode: 'transcode';
          codec: 'aac' | 'ac3' | 'eac3';
          bitrateBps: number;
        },
  ) {
    this.audioPlanCache.set(userFileKey(userId, mediaFileId), plan);
  }
  getAudioPlan(userId: number, mediaFileId: number) {
    return this.audioPlanCache.get(userFileKey(userId, mediaFileId)) ?? null;
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
    for (const session of this.sessions.values()) {
      if (session.lastActivity.getTime() <= cutoff) {
        this.unregister(session.userId, session.mediaFileId);
      }
    }
  }
}
