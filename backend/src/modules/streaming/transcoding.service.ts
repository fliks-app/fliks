import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ChildProcess, spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, watch, FSWatcher } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { TRANSCODE_DIR } from '../../common/constants/paths';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscodeProfile {
  name: string;
  maxWidth: number;
  maxHeight: number;
  videoBitrate: string;
  audioBitrate: string;
}

export type DeviceType = 'mobile' | 'desktop';

/** Threshold above which source bitrate earns its own "Original" rung
 *  alongside the transcode rung at the same resolution. */
export const ORIGINAL_SEPARATE_RATIO = 1.3;

export interface BurnInSubtitle {
  /** FFmpeg -vf filter string (e.g. "subtitles='/path/to/sub.srt'") or null for image-based */
  filter: string | null;
  /** For image-based: stream index to overlay */
  streamIndex?: number;
  /** 'text' or 'image' */
  type: 'text' | 'image';
}

export interface SessionContext {
  userId?: number;
  username?: string;
  mediaTitle?: string;
  mediaType?: string;
  posterUrl?: string | null;
  transcodeReasons?: { flag: string; message: string }[];
  tonemap?: boolean;
  burnInSubtitle?: BurnInSubtitle;
  audioStreamIndex?: number;
  /** Crop info for removing hardcoded black bars */
  crop?: { width: number; height: number; x: number; y: number };
  /** When true, produce video-only segments (audio served separately via EXT-X-MEDIA) */
  videoOnly?: boolean;
  /** When true, mux ALL audio tracks into the output (for native players like ExoPlayer) */
  mapAllAudio?: boolean;
  /** Audio stream info for multi-audio var_stream_map (single FFmpeg process) */
  audioStreams?: { language?: string; title?: string }[];
  /** Whether to use fMP4 segments (true) or MPEG-TS (false, for Cast) */
  useFmp4?: boolean;
  /** Client device category — selects the per-device bitrate ladder. */
  deviceType?: DeviceType;
  /**
   * FFmpeg encoder preset ('veryfast' | 'faster' | 'fast' | 'medium' | 'slow').
   * Applied to h264_qsv and libx264; VAAPI/NVENC ignore it (different naming).
   * Default 'faster' if unset — good speed/quality trade-off.
   */
  encoderPreset?: string;
  /** h264_qsv advanced options (all admin-configurable). */
  qsvOptions?: {
    /** -look_ahead 1 -look_ahead_depth 40 (better rate control, slight GPU cost) */
    lookahead: boolean;
    /** -low_power 1 (VDENC on Gen9+ — faster, slight quality loss) */
    lowPower: boolean;
    /** -adaptive_i 1 -adaptive_b 1 (encoder chooses I/B placement) */
    adaptive: boolean;
  };
  /** Source framerate (fps). Used to compute GOP = SEGMENT_DURATION * fps. */
  sourceFps?: number;
  /**
   * True when the backend already has a trusted `streamInfo` for this file
   * (populated by ffprobe at import / rescan). If set, FFmpeg can use an
   * aggressive `-analyzeduration 0 -probesize 200K` to skip the redundant
   * stream-info scan — we already know codecs / dimensions / audio layout.
   * Safe default is false (fall back to a balanced 1s/1MB probe).
   */
  trustedStreamInfo?: boolean;
}

export interface TranscodeSession {
  id: string;
  mediaFileId: number;
  quality: string;
  process: ChildProcess;
  cachePath: string;
  lastAccess: number;
  ready: Promise<void>;
  /** If true, video is copied (remux), not re-encoded */
  remux?: boolean;
  /** User & media context for admin dashboard */
  userId?: number;
  username?: string;
  mediaTitle?: string;
  mediaType?: string;
  posterUrl?: string | null;
  startedAt?: Date;
  transcodeReasons?: { flag: string; message: string }[];
  /** Actual HW accel used (may differ from detected if fallback to CPU) */
  actualHwAccel?: HwAccelType;
  /** FFmpeg stderr output (for debugging HW accel failures) */
  stderr?: string;
  /** True for audio-only sessions (multi-audio HLS renditions) */
  isAudioOnly?: boolean;
  /** The `-start_number` this session was spawned with. Used to determine
   *  whether a cache gap is ahead of (reachable) or behind (unreachable)
   *  the current encoding position. */
  startSegment?: number;
}

/** Build the session map key: one transcode per user per file (like Jellyfin/Plex). */
function sessionKey(mediaFileId: number, userId?: number): string {
  return userId != null ? `${mediaFileId}-u${userId}` : `${mediaFileId}-anon`;
}

/** Build audio session key: separate audio-only session per audio track index. */
function audioSessionKey(
  mediaFileId: number,
  audioIndex: number,
  userId?: number,
): string {
  return `${sessionKey(mediaFileId, userId)}-a${audioIndex}`;
}

/** Build early-segment session key: short-lived parallel ffmpeg producing
 *  seg-0..seg-1 while the main prewarm session encodes from seg-K (resume). */
function earlySessionKey(mediaFileId: number, userId?: number): string {
  return `${sessionKey(mediaFileId, userId)}:early`;
}

export type HwAccelType = 'vaapi' | 'nvenc' | 'qsv' | 'none';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DESKTOP_PROFILES: TranscodeProfile[] = [
  {
    name: '2160p',
    maxWidth: 3840,
    maxHeight: 2160,
    videoBitrate: '20M',
    audioBitrate: '192k',
  },
  {
    name: '1080p',
    maxWidth: 1920,
    maxHeight: 1080,
    videoBitrate: '8M',
    audioBitrate: '192k',
  },
  {
    name: '720p',
    maxWidth: 1280,
    maxHeight: 720,
    videoBitrate: '4M',
    audioBitrate: '128k',
  },
  {
    name: '480p',
    maxWidth: 854,
    maxHeight: 480,
    videoBitrate: '2M',
    audioBitrate: '96k',
  },
  {
    name: '360p',
    maxWidth: 640,
    maxHeight: 360,
    videoBitrate: '1M',
    audioBitrate: '64k',
  },
  {
    name: '240p',
    maxWidth: 426,
    maxHeight: 240,
    videoBitrate: '500k',
    audioBitrate: '64k',
  },
  {
    name: '144p',
    maxWidth: 256,
    maxHeight: 144,
    videoBitrate: '200k',
    audioBitrate: '48k',
  },
];

/** Conservative mobile ladder — same resolutions, lower target bitrates
 *  so phones on cellular don't burn through data. Audio unchanged. */
export const MOBILE_PROFILES: TranscodeProfile[] = [
  { name: '2160p', maxWidth: 3840, maxHeight: 2160, videoBitrate: '8M',  audioBitrate: '192k' },
  { name: '1080p', maxWidth: 1920, maxHeight: 1080, videoBitrate: '3M',  audioBitrate: '192k' },
  { name: '720p',  maxWidth: 1280, maxHeight: 720,  videoBitrate: '1500k', audioBitrate: '128k' },
  { name: '480p',  maxWidth: 854,  maxHeight: 480,  videoBitrate: '800k',  audioBitrate: '96k' },
  { name: '360p',  maxWidth: 640,  maxHeight: 360,  videoBitrate: '500k',  audioBitrate: '64k' },
  { name: '240p',  maxWidth: 426,  maxHeight: 240,  videoBitrate: '300k',  audioBitrate: '64k' },
  { name: '144p',  maxWidth: 256,  maxHeight: 144,  videoBitrate: '150k',  audioBitrate: '48k' },
];

export function getLadderForDevice(deviceType: DeviceType | undefined): TranscodeProfile[] {
  return deviceType === 'mobile' ? MOBILE_PROFILES : DESKTOP_PROFILES;
}

/** Backward-compatible alias — most callers want the desktop ladder. */
export const PROFILES = DESKTOP_PROFILES;

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Check if a segment (or its predecessor) exists. Checks .m4s, .ts, root, and subdir 0/. */
async function segmentNearby(
  cachePath: string,
  segment: number,
): Promise<boolean> {
  const num = String(segment).padStart(4, '0');
  const prevNum = segment > 0 ? String(segment - 1).padStart(4, '0') : null;
  const exts = ['.m4s', '.ts'];
  const dirs = [cachePath, path.join(cachePath, '0')];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (await fileExists(path.join(dir, `seg-${num}${ext}`))) return true;
      if (prevNum && (await fileExists(path.join(dir, `seg-${prevNum}${ext}`))))
        return true;
    }
  }
  return false;
}

/**
 * Starting from `fromSegment`, find the first segment number NOT on disk.
 * Returns `null` when every segment up to a reasonable lookahead exists.
 */
function firstMissingSegment(
  cachePath: string,
  fromSegment: number,
  maxLookahead = 2000,
): number | null {
  const exts = ['.m4s', '.ts'];
  const dirs = [cachePath, path.join(cachePath, '0')];
  for (let seg = fromSegment; seg < fromSegment + maxLookahead; seg++) {
    const num = String(seg).padStart(4, '0');
    let found = false;
    for (const dir of dirs) {
      if (found) break;
      for (const ext of exts) {
        if (existsSync(path.join(dir, `seg-${num}${ext}`))) {
          found = true;
          break;
        }
      }
    }
    if (!found) return seg;
  }
  return null;
}

let SEGMENT_DURATION = 3;
let INIT_TIME = 1;

/** Parse FFmpeg-style rates like '8M', '500k', '192k' to bits per second. */
export function parseBitrateToBps(s: string): number {
  const m = String(s)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const u = (m[2] || '').toLowerCase();
  if (u === 'm') return Math.round(n * 1e6);
  if (u === 'k') return Math.round(n * 1e3);
  return Math.round(n);
}
const SESSION_TIMEOUT_MS = 60 * 1000; // 60s (like Jellyfin HLS timeout)
const MAX_SESSIONS = 4;
/** Max gap (in segments) between FFmpeg frontier and requested segment before restarting. */
const SEEK_WAIT_THRESHOLD = 15;

@Injectable()
export class TranscodingService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(TranscodingService.name);
  private readonly sessions = new Map<string, TranscodeSession>();
  /** Per-key locks to prevent concurrent getOrCreate calls racing (like Jellyfin's AsyncKeyedLocker). */
  private readonly locks = new Map<string, Promise<void>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private detectedHwAccel: HwAccelType = 'none';
  private cachePath = path.join(TRANSCODE_DIR, 'stream');

  async onModuleInit() {
    // Ensure cache directory exists
    await fsp.mkdir(this.cachePath, { recursive: true });

    // Detect hardware acceleration
    this.detectedHwAccel = await this.detectHwAccel();
    this.log.log(`Hardware acceleration: ${this.detectedHwAccel}`);

    // Cleanup timer
    this.cleanupTimer = setInterval(() => this.cleanupStaleSessions(), 30_000);
  }

  /** Get an existing session without creating or modifying it. */
  getExistingSession(
    mediaFileId: number,
    userId?: number,
  ): TranscodeSession | undefined {
    const key = sessionKey(mediaFileId, userId);
    return this.sessions.get(key);
  }

  /** Get the short-lived early-segment companion session (if any). Lives in
   *  parallel to the main session during a mid-file resume. */
  getExistingEarlySession(
    mediaFileId: number,
    userId?: number,
  ): TranscodeSession | undefined {
    return this.sessions.get(earlySessionKey(mediaFileId, userId));
  }

  async onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const session of this.sessions.values()) {
      session.process.kill('SIGTERM');
    }
    this.sessions.clear();
  }

  getDetectedHwAccel(): HwAccelType {
    return this.detectedHwAccel;
  }

  /** Update segment durations from admin streaming settings. */
  setSegmentDurations(segDuration: number, initTime: number) {
    SEGMENT_DURATION = segDuration;
    INIT_TIME = initTime;
  }

  getSegmentDuration(): number {
    return SEGMENT_DURATION;
  }

  getActiveSessions(): TranscodeSession[] {
    return Array.from(this.sessions.values());
  }

  /** Estimate transcode progress as a percentage (0-100) by looking at the highest segment on disk. */
  /**
   * Resolve an existing session: serve from cache, wait for FFmpeg, or signal
   * that a new session is needed. Shared between transcode and remux paths.
   *
   * Returns the existing session if it can serve the segment, or null if the
   * caller should create a new session (session is deleted from the map).
   */
  private async resolveExistingSession(
    key: string,
    existing: TranscodeSession,
    requestedSegment: number,
    qualityMatch: boolean,
  ): Promise<TranscodeSession | null> {
    // exitCode 0 + segment cached → serve from cache.
    // exitCode 0 + segment missing → delete, caller restarts.
    if (existing.process.exitCode === 0 && qualityMatch) {
      if (await segmentNearby(existing.cachePath, requestedSegment)) {
        existing.lastAccess = Date.now();
        return existing;
      }
      this.log.log(
        `Session [${key}]: exited but segment ${requestedSegment} not cached, restarting`,
      );
      this.sessions.delete(key);
      existing.startSegment = requestedSegment;
      return null;
    }

    // Crash (non-zero exit) → clean up, caller restarts.
    if (existing.process.exitCode !== null && existing.process.exitCode !== 0) {
      this.log.warn(
        `Session [${key}]: FFmpeg crashed (code ${existing.process.exitCode}), restarting`,
      );
      this.sessions.delete(key);
      await fsp.rm(existing.cachePath, { recursive: true, force: true });
      return null;
    }

    // Quality/mode mismatch → handled by caller (different logic per path).
    if (!qualityMatch) return null;

    // ── Seek handling (running session, same quality) ──
    existing.lastAccess = Date.now();

    if (!(await segmentNearby(existing.cachePath, requestedSegment))) {
      // Close to startSegment → wait for FFmpeg to catch up.
      if (requestedSegment >= (existing.startSegment ?? 0)) {
        const gap = requestedSegment - (existing.startSegment ?? 0);
        if (gap <= SEEK_WAIT_THRESHOLD) {
          return existing;
        }
      }
      // Far away → restart at requested position.
      this.log.log(
        `Seek: restarting [${key}] from segment ${requestedSegment} (not cached)`,
      );
      this.sessions.delete(key);
      await this.killProcess(existing.process);
      existing.startSegment = requestedSegment;
      return null;
    }

    // Segment cached — check for unreachable gap behind startSegment.
    const gap = firstMissingSegment(existing.cachePath, requestedSegment);
    if (gap != null && gap < (existing.startSegment ?? 0)) {
      this.log.log(
        `Seek: segment ${requestedSegment} cached, restarting [${key}] at unreachable gap ${gap}`,
      );
      this.sessions.delete(key);
      await this.killProcess(existing.process);
      // Caller should restart at `gap` — encode it in startSegment hint.
      existing.startSegment = gap;
      return null;
    }

    return existing;
  }

  /** Find the highest segment number on disk (fast readdir scan). */
  private async highestSegmentOnDisk(cachePath: string): Promise<number> {
    let maxSeg = -1;
    const scanDir = async (dir: string) => {
      try {
        for (const f of await fsp.readdir(dir)) {
          const m = f.match(/^seg-(\d+)\.(m4s|ts)$/);
          if (m) {
            const n = parseInt(m[1], 10);
            if (n > maxSeg) maxSeg = n;
          }
        }
      } catch { /* dir doesn't exist */ }
    };
    await scanDir(cachePath);
    await scanDir(path.join(cachePath, '0'));
    return maxSeg;
  }

  async getTranscodePercent(
    session: TranscodeSession,
    durationSeconds: number,
  ): Promise<number> {
    if (!durationSeconds || durationSeconds <= 0) return 0;
    try {
      const files = await fsp.readdir(session.cachePath);
      // Find the highest segment number (accounts for seek restarts)
      let maxSeg = -1;
      for (const f of files) {
        const m = f.match(/^seg-(\d+)\.ts$/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > maxSeg) maxSeg = n;
        }
      }
      if (maxSeg < 0) return 0;
      const transcodedUpTo = (maxSeg + 1) * SEGMENT_DURATION;
      return Math.min(100, (transcodedUpTo / durationSeconds) * 100);
    } catch {
      return 0;
    }
  }

  /**
   * Get available quality profiles for a given source resolution + device class.
   */
  getAvailableProfiles(
    sourceWidth: number,
    sourceHeight: number,
    deviceType: DeviceType = 'desktop',
  ): TranscodeProfile[] {
    return getLadderForDevice(deviceType).filter(
      (p) => p.maxWidth <= sourceWidth || p.maxHeight <= sourceHeight,
    );
  }

  /**
   * Generate the HLS master playlist listing available qualities.
   */
  generateMasterPlaylist(
    mediaFileId: number,
    sourceWidth: number,
    sourceHeight: number,
    tokenParam: string,
    includeRemux = false,
    sourceBitrate?: number,
    audioStreams?: { language?: string; title?: string }[],
    onlyQuality?: string,
    defaultAudioIndex = 0,
    deviceType: DeviceType = 'desktop',
  ): string {
    const multiAudio = audioStreams && audioStreams.length > 1;
    const lines = ['#EXTM3U'];

    // Multi-audio: declare alternate audio renditions via EXT-X-MEDIA
    if (multiAudio) {
      const pickedIdx =
        defaultAudioIndex >= 0 && defaultAudioIndex < audioStreams.length
          ? defaultAudioIndex
          : 0;
      for (let i = 0; i < audioStreams.length; i++) {
        const a = audioStreams[i];
        const lang = a.language || 'und';
        const name = a.title || lang;
        const isDefault = i === pickedIdx ? 'YES' : 'NO';
        lines.push(
          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${name}",LANGUAGE="${lang}",DEFAULT=${isDefault},AUTOSELECT=${isDefault},URI="/api/stream/${mediaFileId}/audio/${i}/index.m3u8${tokenParam}"`,
        );
      }
    }

    // Always declare CODECS on EXT-X-STREAM-INF. For HLS-TS, this lets Shaka
    // skip fetching seg 0 purely to probe codecs (TS has no init segment) —
    // otherwise a user resuming mid-file wastes a transcode pass at seg 0
    // before the real seek-aware session starts at their resume position.
    // We always produce H.264 High @ L4.0 + AAC-LC, so the string is fixed.
    const audioAttr = multiAudio ? ',AUDIO="audio"' : '';
    const transcodeCodecs = ',CODECS="avc1.640028,mp4a.40.2"';

    // The HLS master never advertises the `/remux/` variant — it proved
    // unreliable on ExoPlayer (Android), which would ABR-downgrade from the
    // remux rung to the identical-resolution 1080p transcode mid-stream and
    // trigger a pointless FFmpeg kill+restart. Transcode profiles cover the
    // full resolution ladder; "remux"/"original" quality picks are mapped
    // onto the top transcode profile.
    const ladder = getLadderForDevice(deviceType);
    let profiles = this.getAvailableProfiles(sourceWidth, sourceHeight, deviceType);
    if (!profiles.length) profiles.push(ladder[ladder.length - 1]); // at least 480p

    if (onlyQuality) {
      if (onlyQuality === 'remux' || onlyQuality === 'original') {
        // Pick the top profile whose maxWidth is ≤ source (matches source
        // resolution as closely as possible without upscaling).
        const top =
          profiles.find((p) => p.maxWidth <= sourceWidth) ?? profiles[0];
        profiles = [top];
      } else {
        const picked = profiles.find((p) => p.name === onlyQuality);
        if (picked) profiles = [picked];
      }
    }

    for (const p of profiles) {
      const bw =
        parseBitrateToBps(p.videoBitrate) + parseBitrateToBps(p.audioBitrate);
      const w = Math.min(p.maxWidth, sourceWidth);
      const rawH = (w * sourceHeight) / sourceWidth;
      const h = Math.floor(rawH / 16) * 16 || 16;
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${w}x${h},NAME="${p.name}"${transcodeCodecs}${audioAttr}`,
        `/api/stream/${mediaFileId}/${p.name}/index.m3u8${tokenParam}`,
      );
    }
    return lines.join('\n');
  }

  /**
   * Start or retrieve a transcode session.
   * Key: one session per user per file (like Jellyfin/Plex).
   * If the user requests a different quality, the old session is killed first.
   */
  async getOrCreateSession(
    mediaFileId: number,
    quality: string,
    absolutePath: string,
    requestedSegment = 0,
    ctx?: SessionContext,
  ): Promise<TranscodeSession> {
    const key = sessionKey(mediaFileId, ctx?.userId);
    const session = await this.withLock(key, () =>
      this.doGetOrCreateSession(
        key,
        mediaFileId,
        quality,
        absolutePath,
        requestedSegment,
        ctx,
      ),
    );
    // HW accel crash check runs OUTSIDE the lock so that concurrent segment
    // requests on the same key (seek, ABR, retry) don't pile up for the 15-30s
    // it takes a big 4K/HDR source to produce its first segment.
    return this.verifyHwAccelOrFallback(
      session,
      key,
      mediaFileId,
      quality,
      absolutePath,
      session.cachePath,
      requestedSegment,
      ctx,
    );
  }

  private async doGetOrCreateSession(
    key: string,
    mediaFileId: number,
    quality: string,
    absolutePath: string,
    requestedSegment: number,
    ctx?: SessionContext,
  ): Promise<TranscodeSession> {
    const isVideoOnly = ctx?.videoOnly ?? false;
    const ctxAudioStreams = ctx?.audioStreams;
    const useVarStreamMap =
      isVideoOnly && ctxAudioStreams && ctxAudioStreams.length > 1;

    const existing = this.sessions.get(key);
    if (existing) {
      const qualityMatch = existing.quality === quality && !existing.remux;
      if (!qualityMatch && existing.process.exitCode === null) {
        // Quality changed — kill old process. Each quality has its own cache dir.
        this.log.log(
          `Quality change [${key}]: ${existing.quality} → ${quality}, killing old session`,
        );
        this.sessions.delete(key);
        await this.killProcess(existing.process);
      } else {
        const resolved = await this.resolveExistingSession(
          key, existing, requestedSegment, qualityMatch,
        );
        if (resolved) return resolved;
        // resolved === null → session deleted. existing.startSegment has the restart target.
        const restartAt = existing.startSegment ?? requestedSegment;
        const dir = path.join(this.cachePath, key, quality);
        await fsp.mkdir(dir, { recursive: true });
        if (useVarStreamMap) {
          for (let i = 0; i <= ctxAudioStreams!.length; i++) {
            await fsp.mkdir(path.join(dir, String(i)), { recursive: true });
          }
        }
        return this.startSeekSession(
          key, mediaFileId, quality, absolutePath, dir, restartAt, ctx,
        );
      }
    }

    // Enforce max sessions (audio-only sessions don't count)
    const videoSessionCount = Array.from(this.sessions.values()).filter(
      (s) => !s.isAudioOnly,
    ).length;
    if (videoSessionCount >= MAX_SESSIONS) {
      this.evictOldestSession();
    }

    const ladder = getLadderForDevice(ctx?.deviceType);
    const profile = ladder.find((p) => p.name === quality) ?? ladder[0];
    const sessionDir = path.join(this.cachePath, key, quality);
    await fsp.mkdir(sessionDir, { recursive: true });

    const shouldTonemap = ctx?.tonemap ?? false;
    const burnIn = ctx?.burnInSubtitle;
    const audioIdx = ctx?.audioStreamIndex;
    const cropInfo = ctx?.crop;
    const isMapAllAudio = ctx?.mapAllAudio ?? false;

    // var_stream_map needs subdirectories pre-created (FFmpeg won't create them)
    if (useVarStreamMap) {
      for (let i = 0; i <= ctxAudioStreams!.length; i++) {
        await fsp.mkdir(path.join(sessionDir, String(i)), { recursive: true });
      }
    }
    const session = this.startFfmpeg(
      key,
      mediaFileId,
      quality,
      absolutePath,
      profile,
      sessionDir,
      this.detectedHwAccel,
      requestedSegment,
      shouldTonemap,
      burnIn,
      audioIdx,
      cropInfo,
      isVideoOnly,
      isMapAllAudio,
      ctxAudioStreams,
      ctx?.useFmp4 ?? true,
      ctx?.encoderPreset,
      ctx?.qsvOptions,
      ctx?.sourceFps,
      ctx?.trustedStreamInfo,
    );
    this.applyContext(session, ctx);

    return session;
  }

  /**
   * Verify HW accel didn't crash on spawn; fall back to CPU if it did.
   *
   * Runs OUTSIDE the session-creation lock — awaits session.ready + up to 5s
   * of polling which would otherwise block every concurrent segment request
   * on this key (seen as 10s Shaka timeouts during pre-start of big 4K/HDR
   * sources where the first segment takes 15-30s to appear).
   *
   * Returns the session that should be used (may be a fresh CPU session if
   * the HW one crashed).
   */
  private async verifyHwAccelOrFallback(
    session: TranscodeSession,
    key: string,
    mediaFileId: number,
    quality: string,
    absolutePath: string,
    sessionDir: string,
    requestedSegment: number,
    ctx?: SessionContext,
  ): Promise<TranscodeSession> {
    if (this.detectedHwAccel === 'none') return session;
    const isVideoOnly = ctx?.videoOnly ?? false;
    const ctxAudioStreams = ctx?.audioStreams;
    const useVarStreamMap =
      isVideoOnly && ctxAudioStreams && ctxAudioStreams.length > 1;
    const ladder = getLadderForDevice(ctx?.deviceType);
    const profile = ladder.find((p) => p.name === quality) ?? ladder[0];

    await session.ready;
    const segNum = String(requestedSegment).padStart(4, '0');
    const segExts = ['.m4s', '.ts'];
    const segExists = async () => {
      for (const ext of segExts) {
        if (await fileExists(path.join(sessionDir, `seg-${segNum}${ext}`))) return true;
        if (await fileExists(path.join(sessionDir, '0', `seg-${segNum}${ext}`))) return true;
      }
      return false;
    };
    for (let i = 0; i < 10; i++) {
      if (session.process.exitCode !== null) break;
      if (await segExists()) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const crashed =
      session.process.exitCode !== null && !(await segExists());
    if (!crashed) return session;

    // Reacquire lock to safely swap sessions — another request may have
    // already replaced it (e.g. via seek restart).
    return this.withLock(key, async () => {
      if (this.sessions.get(key) !== session) {
        // Another path already replaced the session — use current one.
        return this.sessions.get(key) ?? session;
      }
      this.log.warn(
        `Transcode [${key}]: HW accel (${this.detectedHwAccel}) crashed (exit=${session.process.exitCode}), falling back to CPU\n${(session.stderr ?? '').slice(-1000)}`,
      );
      this.sessions.delete(key);
      await this.killAndClean(session.process, sessionDir);
      await fsp.mkdir(sessionDir, { recursive: true });
      if (useVarStreamMap) {
        for (let i = 0; i <= ctxAudioStreams!.length; i++) {
          await fsp.mkdir(path.join(sessionDir, String(i)), { recursive: true });
        }
      }
      const cpuSession = this.startFfmpeg(
        key,
        mediaFileId,
        quality,
        absolutePath,
        profile,
        sessionDir,
        'none',
        requestedSegment,
        ctx?.tonemap ?? false,
        ctx?.burnInSubtitle,
        ctx?.audioStreamIndex,
        ctx?.crop,
        isVideoOnly,
        ctx?.mapAllAudio ?? false,
        ctxAudioStreams,
        ctx?.useFmp4 ?? true,
        ctx?.encoderPreset,
        ctx?.qsvOptions,
        ctx?.sourceFps,
      );
      this.applyContext(cpuSession, ctx);
      this.sessions.set(key, cpuSession);
      return cpuSession;
    });
  }

  /**
   * Spawn a short-lived ffmpeg in parallel to the main prewarm session,
   * producing only seg-0 (and seg-1 as a small buffer) of the requested
   * quality. Used on resume mid-file: Shaka always fetches seg-0 at startup
   * even when load(url, startTime>0) is called, and routing that fetch to
   * the main session would force a kill+restart from K back to 0 — wiping
   * out the prewarm work and adding a second 4K cold-start.
   *
   * Bounded by `-t 4` (input-side limit) so ffmpeg exits ~5s after spawn
   * once it has flushed seg-0 (1s, INIT_TIME) + seg-1 (3s) plus the trailer.
   * Same encoder profile + audio layout as the main session so segments and
   * init.mp4 are decode-compatible (Shaka can mix-and-match across the two
   * sessions seamlessly).
   *
   * Idempotent: a second call with the same (mediaFileId, userId, quality)
   * returns the existing session (running or cleanly exited). Quality
   * mismatch reuses the slot after killing the stale process.
   */
  async getOrCreateEarlySession(
    mediaFileId: number,
    quality: string,
    absolutePath: string,
    ctx?: SessionContext,
  ): Promise<TranscodeSession> {
    const id = earlySessionKey(mediaFileId, ctx?.userId);
    return this.withLock(id, async () => {
      const existing = this.sessions.get(id);
      if (existing) {
        const qualityMatch = existing.quality === quality;
        if (qualityMatch && existing.process.exitCode === null) {
          existing.lastAccess = Date.now();
          return existing;
        }
        if (qualityMatch && existing.process.exitCode === 0) {
          // ffmpeg finished cleanly — segments still on disk, reuse.
          existing.lastAccess = Date.now();
          return existing;
        }
        // Crashed or quality changed — wipe and respawn.
        this.sessions.delete(id);
        await this.killAndClean(existing.process, existing.cachePath);
      }

      const ladder = getLadderForDevice(ctx?.deviceType);
      const profile = ladder.find((p) => p.name === quality) ?? ladder[0];
      const sessionDir = path.join(this.cachePath, id, quality);
      await fsp.mkdir(sessionDir, { recursive: true });

      const isVideoOnly = ctx?.videoOnly ?? false;
      const ctxAudioStreams = ctx?.audioStreams;
      const useVarStreamMap =
        isVideoOnly && ctxAudioStreams && ctxAudioStreams.length > 1;
      if (useVarStreamMap) {
        for (let i = 0; i <= ctxAudioStreams.length; i++) {
          await fsp.mkdir(path.join(sessionDir, String(i)), { recursive: true });
        }
      }

      const args = this.buildFfmpegArgs(
        absolutePath,
        profile,
        sessionDir,
        this.detectedHwAccel,
        /* startSegment */ 0,
        ctx?.tonemap ?? false,
        ctx?.burnInSubtitle,
        ctx?.audioStreamIndex,
        ctx?.crop,
        isVideoOnly,
        ctx?.mapAllAudio ?? false,
        ctxAudioStreams,
        ctx?.useFmp4 ?? true,
        ctx?.encoderPreset,
        ctx?.qsvOptions,
        ctx?.sourceFps,
        ctx?.trustedStreamInfo,
      );
      // Bound the input read to 4s — enough for seg-0 (1s) + seg-1 (3s).
      // Insert as an INPUT option (before -i) so demuxer stops reading after
      // 4s of source, ffmpeg flushes the trailer and exits cleanly.
      const inputIdx = args.indexOf('-i');
      if (inputIdx >= 0) args.splice(inputIdx, 0, '-t', '4');

      const usesVarStreamMap =
        isVideoOnly && ctxAudioStreams && ctxAudioStreams.length > 1;
      const useFmp4 = ctx?.useFmp4 ?? true;
      const session = this.spawnFfmpegSession({
        id,
        mediaFileId,
        quality,
        args,
        sessionDir,
        startSegment: 0,
        segExt: useFmp4 ? '.m4s' : '.ts',
        segSubDir: usesVarStreamMap ? '0' : undefined,
        extra: { actualHwAccel: this.detectedHwAccel },
      });
      this.applyContext(session, ctx);
      return session;
    });
  }

  /**
   * Get the index.m3u8 playlist for a session.
   * Waits until FFmpeg has started writing segments.
   */
  async getPlaylist(session: TranscodeSession): Promise<string | null> {
    await session.ready;
    const playlistPath = path.join(session.cachePath, 'index.m3u8');

    // Wait up to 60s for the playlist to appear (CPU transcode can be slow to start)
    for (let i = 0; i < 120; i++) {
      if (await fileExists(playlistPath)) {
        const content = await fsp.readFile(playlistPath, 'utf-8');
        if (content.includes('.ts') || content.includes('.m4s')) return content; // Wait until at least one segment is listed
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.log.warn(`Playlist not ready for session ${session.id} after 60s`);
    return null;
  }

  /**
   * Get a segment file path, waiting if it's being generated.
   *
   * Uses fs.watch (inotify on Linux) so we react within milliseconds of
   * ffmpeg writing the segment. Without `temp_file`, ffmpeg writes segments
   * incrementally so we verify size-stability (50ms re-stat) before serving.
   * For already-completed segments (ffmpeg moved past them), the first stat
   * check passes immediately — 0ms overhead in the common case.
   */
  async getSegmentPath(
    session: TranscodeSession,
    segmentName: string,
  ): Promise<string | null> {
    const segPath = path.join(session.cachePath, segmentName);

    // Quick size-stability check: if file exists and isn't growing, serve
    // immediately — no need to wait for session.ready (file may be from
    // a previous FFmpeg run that was restarted by HW accel fallback).
    if (existsSync(segPath)) {
      const stable = await this.isSegmentStable(segPath);
      if (stable) return segPath;
      // File exists but still being written — fall through to watch loop.
    }

    // Init segments: wait for FFmpeg to produce at least the first media
    // segment before watching (init is written before seg-0000).
    if (segmentName.includes('init')) {
      await session.ready;
      // Re-check after ready — init should now exist.
      if (existsSync(segPath)) {
        const stable = await this.isSegmentStable(segPath);
        if (stable) return segPath;
      }
    }

    const dir = path.dirname(segPath);
    const name = path.basename(segPath);

    return new Promise((resolve) => {
      let watcher: FSWatcher | null = null;
      let exitTimer: NodeJS.Timeout | null = null;
      let timeout: NodeJS.Timeout | null = null;
      let settled = false;

      const finish = (val: string | null) => {
        if (settled) return;
        settled = true;
        watcher?.close();
        if (exitTimer) clearInterval(exitTimer);
        if (timeout) clearTimeout(timeout);
        resolve(val);
      };

      const tryServe = async () => {
        if (settled || !existsSync(segPath)) return;
        if (await this.isSegmentStable(segPath)) finish(segPath);
      };

      try {
        watcher = watch(dir, { persistent: false }, (_event, filename) => {
          if (filename === name) void tryServe();
        });
      } catch {
        // Directory doesn't exist yet — exitTimer covers it.
      }

      // Cover the race where the file appeared between the existsSync above
      // and watch() registering its handlers.
      void tryServe();

      exitTimer = setInterval(() => {
        if (session.process.exitCode !== null && !existsSync(segPath)) {
          finish(null);
        } else {
          void tryServe();
        }
      }, 500);

      timeout = setTimeout(() => finish(null), 60_000);
    });
  }

  /**
   * 50ms size-stability check. Returns true when the file exists, is non-empty,
   * and its size hasn't changed in 50ms (= ffmpeg finished writing this segment).
   * For segments ffmpeg has already moved past, the first stat succeeds and
   * the 50ms sleep is skipped via the size === size2 check (no growth).
   */
  private async isSegmentStable(segPath: string): Promise<boolean> {
    try {
      const s1 = (await fsp.stat(segPath)).size;
      if (s1 === 0) return false;
      await new Promise((r) => setTimeout(r, 50));
      const s2 = (await fsp.stat(segPath)).size;
      return s1 === s2;
    } catch {
      return false;
    }
  }

  /**
   * Shared helper: spawn an FFmpeg process, wait for first segment, and register the session.
   */
  private spawnFfmpegSession(opts: {
    id: string;
    mediaFileId: number;
    quality: string;
    args: string[];
    sessionDir: string;
    startSegment: number;
    /** Segment file extension (default '.m4s') */
    segExt?: string;
    /** Subdirectory for first segment check (e.g. '0' for var_stream_map) */
    segSubDir?: string;
    extra?: Partial<TranscodeSession>;
  }): TranscodeSession {
    const {
      id,
      mediaFileId,
      quality,
      args,
      sessionDir,
      startSegment,
      segExt = '.m4s',
      segSubDir,
      extra,
    } = opts;
    const { resolve: readyResolve, promise: readyPromise } =
      this.createDeferred();

    this.log.log(`FFmpeg start [${id}]: ffmpeg ${args.join(' ')}`);

    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    let resolved = false;
    const segDir = segSubDir ? path.join(sessionDir, segSubDir) : sessionDir;
    const firstSeg = path.join(
      segDir,
      `seg-${String(startSegment).padStart(4, '0')}${segExt}`,
    );
    const firstSegName = path.basename(firstSeg);

    let readyWatcher: FSWatcher | null = null;
    const checkReady = () => {
      if (!resolved && existsSync(firstSeg)) {
        resolved = true;
        readyWatcher?.close();
        clearInterval(pollTimer);
        readyResolve();
      }
    };

    // fs.watch (inotify) wakes us within ms of ffmpeg's atomic rename
    // (combined with +temp_file). pollTimer below is a safety net for the
    // rare case where segDir didn't exist at watcher registration time.
    try {
      readyWatcher = watch(
        segDir,
        { persistent: false },
        (_event, filename) => {
          if (filename === firstSegName) checkReady();
        },
      );
    } catch {
      // Directory will be created by ffmpeg shortly — pollTimer covers this.
    }

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      checkReady();
    });

    const pollTimer = setInterval(() => {
      checkReady();
    }, 500);

    proc.on('close', (code) => {
      clearInterval(pollTimer);
      readyWatcher?.close();
      if (!resolved) {
        resolved = true;
        readyResolve();
      }
      if (code && code !== 0 && code !== 255) {
        this.log.error(`FFmpeg [${id}] exited ${code}:\n${stderr.slice(-500)}`);
      }
    });

    proc.on('error', (err) => {
      this.log.error(`FFmpeg [${id}] spawn error: ${err.message}`);
      readyResolve();
    });

    const session: TranscodeSession = {
      id,
      mediaFileId,
      quality,
      process: proc,
      cachePath: sessionDir,
      lastAccess: Date.now(),
      ready: readyPromise,
      startSegment,
      ...extra,
    };

    // Keep stderr reference on session for debugging
    proc.stderr.on('data', () => {
      session.stderr = stderr;
    });

    this.sessions.set(id, session);
    return session;
  }

  private startFfmpeg(
    sessionId: string,
    mediaFileId: number,
    quality: string,
    absolutePath: string,
    profile: TranscodeProfile,
    sessionDir: string,
    hwAccel: HwAccelType,
    startSegment = 0,
    tonemap = false,
    burnIn?: BurnInSubtitle,
    audioStreamIndex?: number,
    crop?: { width: number; height: number; x: number; y: number },
    videoOnly = false,
    mapAllAudio = false,
    audioStreams?: { language?: string; title?: string }[],
    useFmp4 = true,
    encoderPreset?: string,
    qsvOptions?: { lookahead: boolean; lowPower: boolean; adaptive: boolean },
    sourceFps?: number,
    trustedStreamInfo = false,
  ): TranscodeSession {
    const args = this.buildFfmpegArgs(
      absolutePath,
      profile,
      sessionDir,
      hwAccel,
      startSegment,
      tonemap,
      burnIn,
      audioStreamIndex,
      crop,
      videoOnly,
      mapAllAudio,
      audioStreams,
      useFmp4,
      encoderPreset,
      qsvOptions,
      sourceFps,
      trustedStreamInfo,
    );

    const usesVarStreamMap =
      videoOnly && audioStreams && audioStreams.length > 1;
    const segExt = useFmp4 ? '.m4s' : '.ts';
    return this.spawnFfmpegSession({
      id: sessionId,
      mediaFileId,
      quality,
      args,
      sessionDir,
      startSegment,
      segExt,
      segSubDir: usesVarStreamMap ? '0' : undefined,
      extra: { actualHwAccel: hwAccel },
    });
  }

  private startSeekSession(
    sessionId: string,
    mediaFileId: number,
    quality: string,
    absolutePath: string,
    sessionDir: string,
    startSegment: number,
    ctx?: SessionContext,
  ): TranscodeSession {
    const ladder = getLadderForDevice(ctx?.deviceType);
    const profile = ladder.find((p) => p.name === quality) ?? ladder[0];
    const session = this.startFfmpeg(
      sessionId,
      mediaFileId,
      quality,
      absolutePath,
      profile,
      sessionDir,
      this.detectedHwAccel,
      startSegment,
      ctx?.tonemap ?? false,
      ctx?.burnInSubtitle,
      ctx?.audioStreamIndex,
      ctx?.crop,
      ctx?.videoOnly ?? false,
      ctx?.mapAllAudio ?? false,
      ctx?.audioStreams,
      ctx?.useFmp4 ?? true,
      ctx?.encoderPreset,
      ctx?.qsvOptions,
      ctx?.sourceFps,
      ctx?.trustedStreamInfo,
    );
    this.applyContext(session, ctx);
    this.sessions.set(sessionId, session);
    return session;
  }

  async killSession(mediaFileId: number, userId?: number) {
    const key = sessionKey(mediaFileId, userId);
    const earlyKey = earlySessionKey(mediaFileId, userId);
    const promises: Promise<void>[] = [];
    const session = this.sessions.get(key);
    if (session) {
      this.log.log(`Kill session [${key}] (quality: ${session.quality})`);
      this.sessions.delete(key);
      promises.push(this.killAndClean(session.process, session.cachePath));
    }
    // Kill the early-segment companion session (resume seg-0 oneshot).
    const earlySession = this.sessions.get(earlyKey);
    if (earlySession) {
      this.sessions.delete(earlyKey);
      promises.push(
        this.killAndClean(earlySession.process, earlySession.cachePath),
      );
    }
    // Also kill associated audio sessions
    const audioPrefix = `${key}-a`;
    for (const [id, s] of this.sessions) {
      if (id.startsWith(audioPrefix)) {
        this.sessions.delete(id);
        promises.push(this.killAndClean(s.process, s.cachePath));
      }
    }
    await Promise.all(promises);
    // Clean up parent dirs (stream/key/ and stream/key:early/) if now empty.
    const parentDir = path.join(this.cachePath, key);
    fsp.rm(parentDir, { recursive: true, force: true }).catch(() => {});
    const earlyParentDir = path.join(this.cachePath, earlyKey);
    fsp.rm(earlyParentDir, { recursive: true, force: true }).catch(() => {});
  }

  /** Kill a session by its map key (used by admin dashboard). */
  killSessionById(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    this.gracefulKill(session);
  }

  /** Kill all sessions for a given media file (used on player close / page unload). */
  killAllSessionsForFile(mediaFileId: number) {
    for (const [id, session] of this.sessions) {
      if (session.mediaFileId === mediaFileId) {
        this.log.log(`Killing session ${id} for media file ${mediaFileId}`);
        this.sessions.delete(id);
        this.gracefulKill(session);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private buildFfmpegArgs(
    inputPath: string,
    profile: TranscodeProfile,
    outputDir: string,
    hwAccel: HwAccelType,
    startSegment = 0,
    tonemap = false,
    burnIn?: BurnInSubtitle,
    audioStreamIndex?: number,
    crop?: { width: number; height: number; x: number; y: number },
    videoOnly = false,
    mapAllAudio = false,
    audioStreams?: { language?: string; title?: string }[],
    useFmp4 = true,
    encoderPreset: string = 'faster',
    qsvOptions: { lookahead: boolean; lowPower: boolean; adaptive: boolean } = {
      lookahead: false,
      lowPower: false,
      adaptive: true,
    },
    sourceFps?: number,
    trustedStreamInfo = false,
  ): string[] {
    // GOP = segment_duration × fps so each segment starts exactly on an IDR.
    // Fallback to 24 fps when source fps is unknown (safe for most content).
    const fps = sourceFps && sourceFps > 0 ? sourceFps : 24;
    const gopSize = Math.max(1, Math.round(SEGMENT_DURATION * fps));
    // Keyframes at: 0, INIT_TIME, INIT_TIME+SEG, INIT_TIME+2*SEG, ...
    // Lets -hls_init_time actually cut segment 0 short (needs a keyframe at
    // INIT_TIME). When INIT_TIME >= SEGMENT_DURATION, collapses to regular
    // fixed-GOP behaviour.
    const forceKeyframesExpr = `expr:if(eq(n_forced,0),gte(t,0),gte(t,${INIT_TIME}+(n_forced-1)*${SEGMENT_DURATION}))`;
    // Build reusable QSV extra options flag list.
    const qsvExtra: string[] = [];
    if (qsvOptions.lookahead) {
      qsvExtra.push('-look_ahead', '1', '-look_ahead_depth', '40');
    }
    if (qsvOptions.lowPower) {
      qsvExtra.push('-low_power', '1');
    }
    if (qsvOptions.adaptive) {
      qsvExtra.push('-adaptive_i', '1', '-adaptive_b', '1');
    }
    const args = ['-hide_banner', '-loglevel', 'warning'];

    // Reduce FFmpeg's avformat_find_stream_info scan. When we already have a
    // trusted streamInfo in the DB (populated by ffprobe at import/rescan),
    // collapse the probe to effectively nothing — FFmpeg just reads container
    // headers and stops. Otherwise fall back to a balanced 1s/1MB budget.
    // Default FFmpeg is 5s/5MB which burns 3-5s on cold start of large 4K MKVs.
    if (trustedStreamInfo) {
      this.log.log('Probe: using cached streamInfo (0s / 200KB scan)');
      args.push('-analyzeduration', '0', '-probesize', '200000');
    } else {
      this.log.log(
        'Probe: no cached streamInfo — running full FFmpeg scan (1s / 1MB)',
      );
      args.push('-analyzeduration', '1000000', '-probesize', '1000000');
    }

    // Seek to start position if needed
    if (startSegment > 0) {
      const seekSeconds = startSegment * SEGMENT_DURATION;
      args.push('-ss', String(seekSeconds));
      // -copyts preserves original timestamps so HLS segment timestamps match
      // the source file timeline (required for subtitle sync)
      args.push('-copyts', '-avoid_negative_ts', 'make_zero');
    }

    // parseBitrateToBps handles both "8M" and "200k" correctly. Using parseInt()*1e6
    // would give 200 Mbps for "200k" (it drops the suffix and multiplies as if M).
    const bitrateNum = parseBitrateToBps(profile.videoBitrate);

    // Force pipeline adjustments when HW accel can't handle required filters:
    // - Subtitle burn-in is always CPU-only
    // - QSV can't crop (fixed-size pool constraint), fallback to VAAPI encode which supports hwdownload/hwupload
    const effectiveHwAccel = burnIn?.filter
      ? ('none' as HwAccelType)
      : hwAccel === 'qsv' && crop
        ? ('vaapi' as HwAccelType)
        : hwAccel;

    // Hardware acceleration input decoding
    if (effectiveHwAccel === 'qsv') {
      // Jellyfin approach on Linux: decode with VAAPI (native), scale with VAAPI,
      // then map to QSV surfaces for encoding. More compatible than pure QSV pipeline.
      args.push(
        '-init_hw_device',
        'vaapi=va:/dev/dri/renderD128',
        '-init_hw_device',
        'qsv=qs@va',
      );
      if (tonemap) {
        args.push(
          '-init_hw_device',
          'opencl=ocl:0.0',
          '-filter_hw_device',
          'ocl',
        );
      }
      args.push(
        '-hwaccel',
        'vaapi',
        '-hwaccel_output_format',
        'vaapi',
        '-hwaccel_device',
        'va',
        '-noautorotate',
      );
    } else if (effectiveHwAccel === 'vaapi') {
      args.push('-init_hw_device', 'vaapi=va:/dev/dri/renderD128');
      if (tonemap) {
        args.push(
          '-init_hw_device',
          'opencl=ocl:0.0',
          '-filter_hw_device',
          'ocl',
        );
      }
      args.push(
        '-hwaccel',
        'vaapi',
        '-hwaccel_output_format',
        'vaapi',
        '-hwaccel_device',
        'va',
        '-noautorotate',
      );
    } else if (effectiveHwAccel === 'nvenc') {
      if (tonemap) {
        // For tone mapping, don't force cuda output format — allows hwdownload to CPU
        args.push('-hwaccel', 'cuda', '-noautorotate');
      } else {
        args.push(
          '-hwaccel',
          'cuda',
          '-hwaccel_output_format',
          'cuda',
          '-noautorotate',
        );
      }
    }

    args.push('-i', inputPath);

    // Video encoding
    const w = profile.maxWidth;
    const cropStr = crop
      ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`
      : '';
    const cpuCropPrefix = cropStr ? `${cropStr},` : '';
    const burnInFilter = burnIn?.filter ? `,${burnIn.filter}` : '';
    const tonemapOpencl =
      tonemap && !burnIn?.filter
        ? ',hwmap=derive_device=opencl:mode=read,tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=reinhard:desat=0'
        : '';
    const tonemapCpu = tonemap
      ? `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=mobius:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,`
      : '';

    // For HW paths with crop: hwdownload to CPU, crop, then hwupload back.
    // If it fails, the fallback mechanism retries with CPU.
    // For VAAPI/NVENC with crop: hwdownload to CPU, crop, hwupload back to VAAPI surfaces.
    // QSV hwmap requires fixed-size pools, so crop changes dimensions and breaks it → force CPU.
    const hwCropPrefix = cropStr
      ? `hwdownload,format=nv12,${cropStr},hwupload=derive_device=vaapi,`
      : '';

    switch (effectiveHwAccel) {
      case 'qsv':
        // Note: QSV + crop is forced to CPU via effectiveHwAccel (fixed-size pool constraint)
        if (tonemapOpencl) {
          // VAAPI decode → VAAPI scale → OpenCL tonemap → map to QSV → QSV encode
          args.push(
            '-c:v',
            'h264_qsv',
            '-preset',
            encoderPreset,
            ...qsvExtra,
            '-mbbrc',
            '1',
            '-b:v',
            String(bitrateNum),
            '-maxrate',
            String(bitrateNum + 1),
            '-rc_init_occupancy',
            String(bitrateNum * 2),
            '-bufsize',
            String(bitrateNum * 4),
            '-vf',
            `scale_vaapi=w=${w}:h=-16:extra_hw_frames=24${tonemapOpencl},hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv`,
            '-g',
            String(gopSize),
            '-keyint_min',
            String(gopSize),
            // Let -hls_init_time cut segment 0 short on HW encoders too.
            '-force_key_frames',
            forceKeyframesExpr,
          );
        } else {
          args.push(
            '-c:v',
            'h264_qsv',
            '-preset',
            encoderPreset,
            ...qsvExtra,
            '-mbbrc',
            '1',
            '-b:v',
            String(bitrateNum),
            '-maxrate',
            String(bitrateNum + 1),
            '-rc_init_occupancy',
            String(bitrateNum * 2),
            '-bufsize',
            String(bitrateNum * 4),
            '-vf',
            `scale_vaapi=w=${w}:h=-16:format=nv12:extra_hw_frames=24,hwmap=derive_device=qsv,format=qsv`,
            '-g',
            String(gopSize),
            '-keyint_min',
            String(gopSize),
            // Let -hls_init_time cut segment 0 short on HW encoders too.
            '-force_key_frames',
            forceKeyframesExpr,
          );
        }
        break;
      case 'vaapi':
        if (tonemapOpencl) {
          args.push(
            '-c:v',
            'h264_vaapi',
            '-b:v',
            profile.videoBitrate,
            '-maxrate',
            profile.videoBitrate,
            '-vf',
            `${hwCropPrefix}scale_vaapi=w=${w}:h=-16:extra_hw_frames=24${tonemapOpencl},hwmap=derive_device=vaapi:mode=write:reverse=1,format=vaapi`,
            '-g',
            String(gopSize),
            '-keyint_min',
            String(gopSize),
            // Let -hls_init_time cut segment 0 short on HW encoders too.
            '-force_key_frames',
            forceKeyframesExpr,
          );
        } else {
          args.push(
            '-c:v',
            'h264_vaapi',
            '-b:v',
            profile.videoBitrate,
            '-maxrate',
            profile.videoBitrate,
            '-vf',
            `${hwCropPrefix}scale_vaapi=w=${w}:h=-16:format=nv12`,
            '-g',
            String(gopSize),
            '-keyint_min',
            String(gopSize),
            // Let -hls_init_time cut segment 0 short on HW encoders too.
            '-force_key_frames',
            forceKeyframesExpr,
          );
        }
        break;
      case 'nvenc':
        if (tonemap) {
          // No native GPU tone mapping — download from GPU, tonemap on CPU, encode with NVENC
          args.push(
            '-c:v',
            'h264_nvenc',
            '-preset',
            'p4',
            '-b:v',
            profile.videoBitrate,
            '-maxrate',
            profile.videoBitrate,
            '-vf',
            `hwdownload,format=p010le,${cpuCropPrefix}${tonemapCpu}scale=${w}:-2`,
            '-g',
            String(gopSize),
            '-keyint_min',
            String(gopSize),
            // Let -hls_init_time cut segment 0 short on HW encoders too.
            '-force_key_frames',
            forceKeyframesExpr,
          );
        } else {
          // Use scale_cuda to stay on GPU; force nv12 to avoid green bar with 10-bit HDR sources
          const nvCropFilter = cropStr
            ? `hwdownload,format=nv12,${cropStr},hwupload_cuda,`
            : '';
          args.push(
            '-c:v',
            'h264_nvenc',
            '-preset',
            'p4',
            '-b:v',
            profile.videoBitrate,
            '-maxrate',
            profile.videoBitrate,
            '-vf',
            `${nvCropFilter}scale_cuda=w=${w}:h=-2:format=nv12`,
            '-g',
            String(gopSize),
            '-keyint_min',
            String(gopSize),
            // Let -hls_init_time cut segment 0 short on HW encoders too.
            '-force_key_frames',
            forceKeyframesExpr,
          );
        }
        break;
      default:
        args.push(
          '-c:v',
          'libx264',
          // Cap frame-threading so segment 0 emits before a long (threads-1)-frame prebuffer.
          '-threads:v',
          '4',
          '-preset',
          encoderPreset,
          '-b:v',
          profile.videoBitrate,
          '-maxrate',
          profile.videoBitrate,
          '-bufsize',
          `${parseInt(profile.videoBitrate) * 2}M`,
          '-vf',
          `${cpuCropPrefix}${tonemapCpu}scale=${w}:-2:flags=lanczos,format=yuv420p${burnInFilter}`,
          // Force keyframes at segment boundaries + disable scene-change keyframes
          '-force_key_frames',
          forceKeyframesExpr,
          '-sc_threshold:v:0',
          '0',
        );
        break;
    }

    // ── Audio mapping + HLS output ──
    // Always use var_stream_map for fMP4 multi-audio, even when the user has
    // picked a specific track — otherwise switching audio would require a
    // full backend reload. With all audio renditions exposed, Shaka switches
    // client-side via EXT-X-MEDIA. The picked track is signalled via
    // DEFAULT=YES in the master.m3u8 (see streaming.controller.ts).
    const userPickedAudio = audioStreamIndex != null && audioStreamIndex > 0;
    const useVarStreamMap =
      useFmp4 && videoOnly && audioStreams && audioStreams.length > 1;

    if (useVarStreamMap) {
      // Single FFmpeg process for video + all audio renditions (perfect sync).
      // Uses -var_stream_map to output separate streams in subdirectories.
      if (!args.some((a) => a === '-map')) {
        args.push('-map', '0:v:0');
      }
      for (let i = 0; i < audioStreams.length; i++) {
        args.push('-map', `0:a:${i}`);
      }
      args.push('-c:a', 'aac', '-b:a', profile.audioBitrate, '-ac', '2');

      // Build var_stream_map: "v:0,agroup:audio a:0,agroup:audio,language:fre ..."
      const varParts = ['v:0,agroup:audio'];
      for (let i = 0; i < audioStreams.length; i++) {
        const lang = audioStreams[i].language || 'und';
        varParts.push(`a:${i},agroup:audio,language:${lang}`);
      }

      args.push(
        '-f',
        'hls',
        '-hls_time',
        String(SEGMENT_DURATION),
        '-hls_init_time',
        String(INIT_TIME),
        '-hls_list_size',
        '0',
        '-start_number',
        String(startSegment),
        '-hls_segment_type',
        'fmp4',
        '-hls_fmp4_init_filename',
        'init_%v.mp4',
        '-hls_flags',
        'independent_segments',
        '-var_stream_map',
        varParts.join(' '),
        '-hls_segment_filename',
        path.join(outputDir, '%v', 'seg-%04d.m4s'),
        path.join(outputDir, '%v', 'index.m3u8'),
      );
    } else {
      // Standard single-stream output.
      // `userPickedAudio` (audioStreamIndex set) wins over `mapAllAudio`:
      // when the user explicitly chose a track from the UI, honour it with a
      // single -map so the next reload actually plays that audio. Otherwise
      // mapAllAudio mux every PID for native client-side switching.
      if (userPickedAudio) {
        args.push('-map', '0:v:0', '-map', `0:a:${audioStreamIndex}`);
      } else if (mapAllAudio && audioStreams && audioStreams.length > 1) {
        // TS + multi-audio: mux ALL audio tracks so native players (ExoPlayer/AVPlayer) can switch
        args.push('-map', '0:v:0');
        for (let i = 0; i < audioStreams.length; i++) {
          args.push('-map', `0:a:${i}`);
          // Preserve language metadata so ExoPlayer/AVPlayer show correct track names
          const lang = audioStreams[i].language;
          if (lang) {
            args.push(`-metadata:s:a:${i}`, `language=${lang}`);
          }
        }
      }
      args.push('-c:a', 'aac', '-b:a', profile.audioBitrate, '-ac', '2');

      args.push(
        '-f',
        'hls',
        '-hls_time',
        String(SEGMENT_DURATION),
        '-hls_init_time',
        String(INIT_TIME),
        '-hls_list_size',
        '0',
        '-start_number',
        String(startSegment),
      );
      if (useFmp4) {
        args.push(
          '-hls_segment_type',
          'fmp4',
          '-hls_fmp4_init_filename',
          'init.mp4',
          '-hls_segment_filename',
          path.join(outputDir, 'seg-%04d.m4s'),
        );
      } else {
        args.push('-hls_segment_filename', path.join(outputDir, 'seg-%04d.ts'));
      }
      args.push(
        '-hls_flags',
        'independent_segments',
        path.join(outputDir, 'index.m3u8'),
      );
    }

    return args;
  }

  /**
   * Build FFmpeg args for audio-only HLS output (used for multi-audio EXT-X-MEDIA renditions).
   * Lightweight: no video encoding, no HW accel needed.
   */
  private buildAudioOnlyFfmpegArgs(
    inputPath: string,
    outputDir: string,
    audioStreamIndex: number,
    audioBitrate = '192k',
    startSegment = 0,
    trustedStreamInfo = false,
  ): string[] {
    const args = ['-hide_banner', '-loglevel', 'warning'];
    if (trustedStreamInfo) {
      this.log.log(
        'Probe [audio-only]: using cached streamInfo (0s / 200KB scan)',
      );
      args.push('-analyzeduration', '0', '-probesize', '200000');
    } else {
      this.log.log(
        'Probe [audio-only]: no cached streamInfo — running full FFmpeg scan (1s / 1MB)',
      );
      args.push('-analyzeduration', '1000000', '-probesize', '1000000');
    }

    if (startSegment > 0) {
      args.push('-ss', String(startSegment * SEGMENT_DURATION));
      args.push('-copyts', '-avoid_negative_ts', 'make_zero');
    }

    args.push('-i', inputPath);
    args.push('-map', `0:a:${audioStreamIndex}`);
    args.push('-vn');
    args.push('-c:a', 'aac', '-b:a', audioBitrate, '-ac', '2');

    // Use fMP4 segments for audio — browsers can't transmux audio-only MPEG-TS
    args.push(
      '-f',
      'hls',
      '-hls_time',
      String(SEGMENT_DURATION),
      // Short first segment cuts post-seek time-to-first-byte: ffmpeg writes
      // the initial segment after INIT_TIME of input instead of waiting for
      // a full SEGMENT_DURATION.
      '-hls_init_time',
      String(INIT_TIME),
      '-hls_list_size',
      '0',
      '-start_number',
      String(startSegment),
      '-hls_segment_type',
      'fmp4',
      '-hls_fmp4_init_filename',
      'init.mp4',
      '-hls_segment_filename',
      path.join(outputDir, 'seg-%04d.m4s'),
      '-hls_flags',
      'independent_segments',
      path.join(outputDir, 'index.m3u8'),
    );

    return args;
  }

  /**
   * Build FFmpeg args for remux mode: copy video stream, optionally transcode audio.
   * This is much cheaper than full transcoding — no video re-encoding.
   */
  buildRemuxArgs(
    inputPath: string,
    outputDir: string,
    copyAudio: boolean,
    audioBitrate = '192k',
    startSegment = 0,
    videoOnly = false,
    mapAllAudio = false,
    audioStreams?: { language?: string; title?: string }[],
    useFmp4 = true,
    trustedStreamInfo = false,
    audioStreamIndex?: number,
  ): string[] {
    const args = ['-hide_banner', '-loglevel', 'warning'];
    // See buildFfmpegArgs for rationale — trust cached streamInfo when we have
    // it, otherwise use a balanced 1s/1MB probe.
    if (trustedStreamInfo) {
      this.log.log('Probe [remux]: using cached streamInfo (0s / 200KB scan)');
      args.push('-analyzeduration', '0', '-probesize', '200000');
    } else {
      this.log.log(
        'Probe [remux]: no cached streamInfo — running full FFmpeg scan (1s / 1MB)',
      );
      args.push('-analyzeduration', '1000000', '-probesize', '1000000');
    }

    if (startSegment > 0) {
      args.push('-ss', String(startSegment * SEGMENT_DURATION));
      args.push('-copyts', '-avoid_negative_ts', 'make_zero');
    }

    args.push('-i', inputPath);

    const userPickedAudio = audioStreamIndex != null && audioStreamIndex > 0;
    if (videoOnly && !userPickedAudio) {
      // Video-only remux for fMP4 var_stream_map (audio served separately).
      args.push('-map', '0:v:0', '-c:v', 'copy', '-an');
    } else if (userPickedAudio) {
      // User picked a specific audio track from the UI — single-map wins
      // over both videoOnly (var_stream_map) and mapAllAudio so the chosen
      // track actually plays after a reload.
      args.push(
        '-map',
        '0:v:0',
        '-map',
        `0:a:${audioStreamIndex}`,
        '-c:v',
        'copy',
      );
      if (copyAudio) {
        args.push('-c:a', 'copy');
      } else {
        args.push('-c:a', 'aac', '-b:a', audioBitrate, '-ac', '2');
      }
    } else if (mapAllAudio && audioStreams && audioStreams.length > 1) {
      // TS + multi-audio: copy video, map all audio tracks as distinct PIDs
      // so ExoPlayer/AVPlayer can switch between them natively.
      args.push('-map', '0:v:0', '-c:v', 'copy');
      for (let i = 0; i < audioStreams.length; i++) {
        args.push('-map', `0:a:${i}`);
        const lang = audioStreams[i].language;
        if (lang) args.push(`-metadata:s:a:${i}`, `language=${lang}`);
      }
      if (copyAudio) {
        args.push('-c:a', 'copy');
      } else {
        args.push('-c:a', 'aac', '-b:a', audioBitrate, '-ac', '2');
      }
    } else {
      args.push('-c:v', 'copy');
      if (copyAudio) {
        args.push('-c:a', 'copy');
      } else {
        args.push('-c:a', 'aac', '-b:a', audioBitrate, '-ac', '2');
      }
    }

    // HLS output — fMP4 or TS based on useFmp4
    args.push(
      '-f',
      'hls',
      '-hls_time',
      String(SEGMENT_DURATION),
      // Match the transcode paths so post-seek remux writes a short first
      // segment (~INIT_TIME) instead of waiting for a full SEGMENT_DURATION.
      '-hls_init_time',
      String(INIT_TIME),
      '-hls_list_size',
      '0',
      '-start_number',
      String(startSegment),
    );
    if (useFmp4) {
      args.push(
        '-hls_segment_type',
        'fmp4',
        '-hls_fmp4_init_filename',
        'init.mp4',
        '-hls_segment_filename',
        path.join(outputDir, 'seg-%04d.m4s'),
      );
    } else {
      args.push('-hls_segment_filename', path.join(outputDir, 'seg-%04d.ts'));
    }
    args.push(
      '-hls_flags',
      'independent_segments',
      path.join(outputDir, 'index.m3u8'),
    );

    return args;
  }

  /**
   * Start a remux session (copy video, optionally transcode audio).
   * Shares the same per-user-per-file slot as transcode sessions.
   */
  async getOrCreateRemuxSession(
    mediaFileId: number,
    absolutePath: string,
    copyAudio: boolean,
    requestedSegment = 0,
    ctx?: SessionContext,
  ): Promise<TranscodeSession> {
    const key = sessionKey(mediaFileId, ctx?.userId);
    return this.withLock(key, () =>
      this.doGetOrCreateRemuxSession(
        key,
        mediaFileId,
        absolutePath,
        copyAudio,
        requestedSegment,
        ctx,
      ),
    );
  }

  private async doGetOrCreateRemuxSession(
    key: string,
    mediaFileId: number,
    absolutePath: string,
    copyAudio: boolean,
    requestedSegment: number,
    ctx?: SessionContext,
  ): Promise<TranscodeSession> {
    const existing = this.sessions.get(key);
    if (existing) {
      const qualityMatch = !!existing.remux;
      if (!qualityMatch && existing.process.exitCode === null) {
        // Switching from transcode to remux — kill old session.
        this.log.log(
          `Switch to remux [${key}]: killing old ${existing.quality} session`,
        );
        this.sessions.delete(key);
        await this.killAndClean(existing.process, existing.cachePath);
      } else {
        const resolved = await this.resolveExistingSession(
          key, existing, requestedSegment, qualityMatch,
        );
        if (resolved) return resolved;
        // resolved === null → session deleted, restart at gap or requested segment.
        requestedSegment = existing.startSegment ?? requestedSegment;
      }
    }

    if (this.sessions.size >= MAX_SESSIONS) {
      this.evictOldestSession();
    }

    const sessionDir = path.join(this.cachePath, key, 'remux');
    await fsp.mkdir(sessionDir, { recursive: true });

    const isVideoOnly = ctx?.videoOnly ?? false;
    const args = this.buildRemuxArgs(
      absolutePath,
      sessionDir,
      copyAudio,
      '192k',
      requestedSegment,
      isVideoOnly,
      ctx?.mapAllAudio ?? false,
      ctx?.audioStreams,
      ctx?.useFmp4 ?? true,
      ctx?.trustedStreamInfo,
      ctx?.audioStreamIndex,
    );

    const session = this.spawnFfmpegSession({
      id: key,
      mediaFileId,
      quality: 'remux',
      args,
      sessionDir,
      startSegment: requestedSegment,
      extra: { remux: true },
    });

    this.applyContext(session, ctx);
    return session;
  }

  // ---------------------------------------------------------------------------
  // Audio-only sessions (multi-audio HLS)
  // ---------------------------------------------------------------------------

  /**
   * Start or retrieve an audio-only HLS session for a specific audio track.
   * Audio sessions are keyed separately from video sessions.
   */
  async getOrCreateAudioSession(
    mediaFileId: number,
    audioIndex: number,
    absolutePath: string,
    requestedSegment = 0,
    ctx?: SessionContext,
  ): Promise<TranscodeSession> {
    const key = audioSessionKey(mediaFileId, audioIndex, ctx?.userId);
    return this.withLock(key, () =>
      this.doGetOrCreateAudioSession(
        key,
        mediaFileId,
        audioIndex,
        absolutePath,
        requestedSegment,
        ctx,
      ),
    );
  }

  private async doGetOrCreateAudioSession(
    key: string,
    mediaFileId: number,
    audioIndex: number,
    absolutePath: string,
    requestedSegment: number,
    ctx?: SessionContext,
  ): Promise<TranscodeSession> {
    const existing = this.sessions.get(key);
    if (existing) {
      if (existing.process.exitCode !== null) {
        this.sessions.delete(key);
        await fsp.rm(existing.cachePath, { recursive: true, force: true });
      } else {
        existing.lastAccess = Date.now();

        if (!(await segmentNearby(existing.cachePath, requestedSegment))) {
          this.log.log(
            `Seek: restarting audio session [${key}] from segment ${requestedSegment} (not cached)`,
          );
          this.sessions.delete(key);
          await this.killProcess(existing.process);
        } else {
          const gap = firstMissingSegment(existing.cachePath, requestedSegment);
          if (gap != null && gap < (existing.startSegment ?? 0)) {
            this.log.log(
              `Seek: segment ${requestedSegment} cached, restarting audio [${key}] at unreachable gap ${gap}`,
            );
            this.sessions.delete(key);
            await this.killProcess(existing.process);
            requestedSegment = gap;
          } else {
            return existing;
          }
        }
      }
    }

    const sessionDir = path.join(this.cachePath, key, 'audio');
    await fsp.mkdir(sessionDir, { recursive: true });

    const args = this.buildAudioOnlyFfmpegArgs(
      absolutePath,
      sessionDir,
      audioIndex,
      '192k',
      requestedSegment,
      ctx?.trustedStreamInfo,
    );

    const session = this.spawnFfmpegSession({
      id: key,
      mediaFileId,
      quality: `audio-${audioIndex}`,
      args,
      sessionDir,
      startSegment: requestedSegment,
      extra: { isAudioOnly: true },
    });

    this.applyContext(session, ctx);
    return session;
  }

  private async detectHwAccel(): Promise<HwAccelType> {
    // Priority: QSV (Intel optimized) > VAAPI (generic Linux) > NVENC (NVIDIA) > none
    // QSV is derived from VAAPI on Linux (like Jellyfin) for better compatibility
    const tests: { type: HwAccelType; args: string[] }[] = [
      {
        type: 'qsv',
        args: [
          '-hide_banner',
          '-loglevel',
          'error',
          '-init_hw_device',
          'vaapi=va:/dev/dri/renderD128',
          '-init_hw_device',
          'qsv=qs@va',
          '-filter_hw_device',
          'qs',
          '-f',
          'lavfi',
          '-i',
          'color=black:s=64x64:d=0.1',
          '-vf',
          'hwupload=extra_hw_frames=64,format=qsv',
          '-c:v',
          'h264_qsv',
          '-frames:v',
          '1',
          '-f',
          'null',
          '-',
        ],
      },
      {
        type: 'vaapi',
        args: [
          '-hide_banner',
          '-loglevel',
          'error',
          '-init_hw_device',
          'vaapi=va:/dev/dri/renderD128',
          '-f',
          'lavfi',
          '-i',
          'color=black:s=64x64:d=0.1',
          '-filter_hw_device',
          'va',
          '-vf',
          'format=nv12,hwupload',
          '-c:v',
          'h264_vaapi',
          '-frames:v',
          '1',
          '-f',
          'null',
          '-',
        ],
      },
      {
        type: 'nvenc',
        args: [
          '-hide_banner',
          '-loglevel',
          'error',
          '-hwaccel',
          'cuda',
          '-f',
          'lavfi',
          '-i',
          'color=black:s=64x64:d=0.1',
          '-c:v',
          'h264_nvenc',
          '-frames:v',
          '1',
          '-f',
          'null',
          '-',
        ],
      },
    ];

    for (const test of tests) {
      try {
        await execFileAsync('ffmpeg', test.args, { timeout: 10_000 });
        this.log.log(`HW accel test passed: ${test.type}`);
        return test.type;
      } catch {
        this.log.log(`HW accel test failed: ${test.type}`);
      }
    }

    return 'none';
  }

  private cleanupStaleSessions() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      // Don't kill sessions whose FFmpeg is still running — they're actively
      // transcoding (e.g. for a download). Only clean up sessions that have
      // been idle AND whose process has already exited.
      const processDone = session.process.exitCode !== null;
      if (now - session.lastAccess > SESSION_TIMEOUT_MS && processDone) {
        this.log.log(`Cleanup stale session: ${id}`);
        this.sessions.delete(id);
        this.gracefulKill(session);
      }
    }
  }

  private evictOldestSession() {
    let oldest: TranscodeSession | null = null;
    for (const session of this.sessions.values()) {
      if (session.isAudioOnly) continue; // audio sessions don't count
      if (!oldest || session.lastAccess < oldest.lastAccess) {
        oldest = session;
      }
    }
    if (oldest) {
      this.log.log(`Evicting session: ${oldest.id}`);
      this.sessions.delete(oldest.id);
      this.gracefulKill(oldest);
    }
  }

  /** Send SIGTERM, wait for exit, then remove cache directory. Fire-and-forget version. */
  private gracefulKill(session: TranscodeSession) {
    this.killAndClean(session.process, session.cachePath).catch(() => {});
  }

  /**
   * Kill an ffmpeg process and wait for it to exit. Does NOT delete cache.
   * Uses SIGKILL by default (instant) for seek restarts — ffmpeg's graceful
   * SIGTERM shutdown (write trailer, close files) is wasted work when we're
   * about to overwrite the output. SIGTERM is only used when the caller
   * explicitly needs a clean shutdown (e.g. stopSessions on player close).
   */
  private killProcess(proc: ChildProcess, graceful = false): Promise<void> {
    if (proc.exitCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      proc.once('close', () => resolve());
      if (graceful) {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill('SIGKILL');
        }, 5000);
      } else {
        proc.kill('SIGKILL');
      }
    });
  }

  /** Graceful SIGTERM, wait for the process to exit, then rm the directory. */
  private async killAndClean(
    proc: ChildProcess,
    dirPath: string,
  ): Promise<void> {
    await this.killProcess(proc, true);
    await fsp.rm(dirPath, { recursive: true, force: true });
  }

  private applyContext(session: TranscodeSession, ctx?: SessionContext) {
    if (!ctx) return;
    session.userId = ctx.userId;
    session.username = ctx.username;
    session.mediaTitle = ctx.mediaTitle;
    session.mediaType = ctx.mediaType;
    session.posterUrl = ctx.posterUrl;
    session.transcodeReasons = ctx.transcodeReasons;
    if (!session.startedAt) session.startedAt = new Date();
  }

  /** Simple keyed lock: serialises access per session key (like Jellyfin's AsyncKeyedLocker). */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Wait for any existing operation on this key
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }
    let release!: () => void;
    const lock = new Promise<void>((r) => {
      release = r;
    });
    this.locks.set(key, lock);
    try {
      return await fn();
    } finally {
      this.locks.delete(key);
      release();
    }
  }

  private createDeferred(): { resolve: () => void; promise: Promise<void> } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { resolve, promise };
  }
}
