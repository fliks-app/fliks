import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { CastService } from '../../../../core/services/cast.service';
import { CastPlayerService } from '../../../../core/services/cast-player.service';
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
} from '@lucide/angular';
import { Media } from '../../../../core/services/api/media.service';
import { ConfirmationService } from '../../../../core/services/confirmation.service';
import type { MediaFileRow } from '../../media-detail.utils';
import { formatMediaDetailBytes } from '../../media-detail.utils';

@Component({
  selector: 'app-media-detail-header',
  imports: [
    DecimalPipe, FormsModule, RouterLink, TranslateModule,
    LucideChevronLeft, LucideFilm, LucideTrash2, LucideEllipsisVertical,
    LucideDownload, LucideSearch, LucideSettings, LucideFolder,
    LucideRotateCcw, LucideFileText, LucideEyeOff, LucideEye,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-header.component.html',
})
export class MediaDetailHeaderComponent {
  private readonly confirmation = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);
  readonly castService = inject(CastService);
  private readonly castPlayer = inject(CastPlayerService);

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
  readonly rescanLoading = input(false);

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

  formatBytes(bytes: number): string {
    return formatMediaDetailBytes(bytes);
  }

  async play(fromStart: boolean) {
    const fileId = this.selectedFileId();
    if (!fileId) return;
    const m = this.media();

    if (this.castService.isConnected()) {
      const file = this.files().find(f => f.id === fileId);
      await this.castPlayer.quickStart({
        mediaFileId: fileId,
        mediaId: m.id,
        title: m.title,
        fanartUrl: m.posterUrl ?? null,
        streamInfo: file?.streamInfo,
        startTime: fromStart ? 0 : undefined,
      });
      this.castPlayer.expanded.set(true);
    } else {
      const qp: any = { mediaId: m.id };
      if (fromStart) qp.t = 0;
      this.router.navigate(['/watch', fileId], { queryParams: qp });
    }
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
