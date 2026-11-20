import { signal } from '@angular/core';
import type { PlaybackEngine } from '../../core/services/playback-engine/playback-engine';

/** The direct-played file's keyframes, loaded only for an engine whose seeks land on one; empty means exact seeks. */
export class KeyframeGrid {
  readonly keyframes = signal<readonly number[]>([]);
  private engine: PlaybackEngine | null = null;
  private fileId: number | null = null;
  private loadedFor: number | null = null;

  constructor(private readonly fetchKeyframes: (fileId: number) => Promise<number[]>) {}

  attach(engine: PlaybackEngine): void {
    this.engine = engine;
    this.load();
  }

  /** The file played as is, or null for a remux or transcode, whose keyframes follow the output's own grid. */
  use(fileId: number | null): void {
    if (fileId !== this.fileId) {
      this.keyframes.set([]);
      this.loadedFor = null;
    }
    this.fileId = fileId;
    this.load();
  }

  private load(): void {
    const id = this.fileId;
    if (id == null || !this.engine?.seeksToKeyframe || this.loadedFor === id) return;
    this.loadedFor = id;
    this.fetchKeyframes(id).then(
      (k) => {
        if (this.fileId === id) this.keyframes.set(k);
      },
      () => {
        if (this.loadedFor === id) this.loadedFor = null;
      },
    );
  }
}
