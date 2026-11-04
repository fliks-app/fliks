import { Component, computed, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideBookOpen, LucideFilm } from '@lucide/angular';
import type { MediaType } from '../../../core/enums/media-type.enum';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../directives/cached-src.directive';
import { ImgFadeInDirective } from '../../directives/img-fade-in.directive';
import { SpoilerDirective } from '../../directives/spoiler.directive';

/** Desktop hero cover (poster or episode still) carrying the view-transition name of its card. */
@Component({
  selector: 'app-hero-poster',
  imports: [CachedSrcDirective, ResolveUrlPipe, ImgFadeInDirective, SpoilerDirective, TranslatePipe, LucideBookOpen, LucideFilm],
  templateUrl: './hero-poster.html',
})
export class HeroPosterComponent {
  /** Picks the placeholder glyph: a book for books and comics. */
  readonly kind = input<MediaType | null>(null);
  readonly url = input<string | null>(null);
  readonly alt = input('');
  readonly mode = input<'poster' | 'still'>('poster');
  readonly spoiler = input(false);
  protected readonly bookLike = computed(() => this.kind() === 'book' || this.kind() === 'comic');
  readonly viewTransitionName = input<string | null>(null);
}
