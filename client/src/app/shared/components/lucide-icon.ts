import { Component, ChangeDetectionStrategy, input } from '@angular/core';
import {
  LucideFilm,
  LucideTv,
  LucideLibrary,
  LucideLayoutGrid,
  LucideBook,
  LucideGamepad2,
  LucideMusic,
  LucideHeart,
  LucideStar,
  LucideGlobe,
  LucideMonitor,
  LucidePopcorn,
  LucideClapperboard,
  LucideUsers,
  LucideFolder,
  LucideSwords,
} from '@lucide/angular';

/**
 * Renders a Lucide icon by name string. Supports a curated list of icons
 * commonly used for library customisation. Falls back to LucideLibrary.
 *
 * Usage: `<app-lucide-icon [name]="'film'" class="h-5 w-5" />`
 */
@Component({
  selector: 'app-lucide-icon',
  standalone: true,
  imports: [
    LucideFilm, LucideTv, LucideLibrary, LucideLayoutGrid,
    LucideBook, LucideGamepad2, LucideMusic, LucideHeart,
    LucideStar, LucideGlobe, LucideMonitor, LucidePopcorn,
    LucideClapperboard, LucideUsers, LucideFolder, LucideSwords,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (name()) {
      @case ('film') { <svg lucideFilm></svg> }
      @case ('tv') { <svg lucideTv></svg> }
      @case ('layout-grid') { <svg lucideLayoutGrid></svg> }
      @case ('book') { <svg lucideBook></svg> }
      @case ('gamepad-2') { <svg lucideGamepad2></svg> }
      @case ('music') { <svg lucideMusic></svg> }
      @case ('heart') { <svg lucideHeart></svg> }
      @case ('star') { <svg lucideStar></svg> }
      @case ('globe') { <svg lucideGlobe></svg> }
      @case ('monitor') { <svg lucideMonitor></svg> }
      @case ('popcorn') { <svg lucidePopcorn></svg> }
      @case ('clapperboard') { <svg lucideClapperboard></svg> }
      @case ('users') { <svg lucideUsers></svg> }
      @case ('folder') { <svg lucideFolder></svg> }
      @case ('swords') { <svg lucideSwords></svg> }
      @default { <svg lucideLibrary></svg> }
    }
  `,
  styles: [`:host { display: inline-flex; } svg { width: 100%; height: 100%; }`],
})
export class LucideIconComponent {
  readonly name = input<string>('library');
}
