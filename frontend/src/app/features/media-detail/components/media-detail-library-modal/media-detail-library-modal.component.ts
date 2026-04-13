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

@Component({
  selector: 'app-media-detail-library-modal',
  imports: [TranslateModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-library-modal.component.html',
})
export class MediaDetailLibraryModalComponent {
  readonly libraries = input<Library[]>([]);
  readonly selectedLibraryId = input<number | null>(null);
  readonly saving = input(false);
  readonly saved = input(false);

  readonly selectedLibraryIdChange = output<number | null>();
  readonly save = output<void>();

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  showModal() {
    this.dialogEl()?.nativeElement.showModal();
  }
}
