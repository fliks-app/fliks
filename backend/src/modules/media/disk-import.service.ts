import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { relativePathUnderMediaRoot } from '../../common/utils/media-path.util';
import { Media } from './entities/media.entity';
import { MediaFile } from './entities/media-file.entity';
import { Season } from './entities/season.entity';
import { Episode } from './entities/episode.entity';
import { RootFolder } from '../root-folders/entities/root-folder.entity';
import { parseReleaseQuality } from './release-quality.parser';
import { ImportFileEntry } from './dto/confirm-disk-import.dto';

const VIDEO_EXTS = new Set([
  '.mkv',
  '.mp4',
  '.avi',
  '.mov',
  '.ts',
  '.m2ts',
  '.wmv',
  '.flv',
]);

export interface ScanCandidate {
  filePath: string;
  filename: string;
  size: number;
  qualityName: string;
  qualityId: number;
  seasonNumber: number | null;
  episodeNumber: number | null;
  mediaId: number | null;
  mediaTitle: string | null;
  mediaYear: number | null;
  mediaType: string | null;
  episodeId: number | null;
  episodeTitle: string | null;
  existingQuality: string | null;
}

@Injectable()
export class DiskImportService {
  private readonly logger = new Logger(DiskImportService.name);

  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(MediaFile)
    private readonly fileRepo: Repository<MediaFile>,
    @InjectRepository(Season)
    private readonly seasonRepo: Repository<Season>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(RootFolder)
    private readonly rootFolderRepo: Repository<RootFolder>,
  ) {}

  async scanFolder(folderPath: string): Promise<ScanCandidate[]> {
    const resolved = path.resolve(folderPath);
    this.logger.log(`Disk library scan started — folder="${resolved}"`);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new BadRequestException(
        `Path "${resolved}" does not exist or is not accessible`,
      );
    }
    if (!stat.isDirectory()) {
      throw new BadRequestException(`Path "${resolved}" is not a directory`);
    }

    const videoFiles = this.collectVideoFiles(resolved, 0);
    if (!videoFiles.length) return [];

    const allMedia = await this.mediaRepo.find({
      select: ['id', 'title', 'originalTitle', 'year', 'type'],
    });

    return Promise.all(videoFiles.map((f) => this.buildCandidate(f, allMedia)));
  }

  async confirmImport(
    imports: ImportFileEntry[],
  ): Promise<{ imported: number; errors: string[] }> {
    let imported = 0;
    const errors: string[] = [];

    for (const entry of imports) {
      try {
        const media = await this.mediaRepo.findOne({
          where: { id: entry.mediaId },
        });
        if (!media) {
          errors.push(`Media #${entry.mediaId} not found`);
          continue;
        }

        let fileSize = 0;
        try {
          fileSize = fs.statSync(entry.filePath).size;
        } catch {
          /* use 0 if file disappeared */
        }

        // Ensure media.rootFolderId and folderName are set
        if (!media.rootFolderId) {
          const dir = path.dirname(entry.filePath);
          const rootFolders = await this.rootFolderRepo.find();
          const rf = rootFolders
            .filter((r) => dir.startsWith(r.path))
            .sort((a, b) => b.path.length - a.path.length)[0];
          if (rf) {
            const remainder = dir
              .slice(rf.path.length)
              .replace(/^\/+/, '')
              .split('/')[0];
            const folderName = remainder || path.basename(dir);
            await this.mediaRepo.update(media.id, {
              rootFolderId: rf.id,
              folderName,
            });
            media.rootFolderId = rf.id;
            media.rootFolder = rf;
            media.folderName = folderName;
          }
        } else if (!media.folderName) {
          const dir = path.dirname(entry.filePath);
          const folderName = media.rootFolder
            ? dir
                .slice(media.rootFolder.path.length)
                .replace(/^\/+/, '')
                .split('/')[0]
            : path.basename(dir);
          if (folderName) {
            await this.mediaRepo.update(media.id, { folderName });
            media.folderName = folderName;
          }
        }

        if (!media.path) continue; // Skip if we can't compute a path
        const relativePath = relativePathUnderMediaRoot(media.path, entry.filePath);
        if (!relativePath) {
          this.logger.error(
            `Disk import: file outside media folder — mediaId=${media.id} mediaPath=${media.path} filePath=${entry.filePath}`,
          );
          errors.push(
            `${path.basename(entry.filePath)}: fichier en dehors du dossier média (vérifiez le dossier racine)`,
          );
          continue;
        }

        // Avoid duplicate path
        const existing = await this.fileRepo.findOne({
          where: { mediaId: media.id, relativePath },
        });
        if (existing) continue;

        // Block import if a file of equivalent or better quality already exists
        if (!entry.force) {
          const candidateQuality = parseReleaseQuality(entry.quality);
          const candidateRank = candidateQuality.quality.rank;
          const where: Record<string, unknown> = { mediaId: media.id };
          if (entry.episodeId) where['episodeId'] = entry.episodeId;
          const existingFiles = await this.fileRepo.find({ where });
          const hasBetterOrEqual = existingFiles.some((ef) => {
            const parsed = parseReleaseQuality(ef.quality);
            return parsed.quality.rank >= candidateRank;
          });
          if (hasBetterOrEqual) {
            errors.push(
              `${path.basename(entry.filePath)}: qualité équivalente ou supérieure déjà présente`,
            );
            continue;
          }
        }

        await this.fileRepo.save(
          this.fileRepo.create({
            mediaId: media.id,
            episodeId: entry.episodeId ?? undefined,
            relativePath,
            size: fileSize,
            quality: entry.quality,
          }),
        );

        // Mark episode as having a file
        if (entry.episodeId) {
          await this.episodeRepo.update(entry.episodeId, { hasFile: true });
        }

        imported++;
      } catch (e) {
        errors.push(
          `${path.basename(entry.filePath)}: ${(e as Error).message}`,
        );
      }
    }

    return { imported, errors };
  }

  // ---------------------------------------------------------------------------

  private collectVideoFiles(dir: string, depth: number): string[] {
    if (depth > 3) return [];
    const files: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.collectVideoFiles(fullPath, depth + 1));
      } else if (VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
    return files;
  }

  private async buildCandidate(
    filePath: string,
    allMedia: Pick<Media, 'id' | 'title' | 'originalTitle' | 'year' | 'type'>[],
  ): Promise<ScanCandidate> {
    const filename = path.basename(filePath);
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      /* ignore */
    }

    const { quality } = parseReleaseQuality(filename);
    const epNums = this.parseEpisodeNumbers(filename);
    const extractedTitle = this.extractTitle(filename);
    const matched = this.matchMedia(extractedTitle, allMedia);

    let episodeId: number | null = null;
    let episodeTitle: string | null = null;

    if (matched?.type === 'series' && epNums) {
      let season = await this.seasonRepo.findOne({
        where: { mediaId: matched.id, seasonNumber: epNums.season },
      });
      if (!season) {
        season = await this.seasonRepo.save(
          this.seasonRepo.create({
            mediaId: matched.id,
            seasonNumber: epNums.season,
            monitored: true,
          }),
        );
      }
      let ep = await this.episodeRepo.findOne({
        where: { seasonId: season.id, episodeNumber: epNums.episode },
      });
      if (!ep) {
        ep = await this.episodeRepo.save(
          this.episodeRepo.create({
            seasonId: season.id,
            episodeNumber: epNums.episode,
            monitored: true,
          }),
        );
      }
      episodeId = ep.id;
      episodeTitle = ep.title ?? null;
    }

    // Check if a file of equivalent or better quality already exists
    let existingQuality: string | null = null;
    if (matched) {
      const where: Record<string, unknown> = { mediaId: matched.id };
      if (episodeId) where['episodeId'] = episodeId;
      const existingFiles = await this.fileRepo.find({ where });
      const candidateRank = quality.rank;
      for (const ef of existingFiles) {
        const parsed = parseReleaseQuality(ef.quality);
        if (parsed.quality.rank >= candidateRank) {
          existingQuality = ef.quality;
          break;
        }
      }
    }

    return {
      filePath,
      filename,
      size,
      qualityName: quality.name,
      qualityId: quality.id,
      seasonNumber: epNums?.season ?? null,
      episodeNumber: epNums?.episode ?? null,
      mediaId: matched?.id ?? null,
      mediaTitle: matched?.title ?? null,
      mediaYear: matched?.year ?? null,
      mediaType: matched?.type ?? null,
      episodeId,
      episodeTitle,
      existingQuality,
    };
  }

  private extractTitle(filename: string): string {
    let name = path.basename(filename, path.extname(filename));
    name = name.replace(/[._]/g, ' ');
    // Cut off at quality markers or episode pattern
    name = name.replace(/\s*\b(2160|4k|uhd|1080|720|480p?)\b.*/i, '');
    name = name.replace(
      /\s*\b(bluray|blu.?ray|web.?dl|web.?rip|hdtv|dvdrip|bdrip|remux)\b.*/i,
      '',
    );
    name = name.replace(/\s*\b(x264|x265|xvid|h264|h265|hevc|avc)\b.*/i, '');
    name = name.replace(/\s*[Ss]\d{1,2}[Ee]\d{1,3}.*/i, '');
    // Remove trailing year
    name = name.replace(/\s*[\[(]?\d{4}[\])]?\s*$/, '');
    return name.trim().toLowerCase();
  }

  private matchMedia(
    extractedTitle: string,
    allMedia: Pick<Media, 'id' | 'title' | 'originalTitle' | 'year' | 'type'>[],
  ): Pick<Media, 'id' | 'title' | 'originalTitle' | 'year' | 'type'> | null {
    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const target = norm(extractedTitle);
    if (!target) return null;

    // Exact match
    let match = allMedia.find(
      (m) => norm(m.title) === target || norm(m.originalTitle ?? '') === target,
    );
    if (match) return match;

    // Target starts with media title (e.g. "inception 2010" → "inception")
    match = allMedia.find((m) => {
      const mt = norm(m.title);
      return mt.length >= 2 && target.startsWith(mt);
    });
    if (match) return match;

    // Media title starts with target
    match = allMedia.find((m) => {
      const mt = norm(m.title);
      return mt.length >= 3 && mt.startsWith(target);
    });
    return match ?? null;
  }

  private parseEpisodeNumbers(
    filename: string,
  ): { season: number; episode: number } | null {
    const m = filename.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
    if (!m) return null;
    return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  }
}
