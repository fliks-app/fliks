import { Media } from '../../core/services/api/media.service';
import { PlayContext } from '../../core/services/playable-media.service';

/** Resolve a playable file from list/detail media (files include episodeId for series episodes). */
export function pickPlayContext(m: Media): PlayContext | null {
  const files = m.files ?? [];
  if (!files.length) return null;

  if (m.type === 'movie') {
    const f = files.find((x) => !x.episodeId) ?? files[0];
    return {
      fileId: f.id,
      mediaId: m.id,
      title: m.title,
      fanartUrl: m.posterUrl ?? null,
      streamInfo: f.streamInfo,
    };
  }

  const epFiles = files
    .filter((f) => f.episodeId != null && f.episodeId > 0)
    .sort((a, b) => (a.episodeId ?? 0) - (b.episodeId ?? 0));
  if (!epFiles.length) return null;
  const f = epFiles[0];
  return {
    fileId: f.id,
    mediaId: m.id,
    episodeId: f.episodeId!,
    title: m.title,
    fanartUrl: m.posterUrl ?? null,
    streamInfo: f.streamInfo,
  };
}
