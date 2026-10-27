import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { ImgFadeInDirective } from '../../directives/img-fade-in.directive';

/** Fills its parent with a 2×2 grid of posters from `gridFrom` of them, else the first one, else the projected fallback. */
@Component({
  selector: 'app-poster-mosaic',
  imports: [ResolveUrlPipe, ImgFadeInDirective],
  host: { class: 'block h-full w-full' },
  templateUrl: './poster-mosaic.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PosterMosaicComponent {
  readonly posters = input.required<string[]>();
  readonly gridFrom = input(4);
}
