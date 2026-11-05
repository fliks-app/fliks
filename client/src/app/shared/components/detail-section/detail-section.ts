import { Component, input } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { CollapsibleSectionComponent } from '../collapsible-section/collapsible-section';

/** One section of a detail page, whatever the kind: a divider, then the heading with its fold or a plain heading.
 *  A section with nothing to show is not rendered by its page, so it leaves no divider or gap. */
@Component({
  selector: 'app-detail-section',
  imports: [CollapsibleSectionComponent, NgTemplateOutlet],
  templateUrl: './detail-section.html',
  host: { class: 'block' },
})
export class DetailSectionComponent {
  readonly heading = input<string | null>(null);
  /** localStorage suffix of the fold; empty means it reopens at its default. */
  readonly persistKey = input('');
  readonly defaultOpen = input(true);
  /** False keeps a heading plain, with no fold. */
  readonly collapsible = input(true);
}
