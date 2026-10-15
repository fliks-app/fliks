import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import * as path from 'path';
import { Episode } from '../media/entities/episode.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { Media } from '../media/entities/media.entity';
import { Season } from '../media/entities/season.entity';
import { EpisodeMarker } from './entities/episode-marker.entity';
import { SettingsService } from '../settings/settings.service';
import {
  EngineService,
  type Fingerprint,
  type IntroDetectRequest,
  type JobPriority,
} from '../engine/engine.service';

/** Fingerprint jobs in flight at once; the engine queues them behind its own slot budget. */
const FINGERPRINT_CONCURRENCY = 4;

const DEFAULT_MAX_LOOKUP_MINUTES = 10;
const DEFAULT_MIN_SEGMENT_SECONDS = 15;

type MarkerKind = 'intro' | 'outro';

interface FingerprintedEpisode {
  episode: Episode;
  file: MediaFile;
  fingerprint: Fingerprint;
}

@Injectable()
export class IntroDetectionService {
  private readonly log = new Logger(IntroDetectionService.name);

  constructor(
    @InjectRepository(EpisodeMarker)
    private readonly markerRepo: Repository<EpisodeMarker>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    @InjectRepository(Season)
    private readonly seasonRepo: Repository<Season>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    private readonly settings: SettingsService,
    private readonly engine: EngineService,
  ) {}

  async detectSeasonIntros(
    seasonId: number,
    onProgress?: (current: number, total: number, message: string) => void,
    priority: JobPriority = 'low',
  ): Promise<{ introsDetected: number; skipped: number }> {
    if (!this.engine.engineFeatures.includes('intro-detect')) {
      throw new Error('The engine has no intro-detect feature');
    }

    const t0 = Date.now();
    const season = await this.seasonRepo.findOne({ where: { id: seasonId } });
    if (!season) throw new Error(`Season #${seasonId} not found`);

    const media = await this.mediaRepo.findOne({
      where: { id: season.mediaId },
    });
    if (!media?.path) {
      this.log.warn(`Skip season #${seasonId}: parent media has no path`);
      return { introsDetected: 0, skipped: 0 };
    }
    const mediaPath: string = media.path;

    const episodes = await this.episodeRepo.find({
      where: { season: { id: seasonId }, hasFile: true },
      order: { episodeNumber: 'ASC' },
    });
    this.log.log(
      `▶ Intro detection START — "${media.title}" S${String(season.seasonNumber).padStart(2, '0')} (season #${seasonId}): ${episodes.length} episode(s) with file`,
    );
    if (episodes.length < 2) {
      this.log.log(
        `Season #${seasonId}: only ${episodes.length} episode(s) with files — need ≥ 2, skipping detection`,
      );
      return { introsDetected: 0, skipped: episodes.length };
    }

    const fileByEpisode = await this.latestFileByEpisode(episodes);
    const lookupSec = await this.lookupSeconds();
    const minSegmentSec = await this.minSegmentSeconds();
    this.log.log(
      `Season #${seasonId}: scanning first ${lookupSec / 60} min of audio per episode, min segment ${minSegmentSec}s`,
    );

    const manualIds = await this.manualMarkerEpisodeIds(
      episodes.map((e) => e.id),
      'intro',
    );

    const fingerprinted = await this.fingerprintEpisodes({
      episodes,
      mediaPath,
      fileByEpisode,
      manualIds,
      lookupSec,
      outro: false,
      priority,
      onProgress,
      progressLabel: 'Fingerprinting',
    });

    const { detected, resultFileIds } = await this.runIntroDetect({
      kind: 'intro',
      fingerprinted,
      lookupSec,
      minSegmentSec,
      fingerprintKey: 'introFingerprint',
    });

    const skipped = this.countSkipped(
      episodes,
      fileByEpisode,
      manualIds,
      resultFileIds,
      (file) => true,
    );

    onProgress?.(
      episodes.length,
      episodes.length,
      `Detection complete: ${detected} intro(s)`,
    );
    this.log.log(
      `■ Intro detection END — "${media.title}" S${String(season.seasonNumber).padStart(2, '0')} (season #${seasonId}): ${detected} intro(s) saved, ${skipped} skipped in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    return { introsDetected: detected, skipped };
  }

  async detectSeasonOutros(
    seasonId: number,
    onProgress?: (current: number, total: number, message: string) => void,
    priority: JobPriority = 'low',
  ): Promise<{ outrosDetected: number; skipped: number }> {
    if (!this.engine.engineFeatures.includes('intro-detect')) {
      throw new Error('The engine has no intro-detect feature');
    }

    const t0 = Date.now();
    const season = await this.seasonRepo.findOne({ where: { id: seasonId } });
    if (!season) throw new Error(`Season #${seasonId} not found`);
    const media = await this.mediaRepo.findOne({
      where: { id: season.mediaId },
    });
    if (!media?.path) return { outrosDetected: 0, skipped: 0 };
    const mediaPath: string = media.path;

    const episodes = await this.episodeRepo.find({
      where: { season: { id: seasonId }, hasFile: true },
      order: { episodeNumber: 'ASC' },
    });
    if (!episodes.length) return { outrosDetected: 0, skipped: 0 };

    this.log.log(
      `▶ Outro detection START — "${media.title}" S${String(season.seasonNumber).padStart(2, '0')} (season #${seasonId}): ${episodes.length} episode(s)`,
    );

    const fileByEpisode = await this.latestFileByEpisode(episodes);
    const lookupSec = await this.lookupSeconds();
    const minSegmentSec = await this.minSegmentSeconds();

    const manualIds = await this.manualMarkerEpisodeIds(
      episodes.map((e) => e.id),
      'outro',
    );

    const fingerprinted = await this.fingerprintEpisodes({
      episodes,
      mediaPath,
      fileByEpisode,
      manualIds,
      lookupSec,
      outro: true,
      priority,
      onProgress,
      progressLabel: 'Outro fingerprinting',
    });

    const { detected, resultFileIds } = await this.runIntroDetect({
      kind: 'outro',
      fingerprinted,
      lookupSec,
      minSegmentSec,
      fingerprintKey: 'outroFingerprint',
    });

    const skipped = this.countSkipped(
      episodes,
      fileByEpisode,
      manualIds,
      resultFileIds,
      (file) => (file.streamInfo?.durationSeconds ?? 0) > 0,
    );

    this.log.log(
      `■ Outro detection END — "${media.title}" S${String(season.seasonNumber).padStart(2, '0')}: ${detected} outro(s) saved, ${skipped} skipped (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
    return { outrosDetected: detected, skipped };
  }

  private async latestFileByEpisode(
    episodes: Episode[],
  ): Promise<Map<number, MediaFile>> {
    const files = await this.mediaFileRepo.find({
      where: { episode: { id: In(episodes.map((e) => e.id)) } },
      order: { id: 'DESC' },
    });
    const fileByEpisode = new Map<number, MediaFile>();
    for (const f of files) {
      if (!fileByEpisode.has(f.episodeId)) fileByEpisode.set(f.episodeId, f);
    }
    return fileByEpisode;
  }

  private async lookupSeconds(): Promise<number> {
    const lookupMin =
      Number(await this.settings.get('introMaxLookupMinutes')) ||
      DEFAULT_MAX_LOOKUP_MINUTES;
    return lookupMin * 60;
  }

  private async minSegmentSeconds(): Promise<number> {
    return (
      Number(await this.settings.get('introMinSegmentSeconds')) ||
      DEFAULT_MIN_SEGMENT_SECONDS
    );
  }

  private async manualMarkerEpisodeIds(
    episodeIds: number[],
    type: MarkerKind,
  ): Promise<Set<number>> {
    const existingManual = await this.markerRepo.find({
      where: {
        episode: { id: In(episodeIds) },
        type,
        manual: true,
      },
    });
    return new Set(existingManual.map((m) => m.episodeId));
  }

  private async fingerprintEpisodes(opts: {
    episodes: Episode[];
    mediaPath: string;
    fileByEpisode: Map<number, MediaFile>;
    manualIds: Set<number>;
    lookupSec: number;
    outro: boolean;
    priority: JobPriority;
    onProgress?: (current: number, total: number, message: string) => void;
    progressLabel: string;
  }): Promise<FingerprintedEpisode[]> {
    const targets = opts.episodes.filter((ep) => {
      if (opts.manualIds.has(ep.id)) return false;
      const file = opts.fileByEpisode.get(ep.id);
      if (!file) return false;
      if (opts.outro && (file.streamInfo?.durationSeconds ?? 0) <= 0) {
        return false;
      }
      return true;
    });

    const fingerprinted: FingerprintedEpisode[] = [];
    let processed = 0;
    opts.onProgress?.(0, targets.length, `${opts.progressLabel} 0/${targets.length}`);

    for (let i = 0; i < targets.length; i += FINGERPRINT_CONCURRENCY) {
      const slice = targets.slice(i, i + FINGERPRINT_CONCURRENCY);
      await Promise.all(
        slice.map(async (ep) => {
          const file = opts.fileByEpisode.get(ep.id)!;
          const abs = path.resolve(opts.mediaPath, file.relativePath);
          const dur = file.streamInfo?.durationSeconds ?? 0;
          const epT0 = Date.now();
          try {
            const fp = await this.fingerprint(
              file.id,
              abs,
              opts.lookupSec,
              opts.outro ? dur : null,
              opts.priority,
            );
            fingerprinted.push({ episode: ep, file, fingerprint: fp });
            this.log.log(
              `  ✓ E${ep.episodeNumber}${opts.outro ? ' outro' : ''} fingerprinted in ${((Date.now() - epT0) / 1000).toFixed(1)}s (${fp.hashes.length} hashes)`,
            );
          } catch (err) {
            this.log.warn(
              `  ✗ E${ep.episodeNumber} fingerprint failed (${abs}): ${(err as Error).message}`,
            );
          }
          processed++;
          opts.onProgress?.(
            processed,
            targets.length,
            `${opts.progressLabel} ${processed}/${targets.length}`,
          );
        }),
      );
    }

    fingerprinted.sort(
      (a, b) => a.episode.episodeNumber - b.episode.episodeNumber,
    );
    return fingerprinted;
  }

  private async runIntroDetect(opts: {
    kind: MarkerKind;
    fingerprinted: FingerprintedEpisode[];
    lookupSec: number;
    minSegmentSec: number;
    fingerprintKey: 'introFingerprint' | 'outroFingerprint';
  }): Promise<{ detected: number; resultFileIds: Set<number> }> {
    const resultFileIds = new Set<number>();
    if (!opts.fingerprinted.length) {
      return { detected: 0, resultFileIds };
    }

    const episodes: IntroDetectRequest['episodes'] = opts.fingerprinted.map(
      ({ file, fingerprint }) => {
        const row: IntroDetectRequest['episodes'][number] = {
          mediaFileId: file.id,
          durationSeconds: file.streamInfo?.durationSeconds ?? 0,
          chapters: file.streamInfo?.chapters ?? undefined,
          [opts.fingerprintKey]: fingerprint,
        };
        return row;
      },
    );

    const { results } = await this.engine.introDetect({
      kind: opts.kind,
      lookupSeconds: opts.lookupSec,
      minSegmentSeconds: opts.minSegmentSec,
      episodes,
    });

    const fileToEpisode = new Map(
      opts.fingerprinted.map(({ file, episode }) => [file.id, episode]),
    );

    for (const segment of results) {
      resultFileIds.add(segment.mediaFileId);
      const ep = fileToEpisode.get(segment.mediaFileId);
      if (!ep) continue;

      await this.markerRepo.delete({
        episode: { id: ep.id },
        type: opts.kind,
        manual: false,
      });
      await this.markerRepo.save({
        episode: { id: ep.id },
        type: opts.kind,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        confidence: segment.confidence,
        manual: false,
      } as Partial<EpisodeMarker>);

      this.log.log(
        `  E${ep.episodeNumber}: ${opts.kind} ${segment.startSeconds.toFixed(1)}s–${segment.endSeconds.toFixed(1)}s (conf=${segment.confidence.toFixed(2)}, source=${segment.source})`,
      );
    }

    return { detected: results.length, resultFileIds };
  }

  private countSkipped(
    episodes: Episode[],
    fileByEpisode: Map<number, MediaFile>,
    manualIds: Set<number>,
    resultFileIds: Set<number>,
    eligible: (file: MediaFile) => boolean,
  ): number {
    let skipped = 0;
    for (const ep of episodes) {
      if (manualIds.has(ep.id)) continue;
      const file = fileByEpisode.get(ep.id);
      if (!file || !eligible(file)) continue;
      if (!resultFileIds.has(file.id)) skipped++;
    }
    return skipped;
  }

  private async fingerprint(
    mediaFileId: number,
    absPath: string,
    lookupSec: number,
    outroOfSeconds: number | null,
    priority: JobPriority,
  ): Promise<Fingerprint> {
    const { fingerprint } = await this.engine.runJob({
      kind: {
        type: 'Fingerprint',
        window:
          outroOfSeconds == null
            ? { type: 'head' }
            : { type: 'outro', durationSeconds: outroOfSeconds },
        maxLookupMinutes: lookupSec / 60,
      },
      media: { mediaFileId, path: absPath },
      priority,
    });
    return { ...fingerprint, baseOffsetSec: fingerprint.baseOffsetSec ?? 0 };
  }
}
