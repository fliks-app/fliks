import { Component, ChangeDetectionStrategy, input, output, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgClass } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { LucideFilm, LucidePlay, LucideEye, LucideEyeOff } from '@lucide/angular';
import { Media } from '../../core/services/api/media.service';
import { PlayableMediaService } from '../../core/services/playable-media.service';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { pickPlayContext } from '../utils/media-play.util';

export type MediaStatus =
  | 'downloaded-monitored'
  | 'downloaded-unmonitored'
  | 'missing-monitored'
  | 'missing-unmonitored'
  | 'queued'
  | 'unreleased';

export type MediaCardVariant = 'grid' | 'poster';

@Component({
  selector: 'app-media-card',
  imports: [RouterLink, NgClass, TranslateModule, ResolveUrlPipe, LucideFilm, LucidePlay, LucideEye, LucideEyeOff],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-card.html',
})
export class MediaCardComponent {
  private readonly playable = inject(PlayableMediaService);

  readonly media = input.required<Media>();
  /** From GET /api/playback/watched-ids (fully watched movie or full series). */
  readonly watched = input(false);
  readonly watchedChange = output<void>();
  /** `grid`: liste films/séries ; `poster`: bandeau horizontal (accueil). */
  readonly variant = input<MediaCardVariant>('grid');
  /** When set, replaces the status/quality subtitle line. */
  readonly subtitle = input<string | undefined>(undefined);

  readonly isPoster = computed(() => this.variant() === 'poster');

  readonly detailLink = computed(() => [
    '/',
    this.media().type === 'movie' ? 'movies' : 'series',
    String(this.media().id),
  ]);

  readonly canPlay = computed(() => pickPlayContext(this.media()) != null);

  readonly mediaStatus = computed<MediaStatus>(() => {
    const m = this.media();
    const hasFiles = m.type === 'series'
      ? (m.episodeStats?.downloadedEpisodes ?? 0) > 0
      : (m.files?.length ?? 0) > 0;
    const isReleased = this.isReleased(m);

    if (hasFiles && m.monitored) return 'downloaded-monitored';
    if (hasFiles && !m.monitored) return 'downloaded-unmonitored';
    if (!isReleased) return 'unreleased';
    if (m.monitored) return 'missing-monitored';
    return 'missing-unmonitored';
  });

  readonly barColorClass = computed(() => {
    const map: Record<MediaStatus, string> = {
      'downloaded-monitored': 'bg-green-500',
      'downloaded-unmonitored': 'bg-green-800',
      'missing-monitored': 'bg-red-500',
      'missing-unmonitored': 'bg-amber-500',
      'queued': 'bg-purple-500',
      'unreleased': 'bg-blue-400',
    };
    return map[this.mediaStatus()];
  });

  readonly barPercent = computed(() => {
    const m = this.media();
    if (m.type === 'series' && m.episodeStats) {
      const { totalEpisodes, downloadedEpisodes } = m.episodeStats;
      return totalEpisodes > 0 ? (downloadedEpisodes / totalEpisodes) * 100 : 0;
    }
    return 100;
  });

  readonly statusLabel = computed(() => {
    const m = this.media();
    return m.monitored ? 'media_card.monitored' : 'media_card.unmonitored';
  });

  readonly qualityLabel = computed(() => {
    return this.media().qualityProfile?.name ?? '';
  });

  private isReleased(m: Media): boolean {
    if (m.type === 'series') {
      return m.status === 'continuing' || m.status === 'ended';
    }
    const now = new Date();
    const dates = [m.releaseDate, m.inCinemas, m.digitalRelease, m.physicalRelease];
    return dates.some((d) => d && new Date(d) <= now);
  }

  async play(ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    const ctx = pickPlayContext(this.media());
    if (!ctx) return;
    await this.playable.play(ctx, false);
  }

  async toggleWatchedMovie(ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    const m = this.media();
    if (m.type !== 'movie') return;
    const ctx = pickPlayContext(m);
    if (!ctx) return;
    try {
      await this.playable.toggleWatched(ctx.fileId, m.id);
      this.watchedChange.emit();
    } catch {
      /* ignore */
    }
  }
}
