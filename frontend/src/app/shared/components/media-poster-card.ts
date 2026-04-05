import { Component, ChangeDetectionStrategy, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideFilm } from '@lucide/angular';

@Component({
  selector: 'app-media-poster-card',
  imports: [RouterLink, LucideFilm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a [routerLink]="link()" class="block shrink-0 w-28 sm:w-36 group">
      <figure class="relative aspect-[2/3] bg-base-300 rounded-lg overflow-hidden shadow-md group-hover:shadow-xl transition-shadow">
        @if (posterUrl()) {
          <img [src]="posterUrl()" [alt]="title()" class="w-full h-full object-cover" loading="lazy" />
        } @else {
          <div class="flex items-center justify-center w-full h-full text-base-content/30">
            <svg lucideFilm class="h-10 w-10" [strokeWidth]="1.5"></svg>
          </div>
        }
      </figure>
      <p class="text-sm font-medium mt-1.5 line-clamp-1 text-center">{{ title() }}</p>
      @if (subtitle()) {
        <p class="text-xs text-base-content/50 line-clamp-1 text-center">{{ subtitle() }}</p>
      }
    </a>
  `,
})
export class MediaPosterCardComponent {
  readonly posterUrl = input<string | null>(null);
  readonly title = input('');
  readonly subtitle = input('');
  readonly link = input<string[]>([]);
}
