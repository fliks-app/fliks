import { Component, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { MediaCollection, RelatedMedia } from '../../../core/services/api/media.service';
import { LikesApiService } from '../../../core/services/api/likes-api.service';
import { TranslatePipe } from '@ngx-translate/core';
import { DetailHeroComponent } from '../../../shared/components/detail-hero/detail-hero';
import { DetailSectionComponent } from '../../../shared/components/detail-section/detail-section';
import { DownloadDetailModalComponent } from '../../../shared/components/download-detail-modal/download-detail-modal';
import { DownloadQualityModalComponent } from '../../../shared/components/download-quality-modal/download-quality-modal';
import { HorizontalScrollerComponent } from '../../../shared/components/horizontal-scroller';
import { MediaCardComponent } from '../../../shared/components/media-card/media-card';
import { MediaFileInfoComponent } from '../../../shared/components/media-file-info';
import { MediaInfoExtraComponent } from '../../../shared/components/media-info-extra/media-info-extra';
import { SubtitlesModalComponent } from '../../../shared/components/subtitles-modal/subtitles-modal';
import { LikeController } from '../../../shared/utils/like-controller';
import { MediaCastComponent } from '../components/media-cast/media-cast.component';
import { VideoWorkBase } from '../video-work';

/** The page of a movie, rendered by the media detail shell for the `movie` kind. */
@Component({
  selector: 'app-movie-work',
  imports: [
    NgTemplateOutlet,
    TranslatePipe,
    DetailHeroComponent,
    DetailSectionComponent,
    DownloadDetailModalComponent,
    DownloadQualityModalComponent,
    HorizontalScrollerComponent,
    MediaCardComponent,
    MediaCastComponent,
    MediaFileInfoComponent,
    MediaInfoExtraComponent,
    SubtitlesModalComponent,
  ],
  templateUrl: './movie-work.component.html',
  host: { class: 'flex flex-col' },
})
export class MovieWorkComponent extends VideoWorkBase {
  protected readonly like = new LikeController(
    { media: () => this.media(), episodeMode: () => false, focusedEpisode: () => null },
    inject(LikesApiService),
  );
  protected readonly similar = signal<RelatedMedia[]>([]);
  protected readonly collection = signal<MediaCollection | null>(null);

  protected override onTitleChange(): void {
    this.similar.set([]);
    this.collection.set(null);
  }

  protected override loadRelated(id: number): void {
    this.mediaService.getSimilar(id).then((s) => this.media().id === id && this.similar.set(s)).catch(() => {});
    this.mediaService.getCollection(id).then((c) => this.media().id === id && this.collection.set(c)).catch(() => {});
  }
}
