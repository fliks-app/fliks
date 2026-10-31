import {
  Component,
  inject,
  input,
  signal,
  computed,
  OnInit,
} from '@angular/core';
import { MetadataService } from '../../core/services/api/metadata.service';
import { MediaType } from '../../core/enums/media-type.enum';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';

/** Per-process metadata detail cache so `app-request-poster` instances on one row share one round-trip; holds the in-flight promise to avoid races. */
const detailsCache = new Map<
  string,
  Promise<{ posterUrl: string | null; fanartUrl: string | null }>
>();

@Component({
  selector: 'app-request-poster',
  imports: [ResolveUrlPipe],
  host: { class: 'block w-full h-full min-h-0' },
  templateUrl: './request-poster.html',
})
export class RequestPosterComponent implements OnInit {
  private readonly metadata = inject(MetadataService);

  readonly tmdbId = input.required<number>();
  readonly mediaType = input.required<MediaType>();
  readonly titleText = input<string>('');
  /** `poster` shows the portrait with a placeholder fallback; `backdrop` shows landscape fanart with no fallback, silent when empty. */
  readonly mode = input<'poster' | 'backdrop'>('poster');
  /** Pre-resolved local art: when the current mode's URL is given it renders directly and skips the metadata lookup. */
  readonly poster = input<string | null>(null);
  readonly fanart = input<string | null>(null);

  private readonly fetchedPoster = signal<string | null>(null);
  private readonly fetchedFanart = signal<string | null>(null);
  readonly loaded = signal(false);

  readonly imageUrl = computed(() =>
    this.mode() === 'backdrop'
      ? (this.fanart() ?? this.fetchedFanart())
      : (this.poster() ?? this.fetchedPoster()),
  );

  async ngOnInit() {
    const provided =
      this.mode() === 'backdrop' ? this.fanart() : this.poster();
    if (provided) {
      this.loaded.set(true);
      return;
    }
    const key = `${this.mediaType()}:${this.tmdbId()}`;
    let promise = detailsCache.get(key);
    if (!promise) {
      promise = this.metadata
        .detailsByKind(this.mediaType(), this.tmdbId())
        .then((d) => ({ posterUrl: d.posterUrl, fanartUrl: d.fanartUrl }))
        .catch(() => ({ posterUrl: null, fanartUrl: null }));
      detailsCache.set(key, promise);
    }
    const details = await promise;
    this.fetchedPoster.set(details.posterUrl);
    this.fetchedFanart.set(details.fanartUrl);
    this.loaded.set(true);
  }
}
