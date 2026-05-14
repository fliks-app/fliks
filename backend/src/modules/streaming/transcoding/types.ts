import { ChildProcess } from 'child_process';

export interface TranscodeProfile {
  name: string;
  maxWidth: number;
  maxHeight: number;
  videoBitrate: string;
  audioBitrate: string;
}

export type DeviceType = 'mobile' | 'desktop';

export type HwAccelType = 'vaapi' | 'nvenc' | 'qsv' | 'videotoolbox' | 'none';

/** Short human-readable label for each HW accel type (used in admin
 *  dashboard and player stats overlay). */
export const HW_ACCEL_LABEL: Record<HwAccelType, string> = {
  qsv: 'QSV',
  vaapi: 'VAAPI',
  nvenc: 'NVENC',
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
  /** Audio stream info for multi-audio var_stream_map (single FFmpeg process) */
  audioStreams?: { language?: string; title?: string }[];
  /** Client device category — selects the per-device bitrate ladder. */
  deviceType?: DeviceType;
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
   * True when the playback target is a Chromecast receiver. Switches HLS
   * segments to MPEG-TS (instead of fMP4) so the Cast receiver isn't
   * subject to the encoder-priming desync that comes from an unhonoured
   * init fMP4 `edts/elst` atom. Container choice only — codecs and the
   * rest of the pipeline are unchanged.
   */
  useTs?: boolean;
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
  /** Marks the session as killed intentionally (seek restart, quality
   *  change, etc.) so the close handler doesn't log a spurious "exited
   *  WITHOUT producing first segment" warning. */
  intentionallyKilled?: boolean;
}
