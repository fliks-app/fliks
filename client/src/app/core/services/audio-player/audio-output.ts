import type { Signal } from '@angular/core';
import type { AudioRequest } from './audio-player.service';
import type { RemoteAction } from '../remote.service';
import type { MusicTrackRequest, Repeat } from './music-queue';
import type { StemMode } from './stem-mix';

/** What the full-screen audio player reads and drives: the local player, or an audio session played on another device. */
export interface AudioOutput {
  readonly track: Signal<AudioRequest | null>;
  /** What the players show: the track a skip moves to, before it has loaded. */
  readonly uiTrack: Signal<AudioRequest | null>;
  readonly playing: Signal<boolean>;
  /** The playhead waits for data while playing: a clock run between position reports holds. */
  readonly buffering: Signal<boolean>;
  /** What the play button shows: a start in flight counts as playing. */
  readonly uiPlaying: Signal<boolean>;
  readonly position: Signal<number>;
  readonly duration: Signal<number>;
  readonly rate: Signal<number>;
  /** A track queue (music) rather than one long recording (audiobook). */
  readonly musicMode: Signal<boolean>;
  readonly queue: Signal<readonly MusicTrackRequest[]>;
  readonly queueIndex: Signal<number>;
  readonly shuffle: Signal<boolean>;
  readonly repeat: Signal<Repeat>;
  readonly expanded: Signal<boolean>;
  readonly volume: Signal<number>;
  readonly muted: Signal<boolean>;
  /** False when the output keeps its own level (a native player, a cast, a device that refuses it). */
  readonly canSetVolume: Signal<boolean>;
  setVolume(level: number): void;
  toggleMute(): void;
  toggle(): void;
  seek(position: number): Promise<void> | void;
  next(): void;
  previous(): void;
  /** The track a skip in that direction would play. */
  neighbour(step: 1 | -1): MusicTrackRequest | null;
  setShuffle(on: boolean): void;
  cycleRepeat(): void;
  playQueueAt(index: number): void;
  expand(): void;
  collapse(): void;
  close(): Promise<void> | void;
  /** Karaoke mix and key, on an output that can apply stems. */
  readonly stemMode?: Signal<StemMode>;
  /** Guide vocal level, 0 to 1. */
  readonly vocalLevel?: Signal<number>;
  /** Key change in semitones. */
  readonly pitch?: Signal<number>;
  /** The playing track has stems ready and the output can mix them. */
  readonly stemsAvailable?: Signal<boolean>;
  setStemMode?(mode: StemMode): void;
  setVocalLevel?(level: number): void;
  setPitch?(semitones: number): Promise<void> | void;
  /** Whether the driven device applies `action`; absent on the local player. */
  supports?(action: RemoteAction): boolean;
}
