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
import { LibrarySummary } from '../../../../core/services/api/libraries-api.service';
import { METADATA_PROVIDER_OPTIONS_OVERRIDE } from '../../../../core/constants/metadata-providers';
import { TvSelectDirective } from '../../../../shared/directives/tv-select.directive';
import { ModalHeaderComponent } from '../../../../shared/components/modal-header';

@Component({
  selector: 'app-media-detail-library-modal',
  imports: [TranslateModule, FormsModule, TvSelectDirective, ModalHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-library-modal.component.html',
})
export class MediaDetailLibraryModalComponent {
  readonly libraries = input<LibrarySummary[]>([]);
  readonly selectedLibraryId = input<number | null>(null);
  readonly selectedProvider = input<'tmdb' | 'tvdb' | null>(null);
  readonly saving = input(false);
  readonly saved = input(false);

  readonly selectedLibraryIdChange = output<number | null>();
  readonly selectedProviderChange = output<'tmdb' | 'tvdb' | null>();
  readonly save = output<void>();

  readonly providerOptions = METADATA_PROVIDER_OPTIONS_OVERRIDE;

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  showModal() {
    this.dialogEl()?.nativeElement.showModal();
  }

  close() {
    this.dialogEl()?.nativeElement.close();
  }
}
