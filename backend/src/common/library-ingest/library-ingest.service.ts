import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { Media } from '../../modules/media/entities/media.entity';
import { MediaFile } from '../../modules/media/entities/media-file.entity';
import { Episode } from '../../modules/media/entities/episode.entity';
import { Season } from '../../modules/media/entities/season.entity';
import { MediaType } from '../enums';
import { relativePathUnderMediaRoot } from '../utils/media-path.util';
import { NamingService } from '../../modules/scheduler/naming.service';
import { PostImportQueueService } from '../post-import/post-import-queue.service';
import { FileTransferService, TransferMethod } from '../services/file-transfer.service';
import { FfprobeService } from '../../modules/subtitles/ffprobe.service';
import { EventsService } from '../../modules/scheduler/events.service';
import { qualityFromResolution } from '../release-parsing';
import { MediaService } from '../../modules/media/media.service';
import { PlaybackState } from '../../modules/streaming/entities/playback-state.entity';
import { resolveEdlPath } from '../../modules/streaming/edl/edl-sidecar';
import { SubtitlesService } from '../../modules/subtitles/subtitles.service';
import { SubtitleSyncService } from '../../modules/subtitles/subtitle-sync.service';

export interface IngestRequest {
  /** Media the file(s) belong to. Must already be anchored to a library
   *  (`library` + `folderName` persisted) — resolving/pinning that is the
   *  caller's job, since each caller picks its own library differently. */
  mediaId: number;
  /** `episodeId`: pre-resolved by the caller. `size`: last-resort size when
   *  the destination cannot be stat'ed. */
  files: { path: string; episodeId?: number; size?: number }[];
  transfer: TransferMethod;
  /** Quality used when the probe yields no usable dimensions. */
  fallbackQuality?: string;
  /** Release title — source tag of the derived quality and release group. */
  releaseName?: string;
  sourceLabel: string;
  /** Bypass collision detection and overwrite in place. */
  force?: boolean;
  /** Append " (n)" instead of silently skipping when the computed name collides. */
  uniquifyOnCollision?: boolean;
  /** A download supersedes what it covers: the previous file(s) of the movie, or of every
   *  episode the new files fully cover, are deleted. Disk import keeps versions side by side. */
  replaceExisting?: boolean;
}

export interface IngestResult {
  /** `sourcePath` echoes the request entry, so a caller can map a landed file
   *  back to what it knows about it — a skipped file leaves no entry. */
  imported: {
    file: MediaFile;
    episodeId?: number;
    seasonId?: number;
    sourcePath: string;
  }[];
  /** Files whose destination was already taken. A retried import is a no-op, and a caller that
   *  cannot tell that from "nothing could be placed" reports a success as a failure. */
  alreadyPresent: string[];
}

/**
 * Destination-path + filesystem-write + `MediaFile` persistence core shared
 * by every path that lands a file in a library. Extracted from disk import;
 * the media passed in must already be pinned to its library/folderName.
 */
@Injectable()
export class LibraryIngestService {
  private readonly logger = new Logger(LibraryIngestService.name);

  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(MediaFile)
    private readonly fileRepo: Repository<MediaFile>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(Season)
    private readonly seasonRepo: Repository<Season>,
    private readonly naming: NamingService,
    private readonly fileTransfer: FileTransferService,
    private readonly postImportQueue: PostImportQueueService,
    private readonly ffprobe: FfprobeService,
    private readonly events: EventsService,
    @Inject(forwardRef(() => MediaService))
    private readonly mediaService: MediaService,
    private readonly subtitles: SubtitlesService,
    private readonly subtitleSync: SubtitleSyncService,
  ) {}

  async ingest(req: IngestRequest): Promise<IngestResult> {
    const media = await this.mediaRepo.findOne({
      where: { id: req.mediaId },
      relations: ['library'],
    });
    if (!media) {
      throw new Error(`Media #${req.mediaId} not found`);
    }
    // `media.path` is a getter over library.path + folderName; both are the
    // caller's to set, and a null here would surface as a path.join TypeError.
    if (!media.path) {
      throw new Error(
        `Media #${req.mediaId} is not anchored to a library folder`,
      );
    }
    // A grab must never land loose files at the library root: `media.path`
    // falls back to it when `folderName` is empty.
    if (!media.folderName) {
      throw new Error(
        `Media #${req.mediaId} has no folder of its own, refusing to place files at the library root`,
      );
    }
    if (!req.files.length) return { imported: [], alreadyPresent: [] };

    // A series release carrying several video files is a season pack: every file
    // is its own episode. Anything else keeps only the largest file (samples,
    // proofs and extras ride along in the same folder). A single-file request is
    // unaffected either way.
    const isSeasonPack = media.type === MediaType.SERIES && req.files.length > 1;
    const files = isSeasonPack
      ? req.files
      : [req.files.reduce((a, b) => ((a.size ?? 0) > (b.size ?? 0) ? a : b))];
    if (isSeasonPack) {
      this.logger.log(
        `Ingest[${req.sourceLabel}]: season pack — ${files.length} episode(s) to import`,
      );
    }

    const formats = await this.naming.getFormats();
    const companionExts = await this.fileTransfer.getCompanionExts();
    const releaseGroup = req.releaseName
      ? this.naming.extractReleaseGroup(req.releaseName)
      : undefined;

    const alreadyPresent: string[] = [];
    const imported: (IngestResult['imported'][number] & {
      destPath: string;
      seasonNumber?: number;
      episodeNumber?: number;
      episodeEnd?: number;
    })[] = [];

    for (const file of files) {
      const ext = path.extname(file.path);
      const sourceBase = path.basename(file.path, ext);

      let episodeId: number | undefined;
      let seasonId: number | undefined;
      let seasonNumber: number | undefined;
      let episodeNumber: number | undefined;
      let episodeTitle: string | undefined;
      let airDate: string | undefined;
      let episodeEnd: number | undefined;

      if (media.type !== MediaType.MOVIE) {
        const epNums =
          this.naming.parseEpisodeNumbers(sourceBase, file.path) ??
          (req.releaseName ? this.naming.parseEpisodeNumbers(req.releaseName) : null);
        seasonNumber = epNums?.season;
        episodeNumber = epNums?.episode;
        episodeEnd = epNums?.episodeEnd;

        // The caller's episode is authoritative only if it belongs to this media.
        const ep =
          file.episodeId != null
            ? await this.episodeRepo.findOne({
                where: { id: file.episodeId, season: { media: { id: media.id } } },
                relations: ['season'],
              })
            : null;
        if (file.episodeId != null && !ep) {
          this.logger.warn(
            `Ingest[${req.sourceLabel}]: episode #${file.episodeId} does not belong to media #${media.id}, falling back to filename parsing`,
          );
        }
        if (ep) {
          episodeId = ep.id;
          episodeNumber = ep.episodeNumber;
          seasonNumber = ep.season?.seasonNumber ?? 1;
          seasonId = ep.season?.id;
          episodeTitle = ep.title ?? undefined;
          airDate = ep.airDate ?? undefined;
        } else if (epNums) {
          const season = await this.seasonRepo.findOne({
            where: { media: { id: media.id }, seasonNumber: epNums.season },
          });
          if (season) {
            seasonId = season.id;
            const episode = await this.episodeRepo.findOne({
              where: { season: { id: season.id }, episodeNumber: epNums.episode },
            });
            if (episode) {
              episodeId = episode.id;
              episodeTitle = episode.title ?? undefined;
              airDate = episode.airDate ?? undefined;
              if (
                epNums.episodeEnd != null &&
                episode.endEpisodeNumber !== epNums.episodeEnd
              ) {
                episode.endEpisodeNumber = epNums.episodeEnd;
                await this.episodeRepo.save(episode);
              }
            }
          }
        } else {
          // No numbering at all: the name may still carry a special's title, which is the
          // only thing a special is identifiable by. No title match means no link.
          const season = await this.seasonRepo.findOne({
            where: { media: { id: media.id }, seasonNumber: 0 },
            relations: ['episodes'],
          });
          const episode = this.naming.matchSpecialByTitle(
            sourceBase,
            season?.episodes ?? [],
          );
          if (season && episode) {
            seasonId = season.id;
            seasonNumber = 0;
            episodeNumber = episode.episodeNumber;
            episodeId = episode.id;
            episodeTitle = episode.title ?? undefined;
            airDate = episode.airDate ?? undefined;
            this.logger.log(
              `Ingest[${req.sourceLabel}]: "${sourceBase}" → special S00E${String(episode.episodeNumber).padStart(2, '0')} "${episode.title ?? ''}" matched by title`,
            );
          }
        }
        if (isSeasonPack) {
          this.logger.log(
            `Ingest[${req.sourceLabel}]: "${sourceBase}" → ${epNums ? `S${String(epNums.season).padStart(2, '0')}E${String(epNums.episode).padStart(2, '0')}` : 'no episode parsed'}`,
          );
        }
      }

      // Derive quality from the real pixels, not the (sometimes mislabeled)
      // release name: a torrent tagged "2160p" that is actually 1920×804 must
      // be named + tracked as 1080p. The source tag still comes from the
      // release name. Falls back to the caller's quality when probing yields
      // no dimensions.
      const streamInfo = await this.ffprobe.detectMediaFileInfo(file.path);
      const srcVideo = streamInfo?.video?.[0];
      const quality =
        srcVideo?.width && srcVideo?.height
          ? qualityFromResolution(
              req.releaseName ?? path.basename(file.path),
              srcVideo.width,
              srcVideo.height,
            )
          : (req.fallbackQuality ?? '');

      let newBaseName: string;
      let destDir: string;

      if (media.type === MediaType.MOVIE) {
        newBaseName = this.naming.applyMovieFormat(formats.movie, {
          title: media.title,
          originalTitle: media.originalTitle,
          year: media.year,
          quality,
          releaseGroup,
          tmdbId: media.tmdbId,
        });
        destDir = media.path!;
      } else {
        newBaseName = this.naming.applySeriesFormat(formats.series, {
          seriesTitle: media.title,
          season: seasonNumber ?? 1,
          episode: episodeNumber ?? 1,
          episodeTitle,
          quality,
          releaseGroup,
          airDate,
        });
        const seasonFolder = this.naming.applySeasonFolderFormat(
          formats.seasonFolder,
          { season: seasonNumber ?? 1 },
        );
        destDir = path.join(media.path!, seasonFolder);
      }

      let destPath = path.join(destDir, newBaseName + ext);

      // `relativePath` is stored relative to the MEDIA root (library.path +
      // folderName) — matches how the grab/rescan paths store it.
      let relativePath = relativePathUnderMediaRoot(media.path!, destPath);
      if (!relativePath) {
        this.logger.error(
          `Ingest[${req.sourceLabel}]: computed dest outside media folder — root=${media.path!} dest=${destPath}`,
        );
        continue;
      }

      const collides = async (rel: string, abs: string) =>
        fs.existsSync(abs) ||
        !!(await this.fileRepo.findOne({
          where: { media: { id: media.id }, relativePath: rel },
        }));

      let sourceSize = 0;
      try {
        sourceSize = fs.statSync(file.path).size;
      } catch {
        // Caller already verified the source exists; best-effort fallback only.
      }

      // A replacing import overwrites a same-named file (repack, proper) unless it is the very
      // same bytes, which is a retried call and must stay a no-op.
      const overwrite =
        req.force ||
        (req.replaceExisting && !this.sameSize(destPath, sourceSize));
      if (!overwrite && (await collides(relativePath, destPath))) {
        if (!req.uniquifyOnCollision) {
          // Re-running the same import is a safe no-op — reported, not silent.
          alreadyPresent.push(file.path);
          continue;
        }
        // A different file maps to a name already taken by this media (e.g.
        // a second copy of the same quality). Append " (n)" instead of
        // silently skipping it.
        let n = 2;
        let base: string;
        let rel: string | null;
        do {
          base = `${newBaseName} (${n})`;
          destPath = path.join(destDir, base + ext);
          rel = relativePathUnderMediaRoot(media.path!, destPath);
          n++;
        } while (rel && (await collides(rel, destPath)) && n < 100);
        if (!rel) continue;
        newBaseName = base;
        relativePath = rel;
      }

      this.logger.log(
        `Ingest[${req.sourceLabel}]: ${req.transfer} "${path.basename(file.path)}" → "${destPath}"`,
      );
      await this.fileTransfer.transferFile(file.path, destPath, req.transfer);
      // An EDL belongs to one encode: a replaced file must not keep the old one.
      if (overwrite || req.replaceExisting) {
        try {
          const stale = await resolveEdlPath(destPath);
          if (stale) await fs.promises.rm(stale, { force: true });
        } catch (err) {
          this.logger.warn(`Ingest[${req.sourceLabel}]: could not remove stale EDL: ${(err as Error).message}`);
        }
      }
      await this.fileTransfer.transferCompanions({
        srcDir: path.dirname(file.path),
        destDir,
        sourceBaseName: sourceBase,
        newBaseName,
        method: req.transfer,
        allowedExts: companionExts,
        logTag: `library-ingest:${req.sourceLabel}`,
      });

      const finalSize = (() => {
        try {
          return fs.statSync(destPath).size;
        } catch {
          return file.size ?? sourceSize;
        }
      })();

      const payload = {
        episode: episodeId != null ? ({ id: episodeId } as Episode) : null,
        size: finalSize,
        quality,
        ...(streamInfo ? { streamInfo } : {}),
      };

      // An overwrite skips the collision check above, so a re-import over an
      // already-tracked path must update that row instead of inserting a dupe.
      const existingFile = await this.fileRepo.findOne({
        where: { media: { id: media.id }, relativePath },
      });
      const saved = existingFile
        ? await this.fileRepo.save(Object.assign(existingFile, payload))
        : await this.fileRepo.save(
            this.fileRepo.create({ media, relativePath, ...payload }),
          );

      if (episodeId != null) {
        await this.episodeRepo.update(episodeId, { hasFile: true });
      }

      imported.push({
        file: saved,
        episodeId,
        seasonId,
        sourcePath: file.path,
        destPath,
        seasonNumber,
        episodeNumber,
        episodeEnd,
      });
    }

    if (req.replaceExisting && imported.length > 0) {
      await this.removeSuperseded(media, imported, req.sourceLabel);
    }

    if (imported.length > 0) {
      const single = imported.length === 1 ? imported[0] : undefined;
      this.events.emitDomain({
        type: 'media.files.imported',
        mediaId: media.id,
        ...(single?.seasonNumber != null
          ? { seasonNumber: single.seasonNumber }
          : {}),
        ...(single?.episodeNumber != null
          ? { episodeNumber: single.episodeNumber }
          : {}),
        source: req.releaseName ? 'download' : 'disk',
      });
    }

    // Serialised on the shared post-import queue so a season pack can't
    // pile up ffmpeg processes.
    for (const { file } of imported) {
      this.postImportQueue.enqueue({ mediaFileId: file.id });
    }

    return {
      imported: imported.map(({ file, episodeId, seasonId, sourcePath }) => ({
        file,
        episodeId,
        seasonId,
        sourcePath,
      })),
      alreadyPresent,
    };
  }

  private sameSize(destPath: string, size: number): boolean {
    try {
      return fs.statSync(destPath).size === size;
    } catch {
      return false;
    }
  }

  /** Deletes the files the new ones supersede, keeping every user's progress by moving
   *  their playback rows onto the replacement first (the FK cascades otherwise). */
  private async removeSuperseded(
    media: Media,
    imported: {
      file: MediaFile;
      episodeId?: number;
      seasonNumber?: number;
      episodeNumber?: number;
      episodeEnd?: number;
    }[],
    label: string,
  ): Promise<void> {
    const newIds = imported.map((i) => i.file.id);
    const others = await this.fileRepo.find({
      where: { media: { id: media.id }, id: Not(In(newIds)) },
      relations: ['episode', 'episode.season'],
    });
    if (!others.length) return;

    const key = (s: number, e: number) => `${s}:${e}`;
    const range = (s: number, from: number, to?: number | null) =>
      Array.from({ length: Math.max(to ?? from, from) - from + 1 }, (_, i) =>
        key(s, from + i),
      );
    const covered = new Set(
      imported.flatMap((i) =>
        i.seasonNumber != null && i.episodeNumber != null
          ? range(i.seasonNumber, i.episodeNumber, i.episodeEnd)
          : [],
      ),
    );

    const playback = this.fileRepo.manager.getRepository(PlaybackState);
    const carried: number[] = [];
    for (const old of others) {
      // A subtitle follows its video only onto a file covering exactly the same episode.
      let heir: MediaFile | undefined = imported[0].file;
      if (media.type !== MediaType.MOVIE) {
        const ep = old.episode;
        const season = ep?.season?.seasonNumber;
        if (!ep || season == null) continue;
        const span = range(season, ep.episodeNumber, ep.endEpisodeNumber);
        if (!span.every((k) => covered.has(k))) continue;
        heir =
          span.length === 1
            ? imported.find((i) => i.episodeId === ep.id && i.episodeEnd == null)?.file
            : undefined;
      }

      try {
        if (heir) {
          carried.push(...(await this.subtitles.carryOver(media.id, old.id, heir)));
        }
        if (media.type === MediaType.MOVIE) {
          await playback
            .createQueryBuilder()
            .update()
            .set({ mediaFile: { id: newIds[0] } })
            .where('"mediaFileId" = :old', { old: old.id })
            .execute();
        } else {
          for (const i of imported) {
            if (i.episodeId == null) continue;
            await playback
              .createQueryBuilder()
              .update()
              .set({ mediaFile: { id: i.file.id } })
              .where('"mediaFileId" = :old AND "episodeId" = :ep', {
                old: old.id,
                ep: i.episodeId,
              })
              .execute();
          }
        }
        await this.mediaService.deleteMediaFile(media.id, old.id, true);
        this.logger.log(
          `Ingest[${label}]: replaced "${old.relativePath}" (superseded by this import)`,
        );
      } catch (err) {
        this.logger.warn(
          `Ingest[${label}]: could not remove superseded "${old.relativePath}": ${(err as Error).message}`,
        );
        continue;
      }

      // The owner keeps a multi-episode range only while a file still spans it.
      const owner = old.episode;
      if (owner?.endEpisodeNumber != null) {
        const spans = imported.some(
          (i) => i.episodeId === owner.id && i.episodeEnd != null,
        );
        if (!spans) {
          await this.episodeRepo.update(owner.id, { endEpisodeNumber: null });
        }
      }
    }

    // Another release of the same content is usually offset or at another frame rate.
    // Sequential and detached: each sync runs ffmpeg + ffsubsync over the whole file.
    void (async () => {
      for (const id of carried) {
        await this.subtitleSync
          .syncSubtitle(id, { automatic: true })
          .catch((err: Error) =>
            this.logger.warn(`Ingest[${label}]: resync of subtitle #${id} failed, kept as is: ${err.message}`),
          );
      }
    })();
  }
}
