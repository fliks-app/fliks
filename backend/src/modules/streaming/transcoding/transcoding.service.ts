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
import {
  EARLY_PROBE_SEGMENTS,
  JOB_GRACE_MS,
  SEEK_WAIT_THRESHOLD,
  SESSION_TIMEOUT_MS,
  getSegmentDuration,
  segmentIndexToSeconds,
  setSegmentDuration as applySegmentDuration,
} from './constants';
import { LiveSessionRegistry } from '../live-session.service';
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
  purgeSegmentsFrom,
  segmentNearby,
} from './segment-utils';
import { sessionKey } from './session-key';
import {
  buildPlaybackProfileFromContext,
  computeProfileHash,
} from './profile-hash';
import { TranscodeCacheService } from './transcode-cache.service';
import {
  VARIANT_EARLY,
  VARIANT_MAIN,
  VARIANT_REMUX,
  type SessionVariant,
  variantHash,
} from './variant';
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
  constructor(
    private readonly cacheService: TranscodeCacheService,
    private readonly liveSessions: LiveSessionRegistry,
  ) {}

  async onModuleInit() {
    // Let the cache GC see which directories are backed by a live session so
    // it never evicts one mid-playback. Session cache paths are quality
    // subdirs of the cache entry dirs; the cache matches by prefix.
    this.cacheService.registerLiveDirProvider(
      () =>
        new Set(
          [...this.sessions.values()]
            .map((s) => s.cachePath)
            .filter((p): p is string => typeof p === 'string' && p.length > 0),
        ),
    );

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

    // Tight cleanup cadence — paired with the live-session 30 s TTL +
    // 60 s job grace, this puts ffmpeg death within ~100 s of the last
    // viewer disappearing.
    this.cleanupTimer = setInterval(() => this.cleanupStaleSessions(), 10_000);
  }

  /** Get an existing session for an exact `(file, user, base hash,
   *  variant)` tuple. Variant defaults to `main`; pass {@link VARIANT_EARLY}
   *  for the early companion, etc. */
  getExistingSession(
    mediaFileId: number,
    userId: number | undefined,
    baseHash: string,
    variant: SessionVariant = VARIANT_MAIN,
  ): TranscodeSession | undefined {
    return this.sessions.get(
      sessionKey(mediaFileId, userId, variantHash(baseHash, variant)),
    );
  }

  /** All transcode sessions registered for a given `(file, user)` pair —
   *  one per profile variant. Used by full-file cleanup (`killSession`)
   *  and by the admin dashboard. */
  getSessionsForFileUser(
    mediaFileId: number,
    userId: number | undefined,
  ): TranscodeSession[] {
    const matches: TranscodeSession[] = [];
    for (const s of this.sessions.values()) {
      if (s.mediaFileId === mediaFileId && s.userId === userId) {
        matches.push(s);
      }
    }
    return matches;
  }

  /** Convenience lookup: derives the profile hash from the supplied
   *  context and returns the matching session, if any. Use this from
   *  segment-serving routes where the controller has just rebuilt the
   *  session context from the request. */
  findSessionByCtx(
    mediaFileId: number,
    ctx: SessionContext | undefined,
  ): TranscodeSession | undefined {
    return this.getExistingSession(
      mediaFileId,
      ctx?.userId,
      this.computeProfileHashForCtx(ctx),
    );
  }

  /** Same as {@link findSessionByCtx} for the early-segment companion. */
  findEarlySessionByCtx(
    mediaFileId: number,
    ctx: SessionContext | undefined,
  ): TranscodeSession | undefined {
    return this.getExistingSession(
      mediaFileId,
      ctx?.userId,
      this.computeProfileHashForCtx(ctx),
      VARIANT_EARLY,
    );
  }

  /** Most-recently-accessed transcode session for this `(file, user)`
   *  pair across every profile variant. Used by segment-serving routes
   *  that can't cheaply reconstruct the session context — when only one
   *  device is active this is exactly the session driving the playback,
   *  and the multi-profile edge case (two devices, two profiles)
   *  resolves to whichever side last fetched a segment. */
  findCurrentSession(
    mediaFileId: number,
    userId: number | undefined,
  ): TranscodeSession | undefined {
    const sessions = this.getSessionsForFileUser(mediaFileId, userId);
    if (sessions.length === 0) return undefined;
    let best = sessions[0];
    for (const s of sessions) {
      if (s.lastAccess > best.lastAccess) best = s;
    }
    return best;
  }

  /** Companion of {@link findCurrentSession} for early sessions. */
  findCurrentEarlySession(
    mediaFileId: number,
    userId: number | undefined,
  ): TranscodeSession | undefined {
    let best: TranscodeSession | undefined;
    for (const s of this.sessions.values()) {
      if (
        s.mediaFileId === mediaFileId &&
        s.userId === userId &&
        s.variant?.kind === 'early'
      ) {
        if (!best || s.lastAccess > best.lastAccess) best = s;
      }
    }
    return best;
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

  /** Profile hash for the given session context — derived from the same
   *  fields {@link buildPlaybackProfileFromContext} consumes. Stashed on
   *  the session and reused as the session-map key segment so multiple
   *  profile variants of the same `(file, user)` coexist as siblings. */
  computeProfileHashForCtx(ctx: SessionContext | undefined): string {
    return computeProfileHash(
      buildPlaybackProfileFromContext(ctx, getSegmentDuration() * 1000),
    );
  }

  /**
   * Resolve the on-disk cache directory for a session variant. Wraps
   * the {@link TranscodeCacheService} layout so every spawn site goes
   * through one place. Returns the directory and the client-level
   * base profile hash; the caller already holds the `SessionVariant`,
   * so storing both `baseProfileHash` and `variant` on the session is
   * enough to recover the cache key via `variantHash`.
   */
  private cacheDirFor(
    ctx: SessionContext | undefined,
    mediaFileId: number,
    variant: SessionVariant,
    quality?: string,
  ): { dir: string; baseHash: string } {
    const baseHash = this.computeProfileHashForCtx(ctx);
    const dir = this.cacheService.cachePathFor(
      ctx?.userId ?? null,
      mediaFileId,
      variantHash(baseHash, variant),
      quality,
    );
    return { dir, baseHash };
  }

  /** Absolute path to the `(userId, mediaFileId)` parent dir under the
   *  new cache root. Used by full-session cleanup which wipes every
   *  profile variant for a given user-file pair. */
  private userFileParentDir(
    mediaFileId: number,
    userId: number | undefined,
  ): string {
    const userSeg = userId == null ? 'anon' : `u${userId}`;
    return path.join(
      this.cacheService.cacheRoot(),
      userSeg,
      String(mediaFileId),
    );
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
          const m = f.match(/^seg-(\d+)\.(?:m4s|ts)$/);
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
    outputAudioCodec: string = 'aac',
    hdrPassThrough?: {
      hdrFormat: 'HDR10' | 'HLG';
      videoBitRateBps?: number;
      audioBitRateBps?: number;
    },
    sdrVariant?: import('./codec/types').CodecVariant,
    sourceFrameRate?: number,
    subtitleRenditions?: import('./types').SubtitleRenditionMeta[],
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
      sourceFrameRate,
      subtitleRenditions,
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
    const profileHash = this.computeProfileHashForCtx(ctx);
    const key = sessionKey(mediaFileId, ctx?.userId, profileHash);
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
        const { dir, baseHash } = this.cacheDirFor(
          ctx,
          mediaFileId,
          VARIANT_MAIN,
          quality,
        );
        await fsp.mkdir(dir, { recursive: true });
        if (useVarStreamMap) {
          for (let i = 0; i <= ctxAudioStreams.length; i++) {
            await fsp.mkdir(path.join(dir, String(i)), { recursive: true });
          }
        }
        // Drop any segments from the previous run at/after the new start: they
        // carry that run's 0-based-at-its-own-ss timeline, which collides with
        // this run's at the boundary and stalls the player. Keeps the cache to
        // a single timeline forward of the restart point.
        await purgeSegmentsFrom(dir, restartAt);
        const restarted = this.startSeekSession(
          key,
          mediaFileId,
          quality,
          absolutePath,
          dir,
          restartAt,
          ctx,
        );
        restarted.baseProfileHash = baseHash;
        restarted.variant = VARIANT_MAIN;
        return restarted;
      }
    }

    const ladder = isHdrProfile(quality)
      ? getHdrLadderForDevice(ctx?.deviceType)
      : getLadderForDevice(ctx?.deviceType);
    const profile = ladder.find((p) => p.name === quality) ?? ladder[0];
    const { dir: sessionDir, baseHash } = this.cacheDirFor(
      ctx,
      mediaFileId,
      VARIANT_MAIN,
      quality,
    );
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
    // Single-timeline cache: clear any prior run's segments at/after this
    // start so the forward path never crosses a backward tfdt jump (see
    // purgeSegmentsFrom). A cold first play finds nothing to drop.
    await purgeSegmentsFrom(sessionDir, requestedSegment);
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
    session.baseProfileHash = baseHash;
    session.variant = VARIANT_MAIN;
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
   * Bounded by an input-side `-t` of EARLY_PROBE_SEGMENTS segments (+1s) so
   * ffmpeg exits shortly after flushing seg-0 .. seg-(EARLY_PROBE_SEGMENTS-1),
   * each a full `getSegmentDuration()` long (there is no `hls_init_time`, so
   * seg-0 is not shortened). Same encoder profile + audio layout as the main
   * session so segments and
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
    const baseHash = this.computeProfileHashForCtx(ctx);
    const id = sessionKey(
      mediaFileId,
      ctx?.userId,
      variantHash(baseHash, VARIANT_EARLY),
    );
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
      const { dir: sessionDir, baseHash } = this.cacheDirFor(
        ctx,
        mediaFileId,
        VARIANT_EARLY,
        quality,
      );
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
          sourceWidth: ctx?.sourceWidth,
          sourceHeight: ctx?.sourceHeight,
          sourceHdrMetadata: ctx?.hdrMetadata,
        },
        this.log,
      );
      // Bound the input read so the early session writes EARLY_PROBE_SEGMENTS
      // full segments (+1s so the last one closes past its boundary), then
      // ffmpeg exits cleanly. Derived from the configured segment duration —
      // a hardcoded 4s only covered two segments at the 3s default and left
      // seg-1 unwritten at 4s/6s grids. Insert as an INPUT option (before -i).
      const earlyReadSec = EARLY_PROBE_SEGMENTS * getSegmentDuration() + 1;
      const inputIdx = args.indexOf('-i');
      if (inputIdx >= 0) args.splice(inputIdx, 0, '-t', String(earlyReadSec));

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
      session.baseProfileHash = baseHash;
      session.variant = VARIANT_EARLY;
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
        // Ready once ffmpeg has written segment lines — fMP4 (.m4s) or TS (.ts).
        if (content.includes('.m4s') || content.includes('.ts')) return content;
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
    // Decoder label, inferred from the input-side ffmpeg flags. The
    // decoder descriptor itself isn't passed through here (it lives in
    // `ffmpeg-args` and we don't want to thread the registry across
    // four spawn sites), so we read it back from the args we just
    // built. Two QSV variants share `qsv=qs@va`: the default emits
    // VAAPI surfaces (`-hwaccel vaapi`), the native-qsv variant emits
    // QSV surfaces (`-hwaccel qsv`).
    const hwaccelIdx = args.indexOf('-hwaccel');
    const hwaccel = hwaccelIdx >= 0 ? args[hwaccelIdx + 1] : 'cpu';
    const hasQsvBridge = args.includes('qsv=qs@va');
    const decoder =
      hwaccel === 'qsv'
        ? 'qsv-native'
        : hwaccel === 'vaapi' && hasQsvBridge
          ? 'qsv'
          : hwaccel;
    this.log.log(
      `FFmpeg start [${id}] ${quality} dec=${decoder} enc=${encoder} ss=${ss} start_number=${startNumber}`,
    );
    this.log.debug(`FFmpeg argv [${id}]: ffmpeg ${args.join(' ')}`);

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
        sourceWidth: ctx?.sourceWidth,
        sourceHeight: ctx?.sourceHeight,
        sourceHdrMetadata: ctx?.hdrMetadata,
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

  /** Stop every ffmpeg job for this `(file, user)` pair across all
   *  profile variants. The on-disk cache **stays** — `TranscodeCacheService`
   *  owns its lifecycle and will evict on TTL / LRU. A subsequent fresh
   *  play (same profile) reattaches to the existing segments instead of
   *  retranscoding from scratch. */
  async killSession(mediaFileId: number, userId?: number) {
    const sessions = this.getSessionsForFileUser(mediaFileId, userId);
    if (sessions.length === 0) return;
    for (const s of sessions) {
      this.log.log(`Kill session [${s.id}] (quality: ${s.quality})`);
      this.sessions.delete(s.id);
      s.intentionallyKilled = true;
    }
    await Promise.all(sessions.map((s) => this.killProcess(s.process)));
  }

  /** Kill a session by its map key (used by admin dashboard). The cache
   *  directory stays — the admin can purge it separately via a future
   *  cache-eviction action; killing a job mid-stream just frees CPU. */
  killSessionById(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    session.intentionallyKilled = true;
    void this.killProcess(session.process);
  }

  /** Kill every session for a given media file across all users / profiles. */
  killAllSessionsForFile(mediaFileId: number) {
    for (const [id, session] of this.sessions) {
      if (session.mediaFileId === mediaFileId) {
        this.log.log(`Killing session ${id} for media file ${mediaFileId}`);
        this.sessions.delete(id);
        session.intentionallyKilled = true;
        void this.killProcess(session.process);
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
    // Remux variant lives in its own session-map bucket so its cache
    // path doesn't collide with a main session for the same base
    // profile hash.
    const baseHash = this.computeProfileHashForCtx(ctx);
    const key = sessionKey(
      mediaFileId,
      ctx?.userId,
      variantHash(baseHash, VARIANT_REMUX),
    );
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

    const { dir: sessionDir, baseHash: remuxBaseHash } = this.cacheDirFor(
      ctx,
      mediaFileId,
      VARIANT_REMUX,
      'remux',
    );
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
      ctx?.audioStreams,
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
    session.baseProfileHash = remuxBaseHash;
    session.variant = VARIANT_REMUX;

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
    const baseHash = this.computeProfileHashForCtx(ctx);
    const variant: SessionVariant = { kind: 'audio', audioIndex };
    const key = sessionKey(
      mediaFileId,
      ctx?.userId,
      variantHash(baseHash, variant),
    );
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

    const { dir: sessionDir, baseHash: audioBaseHash } = this.cacheDirFor(
      ctx,
      mediaFileId,
      { kind: 'audio', audioIndex },
      'audio',
    );
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
      ctx?.audioStreams,
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
    session.baseProfileHash = audioBaseHash;
    session.variant = { kind: 'audio', audioIndex };

    this.applyContext(session, ctx);
    return session;
  }

  /**
   * Reap transcode sessions whose viewers have all gone. Two regimes:
   *
   * 1. Sessions paired with a live session ride the heartbeat-driven
   *    grace timer: as long as `LiveSessionRegistry.listForJob` returns
   *    at least one entry, the ffmpeg job is kept warm. When the count
   *    drops to zero, JOB_GRACE_MS later the ffmpeg process is killed.
   *
   * 2. Sessions that were never seen with a live session (legacy URL
   *    fetches, admin scrubbing) fall back to the SESSION_TIMEOUT_MS
   *    idle window — safe default that mirrors the pre-heartbeat
   *    behaviour.
   *
   * The on-disk cache directory is preserved in both cases.
   * `TranscodeCacheService` owns the disk lifecycle (TTL + LRU); a
   * fresh play that lands on the same (user, file, profileHash)
   * reattaches to the existing segments without retranscoding.
   *
   * Variant sessions (`-early`, `-remux`, `-a<N>`) ride on the same
   * live session as their main counterpart — the LiveSessionRegistry
   * tracks one entry per client, not one per ffmpeg variant — so the
   * lookup strips the variant suffix before querying.
   */
  private cleanupStaleSessions() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (!session.baseProfileHash) {
        this.fallbackIdleCleanup(now, id, session);
        continue;
      }
      const matching = this.liveSessions.listForJob(
        session.userId ?? null,
        session.mediaFileId,
        session.baseProfileHash,
      );
      if (matching.length > 0) {
        session.seenAnyLiveSession = true;
        session.zeroLiveSince = null;
        continue;
      }
      // A recent segment fetch keeps the job alive even when the
      // live-session count is zero — covers transient heartbeat
      // failures (network blip, throttled background tab) where the
      // client is still actively pulling bytes.
      if (now - session.lastAccess < JOB_GRACE_MS) {
        session.zeroLiveSince = null;
        continue;
      }
      if (!session.seenAnyLiveSession) {
        this.fallbackIdleCleanup(now, id, session);
        continue;
      }
      if (session.zeroLiveSince == null) {
        session.zeroLiveSince = now;
        continue;
      }
      if (now - session.zeroLiveSince < JOB_GRACE_MS) continue;
      this.log.log(
        `Cleanup session ${id}: no live viewer for ${Math.round(
          (now - session.zeroLiveSince) / 1000,
        )}s, killing ffmpeg (cache preserved)`,
      );
      this.sessions.delete(id);
      session.intentionallyKilled = true;
      void this.killProcess(session.process);
    }
  }

  /** Idle-timeout fallback for transcode sessions without a tracked
   *  live session — kept on the legacy SESSION_TIMEOUT_MS window. */
  private fallbackIdleCleanup(
    now: number,
    id: string,
    session: TranscodeSession,
  ): void {
    const processDone = session.process.exitCode !== null;
    if (now - session.lastAccess > SESSION_TIMEOUT_MS && processDone) {
      this.log.log(`Cleanup stale (fallback) session: ${id}`);
      this.sessions.delete(id);
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
    session.muxFlavour = ctx.useTs ? 'ts' : 'fmp4';
    // Match the gate in `ffmpeg-args.ts useVarStreamMap`: any non-empty
    // `audioStreams[]` paired with `videoOnly` triggers the var_stream_map
    // layout (subdirs `0/`, `1/`...). Tag the session with the actual
    // layout ffmpeg was spawned with so the controller's drift detection
    // (in `playback-info`) sees the same value `pickAudioLayout()`
    // computes and doesn't false-positive a kill on every refresh.
    session.audioLayout =
      ctx.videoOnly && ctx.audioStreams && ctx.audioStreams.length > 0
        ? 'var-stream-map'
        : 'inline';
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

