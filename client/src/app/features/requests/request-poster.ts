import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
  signal,
  computed,
  OnInit,
} from '@angular/core';
import { MetadataService } from '../../core/services/api/metadata.service';
import { MediaType } from '../../core/enums/media-type.enum';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';

/** Per-process cache for the metadata detail fetch — multiple instances of
 *  `app-request-poster` on the same row (poster chip + mobile backdrop)
 *  share one HTTP round-trip. Holds the in-flight promise so concurrent
 *  ngOnInit calls don't race. */
const detailsCache = new Map<
  string,
  Promise<{ posterUrl: string | null; fanartUrl: string | null }>
>();

@Component({
  selector: 'app-request-poster',
  imports: [ResolveUrlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block w-full h-full min-h-0' },
  template: `
    @if (imageUrl()) {
      <img
        [src]="imageUrl()! | resolveUrl: (mode() === 'backdrop' ? 'medium' : 'thumb')"
        [alt]="titleText()"
        class="w-full h-full object-cover"
        loading="lazy"
      />
    } @else if (loaded() && mode() === 'poster') {
      <div
        class="flex items-center justify-center w-full h-full min-h-[10rem] bg-base-300 text-base-content/25"
        aria-hidden="true"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="h-14 w-14"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.5"
            d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"
          />
        </svg>
      </div>
    } @else if (!loaded() && mode() === 'poster') {
      <div class="skeleton w-full h-full min-h-[10rem] rounded-none"></div>
    }
  `,
})
export class RequestPosterComponent implements OnInit {
  private readonly metadata = inject(MetadataService);

  readonly tmdbId = input.required<number>();
  readonly mediaType = input.required<MediaType>();
  readonly titleText = input<string>('');
  /** `poster` (default) shows the title's portrait poster with a placeholder
   *  fallback when no art is available; `backdrop` shows the landscape fanart
   *  with no fallback — meant to sit behind a gradient and stay silent when
   *  there's nothing to render. */
  readonly mode = input<'poster' | 'backdrop'>('poster');
  /** Pre-resolved art (the request row's local `/api/images` paths). When the
   *  current mode's URL is provided, the component renders it directly and
   *  skips the metadata lookup entirely. */
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
      promise = (
        this.mediaType() === 'movie'
          ? this.metadata.getMovieDetails(this.tmdbId())
          : this.metadata.getTvDetails(this.tmdbId())
      )
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
