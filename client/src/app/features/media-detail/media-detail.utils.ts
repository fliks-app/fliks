import type { Episode, Media, Season } from '../../core/services/api/media.service';
import type { SubtitleFileRow } from '../../core/services/api/subtitles-api.service';

/**
 * Chemin « sur le disque » pour l’affichage : dossier racine du média + chemin relatif
 * enregistré en base (sans toucher aux données existantes).
 */
export function displayMediaFilePath(
  mediaPath: string | null | undefined,
  relativePath: string,
): string {
  if (relativePath == null || relativePath === '') return '—';
  const root = mediaPath?.trim();
  if (!root) return normalizeDisplayPath(relativePath.replace(/\\/g, '/'));
  const a = root.replace(/[/\\]+$/, '').replace(/\\/g, '/');
  const b = relativePath.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  return normalizeDisplayPath(`${a}/${b}`);
}

/** Collapse `.` / `..` in a display path (legacy DB rows could store unsafe relatives). */
function normalizeDisplayPath(p: string): string {
  const parts = p.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length) stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/') || '—';
}

export function formatMediaDetailBytes(bytes: number): string {
  const n = Number(bytes);
  if (!n || n <= 0) return '0 GB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}

/** Visible episodes of a season, optionally only those on disk (coverage). */
export function filterSeasonEpisodesOnDisk(
  season: Season,
  onlyOnDisk: boolean,
): Episode[] {
  const eps = hideShadowedEpisodes(season.episodes);
  if (!onlyOnDisk) return eps;
  const onDisk = onDiskEpisodeNumbers(season.episodes);
  return eps.filter((e) => onDisk.has(e.episodeNumber));
}

/**
 * Episode numbers in a season whose content is on disk — own file (`hasFile`)
 * OR covered by a multi-episode file (inside an owner's
 * `[episodeNumber..endEpisodeNumber]`). Mirror of the backend
 * `episode-coverage.util`. Use this, not raw `hasFile`, for "missing" logic.
 */
export function onDiskEpisodeNumbers(episodes: Episode[]): Set<number> {
  const numbers = new Set<number>();
  for (const owner of episodes) {
    if (!owner.hasFile) continue;
    numbers.add(owner.episodeNumber);
    const end = owner.endEpisodeNumber;
    if (end != null && end > owner.episodeNumber) {
      for (let n = owner.episodeNumber + 1; n <= end; n++) numbers.add(n);
    }
  }
  return numbers;
}

/**
 * Drop episodes whose number is covered by another episode's range
 * (a single S07E25-E26.mkv → E25 row owns the range, E26 row is still
 * created by the provider but hidden here so it doesn't show up as a
 * separate "missing" tile).
 */
export function hideShadowedEpisodes(episodes: Episode[]): Episode[] {
  const shadowed = new Set<number>();
  for (const e of episodes) {
    const end = e.endEpisodeNumber;
    if (end != null && end > e.episodeNumber) {
      for (let n = e.episodeNumber + 1; n <= end; n++) shadowed.add(n);
    }
  }
  if (shadowed.size === 0) return episodes;
  return episodes.filter((e) => !shadowed.has(e.episodeNumber));
}

/** "25" for a single episode, "25-26" when the row covers a range. */
export function episodeBadgeLabel(ep: Episode): string {
  const end = ep.endEpisodeNumber;
  return end != null && end > ep.episodeNumber
    ? `${ep.episodeNumber}-${end}`
    : String(ep.episodeNumber);
}

/** Saisons à afficher dans les onglets : toutes, ou seulement celles avec ≥1 épisode sur disque. */
export function seasonsVisibleWithDiskFilter(media: Media, onlyOnDisk: boolean): Season[] {
  const list = media.seasons ?? [];
  if (!onlyOnDisk) return list;
  return list.filter((s) => filterSeasonEpisodesOnDisk(s, true).length > 0);
}

export type MediaFileRow = NonNullable<Media['files']>[number];

/** Plus d’une version fichier → afficher un `<select>` pour choisir la qualité / la piste. */
export function hasMultipleFileQualityChoices(files: MediaFileRow[]): boolean {
  return files.length > 1;
}

/** Libellé d’option : qualité seule, ou qualité + taille si plusieurs fichiers ont la même étiquette. */
export function fileQualityOptionLabel(f: MediaFileRow, siblings: MediaFileRow[]): string {
  const same = siblings.filter((x) => x.quality === f.quality).length;
  if (same > 1) return `${f.quality} · ${formatMediaDetailBytes(f.size)}`;
  return f.quality;
}

/** Fichiers média explicitement liés à cet épisode (episodeId). */
export function filesForEpisode(
  files: Media['files'],
  episodeId: number,
): MediaFileRow[] {
  return (files ?? []).filter(
    (f) => f.episodeId != null && Number(f.episodeId) === episodeId,
  );
}

/** Sous-titres rattachés à un épisode (episodeId ou fichier média de l’épisode). */
export function subtitlesForEpisode(
  all: SubtitleFileRow[],
  episodeId: number,
  files: { id: number; episodeId?: number | null }[] | undefined,
): SubtitleFileRow[] {
  return all.filter((s) => {
    if (s.episodeId === episodeId) return true;
    const f = files?.find((x) => x.id === s.mediaFileId);
    return f?.episodeId === episodeId;
  });
}
