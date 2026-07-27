import * as path from 'path';
import { Repository } from 'typeorm';
import { readdir } from 'fs/promises';
import { Library } from '../../libraries/entities/library.entity';
import { SubtitleFile } from '../../subtitles/entities/subtitle-file.entity';
import { Episode } from '../../media/entities/episode.entity';
import { Media } from '../../media/entities/media.entity';
import { MediaFile } from '../../media/entities/media-file.entity';
import { SubtitleProviderType, SubtitleStatus } from '../../../common/enums';

// ---------------------------------------------------------------------------
// User-provided remote→local path mapping (path mapping wizard)
// ---------------------------------------------------------------------------

export interface PathMapping {
  remotePath: string;
  localLibraryId: number | null;
  ignore?: boolean;
}

function normalizePath(p: string): string {
  return path
    .normalize(p.trim())
    .replace(/[/\\]+$/, '')
    .replace(/\\/g, '/');
}

/**
 * Longest-prefix match of `fullArrPath` against the user-provided mappings.
 *   { libraryId, folderName }   → use this library + first-segment folder name
 *   { ignore: true }            → matched mapping is ignored (caller skips silently)
 *   null                        → no mapping matched (caller pushes error and skips)
 *
 * folderName is the first segment of the *arr path under the matched remote
 * root, so that on-disk folder naming follows what Radarr/Sonarr already laid
 * out — independent of how the local Fliks library path is named.
 */
export function applyPathMapping(
  fullArrPath: string | null | undefined,
  mappings: PathMapping[],
): { libraryId: number; folderName: string } | { ignore: true } | null {
  if (!fullArrPath?.trim() || !mappings.length) return null;
  const full = normalizePath(fullArrPath);
  const sorted = [...mappings].sort(
    (a, b) =>
      normalizePath(b.remotePath).length - normalizePath(a.remotePath).length,
  );
  for (const m of sorted) {
    const remote = normalizePath(m.remotePath);
    if (!remote) continue;
    const prefix = remote + '/';
    const isUnderRoot = full === remote || full.startsWith(prefix);
    if (!isUnderRoot) continue;
    if (m.ignore) return { ignore: true };
    if (m.localLibraryId == null) return null;
    const rest = full === remote ? '' : full.slice(prefix.length);
    const folderName = rest.split('/')[0] || path.basename(full);
    if (!folderName) return null;
    return { libraryId: m.localLibraryId, folderName };
  }
  return null;
}

/**
 * Server-side suggestion for the wizard pre-select:
 *   1. unique library whose path ends with `/<basename(remotePath)>`
 *   2. fallback: unique library whose basename equals basename(remotePath)
 *   3. ambiguous or none → null (the row stays unselected, blocking Confirm)
 */
export function suggestLocalLibraryId(
  remotePath: string,
  candidates: Library[],
): number | null {
  if (!remotePath?.trim() || !candidates.length) return null;
  const remoteBase = path.basename(normalizePath(remotePath));
  if (!remoteBase) return null;
  const tailMatches = candidates.filter(
    (lib) => !!lib.path && normalizePath(lib.path).endsWith('/' + remoteBase),
  );
  if (tailMatches.length === 1) return tailMatches[0].id;
  const baseMatches = candidates.filter(
    (lib) =>
      !!lib.path && path.basename(normalizePath(lib.path)) === remoteBase,
  );
  if (baseMatches.length === 1) return baseMatches[0].id;
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

/** Imported sidecars are files the user already owns — scored like disk
 *  sidecars and embedded tracks so the upgrade pass never replaces them. */
const IMPORTED_SUBTITLE_SCORE = 100;

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
        score: IMPORTED_SUBTITLE_SCORE,
        ...(wasEmbedded ? { streamIndex: null, codec: null } : {}),
      });
      return 1;
    }
    return 0;
  }

  await subtitleRepo.save(
    subtitleRepo.create({
      media: { id: mediaId } as Media,
      mediaFile: { id: mediaFileId } as MediaFile,
      episode:
        params.episodeId != null ? ({ id: params.episodeId } as Episode) : null,
      language,
      forced,
      hearingImpaired,
      providerType,
      status: SubtitleStatus.DOWNLOADED,
      score: IMPORTED_SUBTITLE_SCORE,
      relativePath,
      tags,
    }),
  );
  return 1;
}
