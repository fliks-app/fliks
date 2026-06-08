import { isImageBasedSubtitleCodec } from './subtitle-codecs';

/** Minimal subtitle row shape the builder needs (satisfied by SubtitleFileRow). */
export interface SubtitleRowLike {
  id: number;
  mediaFileId: number;
  language: string;
  codec?: string | null;
  forced?: boolean | null;
  hearingImpaired?: boolean | null;
  relativePath?: string | null;
  streamIndex?: number | null;
}

export interface SubtitleTrack {
  /** Stable id: `ext-<id>` for sidecar files, `emb-<streamIndex>` for in-container. */
  key: string;
  subtitleId: number;
  language: string;
  codec: string | null;
  forced: boolean;
  hearingImpaired: boolean;
  relativePath: string | null;
  streamIndex: number | null;
  kind: 'external' | 'embedded';
  /** Bitmap track (PGS/VOBSUB…) that can't be served as text — burn-in only. */
  isImage: boolean;
}

/**
 * Single source of truth for a media file's selectable subtitle list, shared by
 * the player and cast pickers so they can't drift. Drops burn-required tracks
 * when `hideBurnIn`, classifies image vs text, and dedupes external subs by id
 * and embedded subs by stream index. Callers map the result to their own shape
 * (label, url, …).
 */
export function buildSubtitleTracks(
  subs: SubtitleRowLike[],
  mediaFileId: number,
  opts: { hideBurnIn: boolean },
): SubtitleTrack[] {
  const out: SubtitleTrack[] = [];
  const seen = new Set<string>();
  for (const sub of subs) {
    if (sub.mediaFileId !== mediaFileId) continue;
    const isImage = isImageBasedSubtitleCodec(sub.codec);
    if (opts.hideBurnIn && isImage) continue;

    let key: string;
    let kind: 'external' | 'embedded';
    if (sub.relativePath) {
      key = `ext-${sub.id}`;
      kind = 'external';
    } else if (sub.streamIndex != null) {
      key = `emb-${sub.streamIndex}`;
      kind = 'embedded';
    } else {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      key,
      subtitleId: sub.id,
      language: sub.language,
      codec: sub.codec ?? null,
      forced: sub.forced ?? false,
      hearingImpaired: sub.hearingImpaired ?? false,
      relativePath: sub.relativePath ?? null,
      streamIndex: sub.streamIndex ?? null,
      kind,
      isImage,
    });
  }
  return out;
}
