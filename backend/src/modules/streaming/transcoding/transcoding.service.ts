import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ChildProcess, spawn } from 'child_process';
import { existsSync, watch, FSWatcher } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { TRANSCODE_DIR } from '../../../common/constants/paths';

import {
  MAX_SESSIONS,
  SEEK_WAIT_THRESHOLD,
  SESSION_TIMEOUT_MS,
  getSegmentDuration,
  setSegmentDurations as applySegmentDurations,
} from './constants';
import {
  buildAudioOnlyFfmpegArgs,
  buildFfmpegArgs,
  buildRemuxArgs,
} from './ffmpeg-args';
import { detectHwAccel } from './hw-detect';
import { generateMasterPlaylist, getAvailableProfiles } from './master-playlist';
import { getLadderForDevice } from './profiles';
import {
  fileExists,
  firstMissingSegment,
  isSegmentStable,
  segmentNearby,
} from './segment-utils';
import { audioSessionKey, earlySessionKey, sessionKey } from './session-key';
import type {
  BurnInSubtitle,
  DeviceType,
  HwAccelType,
  SessionContext,
  TranscodeProfile,
  TranscodeSession,
} from './types';

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
    await fsp.mkdir(this.cachePath, { recursive: true });

    this.detectedHwAccel = await detectHwAccel(this.log);
    this.log.log(`Hardware acceleration: ${this.detectedHwAccel}`);

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
    applySegmentDurations(segDuration, initTime);
  }

  getSegmentDuration(): number {
    return getSegmentDuration();
  }

  getActiveSessions(): TranscodeSession[] {
    return Array.from(this.sessions.values());
  }

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

    if (existing.process.exitCode !== null && existing.process.exitCode !== 0) {
      this.log.warn(
        `Session [${key}]: FFmpeg crashed (code ${existing.process.exitCode}), restarting`,
      );
      this.sessions.delete(key);
      await fsp.rm(existing.cachePath, { recursive: true, force: true });
      return null;
    }

    if (!qualityMatch) return null;

    existing.lastAccess = Date.now();

    if (!(await segmentNearby(existing.cachePath, requestedSegment))) {
      if (requestedSegment >= (existing.startSegment ?? 0)) {
        const gap = requestedSegment - (existing.startSegment ?? 0);
        if (gap <= SEEK_WAIT_THRESHOLD) {
          return existing;
        }
      }
      this.log.log(
        `Seek: restarting [${key}] from segment ${requestedSegment} (not cached)`,
      );
      this.sessions.delete(key);
      existing.intentionallyKilled = true;
      await this.killProcess(existing.process);
      existing.startSegment = requestedSegment;
      return null;
    }

    const gap = firstMissingSegment(existing.cachePath, requestedSegment);
    if (gap != null && gap < (existing.startSegment ?? 0)) {
      this.log.log(
        `Seek: segment ${requestedSegment} cached, restarting [${key}] at unreachable gap ${gap}`,
      );
      this.sessions.delete(key);
      existing.intentionallyKilled = true;
      await this.killProcess(existing.process);
      existing.startSegment = gap;
      return null;
    }

    return existing;
  }

  async getTranscodePercent(
    session: TranscodeSession,
    durationSeconds: number,
  ): Promise<number> {
    if (!durationSeconds || durationSeconds <= 0) return 0;
    try {
      const files = await fsp.readdir(session.cachePath);
      let maxSeg = -1;
      for (const f of files) {
        const m = f.match(/^seg-(\d+)\.ts$/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > maxSeg) maxSeg = n;
        }
      }
      if (maxSeg < 0) return 0;
      const transcodedUpTo = (maxSeg + 1) * getSegmentDuration();
      return Math.min(100, (transcodedUpTo / durationSeconds) * 100);
    } catch {
      return 0;
    }
  }

  /** Get available quality profiles for a given source resolution + device class. */
  getAvailableProfiles(
    sourceWidth: number,
    sourceHeight: number,
    deviceType: DeviceType = 'desktop',
  ): TranscodeProfile[] {
    return getAvailableProfiles(sourceWidth, sourceHeight, deviceType);
  }

  /** Generate the HLS master playlist listing available qualities. */
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
    return generateMasterPlaylist(
      mediaFileId,
      sourceWidth,
      sourceHeight,
      tokenParam,
      includeRemux,
      sourceBitrate,
      audioStreams,
      onlyQuality,
      defaultAudioIndex,
      deviceType,
    );
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
    skipVerify = false,
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
    if (skipVerify) return session;
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
        this.log.log(
          `Quality change [${key}]: ${existing.quality} → ${quality}, killing old session`,
        );
        this.sessions.delete(key);
        existing.intentionallyKilled = true;
        await this.killProcess(existing.process);
      } else {
        const resolved = await this.resolveExistingSession(
          key, existing, requestedSegment, qualityMatch,
        );
        if (resolved) return resolved;
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

    const videoSessionCount = Array.from(this.sessions.values()).filter(
      (s) => !s.isAudioOnly,
    ).length;
    if (videoSessionCount >= MAX_SESSIONS) {
      this.evictOldestSession();
    }

    const ladder = getLadderForDevice(ctx?.deviceType);
    const profile = ladder.find((p) => p.name === quality) ?? ladder[0];
    const sessionDir = path.join(this.cachePath, key, quality);
    const dirExisted = existsSync(sessionDir);
    await fsp.mkdir(sessionDir, { recursive: true });
    this.log.log(
      `[disk] mkdir ${sessionDir} (existed=${dirExisted}) for ${key}`,
    );

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
      ctx,
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

    return this.withLock(key, async () => {
      if (this.sessions.get(key) !== session) {
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
        ctx,
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
          existing.lastAccess = Date.now();
          return existing;
        }
        this.sessions.delete(id);
        await this.killAndClean(existing.process, existing.cachePath);
      }

      const ladder = getLadderForDevice(ctx?.deviceType);
      const profile = ladder.find((p) => p.name === quality) ?? ladder[0];
      const sessionDir = path.join(this.cachePath, id, quality);
      const dirExisted = existsSync(sessionDir);
      await fsp.mkdir(sessionDir, { recursive: true });
      this.log.log(
        `[disk] mkdir ${sessionDir} (existed=${dirExisted}) for ${id}`,
      );

      const isVideoOnly = ctx?.videoOnly ?? false;
      const ctxAudioStreams = ctx?.audioStreams;
      const useVarStreamMap =
        isVideoOnly && ctxAudioStreams && ctxAudioStreams.length > 1;
      if (useVarStreamMap) {
        for (let i = 0; i <= ctxAudioStreams.length; i++) {
          await fsp.mkdir(path.join(sessionDir, String(i)), { recursive: true });
        }
      }

      const args = buildFfmpegArgs(
        {
          inputPath: absolutePath,
          profile,
          outputDir: sessionDir,
          hwAccel: this.detectedHwAccel,
          startSegment: 0,
          tonemap: ctx?.tonemap ?? false,
          burnIn: ctx?.burnInSubtitle,
          audioStreamIndex: ctx?.audioStreamIndex,
          crop: ctx?.crop,
          videoOnly: isVideoOnly,
          mapAllAudio: ctx?.mapAllAudio ?? false,
          audioStreams: ctxAudioStreams,
          useFmp4: ctx?.useFmp4 ?? true,
          encoderPreset: ctx?.encoderPreset,
          qsvOptions: ctx?.qsvOptions,
          sourceFps: ctx?.sourceFps,
          trustedStreamInfo: ctx?.trustedStreamInfo,
        },
        this.log,
      );
      // Bound input read to 4s — enough for seg-0 + seg-1, then ffmpeg
      // exits cleanly. Insert as INPUT option (before -i).
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

  /** Get the index.m3u8 playlist for a session. */
  async getPlaylist(session: TranscodeSession): Promise<string | null> {
    await session.ready;
    const playlistPath = path.join(session.cachePath, 'index.m3u8');

    for (let i = 0; i < 120; i++) {
      if (await fileExists(playlistPath)) {
        const content = await fsp.readFile(playlistPath, 'utf-8');
        if (content.includes('.ts') || content.includes('.m4s')) return content;
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
   */
  async getSegmentPath(
    session: TranscodeSession,
    segmentName: string,
    timeoutMs = 60_000,
  ): Promise<string | null> {
    const segPath = path.join(session.cachePath, segmentName);

    if (existsSync(segPath)) {
      const stable = await isSegmentStable(segPath);
      if (stable) return segPath;
    }

    if (segmentName.includes('init')) {
      await session.ready;
      if (existsSync(segPath)) {
        const stable = await isSegmentStable(segPath);
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
        if (await isSegmentStable(segPath)) finish(segPath);
      };

      try {
        watcher = watch(dir, { persistent: false }, (_event, filename) => {
          if (filename === name) void tryServe();
        });
      } catch {
        // Directory doesn't exist yet — exitTimer covers it.
      }

      void tryServe();

      exitTimer = setInterval(() => {
        if (session.process.exitCode !== null && !existsSync(segPath)) {
          finish(null);
        } else {
          void tryServe();
        }
      }, 500);

      timeout = setTimeout(() => finish(null), timeoutMs);
    });
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
    const spawnTs = Date.now();

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
        this.log.log(`[disk] first-seg-written ${firstSeg}`);
        this.log.log(
          `[timing] ffmpeg-ready id=${id} mfid=${mediaFileId} startSeg=${startSegment} took=${Date.now() - spawnTs}ms`,
        );
        readyResolve();
      }
    };

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
      const firstSegProduced = resolved;
      if (!resolved) {
        resolved = true;
        readyResolve();
      }
      if (code && code !== 0 && code !== 255) {
        this.log.error(`FFmpeg [${id}] exited ${code}:\n${stderr.slice(-2000)}`);
      } else if (!firstSegProduced && !session.intentionallyKilled) {
        this.log.warn(
          `FFmpeg [${id}] exited code=${code} WITHOUT producing first segment ${firstSegName}\nstderr:\n${stderr.slice(-2000)}`,
        );
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
    ctx?: SessionContext,
  ): TranscodeSession {
    const isVideoOnly = ctx?.videoOnly ?? false;
    const audioStreams = ctx?.audioStreams;
    const useFmp4 = ctx?.useFmp4 ?? true;

    const args = buildFfmpegArgs(
      {
        inputPath: absolutePath,
        profile,
        outputDir: sessionDir,
        hwAccel,
        startSegment,
        tonemap: ctx?.tonemap ?? false,
        burnIn: ctx?.burnInSubtitle,
        audioStreamIndex: ctx?.audioStreamIndex,
        crop: ctx?.crop,
        videoOnly: isVideoOnly,
        mapAllAudio: ctx?.mapAllAudio ?? false,
        audioStreams,
        useFmp4,
        encoderPreset: ctx?.encoderPreset,
        qsvOptions: ctx?.qsvOptions,
        sourceFps: ctx?.sourceFps,
        trustedStreamInfo: ctx?.trustedStreamInfo,
      },
      this.log,
    );

    const usesVarStreamMap =
      isVideoOnly && audioStreams && audioStreams.length > 1;
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
      ctx,
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
      promises.push(
        this.killAndClean(session.process, session.cachePath, session.id),
      );
    }
    const earlySession = this.sessions.get(earlyKey);
    if (earlySession) {
      this.sessions.delete(earlyKey);
      promises.push(
        this.killAndClean(
          earlySession.process,
          earlySession.cachePath,
          earlySession.id,
        ),
      );
    }
    const audioPrefix = `${key}-a`;
    for (const [id, s] of this.sessions) {
      if (id.startsWith(audioPrefix)) {
        this.sessions.delete(id);
        promises.push(this.killAndClean(s.process, s.cachePath, s.id));
      }
    }
    await Promise.all(promises);
    const parentDir = path.join(this.cachePath, key);
    if (!this.sessions.has(key)) {
      const existed = existsSync(parentDir);
      this.log.log(`[disk] rm parent ${parentDir} (existed=${existed})`);
      fsp.rm(parentDir, { recursive: true, force: true }).catch(() => {});
    } else {
      this.log.log(
        `[disk] skip rm parent ${parentDir} — session ${key} replaced`,
      );
    }
    const earlyParentDir = path.join(this.cachePath, earlyKey);
    if (!this.sessions.has(earlyKey)) {
      const existed = existsSync(earlyParentDir);
      this.log.log(`[disk] rm parent ${earlyParentDir} (existed=${existed})`);
      fsp.rm(earlyParentDir, { recursive: true, force: true }).catch(() => {});
    } else {
      this.log.log(
        `[disk] skip rm parent ${earlyParentDir} — session ${earlyKey} replaced`,
      );
    }
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
        requestedSegment = existing.startSegment ?? requestedSegment;
      }
    }

    if (this.sessions.size >= MAX_SESSIONS) {
      this.evictOldestSession();
    }

    const sessionDir = path.join(this.cachePath, key, 'remux');
    await fsp.mkdir(sessionDir, { recursive: true });

    const isVideoOnly = ctx?.videoOnly ?? false;
    const args = buildRemuxArgs(
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
      this.log,
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
          existing.intentionallyKilled = true;
          await this.killProcess(existing.process);
        } else {
          const gap = firstMissingSegment(existing.cachePath, requestedSegment);
          if (gap != null && gap < (existing.startSegment ?? 0)) {
            this.log.log(
              `Seek: segment ${requestedSegment} cached, restarting audio [${key}] at unreachable gap ${gap}`,
            );
            this.sessions.delete(key);
            existing.intentionallyKilled = true;
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

    const args = buildAudioOnlyFfmpegArgs(
      absolutePath,
      sessionDir,
      audioIndex,
      '192k',
      requestedSegment,
      ctx?.trustedStreamInfo ?? false,
      this.log,
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

  private cleanupStaleSessions() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
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
      if (session.isAudioOnly) continue;
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

  /** SIGKILL the process (instant), wait for exit, then rm the directory.
   *  Uses SIGKILL rather than SIGTERM grace because the 5s grace window of
   *  the old ffmpeg overlaps with a new ffmpeg spawn on the same HW
   *  (VAAPI/QSV), causing the new session's encoder init to hang. The
   *  trailer/flush bytes the old process would have written are wasted —
   *  HLS segments are independent and the next session writes fresh.
   *
   *  Skips the rm when a replacement session is already registered with the
   *  same id — avoids wiping a freshly-spawned session's cache dir during a
   *  quick close+replay cycle (stopSessions ↔ playback-info race). */
  private async killAndClean(
    proc: ChildProcess,
    dirPath: string,
    sessionId?: string,
  ): Promise<void> {
    await this.killProcess(proc, false);
    if (sessionId && this.sessions.has(sessionId)) {
      this.log.log(
        `[disk] skip rm ${dirPath} — session ${sessionId} replaced`,
      );
      return;
    }
    const existed = existsSync(dirPath);
    this.log.log(`[disk] rm ${dirPath} (existed=${existed})`);
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
