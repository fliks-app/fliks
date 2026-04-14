import { Component, ChangeDetectionStrategy, input, output, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { NgClass, DecimalPipe } from '@angular/common';
import { TranslateService } from '@ngx-translate/core';
import { LucideFilm, LucidePlay, LucideStar, LucideCheck, LucideClock, LucideX, LucideCircleCheck, LucideCircleX } from '@lucide/angular';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { Media } from '../../../core/services/api/media.service';
import { Capacitor } from '@capacitor/core';
import { computeMediaBarStatus, computeMediaBarPercent } from '../../utils/media-status.util';

export type MediaCardAspect = 'portrait' | 'landscape';

export type BarStatus =
  | 'downloaded-monitored'
  | 'downloaded-unmonitored'
  | 'missing-monitored'
  | 'missing-unmonitored'
  | 'unreleased'
  | 'queued';

export type CardBadge = 'library' | 'pending' | 'declined' | null;
export type CardStatus = 'watched' | 'missing' | null;

@Component({
  selector: 'app-media-card',
  imports: [RouterLink, NgClass, DecimalPipe, ResolveUrlPipe,
    LucideFilm, LucidePlay, LucideStar, LucideCheck, LucideClock, LucideX, LucideCircleCheck, LucideCircleX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-card.html',
})
export class MediaCardComponent {
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);
  protected readonly isNative = Capacitor.isNativePlatform();

  // Data source (auto-derives imageUrl, title, rating, link, playable, barStatus, barPercent)
  readonly media = input<Media | null>(null);

  // Layout
  readonly aspect = input<MediaCardAspect>('portrait');

  // Image (override media.posterUrl)
  readonly imageUrl = input<string | null>(null);
  readonly imageBlurred = input(false);

  // Text (override media.title / media.rating)
  readonly title = input('');
  readonly subtitle = input<string | undefined>(undefined);
  readonly rating = input(0);

  // Badges
  readonly topLeftBadge = input<string | undefined>(undefined);
  readonly badge = input<CardBadge>(null);
  readonly status = input<CardStatus>(null);

  // Navigation (override media-derived link)
  readonly link = input<string[] | null>(null);
  readonly subtitleLink = input<string[] | null>(null);
  readonly playable = input(false);

  // Progress
  readonly progressPercent = input(0);

  // Status bar (override media-derived barStatus/barPercent)
  readonly barStatus = input<BarStatus | null>(null);
  readonly barPercent = input(100);
  /** Hide the colored status bar entirely. */
  readonly hideStatusBar = input(false);

  // State
  readonly dimmed = input(false);
  readonly dismissable = input(false);

  // Events
  readonly clicked = output<void>();
  readonly played = output<void>();
  readonly dismissed = output<void>();

  // Resolved template values (explicit input wins over media-derived default)
  protected readonly _img = computed(() => this.imageUrl() ?? this.media()?.posterUrl ?? null);
  protected readonly _title = computed(() => this.title() || this.media()?.title || '');
  protected readonly _rating = computed(() => this.rating() || this.media()?.rating || 0);
  protected readonly _link = computed(() => {
    if (this.link()) return this.link();
    const m = this.media();
    return m ? ['/' + (m.type === 'movie' ? 'movies' : 'series'), '' + m.id] : null;
  });
  protected readonly _playable = computed(() => {
    if (this.playable()) return true;
    const m = this.media();
    return m ? !!(m.files?.length) : false;
  });
  protected readonly _subtitle = computed(() => {
    if (this.subtitle() !== undefined) return this.subtitle();
    const m = this.media();
    if (m?.year) return '' + m.year;
    return undefined;
  });
  protected readonly _barStatus = computed((): BarStatus | null => {
    if (this.hideStatusBar()) return null;
    if (this.barStatus()) return this.barStatus();
    const m = this.media();
    return m ? computeMediaBarStatus(m) : null;
  });
  protected readonly _barPercent = computed(() => {
    if (!this.barStatus() && this.media()) return computeMediaBarPercent(this.media()!);
    return this.barPercent();
  });

  protected onCardClick() {
    const link = this._link();
    if (link) void this.router.navigate(link);
    this.clicked.emit();
  }

  protected onPlayClick(event: Event) {
    event.stopPropagation();
    this.played.emit();
    this.clicked.emit();
    const m = this.media();
    if (m?.files?.length) {
      const file = m.files[0];
      const qp: Record<string, number> = { mediaId: m.id };
      if (file.episodeId) qp['episodeId'] = file.episodeId;
      void this.router.navigate(['/watch', file.id], { queryParams: qp });
    }
  }

  /** Status badge shown in the top-left corner of the poster. */
  protected readonly statusBadge = computed((): { text: string; class: string } | null => {
    const s = this._barStatus();
    if (!s) return null;
    switch (s) {
      case 'missing-monitored':
        return { text: this.translate.instant('media_card.monitored'), class: 'badge-warning' };
      case 'missing-unmonitored':
        return { text: this.translate.instant('media_card.unmonitored'), class: 'badge-error' };
      case 'unreleased':
        return { text: this.translate.instant('media_card.unreleased'), class: 'badge-info' };
      case 'queued':
        return { text: this.translate.instant('media_card.queued'), class: 'badge-secondary' };
      default:
        return null;
    }
  });
}
