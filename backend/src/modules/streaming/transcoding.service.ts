import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ChildProcess, spawn, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
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

export interface TranscodeSession {
  id: string;
  mediaFileId: number;
  quality: string;
  process: ChildProcess;
  cachePath: string;
  lastAccess: number;
  ready: Promise<void>;
}

export type HwAccelType = 'vaapi' | 'nvenc' | 'qsv' | 'none';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROFILES: TranscodeProfile[] = [
  { name: '1080p', maxWidth: 1920, maxHeight: 1080, videoBitrate: '8M', audioBitrate: '192k' },
  { name: '720p', maxWidth: 1280, maxHeight: 720, videoBitrate: '4M', audioBitrate: '128k' },
  { name: '480p', maxWidth: 854, maxHeight: 480, videoBitrate: '2M', audioBitrate: '96k' },
];

const SEGMENT_DURATION = 6;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const MAX_SESSIONS = 3;

@Injectable()
export class TranscodingService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(TranscodingService.name);
  private readonly sessions = new Map<string, TranscodeSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private detectedHwAccel: HwAccelType = 'none';
  private cachePath = '/tmp/suitarr-stream';

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

  /**
   * Get available quality profiles for a given source resolution.
   */
  getAvailableProfiles(sourceWidth: number, sourceHeight: number): TranscodeProfile[] {
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
  ): string {
    const profiles = this.getAvailableProfiles(sourceWidth, sourceHeight);
    if (!profiles.length) profiles.push(PROFILES[PROFILES.length - 1]); // at least 480p

    const lines = ['#EXTM3U'];
    for (const p of profiles) {
      const bw = parseInt(p.videoBitrate) * 1_000_000;
      const w = Math.min(p.maxWidth, sourceWidth);
      const h = Math.min(p.maxHeight, sourceHeight);
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${w}x${h},NAME="${p.name}"`,
        `/api/stream/${mediaFileId}/${p.name}/index.m3u8${tokenParam}`,
      );
    }
    return lines.join('\n');
  }

  /**
   * Start or retrieve a transcode session. Returns the session cache path.
   */
  async getOrCreateSession(
    mediaFileId: number,
    quality: string,
    absolutePath: string,
    requestedSegment = 0,
  ): Promise<TranscodeSession> {
    const sessionId = `${mediaFileId}-${quality}`;
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastAccess = Date.now();

      // If the requested segment is far ahead, restart FFmpeg with seek
      if (requestedSegment > 0) {
        const segFile = path.join(existing.cachePath, `seg-${String(requestedSegment).padStart(3, '0')}.ts`);
        const nearbyExists = fs.existsSync(segFile) ||
          fs.existsSync(path.join(existing.cachePath, `seg-${String(Math.max(0, requestedSegment - 1)).padStart(3, '0')}.ts`));
        if (!nearbyExists) {
          this.log.log(`Seek: restarting transcode [${sessionId}] from segment ${requestedSegment}`);
          existing.process.kill('SIGTERM');
          this.sessions.delete(sessionId);
          await fsp.rm(existing.cachePath, { recursive: true, force: true });
          await fsp.mkdir(existing.cachePath, { recursive: true });
          return this.startSeekSession(sessionId, mediaFileId, quality, absolutePath, existing.cachePath, requestedSegment);
        }
      }

      return existing;
    }

    // Enforce max sessions
    if (this.sessions.size >= MAX_SESSIONS) {
      this.evictOldestSession();
    }

    const profile = PROFILES.find((p) => p.name === quality) ?? PROFILES[0];
    const sessionDir = path.join(this.cachePath, sessionId);
    await fsp.mkdir(sessionDir, { recursive: true });

    const session = await this.startFfmpeg(
      sessionId, mediaFileId, quality, absolutePath, profile, sessionDir, this.detectedHwAccel,
    );

    // If HW accel failed (no segments produced), retry with CPU
    if (this.detectedHwAccel !== 'none') {
      await session.ready;
      // Give FFmpeg a moment to finish crashing
      await new Promise((r) => setTimeout(r, 1000));
      const hwFirstSeg = path.join(sessionDir, 'seg-000.ts');
      if (!fs.existsSync(hwFirstSeg)) {
        this.log.warn(`Transcode [${sessionId}]: HW accel (${this.detectedHwAccel}) failed, falling back to CPU`);
        this.detectedHwAccel = 'none';
        session.process.kill('SIGTERM');
        this.sessions.delete(sessionId);
        await fsp.rm(sessionDir, { recursive: true, force: true });
        await fsp.mkdir(sessionDir, { recursive: true });
        const cpuSession = await this.startFfmpeg(
          sessionId, mediaFileId, quality, absolutePath, profile, sessionDir, 'none', 0,
        );
        this.sessions.set(sessionId, cpuSession);
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
      if (fs.existsSync(playlistPath)) {
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
  async getSegmentPath(session: TranscodeSession, segmentName: string): Promise<string | null> {
    const segPath = path.join(session.cachePath, segmentName);

    // Wait up to 30s for the segment to appear
    for (let i = 0; i < 60; i++) {
      if (fs.existsSync(segPath)) {
        // Wait a bit more to ensure writing is complete
        const size1 = fs.statSync(segPath).size;
        await new Promise((r) => setTimeout(r, 200));
        const size2 = fs.statSync(segPath).size;
        if (size1 === size2 && size1 > 0) return segPath;
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
  ): Promise<TranscodeSession> {
    const { resolve: readyResolve, promise: readyPromise } = this.createDeferred();

    const args = this.buildFfmpegArgs(absolutePath, profile, sessionDir, hwAccel, startSegment);
    this.log.log(`Transcode start [${sessionId}] (${hwAccel}): ffmpeg ${args.join(' ')}`);

    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    let resolved = false;
    const firstSeg = path.join(sessionDir, `seg-${String(startSegment).padStart(3, '0')}.ts`);

    const checkReady = () => {
      if (!resolved && fs.existsSync(firstSeg)) {
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
      if (!resolved) { resolved = true; readyResolve(); }
      if (code && code !== 0 && code !== 255) {
        this.log.error(`Transcode [${sessionId}] exited ${code}:\n${stderr.slice(-500)}`);
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
    };

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
  ): Promise<TranscodeSession> {
    const profile = PROFILES.find((p) => p.name === quality) ?? PROFILES[0];
    const session = await this.startFfmpeg(
      sessionId, mediaFileId, quality, absolutePath, profile, sessionDir,
      this.detectedHwAccel, startSegment,
    );
    this.sessions.set(sessionId, session);
    return session;
  }

  killSession(mediaFileId: number, quality: string) {
    const sessionId = `${mediaFileId}-${quality}`;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.process.kill('SIGTERM');
    this.sessions.delete(sessionId);
    fsp.rm(session.cachePath, { recursive: true, force: true }).catch(() => {});
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
  ): string[] {
    const args = ['-hide_banner', '-loglevel', 'warning'];

    // Seek to start position if needed
    if (startSegment > 0) {
      const seekSeconds = startSegment * SEGMENT_DURATION;
      args.push('-ss', String(seekSeconds));
    }

    // Hardware acceleration input decoding
    if (hwAccel === 'vaapi') {
      args.push(
        '-init_hw_device', 'vaapi=va:/dev/dri/renderD128',
        '-hwaccel', 'vaapi',
        '-hwaccel_output_format', 'vaapi',
        '-hwaccel_device', 'va',
      );
    } else if (hwAccel === 'nvenc') {
      args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
    } else if (hwAccel === 'qsv') {
      args.push(
        '-init_hw_device', 'qsv=qsv:hw',
        '-hwaccel', 'qsv',
        '-hwaccel_output_format', 'qsv',
      );
    }

    args.push('-i', inputPath);

    // Video encoding
    switch (hwAccel) {
      case 'vaapi':
        args.push(
          '-c:v', 'h264_vaapi',
          '-b:v', profile.videoBitrate,
          '-maxrate', profile.videoBitrate,
          '-vf', `scale_vaapi=w=${profile.maxWidth}:h=-2:format=nv12`,
        );
        break;
      case 'nvenc':
        args.push(
          '-c:v', 'h264_nvenc',
          '-preset', 'p4',
          '-b:v', profile.videoBitrate,
          '-maxrate', profile.videoBitrate,
          '-vf', `scale=${profile.maxWidth}:-2`,
        );
        break;
      case 'qsv':
        args.push(
          '-c:v', 'h264_qsv',
          '-preset', 'veryfast',
          '-b:v', profile.videoBitrate,
          '-maxrate', profile.videoBitrate,
          '-vf', `scale=${profile.maxWidth}:-2`,
        );
        break;
      default:
        args.push(
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-b:v', profile.videoBitrate,
          '-maxrate', profile.videoBitrate,
          '-bufsize', `${parseInt(profile.videoBitrate) * 2}M`,
          '-vf', `scale=${profile.maxWidth}:-2`,
        );
        break;
    }

    // Audio
    args.push('-c:a', 'aac', '-b:a', profile.audioBitrate, '-ac', '2');

    // HLS output
    args.push(
      '-f', 'hls',
      '-hls_time', String(SEGMENT_DURATION),
      '-hls_list_size', '0',
      '-start_number', String(startSegment),
      '-hls_segment_filename', path.join(outputDir, 'seg-%03d.ts'),
      '-hls_flags', 'independent_segments',
      path.join(outputDir, 'index.m3u8'),
    );

    return args;
  }

  private async detectHwAccel(): Promise<HwAccelType> {
    // Test each accelerator with a real 1-frame encode
    const tests: { type: HwAccelType; args: string[] }[] = [
      {
        type: 'vaapi',
        args: [
          '-hide_banner', '-loglevel', 'error',
          '-init_hw_device', 'vaapi=va:/dev/dri/renderD128',
          '-f', 'lavfi', '-i', 'color=black:s=64x64:d=0.1',
          '-filter_hw_device', 'va', '-vf', 'format=nv12,hwupload',
          '-c:v', 'h264_vaapi', '-frames:v', '1',
          '-f', 'null', '-',
        ],
      },
      {
        type: 'nvenc',
        args: [
          '-hide_banner', '-loglevel', 'error',
          '-hwaccel', 'cuda',
          '-f', 'lavfi', '-i', 'color=black:s=64x64:d=0.1',
          '-c:v', 'h264_nvenc', '-frames:v', '1',
          '-f', 'null', '-',
        ],
      },
      {
        type: 'qsv',
        args: [
          '-hide_banner', '-loglevel', 'error',
          '-init_hw_device', 'qsv=qsv:hw',
          '-f', 'lavfi', '-i', 'color=black:s=64x64:d=0.1',
          '-c:v', 'h264_qsv', '-frames:v', '1',
          '-f', 'null', '-',
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
        session.process.kill('SIGTERM');
        this.sessions.delete(id);
        fsp.rm(session.cachePath, { recursive: true, force: true }).catch(() => {});
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
      oldest.process.kill('SIGTERM');
      this.sessions.delete(oldest.id);
      fsp.rm(oldest.cachePath, { recursive: true, force: true }).catch(() => {});
    }
  }

  private createDeferred(): { resolve: () => void; promise: Promise<void> } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { resolve, promise };
  }
}
