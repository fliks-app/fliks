import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  output,
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucideTrash2 } from '@lucide/angular';
import { ConfirmationService } from '../../../../core/services/confirmation.service';
import { formatMediaDetailBytes } from '../../media-detail.utils';
import * as pathUtil from '../../media-detail.utils';

export interface FileRow {
  id: number;
  quality: string;
  relativePath: string;
  size: number;
}

@Component({
  selector: 'app-media-detail-files',
  imports: [TranslateModule, LucideTrash2],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-files.component.html',
})
export class MediaDetailFilesComponent {
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);

  readonly files = input<FileRow[]>([]);
  readonly rootPath = input<string | null>(null);
  readonly canGrab = input(false);
  readonly releasesLoading = input(false);
  readonly grabBusy = input<string | null>(null);
  readonly showGrabButtons = input(false);

  readonly deleteFile = output<{ fileId: number; deleteOnDisk: boolean }>();
  readonly loadReleases = output<void>();
  readonly grabBest = output<void>();

  async onDeleteClick(fileId: number) {
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

  formatBytes(bytes: number): string {
    return formatMediaDetailBytes(bytes);
  }

  fileDiskPath(relativePath: string): string {
    return pathUtil.displayMediaFilePath(this.rootPath(), relativePath);
  }
}
