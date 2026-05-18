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
  SEEK_WAIT_THRESHOLD,
  SESSION_TIMEOUT_MS,
  getSegmentDuration,
  segmentIndexToSeconds,
  setSegmentDuration as applySegmentDuration,
} from './constants';
import {
  getHdrLadderForDevice,
  getLadderForDevice,
  isHdrProfile,
} from './profiles';
import {
  buildAudioOnlyFfmpegArgs,
  buildFfmpegArgs,
  buildRemuxArgs,
} from './ffmpeg-args';
import { detectHwAccel } from './hw-detect';
import { ALL_DESCRIPTORS, encoderRegistry } from './codec/encoders';
import { runEncoderProbes } from './codec/encoder-probe';
import { ALL_DECODERS } from './codec/decoders';
import { runDecoderProbes } from './codec/decoder-probe';
import {
  isVppQsvTonemapEnabled,
  runVppQsvTonemapProbe,
} from './codec/vpp-qsv-probe';
import {
  isTonemapOpenclEnabled,
  runTonemapOpenclProbe,
} from './codec/tonemap-opencl-probe';
import {
  generateMasterPlaylist,
  getAvailableProfiles,
} from './master-playlist';
import {
  fileExists,
  firstMissingSegment,
  segmentNearby,
} from './segment-utils';
import { audioSessionKey, earlySessionKey, sessionKey } from './session-key';
import type {
  BurnInSubtitle,
  DeviceType,
  HwAccelType,
  SessionContext,
  TonemapAlgo,
  TranscodeProfile,
  TranscodeSession,
} from './types';

@Injectable()
export class TranscodingService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(TranscodingService.name);
  private readonly sessions = new Map<string, TranscodeSession>();
  /** Per-key locks to prevent concurrent getOrCreate calls racing. */
  private readonly locks = new Map<string, Promise<void>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private detectedHwAccel: HwAccelType = 'none';
  private cachePath = path.join(TRANSCODE_DIR, 'stream');

  async onModuleInit() {
    await fsp.mkdir(this.cachePath, { recursive: true });

    // The in-memory `sessions` map only knows about live sessions. After a
    // backend restart the map starts empty, so any directory still under
    // `cachePath` is an orphan — written by a previous process that is no
    // longer alive to evict it. Wipe them so a re-load on the same
    // (mediaFileId, userId) starts from a clean slate instead of inheriting
    // partial / overflow segments from the previous run.
    try {
      const entries = await fsp.readdir(this.cachePath);
      if (entries.length) {
        await Promise.all(
          entries.map((e) =>
            fsp.rm(path.join(this.cachePath, e), {
              recursive: true,
              force: true,
            }),
          ),
        );
        this.log.log(
          `[disk] init wipe: removed ${entries.length} orphan session dir(s)`,
        );
      }
    } catch (err) {
      this.log.warn(`[disk] init wipe failed: ${(err as Error).message}`);
    }

    this.detectedHwAccel = await detectHwAccel(this.log);
    this.log.log(`Hardware acceleration: ${this.detectedHwAccel}`);

    // Probe every compiled-in encoder. Each runs a single black-frame
    // ffmpeg encode; the descriptors that fail to open are blacklisted
    // in the runtime registry gate. Runs async — module init doesn't
    // wait for it, but the codec selector defaults to "every encoder
    // usable" until the probe completes (the runtime fallback layer
    // catches stragglers).
    void runEncoderProbes(ALL_DESCRIPTORS, this.log);
    // Same one-frame validation pass on the decoder side: synthesise a
    // tiny bitstream per codec, hand it to each descriptor under its
    // real `-hwaccel ...` setup, drop the frame to /dev/null. Both
    // probes fire fire-and-forget — by the time a transcode session
    // actually runs, both maps are populated.
    void runDecoderProbes(ALL_DECODERS, this.log);
    // Probe whether the iGPU's fixed-function HDR tone-mapping unit
    // is wired up. Only the upstream `vpp_qsv tonemap=1` path uses
    // it; gates the single-pass HDR→SDR chain in the QSV encoder
    // filter helpers. Skipped on non-Intel hosts so AMD / NVIDIA / macOS
    // boots don't burn ~30s on two doomed ffmpeg sub-processes (each
    // probe times out at 15s on hosts without the qsv encoder).
    if (this.detectedHwAccel === 'qsv') {
      void runVppQsvTonemapProbe(this.log);
    }
    // tonemap_opencl probe runs on every Linux Intel host (QSV or VAAPI):
    // both paths can route through the opencl tonemap chain at session
    // time, but the QSV↔OpenCL bridge is fragile and we need to know
    // upfront whether `tonemapAlgo='auto'` can safely default to opencl.
    if (
      this.detectedHwAccel === 'qsv' ||
      this.detectedHwAccel === 'vaapi'
    ) {
      void runTonemapOpenclProbe(this.log);
    }

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

  /** List of tone-mapping algorithms the current host can run.
   *  `'auto'` is always available — it maps to the platform's native
   *  HW path (`scale_vt` on macOS / VideoToolbox, tonemap_opencl or
   *  tonemap_vaapi on Intel Linux depending on the probe result). The
   *  three explicit overrides only surface when their underlying
   *  filter graph can actually run end-to-end on this host. */
  getAvailableTonemapAlgos(): TonemapAlgo[] {
    const out: TonemapAlgo[] = ['auto'];
    if (this.detectedHwAccel === 'qsv' || this.detectedHwAccel === 'vaapi') {
      // tonemap_vaapi only needs a VAAPI render node — both the QSV
      // and the VAAPI hwaccel detect paths confirm one exists.
      out.push('vaapi');
    }
    if (this.detectedHwAccel === 'qsv' && isVppQsvTonemapEnabled()) {
      out.push('qsv');
    }
    if (isTonemapOpenclEnabled()) {
      out.push('opencl');
    }
    return out;
  }

  /** Update segment duration from admin streaming settings. */
  setSegmentDuration(segDuration: number) {
    applySegmentDuration(segDuration);
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
      // var_stream_map sessions write video into a `0/` subdir; fall back to
      // the session root for single-stream sessions and remux output.
      const rootDir = session.cachePath;
      const dirs = [path.join(rootDir, '0'), rootDir];
      let maxSeg = -1;
      for (const dir of dirs) {
        let files: string[];
        try {
          files = await fsp.readdir(dir);
        } catch {
          continue;
        }
        for (const f of files) {
          const m = f.match(/^seg-(\d+)\.m4s$/);
          if (m) {
            const n = parseInt(m[1], 10);
            if (n > maxSeg) maxSeg = n;
          }
        }
        if (maxSeg >= 0) break;
      }
      if (maxSeg < 0) return 0;
      const transcodedUpTo = segmentIndexToSeconds(maxSeg + 1);
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
    outputAudioCodec: 'aac' | 'ac3' | 'eac3' = 'aac',
    hdrPassThrough?: {
      hdrFormat: 'HDR10' | 'HLG';
      videoBitRateBps?: number;
      audioBitRateBps?: number;
    },
    sdrVariant?: import('./codec/types').CodecVariant,
  ): string {
    // Ask the encoder registry whether any HEVC Main10 HDR10 encoder is
    // probed-OK on the detected hwAccel (or CPU fallback). When false,
    // the manifest skips lower-res HEVC HDR rungs so we don't advertise
    // `hvc1.*` segments we can't actually produce — the top remux rung
    // stays because `-c:v copy` works regardless of the encoder probe
    // matrix. Pre-registry this was hard-coded to `qsv` and ignored
    // libx265 + hevc_vaapi_main10, leaving valid HDR rungs off the
    // manifest on AMD/CPU-only hosts.
    const canEncodeHevcHdr = !!encoderRegistry.resolve(
      { codec: 'hevc', bitDepth: 10, hdr: 'HDR10' },
      this.detectedHwAccel,
    );
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
      outputAudioCodec,
      hdrPassThrough,
      canEncodeHevcHdr,
      sdrVariant,
    );
  }

  /**
   * Start or retrieve a transcode session.
   * Key: one session per user per file.
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
        // Inherit the killed session's seek position when the caller
        // didn't pass one (init.mp4 requests arrive without a segment
        // hint → requestedSegment=0). Without this, the new quality
        // session spawns at ss=0 and gets killed seconds later by the
        // first segment fetch which triggers a seek restart at the
        // real position.
        if (requestedSegment === 0 && existing.startSegment) {
          requestedSegment = existing.startSegment;
        }
        this.sessions.delete(key);
        existing.intentionallyKilled = true;
        await this.killProcess(existing.process);
      } else {
        const resolved = await this.resolveExistingSession(
          key,
          existing,
          requestedSegment,
          qualityMatch,
        );
        if (resolved) return resolved;
        const restartAt = existing.startSegment ?? requestedSegment;
        const dir = path.join(this.cachePath, key, quality);
        await fsp.mkdir(dir, { recursive: true });
        if (useVarStreamMap) {
          for (let i = 0; i <= ctxAudioStreams.length; i++) {
            await fsp.mkdir(path.join(dir, String(i)), { recursive: true });
          }
        }
        return this.startSeekSession(
          key,
          mediaFileId,
          quality,
          absolutePath,
          dir,
          restartAt,
          ctx,
        );
      }
    }

    const ladder = isHdrProfile(quality)
      ? getHdrLadderForDevice(ctx?.deviceType)
      : getLadderForDevice(ctx?.deviceType);
    const profile = ladder.find((p) => p.name === quality) ?? ladder[0];
    const sessionDir = path.join(this.cachePath, key, quality);
    const dirExisted = existsSync(sessionDir);
    await fsp.mkdir(sessionDir, { recursive: true });
    this.log.log(
      `[disk] mkdir ${sessionDir} (existed=${dirExisted}) for ${key}`,
    );

    if (useVarStreamMap) {
      for (let i = 0; i <= ctxAudioStreams.length; i++) {
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
   * Runs OUTSIDE the session-creation lock — `session.ready` is the
   * coordination point: `spawnFfmpegSession` resolves it either when
   * seg-0 lands on disk (happy path) or when the ffmpeg process closes
   * (crash safety net). After the await, a non-zero exitCode with no
   * segment on disk means the HW path failed — kill it and respawn on
   * CPU.
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
    const ladder = isHdrProfile(quality)
      ? getHdrLadderForDevice(ctx?.deviceType)
      : getLadderForDevice(ctx?.deviceType);
    const profile = ladder.find((p) => p.name === quality) ?? ladder[0];

    await session.ready;
    const segNum = String(requestedSegment).padStart(4, '0');
    const segExts = ['.m4s', '.ts'];
    const segExists = async () => {
      for (const ext of segExts) {
        if (await fileExists(path.join(sessionDir, `seg-${segNum}${ext}`)))
          return true;
        if (await fileExists(path.join(sessionDir, '0', `seg-${segNum}${ext}`)))
          return true;
      }
      return false;
    };
    const crashed = session.process.exitCode !== null && !(await segExists());
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
        for (let i = 0; i <= ctxAudioStreams.length; i++) {
          await fsp.mkdir(path.join(sessionDir, String(i)), {
            recursive: true,
          });
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

      const ladder = isHdrProfile(quality)
        ? getHdrLadderForDevice(ctx?.deviceType)
        : getLadderForDevice(ctx?.deviceType);
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
          await fsp.mkdir(path.join(sessionDir, String(i)), {
            recursive: true,
          });
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
          audioStreams: ctxAudioStreams,
          audioPlan: ctx?.audioPlan,
          encoderPreset: ctx?.encoderPreset,
          qsvOptions: ctx?.qsvOptions,
          tonemapAlgo: ctx?.tonemapAlgo,
          sourceFps: ctx?.sourceFps,
          trustedStreamInfo: ctx?.trustedStreamInfo,
          early: true,
          useTs: ctx?.useTs ?? false,
          videoVariant: ctx?.videoVariant,
          sourceVideoCodec: ctx?.sourceVideoCodec,
          sourceBitDepth: ctx?.isSourceHdr ? 10 : 8,
        },
        this.log,
      );
      // Bound input read to 4s — enough for seg-0 + seg-1, then ffmpeg
      // exits cleanly. Insert as INPUT option (before -i).
      const inputIdx = args.indexOf('-i');
      if (inputIdx >= 0) args.splice(inputIdx, 0, '-t', '4');

      const usesVarStreamMap =
        isVideoOnly && ctxAudioStreams && ctxAudioStreams.length > 1;
      const session = this.spawnFfmpegSession({
        id,
        mediaFileId,
        quality,
        args,
        sessionDir,
        startSegment: 0,
        segExt: ctx?.useTs ? '.ts' : '.m4s',
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
        if (content.includes('.m4s')) return content;
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
   * ffmpeg's atomic rename. `-hls_flags +temp_file` (set by
   * `ffmpeg-args.ts`) makes ffmpeg write each segment to `*.tmp` and
   * rename to the final name once flushed, so seeing the final name on
   * disk is sufficient — no size-stability poll needed.
   */
  async getSegmentPath(
    session: TranscodeSession,
    segmentName: string,
    timeoutMs = 60_000,
  ): Promise<string | null> {
    const segPath = path.join(session.cachePath, segmentName);

    if (existsSync(segPath)) return segPath;

    if (segmentName.includes('init')) {
      await session.ready;
      if (existsSync(segPath)) return segPath;
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

      const tryServe = () => {
        if (settled) return;
        if (existsSync(segPath)) finish(segPath);
      };

      try {
        watcher = watch(dir, { persistent: false }, (_event, filename) => {
          if (filename === name) tryServe();
        });
      } catch {
        // Directory doesn't exist yet — exitTimer covers it.
      }

      tryServe();

      exitTimer = setInterval(() => {
        if (session.process.exitCode !== null && !existsSync(segPath)) {
          finish(null);
        } else {
          tryServe();
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

    // Compact one-liner — quality + encoder + seek + start_number is what
    // the operator needs in normal operation. Full ffmpeg command was at
    // DEBUG previously but Nest's dev logger emits debug by default,
    // which defeated the noise reduction. If full command is needed,
    // grep the ffmpeg process tree (`ps aux | grep ffmpeg`) or
    // re-derive from the descriptor + ctx.
    const encoderIdx = args.indexOf('-c:v');
    const encoder = encoderIdx >= 0 ? args[encoderIdx + 1] : '?';
    const ssIdx = args.lastIndexOf('-ss');
    const ss = ssIdx >= 0 ? args[ssIdx + 1] : '0';
    const startNumberIdx = args.indexOf('-start_number');
    const startNumber =
      startNumberIdx >= 0 ? args[startNumberIdx + 1] : String(startSegment);
    this.log.log(
      `FFmpeg start [${id}] ${quality} ${encoder} ss=${ss} start_number=${startNumber}`,
    );

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
        this.log.error(
          `FFmpeg [${id}] exited ${code}:\n${stderr.slice(-2000)}`,
        );
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
        audioStreams,
        audioPlan: ctx?.audioPlan,
        encoderPreset: ctx?.encoderPreset,
        qsvOptions: ctx?.qsvOptions,
        tonemapAlgo: ctx?.tonemapAlgo,
        sourceFps: ctx?.sourceFps,
        trustedStreamInfo: ctx?.trustedStreamInfo,
        useTs: ctx?.useTs ?? false,
        videoVariant: ctx?.videoVariant,
        sourceVideoCodec: ctx?.sourceVideoCodec,
        sourceBitDepth: ctx?.isSourceHdr ? 10 : 8,
      },
      this.log,
    );

    const usesVarStreamMap =
      isVideoOnly && audioStreams && audioStreams.length > 1;
    const session = this.spawnFfmpegSession({
      id: sessionId,
      mediaFileId,
      quality,
      args,
      sessionDir,
      startSegment,
      segExt: ctx?.useTs ? '.ts' : '.m4s',
      segSubDir: usesVarStreamMap ? '0' : undefined,
      extra: {
        actualHwAccel: hwAccel,
      },
    });
    return session;
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
    const ladder = isHdrProfile(quality)
      ? getHdrLadderForDevice(ctx?.deviceType)
      : getLadderForDevice(ctx?.deviceType);
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
    // Parent-dir rm is serialised under the same per-key lock as
    // getOrCreate to close a race: without the lock, a new session
    // could enter getOrCreate between the `has(key)` probe below and
    // the (previously async, fire-and-forget) rm completing, and the
    // recursive rm would then wipe the new session's fresh segments.
    // The lock makes "either rm the parent OR start a new session"
    // atomic per key.
    await this.removeParentDirIfIdle(key);
    await this.removeParentDirIfIdle(earlyKey);
  }

  private async removeParentDirIfIdle(key: string): Promise<void> {
    await this.withLock(key, async () => {
      if (this.sessions.has(key)) {
        const parentDir = path.join(this.cachePath, key);
        this.log.log(
          `[disk] skip rm parent ${parentDir} — session ${key} replaced`,
        );
        return;
      }
      const parentDir = path.join(this.cachePath, key);
      const existed = existsSync(parentDir);
      this.log.log(`[disk] rm parent ${parentDir} (existed=${existed})`);
      await fsp.rm(parentDir, { recursive: true, force: true }).catch(() => {});
    });
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
          key,
          existing,
          requestedSegment,
          qualityMatch,
        );
        if (resolved) return resolved;
        requestedSegment = existing.startSegment ?? requestedSegment;
      }
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
      ctx?.trustedStreamInfo,
      ctx?.audioStreamIndex,
      this.log,
      ctx?.sourceVideoCodec,
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
      ctx?.useTs ?? false,
    );

    const session = this.spawnFfmpegSession({
      id: key,
      mediaFileId,
      quality: `audio-${audioIndex}`,
      args,
      sessionDir,
      startSegment: requestedSegment,
      segExt: ctx?.useTs ? '.ts' : undefined,
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
      this.log.log(`[disk] skip rm ${dirPath} — session ${sessionId} replaced`);
      return;
    }
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
    session.audioPlan = ctx.audioPlan;
    session.videoVariant = ctx.videoVariant;
    if (!session.startedAt) session.startedAt = new Date();
  }

  /** Simple keyed lock: serialises access per session key. */
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
