import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideArrowRight, LucideCheck, LucideCircleAlert, LucideEyeOff } from '@lucide/angular';
import {
  MediaService,
  TrackingEpisode,
  TrackingStatus,
} from '../../../core/services/api/media.service';
import { ModalHeaderComponent } from '../modal-header';
import { ModalFooterComponent } from '../modal-footer';

export type TrackingScope =
  | { kind: 'movie' }
  | { kind: 'series' }
  | { kind: 'season'; seasonNumber: number }
  | { kind: 'episode'; episodeId: number };

@Component({
  selector: 'app-tracking-status-modal',
  standalone: true,
  imports: [
    ModalFooterComponent,
    NgTemplateOutlet,
    TranslatePipe,
    ModalHeaderComponent,
    LucideArrowRight,
    LucideCheck,
    LucideCircleAlert,
    LucideEyeOff,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tracking-status-modal.html',
})
export class TrackingStatusModalComponent {
  private readonly media = inject(MediaService);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  readonly loading = signal(false);
  readonly data = signal<TrackingStatus | null>(null);
  readonly scope = signal<TrackingScope>({ kind: 'series' });

  /** Open the modal for a media, scoped to the whole series / a season /
   *  a single episode / a movie. Fetches fresh tracking state each time. */
  async open(mediaId: number, scope: TrackingScope): Promise<void> {
    this.scope.set(scope);
    this.data.set(null);
    this.loading.set(true);
    this.dialog()?.nativeElement.showModal();
    try {
      this.data.set(await this.media.getTracking(mediaId));
    } catch {
      this.data.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  close(): void {
    this.dialog()?.nativeElement.close();
  }

  /** Seasons to render, filtered to the active scope. */
  readonly seasons = computed(() => {
    const d = this.data();
    if (!d?.seasons) return [];
    const sc = this.scope();
    if (sc.kind === 'season') {
      return d.seasons.filter((s) => s.seasonNumber === sc.seasonNumber);
    }
    if (sc.kind === 'episode') {
      for (const s of d.seasons) {
        const ep = s.episodes.find((e) => e.episodeId === sc.episodeId);
        if (ep) return [{ seasonNumber: s.seasonNumber, episodes: [ep] }];
      }
      return [];
    }
    return d.seasons;
  });

  episodeLabel(ep: TrackingEpisode): string {
    const s = String(ep.seasonNumber).padStart(2, '0');
    const e = String(ep.episodeNumber).padStart(2, '0');
    let code = `S${s}E${e}`;
    if (ep.endEpisodeNumber != null && ep.endEpisodeNumber > ep.episodeNumber) {
      code += `-E${String(ep.endEpisodeNumber).padStart(2, '0')}`;
    }
    return ep.title ? `${code} — ${ep.title}` : code;
  }
}
