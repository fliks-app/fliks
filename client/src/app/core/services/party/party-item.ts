import type { Signal } from '@angular/core';
import type { PartyItem, PartyItemIn } from '../api/party-api.service';
import type { PlaybackSync } from '../playback/playback-output';

export type ItemRef = { mediaId: number; episodeId?: number | null; itemId?: number | null };

/** Two rows are the same when media and episode agree, and so does the item when both name one (two tracks of one album differ). */
export const sameItem = (a: ItemRef, b: ItemRef): boolean =>
  a.mediaId === b.mediaId && (a.episodeId ?? null) === (b.episodeId ?? null) && (a.itemId == null || b.itemId == null || a.itemId === b.itemId);

/** The wire form of a row. */
export const itemIn = (i: ItemRef & { mediaFileId?: number | null }): PartyItemIn => ({
  mediaId: i.mediaId,
  ...(i.mediaFileId != null && { mediaFileId: i.mediaFileId }),
  ...(i.episodeId != null && { episodeId: i.episodeId }),
  ...(i.itemId != null && { itemId: i.itemId }),
});

/** What the party sync drives: the video player's output satisfies it, and so does the audio player. */
export interface PartyPlayable {
  readonly ready: () => boolean;
  readonly item: () => { mediaId: number; episodeId: number | undefined; itemId?: number };
  readonly paused: () => boolean;
  readonly uiPaused: Signal<boolean>;
  readonly buffering: Signal<boolean>;
  readonly ended: Signal<boolean>;
  readonly seekLocked: Signal<boolean>;
  readonly position: () => number;
  seek(time: number): void;
  play(): void;
  pause(): Promise<void>;
  readonly sync: PlaybackSync;
}

/** A programme row names its item (a track is an `album` media's), so `itemId` no longer tells a track. */
export const isTrack = (i: Pick<PartyItem, 'mediaType'>): boolean => i.mediaType === 'album';

/** The server's cap on a programme. */
export const MAX_PROGRAMME = 500;

type Row = ItemRef & { mediaFileId?: number | null };

/** The programme of a party opened on `current`: the queue as it is, a repeated row dropped, `current` kept and
 *  carrying its file, cut to the cap in a window that keeps it and prefers what follows. */
export function programmeOf(queue: readonly Row[], current: Row): PartyItemIn[] {
  const rows: Row[] = [];
  for (const r of queue) if (!rows.some((o) => sameItem(o, r))) rows.push(sameItem(r, current) ? current : r);
  if (!rows.some((r) => sameItem(r, current))) rows.unshift(current);
  const at = rows.findIndex((r) => sameItem(r, current));
  const from = Math.min(at, Math.max(0, rows.length - MAX_PROGRAMME));
  return rows.slice(from, from + MAX_PROGRAMME).map(itemIn);
}
