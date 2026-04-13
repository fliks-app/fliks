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
import { Library } from '../../../../core/services/api/libraries-api.service';

/**
 * Retained filename for historical reasons — now a library picker.
 * Backend resolves the actual filesystem path inside the chosen library.
 */
@Component({
  selector: 'app-media-detail-root-folder-modal',
  imports: [TranslateModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-root-folder-modal.component.html',
})
export class MediaDetailRootFolderModalComponent {
  readonly libraries = input<Library[]>([]);
  readonly selectedLibraryId = input<number | null>(null);
  readonly pathSaving = input(false);
  readonly pathOk = input(false);

  readonly selectedLibraryIdChange = output<number | null>();
  readonly save = output<void>();

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  showModal() {
    this.dialogEl()?.nativeElement.showModal();
  }
}
