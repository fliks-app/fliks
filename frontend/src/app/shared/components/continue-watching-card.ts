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
      <button (click)="play()" class="block w-full text-left">
        <figure class="relative aspect-video bg-base-300 rounded-lg overflow-hidden shadow-md group-hover:shadow-xl transition-shadow">
          @if (item().fanartUrl) {
            <img [src]="item().fanartUrl" [alt]="item().mediaTitle" class="w-full h-full object-cover" loading="lazy" />
          } @else if (item().posterUrl) {
            <img [src]="item().posterUrl" [alt]="item().mediaTitle" class="w-full h-full object-cover" loading="lazy" />
          } @else {
            <div class="flex items-center justify-center w-full h-full text-base-content/30">
              <svg lucideFilm class="h-10 w-10" [strokeWidth]="1.5"></svg>
            </div>
          }
          <!-- Gradient overlay for text readability -->
          <div class="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/80 to-transparent"></div>
          <!-- Title over image -->
          <div class="absolute bottom-2 left-2.5 right-2.5">
            <p class="text-sm font-semibold text-white line-clamp-1">{{ item().mediaTitle }}</p>
            @if (item().episodeLabel) {
              <p class="text-xs text-white/70 line-clamp-1">{{ item().episodeLabel }}</p>
            }
          </div>
          <!-- Play overlay on hover -->
          <div class="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity">
            <svg lucidePlay class="h-8 w-8 text-white"></svg>
          </div>
          <!-- Progress bar -->
          <div class="absolute bottom-0 left-0 right-0 h-1 bg-black/50">
            <div class="h-full bg-primary" [style.width.%]="item().progressPercent"></div>
          </div>
        </figure>
      </button>
      <!-- Remove button -->
      <button
        class="absolute top-1.5 right-1.5 btn btn-circle btn-xs bg-black/60 border-0 text-white opacity-0 group-hover:opacity-100 transition-opacity"
        (click)="remove.emit(item()); $event.stopPropagation()"
      >
        <svg lucideX class="h-3 w-3"></svg>
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
      const qp: any = { mediaId: i.mediaId };
      if (i.episodeId) qp.episodeId = i.episodeId;
      this.router.navigate(['/watch', i.mediaFileId], { queryParams: qp });
    }
  }
}
