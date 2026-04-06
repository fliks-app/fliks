import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ChildProcess, spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

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
}

/** Build the session map key: one transcode per user per file (like Jellyfin/Plex). */
function sessionKey(mediaFileId: number, userId?: number): string {
  return userId != null ? `${mediaFileId}-u${userId}` : `${mediaFileId}-anon`;
}

export type HwAccelType = 'vaapi' | 'nvenc' | 'qsv' | 'none';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROFILES: TranscodeProfile[] = [
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

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

const SEGMENT_DURATION = 6;
const SESSION_TIMEOUT_MS = 60 * 1000; // 60s (like Jellyfin HLS timeout)
const MAX_SESSIONS = 4;

@Injectable()
export class TranscodingService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(TranscodingService.name);
  private readonly sessions = new Map<string, TranscodeSession>();
  /** Per-key locks to prevent concurrent getOrCreate calls racing (like Jellyfin's AsyncKeyedLocker). */
  private readonly locks = new Map<string, Promise<void>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private detectedHwAccel: HwAccelType = 'none';
  private cachePath = '/tmp/fliks-stream';

  async onModuleInit() {
    // Ensure cache directory exists
    await fsp.mkdir(this.cachePath, { recursive: true });

    // Detect hardware acceleration
    this.detectedHwAccel = await this.detectHwAccel();
    this.log.log(`Hardware acceleration: ${this.detectedHwAccel}`);

    // Cleanup timer
    this.cleanupTimer = setInterval(() => this.cleanupStaleSessions(), 30_000);
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

  getActiveSessions(): TranscodeSession[] {
    return Array.from(this.sessions.values());
  }

  /** Estimate transcode progress as a percentage (0-100) by looking at the highest segment on disk. */
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
   * Get available quality profiles for a given source resolution.
   */
  getAvailableProfiles(
    sourceWidth: number,
    sourceHeight: number,
  ): TranscodeProfile[] {
    return PROFILES.filter(
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
  ): string {
    const lines = ['#EXTM3U'];

    // Add remux variant (original quality, no video re-encoding) as highest quality
    if (includeRemux) {
      const bw = sourceBitrate ?? 20_000_000; // fallback to 20 Mbps if unknown
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${sourceWidth}x${sourceHeight},NAME="remux"`,
        `/api/stream/${mediaFileId}/remux/index.m3u8${tokenParam}`,
      );
    }

    // Add transcode profiles
    const profiles = this.getAvailableProfiles(sourceWidth, sourceHeight);
    if (!profiles.length) profiles.push(PROFILES[PROFILES.length - 1]); // at least 480p

    for (const p of profiles) {
      const bw = parseInt(p.videoBitrate) * 1_000_000;
      const w = Math.min(p.maxWidth, sourceWidth);
      // Compute height from source aspect ratio, aligned to 16px (matches ffmpeg scale=W:-16 for HW encoders)
      const rawH = (w * sourceHeight) / sourceWidth;
      const h = Math.floor(rawH / 16) * 16 || 16;
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${w}x${h},NAME="${p.name}"`,
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
    return this.withLock(key, () =>
      this.doGetOrCreateSession(
        key,
        mediaFileId,
        quality,
        absolutePath,
        requestedSegment,
        ctx,
      ),
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
    const existing = this.sessions.get(key);
    if (existing) {
      // If FFmpeg process has exited, clean up and start fresh
      if (existing.process.exitCode !== null) {
        this.log.warn(
          `Session [${key}]: FFmpeg already exited (code ${existing.process.exitCode}), restarting`,
        );
        this.sessions.delete(key);
        await fsp.rm(existing.cachePath, { recursive: true, force: true });
        // Fall through to create a new session below
      } else if (existing.quality !== quality || existing.remux) {
        // Quality changed (or switching from remux to transcode) — kill old, start new
        this.log.log(
          `Quality change [${key}]: ${existing.quality} → ${quality}, killing old session`,
        );
        this.sessions.delete(key);
        await this.killAndClean(existing.process, existing.cachePath);
        // Fall through to create a new session below
      } else {
        existing.lastAccess = Date.now();

        // If the requested segment is far ahead, restart FFmpeg with seek
        if (requestedSegment > 0) {
          const segFile = path.join(
            existing.cachePath,
            `seg-${String(requestedSegment).padStart(4, '0')}.ts`,
          );
          const nearbyExists =
            (await fileExists(segFile)) ||
            (await fileExists(
              path.join(
                existing.cachePath,
                `seg-${String(Math.max(0, requestedSegment - 1)).padStart(4, '0')}.ts`,
              ),
            ));
          if (!nearbyExists) {
            this.log.log(
              `Seek: restarting transcode [${key}] from segment ${requestedSegment}`,
            );
            this.sessions.delete(key);
            await this.killAndClean(existing.process, existing.cachePath);
            await fsp.mkdir(existing.cachePath, { recursive: true });
            return this.startSeekSession(
              key,
              mediaFileId,
              quality,
              absolutePath,
              existing.cachePath,
              requestedSegment,
              ctx,
            );
          }
        }

        return existing;
      }
    }

    // Enforce max sessions
    if (this.sessions.size >= MAX_SESSIONS) {
      this.evictOldestSession();
    }

    const profile = PROFILES.find((p) => p.name === quality) ?? PROFILES[0];
    const sessionDir = path.join(this.cachePath, key);
    await fsp.mkdir(sessionDir, { recursive: true });

    const shouldTonemap = ctx?.tonemap ?? false;
    const burnIn = ctx?.burnInSubtitle;
    const audioIdx = ctx?.audioStreamIndex;
    const cropInfo = ctx?.crop;
    const session = await this.startFfmpeg(
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
    );
    this.applyContext(session, ctx);

    // If HW accel crashed (non-zero exit, no segments), retry with CPU.
    // Only fallback on actual crash — a still-running process is just slow (e.g. QSV with seek).
    if (this.detectedHwAccel !== 'none') {
      await session.ready;
      // Wait up to 5s for the process to potentially crash
      for (let i = 0; i < 10; i++) {
        if (session.process.exitCode !== null) break;
        const expectedSeg = path.join(
          sessionDir,
          `seg-${String(requestedSegment).padStart(4, '0')}.ts`,
        );
        if (await fileExists(expectedSeg)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const expectedSeg = path.join(
        sessionDir,
        `seg-${String(requestedSegment).padStart(4, '0')}.ts`,
      );
      const crashed =
        session.process.exitCode !== null && !(await fileExists(expectedSeg));
      if (crashed) {
        this.log.warn(
          `Transcode [${key}]: HW accel (${this.detectedHwAccel}) crashed (exit=${session.process.exitCode}), falling back to CPU\n${(session.stderr ?? '').slice(-1000)}`,
        );
        this.sessions.delete(key);
        await this.killAndClean(session.process, sessionDir);
        await fsp.mkdir(sessionDir, { recursive: true });
        const cpuSession = await this.startFfmpeg(
          key,
          mediaFileId,
          quality,
          absolutePath,
          profile,
          sessionDir,
          'none',
          requestedSegment,
          shouldTonemap,
          burnIn,
          audioIdx,
          cropInfo,
        );
        this.applyContext(cpuSession, ctx);
        this.sessions.set(key, cpuSession);
        return cpuSession;
      }
    }

    return session;
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
        if (content.includes('.ts')) return content; // Wait until at least one segment is listed
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.log.warn(`Playlist not ready for session ${session.id} after 60s`);
    return null;
  }

  /**
   * Get a segment file path, waiting if it's being generated.
   */
  async getSegmentPath(
    session: TranscodeSession,
    segmentName: string,
  ): Promise<string | null> {
    const segPath = path.join(session.cachePath, segmentName);

    // Wait up to 60s for the segment to appear (GPU can be slow when multiple transcodes run)
    for (let i = 0; i < 120; i++) {
      // If FFmpeg has exited, stop waiting immediately
      if (session.process.exitCode !== null && !(await fileExists(segPath))) {
        this.log.warn(
          `Segment ${segmentName} unavailable: FFmpeg exited with code ${session.process.exitCode}`,
        );
        return null;
      }
      if (await fileExists(segPath)) {
        try {
          // Wait a bit more to ensure writing is complete
          const size1 = (await fsp.stat(segPath)).size;
          await new Promise((r) => setTimeout(r, 200));
          const size2 = (await fsp.stat(segPath)).size;
          if (size1 === size2 && size1 > 0) return segPath;
        } catch {
          // File was removed between exists check and stat (session killed)
          return null;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  private async startFfmpeg(
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
  ): Promise<TranscodeSession> {
    const { resolve: readyResolve, promise: readyPromise } =
      this.createDeferred();

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
    );
    this.log.log(
      `Transcode start [${sessionId}] (${hwAccel}): ffmpeg ${args.join(' ')}`,
    );

    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    let resolved = false;
    const firstSeg = path.join(
      sessionDir,
      `seg-${String(startSegment).padStart(4, '0')}.ts`,
    );

    const checkReady = () => {
      if (!resolved && existsSync(firstSeg)) {
        resolved = true;
        readyResolve();
      }
    };

    proc.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      checkReady();
    });

    // Also poll for the segment file (stderr may not fire for all encoders)
    const pollTimer = setInterval(() => {
      checkReady();
      if (resolved) clearInterval(pollTimer);
    }, 500);

    proc.on('close', (code) => {
      clearInterval(pollTimer);
      if (!resolved) {
        resolved = true;
        readyResolve();
      }
      if (code && code !== 0 && code !== 255) {
        this.log.error(
          `Transcode [${sessionId}] exited ${code}:\n${stderr.slice(-500)}`,
        );
      }
    });

    proc.on('error', (err) => {
      this.log.error(`Transcode [${sessionId}] spawn error: ${err.message}`);
      readyResolve();
    });

    const session: TranscodeSession = {
      id: sessionId,
      mediaFileId,
      quality,
      process: proc,
      cachePath: sessionDir,
      lastAccess: Date.now(),
      ready: readyPromise,
      actualHwAccel: hwAccel,
    };

    // Keep stderr reference on session for debugging
    proc.stderr!.on('data', () => {
      session.stderr = stderr;
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  private async startSeekSession(
    sessionId: string,
    mediaFileId: number,
    quality: string,
    absolutePath: string,
    sessionDir: string,
    startSegment: number,
    ctx?: SessionContext,
  ): Promise<TranscodeSession> {
    const profile = PROFILES.find((p) => p.name === quality) ?? PROFILES[0];
    const session = await this.startFfmpeg(
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
    );
    this.applyContext(session, ctx);
    this.sessions.set(sessionId, session);
    return session;
  }

  killSession(mediaFileId: number, userId?: number) {
    const key = sessionKey(mediaFileId, userId);
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    this.gracefulKill(session);
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
  ): string[] {
    const args = ['-hide_banner', '-loglevel', 'warning'];

    // Seek to start position if needed
    if (startSegment > 0) {
      const seekSeconds = startSegment * SEGMENT_DURATION;
      args.push('-ss', String(seekSeconds));
    }

    const bitrateNum = parseInt(profile.videoBitrate) * 1_000_000; // e.g. "8M" -> 8000000

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
            String(SEGMENT_DURATION * 24),
            '-keyint_min',
            String(SEGMENT_DURATION * 24),
          );
        } else {
          args.push(
            '-c:v',
            'h264_qsv',
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
            String(SEGMENT_DURATION * 24),
            '-keyint_min',
            String(SEGMENT_DURATION * 24),
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
            String(SEGMENT_DURATION * 24),
            '-keyint_min',
            String(SEGMENT_DURATION * 24),
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
            String(SEGMENT_DURATION * 24),
            '-keyint_min',
            String(SEGMENT_DURATION * 24),
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
            String(SEGMENT_DURATION * 24),
            '-keyint_min',
            String(SEGMENT_DURATION * 24),
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
            String(SEGMENT_DURATION * 24),
            '-keyint_min',
            String(SEGMENT_DURATION * 24),
          );
        }
        break;
      default:
        args.push(
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
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
          `expr:gte(t,n_forced*${SEGMENT_DURATION})`,
          '-sc_threshold:v:0',
          '0',
        );
        break;
    }

    // Audio — select specific audio stream if requested
    if (audioStreamIndex != null) {
      args.push('-map', '0:v:0', '-map', `0:a:${audioStreamIndex}`);
    }
    args.push('-c:a', 'aac', '-b:a', profile.audioBitrate, '-ac', '2');

    // HLS output
    args.push(
      '-f',
      'hls',
      '-hls_time',
      String(SEGMENT_DURATION),
      '-hls_list_size',
      '0',
      '-start_number',
      String(startSegment),
      '-hls_segment_filename',
      path.join(outputDir, 'seg-%04d.ts'),
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
  ): string[] {
    const args = ['-hide_banner', '-loglevel', 'warning'];

    if (startSegment > 0) {
      args.push('-ss', String(startSegment * SEGMENT_DURATION));
    }

    args.push('-i', inputPath);

    // Copy video stream as-is (no re-encoding)
    args.push('-c:v', 'copy');

    // Audio: copy or transcode to AAC
    if (copyAudio) {
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', 'aac', '-b:a', audioBitrate, '-ac', '2');
    }

    // HLS output with fMP4 segments (better for stream copy)
    args.push(
      '-f',
      'hls',
      '-hls_time',
      String(SEGMENT_DURATION),
      '-hls_list_size',
      '0',
      '-start_number',
      String(startSegment),
      '-hls_segment_type',
      'mpegts',
      '-hls_segment_filename',
      path.join(outputDir, 'seg-%04d.ts'),
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
      // If FFmpeg process has exited, clean up and start fresh
      if (existing.process.exitCode !== null) {
        this.log.warn(
          `Session [${key}]: FFmpeg already exited (code ${existing.process.exitCode}), restarting`,
        );
        this.sessions.delete(key);
        await fsp.rm(existing.cachePath, { recursive: true, force: true });
        // Fall through to create a new session below
      } else if (!existing.remux || existing.quality !== 'remux') {
        // Switching from transcode to remux — kill old session
        this.log.log(
          `Switch to remux [${key}]: killing old ${existing.quality} session`,
        );
        this.sessions.delete(key);
        await this.killAndClean(existing.process, existing.cachePath);
        // Fall through to create a new session below
      } else {
        existing.lastAccess = Date.now();

        if (requestedSegment > 0) {
          const segFile = path.join(
            existing.cachePath,
            `seg-${String(requestedSegment).padStart(4, '0')}.ts`,
          );
          const nearbyExists =
            (await fileExists(segFile)) ||
            (await fileExists(
              path.join(
                existing.cachePath,
                `seg-${String(Math.max(0, requestedSegment - 1)).padStart(4, '0')}.ts`,
              ),
            ));
          if (!nearbyExists) {
            this.log.log(
              `Seek: restarting remux [${key}] from segment ${requestedSegment}`,
            );
            this.sessions.delete(key);
            await this.killAndClean(existing.process, existing.cachePath);
          }
        } else {
          return existing;
        }
      }
    }

    if (this.sessions.size >= MAX_SESSIONS) {
      this.evictOldestSession();
    }

    const sessionDir = path.join(this.cachePath, key);
    await fsp.mkdir(sessionDir, { recursive: true });

    const { resolve: readyResolve, promise: readyPromise } =
      this.createDeferred();
    const args = this.buildRemuxArgs(
      absolutePath,
      sessionDir,
      copyAudio,
      '192k',
      requestedSegment,
    );
    this.log.log(`Remux start [${key}]: ffmpeg ${args.join(' ')}`);

    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    let resolved = false;
    const firstSeg = path.join(
      sessionDir,
      `seg-${String(requestedSegment).padStart(4, '0')}.ts`,
    );

    const checkReady = () => {
      if (!resolved && existsSync(firstSeg)) {
        resolved = true;
        readyResolve();
      }
    };

    proc.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      checkReady();
    });

    const pollTimer = setInterval(() => {
      checkReady();
      if (resolved) clearInterval(pollTimer);
    }, 500);

    proc.on('close', (code) => {
      clearInterval(pollTimer);
      if (!resolved) {
        resolved = true;
        readyResolve();
      }
      if (code && code !== 0 && code !== 255) {
        this.log.error(`Remux [${key}] exited ${code}:\n${stderr.slice(-500)}`);
      }
    });

    proc.on('error', (err) => {
      this.log.error(`Remux [${key}] spawn error: ${err.message}`);
      readyResolve();
    });

    const session: TranscodeSession = {
      id: key,
      mediaFileId,
      quality: 'remux',
      process: proc,
      cachePath: sessionDir,
      lastAccess: Date.now(),
      ready: readyPromise,
      remux: true,
    };

    this.applyContext(session, ctx);
    this.sessions.set(key, session);
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
      if (now - session.lastAccess > SESSION_TIMEOUT_MS) {
        this.log.log(`Cleanup stale session: ${id}`);
        this.sessions.delete(id);
        this.gracefulKill(session);
      }
    }
  }

  private evictOldestSession() {
    let oldest: TranscodeSession | null = null;
    for (const session of this.sessions.values()) {
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

  /** Send SIGTERM, wait for the process to exit, then rm the directory. */
  private killAndClean(proc: ChildProcess, dirPath: string): Promise<void> {
    // Already exited — just clean up
    if (proc.exitCode !== null) {
      return fsp.rm(dirPath, { recursive: true, force: true });
    }

    return new Promise<void>((resolve) => {
      const done = () => {
        fsp
          .rm(dirPath, { recursive: true, force: true })
          .then(resolve, resolve);
      };

      proc.once('close', done);
      proc.kill('SIGTERM');

      // Safety net: force-kill if still alive after 5s
      setTimeout(() => {
        if (proc.exitCode === null) {
          proc.kill('SIGKILL');
        }
      }, 5000);
    });
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
