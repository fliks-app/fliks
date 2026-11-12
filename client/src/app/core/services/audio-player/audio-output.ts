import type { Signal } from '@angular/core';
import type { AudioRequest } from './audio-player.service';
import type { MusicTrackRequest, Repeat } from './music-queue';

/** What the full-screen audio player reads and drives: the local player, or an audio session played on another device. */
export interface AudioOutput {
  readonly track: Signal<AudioRequest | null>;
  /** What the players show: the track a skip moves to, before it has loaded. */
  readonly uiTrack: Signal<AudioRequest | null>;
  readonly playing: Signal<boolean>;
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
}
