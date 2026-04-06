import { ChangeDetectionStrategy, Component, inject, input, output, signal, OnInit } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FormsModule } from '@angular/forms';
import {
  LucideChevronLeft,
  LucideFilm,
  LucideTrash2,
  LucideEllipsisVertical,
  LucideDownload,
  LucideSearch,
  LucideSettings,
  LucideFolder,
  LucideRotateCcw,
  LucideFileText,
  LucideEyeOff,
  LucideEye,
  LucideCircleCheck,
} from '@lucide/angular';
import { Media } from '../../../../core/services/api/media.service';
import { PlayableMediaService } from '../../../../core/services/playable-media.service';
import { ConfirmationService } from '../../../../core/services/confirmation.service';
import type { MediaFileRow } from '../../media-detail.utils';
import { formatMediaDetailBytes } from '../../media-detail.utils';

@Component({
  selector: 'app-media-detail-header',
  imports: [
    DecimalPipe, FormsModule, RouterLink, TranslateModule,
    LucideChevronLeft, LucideFilm, LucideTrash2, LucideEllipsisVertical,
    LucideDownload, LucideSearch, LucideSettings, LucideFolder,
    LucideRotateCcw, LucideFileText, LucideEyeOff, LucideEye, LucideCircleCheck,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-header.component.html',
})
export class MediaDetailHeaderComponent implements OnInit {
  private readonly confirmation = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);
  readonly playable = inject(PlayableMediaService);
  readonly watched = signal(false);

  readonly media = input.required<Media>();
  readonly backRoute = input<string[]>(['/']);
  readonly canEditProfiles = input(false);
  readonly isAdmin = input(false);
  readonly refreshLoading = input(false);
  readonly monitoredLoading = input(false);
  readonly deleteLoading = input(false);
  readonly files = input<MediaFileRow[]>([]);
  readonly selectedFileId = input<number | null>(null);
  readonly canGrab = input(false);
  readonly releasesLoading = input(false);
  readonly grabBusy = input<string | null>(null);

  readonly openProfiles = output<void>();
  readonly openRootFolder = output<void>();
  readonly refreshMetadata = output<void>();
  readonly toggleMonitored = output<void>();
  readonly deleteMedia = output<void>();
  readonly selectedFileIdChange = output<number>();
  readonly loadReleases = output<void>();
  readonly grabBest = output<void>();
  readonly deleteFile = output<{ fileId: number; deleteOnDisk: boolean }>();
  readonly rescanFiles = output<void>();

  async ngOnInit() {
    const fileId = this.selectedFileId();
    if (fileId) this.watched.set(await this.playable.loadWatchedState(fileId));
  }

  async toggleWatched() {
    const fileId = this.selectedFileId();
    const m = this.media();
    if (!fileId || !m) return;
    try { this.watched.set(await this.playable.toggleWatched(fileId, m.id)); } catch { /* ignore */ }
  }

  formatBytes(bytes: number): string {
    return formatMediaDetailBytes(bytes);
  }

  async play(fromStart: boolean) {
    const fileId = this.selectedFileId();
    if (!fileId) return;
    const m = this.media();
    const file = this.files().find(f => f.id === fileId);
    await this.playable.play({
      fileId, mediaId: m.id, title: m.title,
      fanartUrl: m.posterUrl ?? null, streamInfo: file?.streamInfo,
    }, fromStart);
  }

  async onDeleteFileClick() {
    const fileId = this.selectedFileId();
    if (!fileId) return;
    const result = await this.confirmation.choose({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant('media_detail.confirm_delete_file_disk'),
      confirmLabel: this.translate.instant('media_detail.delete_file_disk'),
      cancelLabel: this.translate.instant('media_detail.untrack_file'),
      dismissLabel: this.translate.instant('common.cancel'),
      variant: 'danger',
    });
    if (result === null) return;
    this.deleteFile.emit({ fileId, deleteOnDisk: result });
  }
}
