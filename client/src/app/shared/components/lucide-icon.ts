import { Component, input } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../icons';

/** Renders a Lucide icon by name from a curated list, falling back to LucideLibrary. */
@Component({
  selector: 'app-lucide-icon',
  imports: [LucideDynamicIcon],
  templateUrl: './lucide-icon.html',
  styles: [`:host { display: inline-flex; } svg { width: 100%; height: 100%; }`],
})
export class LucideIconComponent {
  protected readonly icons = icons;

  readonly name = input<string>('library');
}
