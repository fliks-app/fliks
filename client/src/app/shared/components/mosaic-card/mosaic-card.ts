import {
  Component,
  input,
  output,
} from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../../icons';
import { PosterMosaicComponent } from '../poster-mosaic/poster-mosaic';

@Component({
  selector: 'app-mosaic-card',
  imports: [PosterMosaicComponent, LucideDynamicIcon],
  templateUrl: './mosaic-card.html',
})
export class MosaicCardComponent {
  protected readonly icons = icons;

  readonly posters = input.required<string[]>();
  readonly label = input.required<string>();
  /** Pre-formatted subtitle line under the label (e.g. "5 éléments"). */
  readonly subtitle = input.required<string>();
  readonly clicked = output<void>();
}
