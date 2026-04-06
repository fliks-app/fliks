import * as path from 'path';
import { Repository } from 'typeorm';
import { readdir } from 'fs/promises';
import { RootFolder } from '../../root-folders/entities/root-folder.entity';
import { SubtitleFile } from '../../subtitles/entities/subtitle-file.entity';
import { SubtitleProviderType, SubtitleStatus } from '../../../common/enums';

// ---------------------------------------------------------------------------
// Root folders (Radarr / Sonarr API reconcile)
// ---------------------------------------------------------------------------

/** Insert missing root folders by path (same behavior as Radarr/Sonarr API reconcile). */
export async function ensureRootFolderPathsExist(
  repo: Repository<RootFolder>,
  paths: string[],
  createdOut: string[],
): Promise<void> {
  const existing = await repo.find();
  const existingPaths = new Set(
    existing.map((f) => f.path.replace(/\/+$/, '')),
  );
  for (const raw of paths) {
    if (!raw?.trim()) continue;
    const normalized = raw.replace(/\/+$/, '');
    if (!existingPaths.has(normalized)) {
      try {
        await repo.save(repo.create({ path: raw.trim() }));
        createdOut.push(raw.trim());
        existingPaths.add(normalized);
      } catch {
        /* duplicate or DB error */
      }
    }
  }
}

/**
 * Map Radarr/Sonarr full library path + optional API rootFolderPath to our
 * rootFolderId + folderName (Media.path is computed from these).
 */
export function resolveRootFolderFromArrPaths(
  fullPath: string | undefined | null,
  rootFolderPathFromApi: string | undefined | null,
  rootFolders: RootFolder[],
): { rootFolderId: number; folderName: string } | null {
  if (!rootFolders.length) return null;

  const norm = (p: string) =>
    path
      .normalize(p.trim())
      .replace(/[/\\]+$/, '')
      .replace(/\\/g, '/');

  const sorted = [...rootFolders].sort(
    (a, b) => norm(b.path).length - norm(a.path).length,
  );

  const full = fullPath?.trim() ? norm(fullPath) : '';
  const apiRoot = rootFolderPathFromApi?.trim()
    ? norm(rootFolderPathFromApi)
    : '';

  if (full) {
    for (const rf of sorted) {
      const root = norm(rf.path);
      if (full === root) {
        return { rootFolderId: rf.id, folderName: path.basename(full) };
      }
      const prefix = root + '/';
      if (full.startsWith(prefix)) {
        const rel = full.slice(prefix.length);
        const folderName = rel.split('/')[0] || path.basename(full);
        if (folderName) {
          return { rootFolderId: rf.id, folderName };
        }
      }
    }
  }

  if (apiRoot && full) {
    const rf = sorted.find((f) => norm(f.path) === apiRoot);
    if (rf) {
      const prefix = apiRoot + '/';
      if (full.startsWith(prefix)) {
        const rel = full.slice(prefix.length);
        const folderName = rel.split('/')[0] || path.basename(full);
        if (folderName) {
          return { rootFolderId: rf.id, folderName };
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Subtitles (Radarr extra files / Sonarr filesystem scan)
// ---------------------------------------------------------------------------

export const SUBTITLE_FILE_EXTENSIONS = new Set([
  '.srt',
  '.ass',
  '.ssa',
  '.sub',
  '.vtt',
]);

/** Try to extract language code from filename like "movie.en.srt" or "movie.fra.forced.srt" */
export function parseLanguageFromPath(relativePath: string): string {
  const base = path.basename(relativePath, path.extname(relativePath));
  const parts = base.split('.');
  const langCodes = new Set([
    'en',
    'fr',
    'de',
    'es',
    'it',
    'pt',
    'nl',
    'ja',
    'ko',
    'zh',
    'ru',
    'ar',
    'pl',
    'sv',
    'da',
    'no',
    'fi',
    'eng',
    'fra',
    'fre',
    'deu',
    'ger',
    'spa',
    'ita',
    'por',
    'nld',
    'dut',
    'jpn',
    'kor',
    'zho',
    'chi',
    'rus',
    'ara',
    'pol',
    'swe',
    'dan',
    'nor',
    'fin',
  ]);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].toLowerCase();
    if (langCodes.has(p)) return p;
  }
  return 'und';
}

/** Parse tags from filename (e.g. "movie.en.forced.srt" → ["forced"]) */
export function parseSubtitleTags(relativePath: string): string[] {
  const base = path
    .basename(relativePath, path.extname(relativePath))
    .toLowerCase();
  const tags: string[] = [];
  if (base.includes('forced')) tags.push('forced');
  if (base.includes('sdh')) tags.push('sdh');
  if (base.includes('.cc') || base.includes('_cc')) tags.push('cc');
  if (base.includes('.hi') || base.includes('_hi')) tags.push('hi');
  return tags;
}

export function hearingImpairedFromTags(tags: string[]): boolean {
  return tags.includes('sdh') || tags.includes('cc') || tags.includes('hi');
}

/** Subtitle files next to the episode video, matching the video basename prefix (Sonarr: no extrafile API). */
export async function subtitlePathsBesideEpisode(
  seriesPath: string,
  episodeRelativePath: string,
  subtitleExts: Set<string> = SUBTITLE_FILE_EXTENSIONS,
): Promise<string[]> {
  const videoAbs = path.join(seriesPath, episodeRelativePath);
  const dir = path.dirname(videoAbs);
  const baseName = path.basename(
    episodeRelativePath,
    path.extname(episodeRelativePath),
  );
  const lowerBase = baseName.toLowerCase();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    if (!subtitleExts.has(ext)) continue;
    const stem = path.basename(name, ext).toLowerCase();
    if (
      stem === lowerBase ||
      stem.startsWith(`${lowerBase}.`) ||
      stem.startsWith(`${lowerBase} `)
    ) {
      out.push(path.join(dir, name));
    }
  }
  return out;
}

export interface UpsertImportedSubtitleParams {
  mediaId: number;
  mediaFileId: number;
  episodeId?: number | null;
  language: string;
  forced: boolean;
  tags: string[];
  /** Relative to media folder (Media.path), like MediaFile.relativePath */
  relativePath: string | null;
  mode: 'skip' | 'update';
  providerType: SubtitleProviderType.RADARR | SubtitleProviderType.SONARR;
}

/**
 * Insert or update a subtitle row from Radarr/Sonarr import (skip vs update semantics).
 * @returns 1 if a row was inserted or updated, 0 if skipped.
 */
export async function upsertImportedSubtitleFile(
  subtitleRepo: Repository<SubtitleFile>,
  params: UpsertImportedSubtitleParams,
): Promise<number> {
  const hearingImpaired = hearingImpairedFromTags(params.tags);
  const {
    mediaId,
    mediaFileId,
    language,
    forced,
    tags,
    relativePath,
    mode,
    providerType,
  } = params;

  let existing = await subtitleRepo.findOne({
    where: {
      mediaFileId,
      language,
      forced,
      relativePath: relativePath ?? undefined,
    },
  });

  if (!existing && mode === 'update') {
    const misTagged = await subtitleRepo.findOne({
      where: {
        mediaFileId,
        language,
        forced,
        providerType: SubtitleProviderType.EMBEDDED,
      },
    });
    if (misTagged?.streamIndex == null) {
      existing = misTagged;
    }
  }

  if (existing) {
    if (mode === 'update') {
      const wasEmbedded =
        existing.providerType === SubtitleProviderType.EMBEDDED;
      await subtitleRepo.update(existing.id, {
        providerType,
        hearingImpaired,
        tags,
        relativePath: relativePath ?? existing.relativePath,
        status: SubtitleStatus.DOWNLOADED,
        ...(wasEmbedded ? { streamIndex: null, codec: null } : {}),
      });
      return 1;
    }
    return 0;
  }

  await subtitleRepo.save(
    subtitleRepo.create({
      mediaId,
      mediaFileId,
      episodeId: params.episodeId ?? undefined,
      language,
      forced,
      hearingImpaired,
      providerType,
      status: SubtitleStatus.DOWNLOADED,
      relativePath,
      tags,
    }),
  );
  return 1;
}
