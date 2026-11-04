import { Component, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideFilm } from '@lucide/angular';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../directives/cached-src.directive';
import { ImgFadeInDirective } from '../../directives/img-fade-in.directive';
import { SpoilerDirective } from '../../directives/spoiler.directive';

/** Desktop hero cover (poster or episode still) carrying the view-transition name of its card. */
@Component({
  selector: 'app-hero-poster',
  imports: [CachedSrcDirective, ResolveUrlPipe, ImgFadeInDirective, SpoilerDirective, TranslatePipe, LucideFilm],
  templateUrl: './hero-poster.html',
})
export class HeroPosterComponent {
  readonly url = input<string | null>(null);
  readonly alt = input('');
  readonly mode = input<'poster' | 'still'>('poster');
  readonly spoiler = input(false);
  readonly viewTransitionName = input<string | null>(null);
}
