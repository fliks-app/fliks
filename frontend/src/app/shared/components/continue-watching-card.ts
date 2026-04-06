import { Component, ChangeDetectionStrategy, input, inject, output } from '@angular/core';
import { Router } from '@angular/router';
import { LucideFilm, LucidePlay, LucideX } from '@lucide/angular';
import { CastService } from '../../core/services/cast.service';
import { CastPlayerService } from '../../core/services/cast-player.service';
import { ContinueWatchingItem } from '../../core/services/api/streaming-api.service';

@Component({
  selector: 'app-continue-watching-card',
  imports: [LucideFilm, LucidePlay, LucideX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="shrink-0 w-56 sm:w-64 group relative">
      <button type="button" (click)="play()" class="block w-full cursor-pointer text-left">
        <figure class="relative aspect-video bg-base-300 rounded-lg overflow-hidden shadow-md transition-shadow duration-200 ease-out group-hover:shadow-xl">
          @if (item().fanartUrl) {
            <img [src]="item().fanartUrl" [alt]="item().mediaTitle" class="w-full h-full object-cover" loading="lazy" />
          } @else if (item().posterUrl) {
            <img [src]="item().posterUrl" [alt]="item().mediaTitle" class="w-full h-full object-cover" loading="lazy" />
          } @else {
            <div class="flex items-center justify-center w-full h-full text-base-content/30">
              <svg lucideFilm class="h-10 w-10" [strokeWidth]="1.5"></svg>
            </div>
          }
          <div class="absolute inset-x-0 bottom-0 h-1/2 bg-linear-to-t from-black/80 to-transparent"></div>
          <div class="absolute bottom-2 left-2.5 right-2.5">
            <p class="text-sm font-semibold text-white line-clamp-1">{{ item().mediaTitle }}</p>
            @if (item().episodeLabel) {
              <p class="text-xs text-white/70 line-clamp-1">{{ item().episodeLabel }}</p>
            }
          </div>
          <!-- Overlay (style proche media-card) -->
          <div
            class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity duration-200 ease-out group-hover:pointer-events-auto group-hover:opacity-100"
          >
            <div
              class="pointer-events-none flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-0 bg-black/50 text-white transition-all duration-200 ease-out group-hover:scale-105 group-hover:bg-black/65"
            >
              <svg lucidePlay class="h-8 w-8" [strokeWidth]="2"></svg>
            </div>
          </div>
          <div class="absolute bottom-0 left-0 right-0 h-1 bg-black/50">
            <div class="h-full bg-primary" [style.width.%]="item().progressPercent"></div>
          </div>
        </figure>
      </button>
      <button
        type="button"
        class="absolute top-2 right-2 z-10 btn btn-circle btn-sm cursor-pointer border-0 bg-black/50 text-white opacity-0 transition-all duration-200 ease-out hover:bg-black/65 group-hover:opacity-100"
        (click)="remove.emit(item()); $event.stopPropagation()"
        aria-label="Remove"
      >
        <svg lucideX class="h-4 w-4" [strokeWidth]="2"></svg>
      </button>
    </div>
  `,
})
export class ContinueWatchingCardComponent {
  private readonly router = inject(Router);
  private readonly castService = inject(CastService);
  private readonly castPlayer = inject(CastPlayerService);

  readonly item = input.required<ContinueWatchingItem>();
  readonly remove = output<ContinueWatchingItem>();

  async play() {
    const i = this.item();
    if (this.castService.isConnected()) {
      await this.castPlayer.quickStart({
        mediaFileId: i.mediaFileId,
        mediaId: i.mediaId,
        episodeId: i.episodeId ?? undefined,
        title: i.mediaTitle,
        episodeTitle: i.episodeLabel ?? undefined,
        fanartUrl: i.posterUrl,
      });
      this.castPlayer.expanded.set(true);
    } else {
      const qp: Record<string, number> = { mediaId: i.mediaId };
      if (i.episodeId) qp['episodeId'] = i.episodeId;
      this.router.navigate(['/watch', i.mediaFileId], { queryParams: qp });
    }
  }
}
