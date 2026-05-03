import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
  signal,
  OnInit,
} from '@angular/core';
import { MetadataService } from '../../core/services/api/metadata.service';
import { MediaType } from '../../core/enums/media-type.enum';

@Component({
  selector: 'app-request-poster',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block w-full h-full min-h-0' },
  template: `
    @if (posterUrl()) {
      <img
        [src]="posterUrl()!"
        [alt]="titleText()"
        class="w-full h-full object-cover"
        loading="lazy"
      />
    } @else if (loaded()) {
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
    } @else {
      <div class="skeleton w-full h-full min-h-[10rem] rounded-none"></div>
    }
  `,
})
export class RequestPosterComponent implements OnInit {
  private readonly metadata = inject(MetadataService);

  readonly tmdbId = input.required<number>();
  readonly mediaType = input.required<MediaType>();
  readonly titleText = input<string>('');

  readonly posterUrl = signal<string | null>(null);
  readonly loaded = signal(false);

  async ngOnInit() {
    try {
      const details =
        this.mediaType() === 'movie'
          ? await this.metadata.getMovieDetails(this.tmdbId())
          : await this.metadata.getTvDetails(this.tmdbId());
      this.posterUrl.set(details.posterUrl);
    } catch {
      /* keep poster empty */
    } finally {
      this.loaded.set(true);
    }
  }
}
