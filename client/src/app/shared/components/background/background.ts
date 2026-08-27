import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
} from '@angular/core';
import { BackgroundService } from '../../../core/services/background.service';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../directives/cached-src.directive';

/**
 * Page-wide background renderer. Mounted once at the layout root so
 * the image covers everything — including under the sidebar — and
 * survives route changes without remount.
 *
 * Crossfade strategy: two stacked layers ping-pong. Setting a new URL
 * writes it into the currently-hidden layer, then flips which layer
 * is "active". The CSS opacity transition does the visual swap, so
 * neither image is destroyed mid-fade (which would flash).
 */
@Component({
  selector: 'app-background',
  imports: [
    CachedSrcDirective,ResolveUrlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './background.html',
})
export class BackgroundComponent {
  private readonly bg = inject(BackgroundService);

  readonly layerA = signal<string | null>(null);
  readonly layerB = signal<string | null>(null);
  readonly activeLayer = signal<'A' | 'B'>('A');
  /** Tracks whether the active layer should currently be at full
   *  opacity. The image is dimmed in CSS (filter: brightness),
   *  so we no longer need a separate veil — fade-out can use the
   *  image opacity directly without showing un-tinted colour. */
  readonly imageVisible = signal(false);

  constructor() {
    let last: string | null = null;
    effect(() => {
      const next = this.bg.url();
      if (next === last) return;
      last = next;

      if (next === null) {
        this.imageVisible.set(false);
        return;
      }

      this.imageVisible.set(true);
      // Write into the currently-inactive layer, then flip active.
      // Keeping the old layer's URL intact means it can fade out
      // smoothly instead of vanishing the moment we swap.
      if (this.activeLayer() === 'A') {
        this.layerB.set(next);
        this.activeLayer.set('B');
      } else {
        this.layerA.set(next);
        this.activeLayer.set('A');
      }
    });
  }
}
