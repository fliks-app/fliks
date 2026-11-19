import { Component, DestroyRef, ElementRef, effect, inject, input, untracked, viewChild } from '@angular/core';
import { KaraokeApiService } from '../../../core/services/api/karaoke-api.service';
import type { AudioOutput } from '../../../core/services/audio-player/audio-output';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import { CDG_HEIGHT, CDG_WIDTH, CdgScreen } from '../../../core/services/karaoke/cdg';

const BACKWARD_JITTER_MS = 300;

/** The CD+G graphics of an MP3+G track, drawn on the player clock. */
@Component({
  selector: 'app-cdg-canvas',
  templateUrl: './cdg-canvas.html',
})
export class CdgCanvasComponent {
  private readonly local = inject(AudioPlayerService);
  private readonly karaoke = inject(KaraokeApiService);
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  /** The media file whose `.cdg` is drawn. */
  readonly fileId = input.required<number>();
  /** The output the graphics follow, when not the local player. */
  readonly output = input<AudioOutput | null>(null);

  protected readonly width = CDG_WIDTH;
  protected readonly height = CDG_HEIGHT;

  private screen: CdgScreen | null = null;
  private frame = 0;
  private image: ImageData | null = null;
  private shown = 0;

  private get audio(): AudioOutput {
    return this.output() ?? this.local;
  }

  constructor() {
    inject(DestroyRef).onDestroy(() => cancelAnimationFrame(this.frame));
    effect(() => {
      const id = this.fileId();
      untracked(() => void this.load(id));
    });
    effect(() => {
      this.audio.position();
      this.audio.playing();
      untracked(() => this.draw());
    });
  }

  private async load(id: number): Promise<void> {
    this.screen = null;
    this.shown = 0;
    try {
      const res = await fetch(this.karaoke.cdgUrl(id), { credentials: 'include' });
      if (!res.ok || this.fileId() !== id) return;
      this.screen = new CdgScreen(new Uint8Array(await res.arrayBuffer()));
      this.draw();
    } catch {
      // No graphics: the canvas stays black.
    }
  }

  private draw(): void {
    cancelAnimationFrame(this.frame);
    const ctx = this.canvas().nativeElement.getContext('2d');
    if (!this.screen || !ctx) return;
    const at = performance.now();
    const reported = this.audio.position() * 1000;
    // A position a little behind the one drawn is clock jitter: replaying from the start would cost more.
    const from = this.shown - reported > 0 && this.shown - reported < BACKWARD_JITTER_MS ? this.shown : reported;
    const paint = (now: number) => {
      this.shown = from + (this.audio.playing() ? (now - at) * this.audio.rate() : 0);
      this.screen!.seek(this.shown);
      this.image ??= new ImageData(CDG_WIDTH, CDG_HEIGHT);
      this.screen!.rgba(this.image.data);
      ctx.putImageData(this.image, 0, 0);
      if (this.audio.playing()) this.frame = requestAnimationFrame(paint);
    };
    paint(at);
  }
}
