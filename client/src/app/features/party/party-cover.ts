import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import type { PartyCover, PartyItem } from '../../core/services/api/party-api.service';
import { PosterMosaicComponent } from '../../shared/components/poster-mosaic/poster-mosaic';
import { coverImage, coverPosters } from './party-thumb';

/** A party's picture, filling its parent: the host's cover, else the programme head's poster. */
@Component({
  selector: 'app-party-cover',
  imports: [ResolveUrlPipe, PosterMosaicComponent],
  host: { class: 'block bg-base-300', '[style.view-transition-name]': 'viewTransitionName()' },
  templateUrl: './party-cover.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyCoverComponent {
  readonly cover = input.required<PartyCover>();
  /** What an automatic cover shows. */
  readonly head = input<PartyItem | null>(null);
  readonly viewTransitionName = input<string | null>(null);

  protected readonly posters = computed(() => coverPosters(this.cover()));
  protected readonly image = computed(() => coverImage(this.cover(), this.head()));
}
