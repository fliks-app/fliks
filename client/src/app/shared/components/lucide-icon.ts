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

/** Renders a Lucide icon by name from a curated list, falling back to LucideLibrary. */
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
