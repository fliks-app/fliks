import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { RootFolder } from '../../../../core/services/api/root-folders-api.service';

@Component({
  selector: 'app-media-detail-root-folder-modal',
  imports: [TranslateModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-root-folder-modal.component.html',
})
export class MediaDetailRootFolderModalComponent {
  readonly rootFolders = input<RootFolder[]>([]);
  readonly selectedRootFolderId = input<number | null>(null);
  readonly pathSaving = input(false);
  readonly pathOk = input(false);

  readonly selectedRootFolderIdChange = output<number | null>();
  readonly save = output<void>();

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  showModal() {
    this.dialogEl()?.nativeElement.showModal();
  }
}
