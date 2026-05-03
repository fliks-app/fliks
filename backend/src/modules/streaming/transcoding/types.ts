import { ChildProcess } from 'child_process';

export interface TranscodeProfile {
  name: string;
  maxWidth: number;
  maxHeight: number;
  videoBitrate: string;
  audioBitrate: string;
}

export type DeviceType = 'mobile' | 'desktop';

export type HwAccelType = 'vaapi' | 'nvenc' | 'qsv' | 'none';

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
  /**
   * Audio is bitstream-compatible with the client (declared in the device
   * profile + channel count fits). When true, the transcode path keeps the
   * source audio with `-c:a copy` instead of forcing AAC stereo, so 5.1
   * EAC-3 / AC-3 reaches the TV as bitstream and the receiver lights up
   * the surround indicator. Tracked in ActiveStreamTracker because the
   * planning decision is made in playback-info but consumed lazily by
   * later FFmpeg spawns (segments / quality switches).
   */
  copyAudio?: boolean;
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
