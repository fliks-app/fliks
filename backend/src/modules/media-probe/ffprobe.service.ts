import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import { EngineService } from '../engine/engine.service';

export interface EmbeddedSubtitleStream {
  streamIndex: number;
  codec: string;
  language: string;
  forced: boolean;
  hearingImpaired: boolean;
  /** True for bitmap subtitles (PGS, VOBSUB, DVB) that need burn-in. */
  isImageBased: boolean;
}

/**
 * Separates "this file carries no subtitle stream" from "ffprobe could not tell us": both
 * arrive as an empty list, and the caller deletes the file's stored rows on the first while
 * a timeout or an unreadable mount must leave them alone.
 */
export interface EmbeddedSubtitleProbe {
  ok: boolean;
  streams: EmbeddedSubtitleStream[];
}

export interface MediaStream {
  streamIndex: number;
  type: 'audio' | 'subtitle';
  codec: string;
  language: string;
  title?: string;
}

export type HdrFormat = 'HDR10' | 'HLG';

export interface CropInfo {
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface VideoStreamInfo {
  streamIndex: number;
  codec: string;
  profile?: string;
  level?: number;
  /** Displayed size: swapped from the coded size when the stream is rotated a
   *  quarter turn, since every decode path autorotates. */
  width?: number;
  height?: number;
  displayAspectRatio?: string;
  pixelFormat?: string;
  frameRate?: string;
  /** Frames the decoder reorders (`has_b_frames`) and the `avg_frame_rate`:
   *  where a copy starts the decode times Matroska leaves unknown. */
  reorderFrames?: number;
  avgFrameRate?: string;
  /** Container start PTS of the video stream (seconds): its first packet. */
  startTimeSeconds?: number;
  /** First frame the decoder presents (seconds), the served origin: past
   *  `startTimeSeconds` when cut mid-GOP or behind an edit list. */
  firstFrameSeconds?: number;
  /** Source time the stream ends at, when the container declares it. */
  endSeconds?: number;
  bitRate?: number;
  bitDepth?: number;
  colorSpace?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  colorRange?: string;
  hdrFormat?: HdrFormat;
  /** Dolby Vision profile from the stream's DOVI configuration record (e.g. 5,
   *  8), with its base-layer signal compatibility id (e.g. 8.1, 8.4), level, and
   *  which layers the record declares. `dvElPresent` tells single-layer (P5/P8)
   *  from dual-layer P7, whose enhancement layer is unreachable over HLS. */
  dvProfile?: number;
  dvBlSignalCompatId?: number;
  dvLevel?: number;
  dvRpuPresent?: boolean;
  dvBlPresent?: boolean;
  dvElPresent?: boolean;
  /** Source HDR10 static metadata (SMPTE ST 2086 mastering display + CTA-861.3
   *  content light), probed via frame side-data for HDR10 sources. Drives the
   *  encoder's master-display / max-cll so the display tonemaps to the source's
   *  real peak luminance instead of a generic 1000-nit reference. */
  hdrMetadata?: { masteringDisplay: string; maxCll: number; maxFall: number };
  /** SMPTE 2094-40 dynamic metadata alongside the static HDR10/DV side data:
   *  a hybrid source. Present (true or false) once probed. */
  hdr10Plus?: boolean;
  crop?: CropInfo;
}

export interface AudioStreamInfo {
  streamIndex: number;
  codec: string;
  language: string;
  /** BCP-47 tag (`es-419`, `pt-BR`, `zh-Hant`) when the container carries a
   *  region/script beyond `language`; display only, `language` drives matching. */
  languageTag?: string;
  title?: string;
  channels?: number;
  channelLayout?: string;
  sampleRate?: number;
  bitRate?: number;
  /** ffprobe profile: `HE-AAC`, `Dolby Digital Plus + Dolby Atmos`, … */
  profile?: string;
  isDefault?: boolean;
  /** Header `start_time`, or the first packet when later (a track starting past
   *  the probe window reads 0 or the video's start). */
  startTimeSeconds?: number;
  /** Source time the track ends at, when the container declares it. */
  endSeconds?: number;
  /** Director's or other commentary (`comment` disposition). */
  commentary?: boolean;
  /** Narrates the picture for blind viewers (`visual_impaired` / `descriptions`). */
  audioDescription?: boolean;
}

export interface SubtitleStreamInfo {
  streamIndex: number;
  codec: string;
  language: string;
  /** BCP-47 tag (`es-419`, `pt-BR`, `zh-Hant`) when the container carries a
   *  region/script beyond `language`; display only, `language` drives matching. */
  languageTag?: string;
  title?: string;
  forced: boolean;
  hearingImpaired: boolean;
  /** True for bitmap subtitles (PGS, VOBSUB, DVB) that need burn-in */
  isImageBased: boolean;
}

export interface Chapter {
  startSeconds: number;
  endSeconds: number;
  title?: string;
}

export interface MediaFileInfo {
  video: VideoStreamInfo[];
  audio: AudioStreamInfo[];
  subtitles: SubtitleStreamInfo[];
  /** Overall container bitrate from ffprobe `format.bit_rate` (bits/s). */
  formatBitRate?: number;
  /** Container `start_time`: the earliest stream start, where an input `-ss`
   *  and a timestamp-rebasing extract count from. */
  formatStartSeconds?: number;
  /** ffprobe `format_name` (`mpegts`, `matroska,webm`, …): how the demuxer seeks. */
  formatName?: string;
  /** Where an MPEG-TS clock breaks (a restarted recording) and playback ends; null
   *  for none, absent until the background scan ran. */
  timestampBreakSeconds?: number | null;
  durationSeconds?: number;
  /** Embedded chapter markers from the container (MKV/MP4). Empty if none. */
  chapters?: Chapter[];
  error?: string;
}

type Probed = { info: MediaFileInfo } | { error: string };

/** Probing, crop detection included, is the engine's: no ffprobe runs in Node. */
@Injectable()
export class FfprobeService {
  private readonly logger = new Logger(FfprobeService.name);

  constructor(private readonly engine: EngineService) {}

  /** The engine's probe of `videoPath`; `error` when ffprobe could not read the file (logged).
   *  Throws when the engine can't be reached, so the caller retries later. */
  private async probe(
    videoPath: string,
    opts: { crop?: boolean; mkvTags?: boolean },
  ): Promise<Probed> {
    const r = await this.engine.probe(path.resolve(videoPath), opts);
    if (r.ok && r.info) return { info: r.info as unknown as MediaFileInfo };
    const error = r.error ?? r.info?.error ?? 'ffprobe failed';
    this.logger.warn(`ffprobe file info failed for "${videoPath}": ${error}`);
    return { error };
  }

  /** {@link probe} for callers that treat an unreachable engine like an unreadable file. */
  private async softProbe(
    videoPath: string,
    opts: { crop?: boolean },
  ): Promise<Probed> {
    try {
      return await this.probe(videoPath, opts);
    } catch (err) {
      const error = (err as Error).message;
      this.logger.warn(`ffprobe file info failed for "${videoPath}": ${error}`);
      return { error };
    }
  }

  async detectEmbeddedSubtitles(
    videoPath: string,
  ): Promise<EmbeddedSubtitleProbe> {
    const r = await this.softProbe(videoPath, {});
    if (!('info' in r)) return { ok: false, streams: [] };
    return {
      ok: true,
      streams: r.info.subtitles.map((s) => ({
        streamIndex: s.streamIndex,
        codec: s.codec,
        language: s.language,
        forced: s.forced,
        hearingImpaired: s.hearingImpaired,
        isImageBased: s.isImageBased,
      })),
    };
  }

  /** Audio and subtitle streams of a file, for the sync modal's reference picker. */
  async detectStreams(videoPath: string): Promise<MediaStream[]> {
    const r = await this.softProbe(videoPath, {});
    if (!('info' in r)) return [];
    return [
      ...r.info.audio.map((s) => ({ ...s, type: 'audio' as const })),
      ...r.info.subtitles.map((s) => ({ ...s, type: 'subtitle' as const })),
    ]
      .sort((a, b) => a.streamIndex - b.streamIndex)
      .map((s) => ({
        streamIndex: s.streamIndex,
        type: s.type,
        codec: s.codec,
        language: s.language,
        title: s.title,
      }));
  }

  /** Throws when the engine is down: an import must not store an empty probe. */
  async detectMediaFileInfo(videoPath: string): Promise<MediaFileInfo> {
    const r = await this.probe(videoPath, { mkvTags: true });
    return 'info' in r
      ? r.info
      : { video: [], audio: [], subtitles: [], error: r.error };
  }

  /** Letterbox bars of the file's first video stream, null when there are none. */
  async detectCrop(videoPath: string): Promise<CropInfo | null> {
    const r = await this.softProbe(videoPath, { crop: true });
    return ('info' in r && r.info.video[0]?.crop) || null;
  }
}
