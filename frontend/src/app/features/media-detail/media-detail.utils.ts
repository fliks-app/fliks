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
  if (!root) return relativePath.replace(/\\/g, '/');
  const a = root.replace(/[/\\]+$/, '').replace(/\\/g, '/');
  const b = relativePath.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  return `${a}/${b}`;
}

export function formatMediaDetailBytes(bytes: number): string {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}

/** Episodes with fichier (hasFile ou fichier tracké avec episodeId). */
export function filterSeasonEpisodesOnDisk(
  season: Season,
  media: Media,
  onlyOnDisk: boolean,
): Episode[] {
  const eps = season.episodes;
  if (!onlyOnDisk) return eps;
  const fileEpisodeIds = new Set(
    (media.files ?? [])
      .map((f) => f.episodeId)
      .filter((id): id is number => id != null && id > 0),
  );
  return eps.filter((e) => e.hasFile || fileEpisodeIds.has(e.id));
}

/** Saisons à afficher dans les onglets : toutes, ou seulement celles avec ≥1 épisode sur disque. */
export function seasonsVisibleWithDiskFilter(media: Media, onlyOnDisk: boolean): Season[] {
  const list = media.seasons ?? [];
  if (!onlyOnDisk) return list;
  return list.filter((s) => filterSeasonEpisodesOnDisk(s, media, true).length > 0);
}

export type MediaFileRow = NonNullable<Media['files']>[number];

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
