import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FormsModule } from '@angular/forms';
import { Media } from '../../../../core/services/api/media.service';
import { ConfirmationService } from '../../../../core/services/confirmation.service';
import type { MediaFileRow } from '../../media-detail.utils';
import { formatMediaDetailBytes } from '../../media-detail.utils';

@Component({
  selector: 'app-media-detail-header',
  imports: [DecimalPipe, FormsModule, RouterLink, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-header.component.html',
})
export class MediaDetailHeaderComponent {
  private readonly confirmation = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);

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
