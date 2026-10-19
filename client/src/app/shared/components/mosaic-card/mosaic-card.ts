import {
  Component,
  input,
  output,
} from '@angular/core';
import { LucideFolder } from '@lucide/angular';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { ImgFadeInDirective } from '../../directives/img-fade-in.directive';

@Component({
  selector: 'app-mosaic-card',
  imports: [LucideFolder, ResolveUrlPipe, ImgFadeInDirective],
  templateUrl: './mosaic-card.html',
})
export class MosaicCardComponent {
  readonly posters = input.required<string[]>();
  readonly label = input.required<string>();
  /** Pre-formatted subtitle line under the label (e.g. "5 éléments"). */
  readonly subtitle = input.required<string>();
  readonly clicked = output<void>();
}
