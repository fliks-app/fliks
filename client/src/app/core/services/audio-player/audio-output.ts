import type { Signal } from '@angular/core';
import type { AudioRequest } from './audio-player.service';
import type { MusicTrackRequest, Repeat } from './music-queue';

/** What the full-screen audio player reads and drives: the local player, or an audio session played on another device. */
export interface AudioOutput {
  readonly track: Signal<AudioRequest | null>;
  readonly playing: Signal<boolean>;
  readonly position: Signal<number>;
  readonly duration: Signal<number>;
  /** A track queue (music) rather than one long recording (audiobook). */
  readonly musicMode: Signal<boolean>;
  readonly queue: Signal<readonly MusicTrackRequest[]>;
  readonly queueIndex: Signal<number>;
  readonly shuffle: Signal<boolean>;
  readonly repeat: Signal<Repeat>;
  readonly expanded: Signal<boolean>;
  toggle(): void;
  seek(position: number): Promise<void> | void;
  next(): void;
  previous(): void;
  setShuffle(on: boolean): void;
  cycleRepeat(): void;
  playQueueAt(index: number): void;
  collapse(): void;
  close(): Promise<void> | void;
}
