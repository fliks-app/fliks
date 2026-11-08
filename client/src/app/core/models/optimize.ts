/** Library optimization: wire types of `server/crates/server/src/optimize` (profile document, preview, difference). */

export type CodecChoice = 'auto' | 'hevc' | 'av1';
export type Goal = 'space' | 'compatibility';
export type Quality = 'small' | 'balanced' | 'faithful';
export type MaxResolution = 'source' | '2160' | '1080' | '720';
export type TooSlow = 'hardware' | 'skip';
export type Incompatible = 'keep' | 'add' | 'replace';
export type ImageSubs = 'keep' | 'drop' | 'ocr_then_drop';
export type Container = 'keep' | 'mkv' | 'mp4';
export type Vmaf = 'auto' | 'on' | 'off';
export type OptimizeLevel = 'metadata' | 'remux' | 'reencode';
export type TrackKind = 'audio' | 'subtitle';
export type PresetKey = 'balanced' | 'cleanup_only' | 'direct_playback';

export interface ProfileDocument {
  eligible: { min_age_days: number; skip_hardlinked: boolean };
  video: {
    enabled: boolean;
    when: {
      codec: string[];
      min_bitrate: number | null;
      only_if_transcoding_here: boolean;
      skip_hdr10plus_dv: boolean;
    };
    codec: CodecChoice;
    goal: Goal;
    quality: Quality;
    max_resolution: MaxResolution;
    prefer_software: boolean;
    software_max_hours: number;
    too_slow: TooSlow;
    crop_in_file: boolean;
  };
  audio: {
    languages: string[];
    drop_other_languages: boolean;
    drop: string[];
    default: string[];
    reorder: boolean;
    incompatible: Incompatible;
  };
  subtitles: {
    languages: string[];
    drop_other_languages: boolean;
    image: ImageSubs;
    reorder: boolean;
  };
  file: { clean: boolean; container: Container; rename_tokens: boolean };
  guards: { min_savings_pct: number; vmaf_sample: Vmaf };
}

export interface OptimizeProfile {
  id: number;
  name: string;
  document: ProfileDocument;
  libraryCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OptimizeProfileBody {
  name: string;
  document: ProfileDocument;
}

export interface OptimizePreset {
  key: PresetKey;
  document: ProfileDocument;
}

/** The editor's four format choices, as `video.codec` + `video.goal`. */
export type FormatChoice = 'most_compact' | 'playable_everywhere' | 'hevc' | 'av1';

export function formatChoice(v: ProfileDocument['video']): FormatChoice {
  if (v.codec === 'hevc') return 'hevc';
  if (v.codec === 'av1') return 'av1';
  return v.goal === 'compatibility' ? 'playable_everywhere' : 'most_compact';
}

export function applyFormatChoice(v: ProfileDocument['video'], c: FormatChoice): void {
  v.codec = c === 'hevc' ? 'hevc' : c === 'av1' ? 'av1' : 'auto';
  if (c === 'most_compact') v.goal = 'space';
  if (c === 'playable_everywhere') v.goal = 'compatibility';
}

export interface PerLevel {
  metadata: number;
  remux: number;
  reencode: number;
}

export interface OptimizePreview {
  files: number;
  conform: number;
  skippedContainer: number;
  withDifference: number;
  perLevel: PerLevel;
  /** Source bytes per level: the base of a savings estimate. */
  bytes: PerLevel;
  durationSeconds: PerLevel;
  removed: { kind: TrackKind; language: string | null; count: number }[];
  ocr: number;
  warnings: Record<string, number>;
}

export interface OptimizeSummary {
  profileId: number | null;
  filesWithDifference: number;
  computedAt: string;
}

export type DropReason =
  | 'commentary'
  | 'audio_description'
  | 'language'
  | 'image_subtitle'
  | 'replaced';

export type Change =
  | {
      type: 'reencode';
      codec: string;
      bitDepth: number;
      crop: unknown;
      maxHeight: number | null;
      cropOnly: boolean;
    }
  | {
      type: 'drop';
      kind: TrackKind;
      streamIndex: number;
      language: string | null;
      reason: DropReason;
    }
  | { type: 'ocr'; streamIndex: number }
  | { type: 'addAudio'; sourceStream: number }
  | { type: 'reorder'; kind: TrackKind }
  | { type: 'default'; streamIndex: number }
  | { type: 'language'; kind: TrackKind; streamIndex: number; code: string }
  | { type: 'flags'; kind: TrackKind; streamIndex: number }
  | { type: 'title'; kind: TrackKind; streamIndex: number }
  | { type: 'statisticsTags' }
  | { type: 'hvc1' }
  | { type: 'container'; to: string }
  | { type: 'rename' };

export type Warning =
  | { type: 'noAudioWouldRemain' }
  | { type: 'profileSubtitleKept'; language: string }
  | { type: 'losslessReplaced'; streamIndex: number }
  | { type: 'videoCopied'; reason: string };

/** What one file would go through; `status` discriminates. */
export type FileOutcome =
  | { status: 'excluded'; why: string }
  | { status: 'skipped'; why: 'container' }
  | { status: 'conform'; warnings: Warning[] }
  | { status: 'diff'; level: OptimizeLevel; changes: Change[]; warnings: Warning[] };

/** `PATCH /api/libraries/:id` fields. */
export interface LibraryOptimizeSettings {
  optimizeProfileId: number | null;
  optimizeNewFiles: boolean;
  allowRename: boolean;
}

export type OriginalPolicy = 'trash' | 'keep' | 'delete';

/** `GET/PUT /api/optimize/settings`; `window` minutes are since local midnight. */
export interface OptimizeSettings {
  window: { startMin: number; endMin: number } | null;
  optimizeOriginal: OriginalPolicy;
  trashRetentionDays: number;
  trashMinFreeGb: number;
  deviceMaxJobs: Record<string, number>;
  gpuPlaybackBeforePause: number;
  /** Per device id: overrides `gpuPlaybackBeforePause` for that device. */
  deviceGpuPlaybackBeforePause: Record<string, number>;
  cpuWeight: number;
  verifyIntervalDays: number;
  verifyBatch: number;
  /** Read only: the PUT ignores it, pause and resume have their own routes. */
  paused?: boolean;
}

export interface LevelLeft {
  jobs: number;
  playSeconds: number;
  estimateSeconds: number | null;
}

export interface QueueEstimate {
  perLevel: Partial<Record<OptimizeLevel, LevelLeft>>;
  /** Null while a level with jobs has no history yet. */
  etaSeconds: number | null;
  endsAt: string | null;
}

export interface QueueStatus {
  paused: boolean;
  /** Inside the time window (or none): new leases may start. */
  open: boolean;
  counts: Record<string, number>;
  estimate: QueueEstimate;
}

export type JobState =
  | 'queued'
  | 'leased'
  | 'staged'
  | 'committing'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface OptimizeJob {
  id: number;
  kind: string;
  mediaFileId: number | null;
  state: JobState;
  priority: number;
  attempt: number;
  failures: number;
  progress: number;
  /** Paused by playback on its device. */
  paused: boolean;
  workerId: string | null;
  deviceId: string | null;
  error: { class?: string; message?: string } | null;
  /** The original can be put back: a backup is kept and no restore ran or was purged. */
  restorable: boolean;
  inPath: string | null;
  inSize: number | null;
  outSize: number | null;
  title: string | null;
  libraryId: number | null;
  level: OptimizeLevel | null;
  codec: string | null;
  durationSeconds: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerDevice {
  id: string;
  name?: string;
  encoders: string[];
  decoders: string[];
  maxJobs: number;
  vramMib?: number;
}

export interface OptimizeWorker {
  instance: string;
  engineVersion: string;
  tokenId: number | null;
  /** ISO time of the worker's last hello, lease or heartbeat. */
  lastSeenAt: string;
  devices: WorkerDevice[];
}

export interface PathMapping {
  from: string;
  to: string;
}

export type WorkerPathAccess = 'none' | 'shared';

export interface WorkerToken {
  id: number;
  name: string;
  enabled: boolean;
  pathAccess: WorkerPathAccess;
  pathMappings: PathMapping[];
  createdAt: string;
  lastSeenAt: string | null;
}

/** The creation answer: the plaintext token is shown once. */
export interface IssuedWorkerToken extends WorkerToken {
  token: string;
}

export interface WorkerTokenPatch {
  name?: string;
  enabled?: boolean;
  pathAccess?: WorkerPathAccess;
  pathMappings?: PathMapping[];
}

export type QueueOutcome =
  | 'queued'
  | 'active'
  | 'missing'
  | 'unprobed'
  | 'nothing_to_do'
  | 'shared'
  | 'stale'
  | 'ocr_pending';

export interface Queued {
  mediaFileId: number;
  outcome: QueueOutcome;
  jobId: number | null;
}

export const LEVELS: OptimizeLevel[] = ['metadata', 'remux', 'reencode'];

/** Bytes a finished job saved; negative when the file grew. */
export function savedBytes(j: Pick<OptimizeJob, 'inSize' | 'outSize'>): number | null {
  return j.inSize != null && j.outSize != null ? j.inSize - j.outSize : null;
}

/** Minutes since midnight to `HH:MM`, and back (null when malformed). */
export function minutesToTime(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function timeToMinutes(t: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** A worker silent for longer than this counts as offline. */
export const WORKER_OFFLINE_MS = 2 * 60_000;

/** Error classes the server and the engine emit; each has an `optimize.queue.error_class.*` key. */
export const ERROR_CLASSES = [
  'access',
  'busy',
  'cancelled',
  'corrupt',
  'damaged',
  'engine',
  'io',
  'network',
  'nospace',
  'shared',
  'stale',
  'verify',
] as const;
