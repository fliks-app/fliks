import { Component, input } from '@angular/core';
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
  templateUrl: './lucide-icon.html',
  styles: [`:host { display: inline-flex; } svg { width: 100%; height: 100%; }`],
})
export class LucideIconComponent {
  readonly name = input<string>('library');
}
