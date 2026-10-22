import type { Media } from './api/media.service';

/** The first `keep` unwatched episodes with a file, in season then episode order; specials are skipped. */
export function pickNextEpisodes(media: Media, watched: ReadonlySet<number>, keep: number) {
  const fileOf = new Map((media.files ?? []).filter((f) => f.episodeId != null).map((f) => [f.episodeId, f.id]));
  return [...(media.seasons ?? [])]
    .filter((s) => s.seasonNumber > 0)
    .sort((a, b) => a.seasonNumber - b.seasonNumber)
    .flatMap((s) =>
      [...(s.episodes ?? [])]
        .sort((a, b) => a.episodeNumber - b.episodeNumber)
        .map((episode) => ({ season: s.seasonNumber, episode })),
    )
    .filter(({ episode }) => !watched.has(episode.id) && (episode.hasFile || fileOf.has(episode.id)))
    .slice(0, keep)
    .map(({ season, episode }) => ({ season, episode, mediaFileId: fileOf.get(episode.id) }));
}
