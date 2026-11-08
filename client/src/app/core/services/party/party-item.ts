import type { Signal } from '@angular/core';
import type { PartyItemIn } from '../api/party-api.service';
import type { PlaybackSync } from '../playback/playback-output';

export type ItemRef = { mediaId: number; episodeId?: number | null; itemId?: number | null };

/** Two rows are the same when media, episode and track agree: two tracks of one album differ. */
export const sameItem = (a: ItemRef, b: ItemRef): boolean =>
  a.mediaId === b.mediaId && (a.episodeId ?? null) === (b.episodeId ?? null) && (a.itemId ?? null) === (b.itemId ?? null);

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
