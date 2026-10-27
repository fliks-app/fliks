import {
  Component,
  input,
  output,
} from '@angular/core';
import { LucideFolder } from '@lucide/angular';
import { PosterMosaicComponent } from '../poster-mosaic/poster-mosaic';

@Component({
  selector: 'app-mosaic-card',
  imports: [LucideFolder, PosterMosaicComponent],
  templateUrl: './mosaic-card.html',
})
export class MosaicCardComponent {
  readonly posters = input.required<string[]>();
  readonly label = input.required<string>();
  /** Pre-formatted subtitle line under the label (e.g. "5 éléments"). */
  readonly subtitle = input.required<string>();
  readonly clicked = output<void>();
}
