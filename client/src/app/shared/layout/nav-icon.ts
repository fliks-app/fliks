import { Component, input } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../icons';

/** Renders a nav or settings contribution's icon by name; a plugin can name any string, so unknown names fall back to a generic circle. */
@Component({
  selector: 'app-nav-icon',
  imports: [LucideDynamicIcon],
  templateUrl: './nav-icon.html',
  styles: [`:host { display: inline-flex; } svg { width: 100%; height: 100%; }`],
})
export class NavIconComponent {
  protected readonly icons = icons;

  readonly name = input.required<string>();
}
