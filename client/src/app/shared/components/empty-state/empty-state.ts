import { Component, input } from '@angular/core';
import { LucideIconComponent } from '../lucide-icon';

/** A page or grid with nothing to show: icon, title, optional hint, projected actions. */
@Component({
  selector: 'app-empty-state',
  imports: [LucideIconComponent],
  templateUrl: './empty-state.html',
})
export class EmptyStateComponent {
  readonly icon = input('library');
  readonly title = input.required<string>();
  readonly hint = input<string | null>();
}
