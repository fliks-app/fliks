/** Library optimization: wire types of `server/crates/server/src/optimize` (profile document, preview, difference). */

import type { MediaFileInfo } from '../services/api/media.service';
import type { MediaType } from '../enums/media-type.enum';

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
  | { type: 'noLanguageMatch' }
  | { type: 'profileSubtitleKept'; language: string }
  | { type: 'losslessReplaced'; streamIndex: number }
  | { type: 'videoCopied'; reason: string };

/** What one file would go through; `status` discriminates. */
export type FileOutcome =
  | { status: 'excluded'; why: string }
  | { status: 'skipped'; why: 'container' }
  | { status: 'conform'; warnings: Warning[] }
  | { status: 'diff'; level: OptimizeLevel; changes: Change[]; warnings: Warning[] };

export const CHANGE_GROUPS = ['video', 'audio', 'subtitles', 'file'] as const;
export type ChangeGroup = (typeof CHANGE_GROUPS)[number];

/** A translation key and its params. */
export interface ChangeLine {
  group: ChangeGroup;
  key: string;
  params: Record<string, unknown>;
}

/** Position of an ffprobe stream among the tracks of its kind, counted from 1 (the absolute index counts the video too). */
export type Ordinal = (kind: TrackKind, streamIndex: number) => number | string;

export function trackOrdinal(info: MediaFileInfo | null | undefined): Ordinal {
  return (kind, streamIndex) => {
    const list = kind === 'audio' ? info?.audio : info?.subtitles;
    const pos = list?.findIndex((t) => t.streamIndex === streamIndex) ?? -1;
    return pos >= 0 ? pos + 1 : '?';
  };
}

export function changeLine(c: Change, track: Ordinal): ChangeLine {
  const k = (t: string) => `settings.optimize.change.${t}`;
  const of = (kind: TrackKind): ChangeGroup => (kind === 'audio' ? 'audio' : 'subtitles');
  switch (c.type) {
    case 'reencode':
      return {
        group: 'video',
        key: k(c.cropOnly ? 'reencode_crop' : 'reencode'),
        params: { codec: c.codec.toUpperCase(), depth: c.bitDepth, height: c.maxHeight ?? '' },
      };
    case 'drop':
      return {
        group: of(c.kind),
        key: k(`drop_${c.reason}`),
        params: { n: track(c.kind, c.streamIndex), language: c.language ?? '?' },
      };
    case 'ocr':
      return { group: 'subtitles', key: k('ocr'), params: { n: track('subtitle', c.streamIndex) } };
    case 'addAudio':
      return { group: 'audio', key: k('add_audio'), params: { n: track('audio', c.sourceStream) } };
    case 'reorder':
      return { group: of(c.kind), key: k('reorder'), params: {} };
    case 'default':
      return { group: 'audio', key: k('default'), params: { n: track('audio', c.streamIndex) } };
    case 'language':
      return {
        group: of(c.kind),
        key: k('language'),
        params: { n: track(c.kind, c.streamIndex), code: c.code },
      };
    case 'flags':
      return { group: of(c.kind), key: k('flags'), params: { n: track(c.kind, c.streamIndex) } };
    case 'title':
      return { group: of(c.kind), key: k('title'), params: { n: track(c.kind, c.streamIndex) } };
    case 'statisticsTags':
      return { group: 'file', key: k('statistics_tags'), params: {} };
    case 'hvc1':
      return { group: 'file', key: k('hvc1'), params: {} };
    case 'container':
      return { group: 'file', key: k('container'), params: { to: c.to.toUpperCase() } };
    case 'rename':
      return { group: 'file', key: k('rename'), params: {} };
  }
}

/** The changes sorted into their groups, empty groups left out. */
export function groupedChanges(changes: Change[], track: Ordinal) {
  const all = changes.map((c) => changeLine(c, track));
  return CHANGE_GROUPS.map((g) => ({ group: g, items: all.filter((l) => l.group === g) })).filter(
    (g) => g.items.length > 0,
  );
}

export function warningLine(w: Warning): { key: string; params: Record<string, unknown> } {
  const k = (t: string) => `settings.optimize.warning.${t}`;
  switch (w.type) {
    case 'noAudioWouldRemain':
      return { key: k('no_audio'), params: {} };
    case 'noLanguageMatch':
      return { key: k('no_language_match'), params: {} };
    case 'profileSubtitleKept':
      return { key: k('profile_subtitle'), params: { language: w.language } };
    case 'losslessReplaced':
      return { key: k('lossless'), params: { n: w.streamIndex + 1 } };
    case 'videoCopied':
      return { key: k(`video_copied.${w.reason}`), params: {} };
  }
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
  /** No run progresses: it yields its slot or waits for one. */
  paused: boolean;
  workerId: string | null;
  deviceId: string | null;
  /** While leased: the device the job runs on when it is not `deviceId` (a GPU encode redone on the CPU). */
  runsOn: string | null;
  error: { class?: string; message?: string; stderr?: string } | null;
  /** The original can be put back: a backup is kept and no restore ran or was purged. */
  restorable: boolean;
  inPath: string | null;
  inSize: number | null;
  outSize: number | null;
  title: string | null;
  mediaId: number | null;
  mediaType: MediaType | null;
  libraryId: number | null;
  level: OptimizeLevel | null;
  codec: string | null;
  durationSeconds: number | null;
  createdAt: string;
  updatedAt: string;
}

/** The device a job runs on now. */
export function jobDevice(j: OptimizeJob): string | null {
  return j.runsOn ?? j.deviceId;
}

/** `GET /api/optimize/jobs/{id}`: what the job does to its file. */
export interface OptimizeJobDetail {
  /** Null on a job queued before the diff was kept. */
  diff: { changes: Change[]; warnings: Warning[] } | null;
  /** Probe at queueing. */
  source: (MediaFileInfo & { formatName?: string }) | null;
  /** Probe of the output, once encoded. */
  output: (MediaFileInfo & { formatName?: string }) | null;
  /** A planned re-encode whose video was copied reports `remux`. */
  doneLevel: OptimizeLevel | null;
  copyReason: string | null;
  cpuFallback: boolean;
  /** Video savings the engine's test encode predicted and the encode reached, in percent. */
  sampledSavingsPct: number | null;
  savingsPct: number | null;
  /** Lowest mean SSIM of the output's check windows. */
  ssim: number | null;
  startedAt: string | null;
  encodedAt: string | null;
  finishedAt: string | null;
}

export interface WorkerDevice {
  id: string;
  name?: string;
  encoders: string[];
  decoders: string[];
  maxJobs: number;
}

export interface OptimizeWorker {
  instance: string;
  engineVersion: string;
  tokenId: number | null;
  /** ISO time of the worker's last hello, lease or heartbeat. */
  lastSeenAt: string;
  devices: WorkerDevice[];
  /** Takes karaoke separation jobs now. */
  karaoke: boolean;
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
  'model',
  'network',
  'nospace',
  'shared',
  'stale',
  'unsupported',
  'verify',
] as const;
