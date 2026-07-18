import { ChildProcess } from 'child_process';

export interface TranscodeProfile {
  name: string;
  maxWidth: number;
  maxHeight: number;
  videoBitrate: string;
  audioBitrate: string;
}

export type DeviceType = 'mobile' | 'desktop';

/**
 * Audio stream metadata sourced from the cached `streamInfo` (ffprobe at
 * scan/rescan time). `streamIndex` is the ABSOLUTE position inside the
 * file (ffprobe `index`), used by FFmpeg arg builders to map audio via
 * `-map 0:<idx>` without re-enumerating streams — required on Blu-ray
 * remuxes where probing for the relative `0:a:N` shorthand fails because
 * PGS subtitle tracks exhaust the probe budget before audio codec params
 * are identified.
 */
export interface AudioStreamMeta {
  language?: string;
  title?: string;
  streamIndex?: number;
  /** Source channel count (from ffprobe streamInfo). Drives the EXT-X-MEDIA
   *  CHANNELS attribute for copy / AC-3 / E-AC-3 renditions, which keep the
   *  source layout; AAC renditions are downmixed to 2 regardless. */
  channels?: number;
}

/**
 * A text subtitle track surfaced as an HLS `SUBTITLES` rendition in the
 * master playlist. `kind` selects the segment source: an embedded stream
 * (extracted to WebVTT by `SubtitleStreamService`) or an external subtitle
 * file row. `key` is the ffprobe stream index (embedded) or the
 * `SubtitleFile` id (external) — the master builder turns it into the
 * rendition's media-playlist URI. Bitmap subtitles (PGS/DVD/DVB) are never
 * renditions: they stay on the burn-in path.
 */
export interface SubtitleRenditionMeta {
  kind: 'embedded' | 'external';
  key: number;
  language?: string;
  name: string;
  forced?: boolean;
}

export type HwAccelType =
  | 'vaapi'
  | 'nvenc'
  | 'qsv'
  | 'amf'
  | 'videotoolbox'
  | 'none';

/** Short human-readable label for each HW accel type (used in admin
 *  dashboard and player stats overlay). */
export const HW_ACCEL_LABEL: Record<HwAccelType, string> = {
  qsv: 'QSV',
  vaapi: 'VAAPI',
  nvenc: 'NVENC',
  amf: 'AMF',
  videotoolbox: 'Apple VT',
  none: 'CPU',
};

export interface BurnInSubtitle {
  /** FFmpeg -vf filter string (e.g. "subtitles='/path/to/sub.srt'") or null for image-based */
  filter: string | null;
  /** For image-based: stream index to overlay */
  streamIndex?: number;
  /** 'text' or 'image' */
  type: 'text' | 'image';
}

/** HDR → SDR tone-mapping algorithm (admin-selectable).
 *  - `auto`: tonemap_opencl with reinhard — best mid-tone restoration on
 *    Intel iGPUs whose fixed-function VPP HDR LUT under-exposes.
 *  - `vaapi`: scale_vaapi → tonemap_vaapi → hwmap=qsv (hybrid pipeline).
 *    Fastest cold start, lowest CPU; use when opencl bridge is broken
 *    or VPP HDR LUT renders correctly on the host iGPU.
 *  - `qsv`: qsv-native decoder + single-pass `vpp_qsv=tonemap=1`
 *    (single-device, same HDR LUT as vaapi underneath).
 *  - `opencl`: explicit opt-in to the `auto` chain. */
export type TonemapAlgo = 'auto' | 'opencl' | 'vaapi' | 'qsv';

export interface SessionContext {
  userId?: number;
  username?: string;
  /** Per-playback suffix appended to the profile hash so a concurrent second
   *  viewer gets its own transcode job (#638). Undefined for the sole playback. */
  instanceSuffix?: string;
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
  /** Audio stream info from cached `streamInfo`. See {@link AudioStreamMeta}. */
  audioStreams?: AudioStreamMeta[];
  /** Client device category — selects the per-device bitrate ladder. */
  deviceType?: DeviceType;
  /** Diagnostic label for the request path that triggered the spawn
   *  (`prewarm`, `seg-request`, `seg-race`, `variant-prespawn`). Echoed in the
   *  "FFmpeg start" log so a mis-anchored session can be traced to its origin
   *  without ad-hoc debug logging. Purely observational — never affects output. */
  spawnReason?: string;
  /**
   * FFmpeg encoder preset ('veryfast' | 'faster' | 'fast' | 'medium' | 'slow').
   * Applied to h264_qsv and libx264; VAAPI/NVENC ignore it (different naming).
   * Default 'faster' if unset — good speed/quality trade-off.
   */
  encoderPreset?: string;
  /** h264_qsv advanced options (admin-configurable). */
  qsvOptions?: {
    /** -low_power 1 (VDENC on Gen9+ — faster, slight quality loss) */
    lowPower: boolean;
  };
  /** HDR → SDR tone-mapping algorithm picked by the admin (or `'auto'` to
   *  let the codec selector keep its built-in preference order). Forwarded
   *  to `ffmpeg-args` to override the default `useVaapiTonemap` decision. */
  tonemapAlgo?: TonemapAlgo;
  /** Source framerate (fps). Used to compute GOP = segmentDuration * fps. */
  sourceFps?: number;
  /** HLS segment duration (seconds) this session cuts on — read from the admin
   *  setting when the context is built and frozen onto the session, so the
   *  serve/seek grid stays fixed for the session's lifetime. */
  segmentDuration?: number;
  /**
   * True when the backend already has a trusted `streamInfo` for this file
   * (populated by ffprobe at import / rescan). If set, FFmpeg can use an
   * aggressive `-analyzeduration 0 -probesize 200K` to skip the redundant
   * stream-info scan — we already know codecs / dimensions / audio layout.
   * Safe default is false (fall back to a balanced 1s/1MB probe).
   */
  trustedStreamInfo?: boolean;
  /**
   * Audio is bitstream-compatible with the client (declared in the device
   * profile + channel count fits). When true, the transcode path keeps the
   * source audio with `-c:a copy` instead of forcing AAC stereo, so 5.1
   * EAC-3 / AC-3 reaches the TV as bitstream and the receiver lights up
   * the surround indicator. Tracked in ActiveStreamTracker because the
   * planning decision is made in playback-info but consumed lazily by
   * later FFmpeg spawns (segments / quality switches).
   */
  /**
   * Canonical audio output decision — single source of truth, computed by
   * `stream-builder` from the source codec / channels and the device's
   * audio allow-list. Everyone downstream (ffmpeg-args, master-playlist,
   * admin dashboard) consumes it without re-deriving anything.
   *
   * - `{ mode: 'copy', codec: <source codec> }` → ffmpeg `-c:a copy`. No
   *   re-encode, no priming, source bitrate preserved.
   * - `{ mode: 'transcode', codec: 'eac3' | 'ac3' | 'aac', bitrateBps }` →
   *   ffmpeg re-encodes. EAC-3 / AC-3 keep the source channel layout
   *   (5.1 stays 5.1) at the indicated bitrate; AAC always downmixes to
   *   stereo.
   *
   * Priority for the surround codec selection is EAC-3 > AC-3 — when the
   * source isn't decodable as-is but the device accepts a surround codec.
   * Pure stereo or no-surround-codec falls back to `'aac'`.
   */
  audioPlan?:
    | { mode: 'copy'; codec: string }
    | {
        mode: 'transcode';
        codec: 'aac' | 'ac3' | 'eac3';
        bitrateBps: number;
      };
  /**
   * Per-rendition audio decision for the multi-audio `var_stream_map` path,
   * one entry per `audioStreams[]` track in source order. The group shares one
   * output codec (HLS requires it); each rendition copies it or transcodes to
   * it, downmixing to `outputChannels`. Threaded so the encode matches the
   * playback-info decision the overlay shows.
   */
  audioTrackPlans?: {
    copy: boolean;
    outputCodec: string;
    outputChannels?: number;
  }[];
  /**
   * True when the playback target is a Tizen TV that can't consume the
   * HLS muxer's fMP4 output — AVPlay rejects the `iso5` + per-stream
   * `sidx` boxes with `InvalidAccessError` / `PLAYER_ERROR_CONNECTION_FAILED`
   * (issue #148). Falling back to MPEG-TS keeps playback working at the
   * cost of Dolby passthrough and a clean HDR path. Cast, browser and
   * native mobile all stay on fMP4 (`useTs: false`).
   */
  useTs?: boolean;
  /**
   * Source video codec (ffprobe `codec_name`, lowercased). Threaded
   * through so the remux path can tag HEVC tracks with `hvc1` instead
   * of FFmpeg's default `hev1` — Apple HLS strictly requires `hvc1`
   * (parameter sets in moov, not mdat), and iOS AVPlayer rejects HEVC
   * HLS variants written with the default `hev1` codec tag.
   */
  sourceVideoCodec?: string;
  /**
   * Source frame dimensions (post container crop / SAR). Drive the
   * aspect-preserving output sizing in `buildFfmpegArgs` — required
   * for non-16:9 sources so the encoder's explicit `h=…` argument
   * matches the source aspect instead of stretching to the profile's
   * raw `maxHeight`.
   */
  sourceWidth?: number;
  sourceHeight?: number;
  /** Probed (or container-minus-audio estimated) source video bitrate in bps.
   *  Threaded to `buildFfmpegArgs` so the rung target is capped to the source
   *  (no upward inflation on a forced transcode). */
  sourceVideoBitrateBps?: number;
  /**
   * Source has HDR transfer characteristics (HDR10 / HLG / DV). The
   * session-wide `tonemap` flag follows the pass-through decision —
   * false when canPassThroughHdr is true (HDR client + HEVC source) —
   * but every quality lock that maps to a transcode rung still needs
   * tone-mapping because we only re-encode to H.264 SDR. Spawners OR
   * this with `tonemap` when picking a non-remux quality.
   */
  isSourceHdr?: boolean;
  /**
   * Output video format the player asked for, picked by stream-builder
   * via the codec selector + quirks DB. Threaded through every session
   * spawn so `ffmpeg-args` resolves the matching encoder descriptor
   * from `encoderRegistry`. Required for transcode/remux spawns —
   * `buildFfmpegArgs` throws when absent so the segment can't silently
   * contradict the master playlist's CODECS string.
   */
  videoVariant?: import('./codec/types').CodecVariant;
  /** Source HDR10 static metadata, threaded from the probed streamInfo so the
   *  encoder signals the source's real mastering display / content light
   *  instead of a generic 1000-nit reference. */
  hdrMetadata?: import('./codec/types').HdrStaticMetadata;
  /** Dolby Vision profile + base-layer compat id, threaded from streamInfo so
   *  ffmpeg-args can gate the P5 libplacebo tonemap (#636). */
  sourceDvProfile?: number;
  sourceDvBlSignalCompatId?: number;
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
  /** Source frame rate this session encodes at. Lets the segment-serve path
   *  resolve the real segment-duration grid without re-probing streamInfo. */
  sourceFps?: number;
  /** Segment duration (seconds) this session was spawned with, frozen from the
   *  admin setting at spawn. The serve/seek grid reads this — never the live
   *  admin value — so an admin change mid-playback can't shift the timeline of
   *  segments already on disk. */
  segmentDuration?: number;
  /** Marks the session as killed intentionally (seek restart, quality
   *  change, etc.) so the close handler doesn't log a spurious "exited
   *  WITHOUT producing first segment" warning. */
  intentionallyKilled?: boolean;
  /** Audio output the session was spawned for. Compared against the
   *  fresh playback-info plan on every subsequent /playback-info call;
   *  a codec drift (e.g. Chromecast picking AAC where browser was on
   *  EAC-3 copy) forces a kill+respawn so the segments stay coherent
   *  with the master.m3u8 CODECS string the player will see. */
  audioPlan?:
    | { mode: 'copy'; codec: string }
    | {
        mode: 'transcode';
        codec: 'aac' | 'ac3' | 'eac3';
        bitrateBps: number;
      };
  /** Video variant the session was spawned for. Same role as
   *  `audioPlan` above: any divergence between a fresh playback-info
   *  decision and the running session means the segments contradict
   *  the manifest, so the session must respawn. */
  videoVariant?: import('./codec/types').CodecVariant;
  /** Mux flavour the session was spawned for:
   *  - `'ts'`: MPEG-TS HLS (legacy Tizen fallback, opt-in via `useTs`).
   *  - `'fmp4'`: fMP4 via HLS muxer — the universal path. Segments are
   *    post-processed at serve time (`cmaf-rewrite.ts`) to strip the
   *    `sidx` boxes + rewrite the `iso5` brand to `cmfc`, so the
   *    same bytes parse on AVPlay / Shaka / ExoPlayer / Cast.
   *  Drift detection respawns the session when the flavour changes. */
  muxFlavour?: 'ts' | 'fmp4';
  /** HLS audio layout the session was spawned for:
   *  - `'inline'`: single video+audio output, flat segment dir.
   *  - `'var-stream-map'`: FFmpeg `-var_stream_map` with one rendition
   *    per audio track, segments under `<repIdx>/`.
   *  Toggled by `audioStreams.length > 1` in the session context, which
   *  in turn is gated on the `debugForceInlineAudio` flag. Tracked for
   *  drift detection: flipping the flag mid-stream must kill+respawn
   *  the session because the on-disk layout differs. */
  audioLayout?: 'inline' | 'var-stream-map';
  /** Client-level base profile hash — matches the
   *  `LiveSession.profileHash` the client beats. Every variant for
   *  the same client (main / early / remux / per-audio) shares this
   *  value. The cache directory layout adds the variant suffix on
   *  top via `variantHash`, the cleanup loop reads it directly when
   *  querying the live-session registry. */
  baseProfileHash?: string;
  /** Output flavour this session produces — disambiguates the cache
   *  bucket among siblings of the same `baseProfileHash`. Combine via
   *  `variantHash(baseProfileHash, variant)` to recover the cache key
   *  (= directory segment + session-map key fragment). */
  variant?: import('./variant').SessionVariant;
  /** Set to true the first time the GC loop observed a matching live
   *  session for this (user, file, profileHash). Gates the
   *  heartbeat-driven grace timer: a session that has never had a
   *  live session falls back to the longer SESSION_TIMEOUT_MS idle
   *  window. */
  seenAnyLiveSession?: boolean;
  /** When the GC loop first observed zero matching live sessions for
   *  this transcode session. Reset to `null` whenever a live session
   *  reappears. Used to enforce the JOB_GRACE_MS window. */
  zeroLiveSince?: number | null;
}
