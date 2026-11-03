import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { TvService } from '../../../core/services/tv.service';
import { CachedSrcDirective } from '../../../shared/directives/cached-src.directive';
import { nextIssue, type ComicMedia } from './comic-media';

/** The page of a comic volume, rendered by the media detail page for the `comic` kind. */
@Component({
  selector: 'app-comic-volume',
  imports: [RouterLink, DatePipe, NgTemplateOutlet, TranslatePipe, ResolveUrlPipe, CachedSrcDirective],
  templateUrl: './comic-volume.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComicVolumeComponent {
  readonly media = input.required<ComicMedia>();

  /** The reader is a personal-device feature: a TV form factor lists the issues without opening them. */
  protected readonly canRead = !inject(TvService).isTv();
  protected readonly comic = computed(() => this.media().comic);
  protected readonly main = computed(() => this.comic().issues.filter((i) => !i.annual));
  protected readonly annuals = computed(() => this.comic().issues.filter((i) => i.kind === 'annual'));
  protected readonly specials = computed(() => this.comic().issues.filter((i) => i.kind === 'special'));
  protected readonly next = computed(() => nextIssue(this.comic().issues));
  protected readonly started = computed(() => !!this.next() && this.next()!.progression != null);
  protected readonly readCount = computed(() => this.comic().issues.filter((i) => i.finished).length);

  protected readonly readLink = (itemId: number) => ['/read', this.media().id, itemId];
  protected percent(p: number | null): number {
    return Math.round((p ?? 0) * 100);
  }
}
