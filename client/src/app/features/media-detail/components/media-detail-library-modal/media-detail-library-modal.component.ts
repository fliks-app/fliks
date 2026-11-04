import {
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import {
  LibraryFolderChoice,
  LibrarySummary,
} from '../../../../core/services/api/libraries-api.service';
import {
  MetadataService,
  ServingProvider,
  withStoredProvider,
} from '../../../../core/services/api/metadata.service';
import type { MediaType } from '../../../../core/enums/media-type.enum';
import { TvSelectDirective } from '../../../../shared/directives/tv-select.directive';
import { ModalHeaderComponent } from '../../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../../shared/components/modal-footer';

@Component({
  selector: 'app-media-detail-library-modal',
  imports: [
    ModalFooterComponent,
    TranslatePipe,
    FormsModule,
    TvSelectDirective,
    ModalHeaderComponent,
  ],
  templateUrl: './media-detail-library-modal.component.html',
})
export class MediaDetailLibraryModalComponent {
  readonly libraries = input<LibrarySummary[]>([]);
  readonly selectedLibraryId = input<number | null>(null);
  readonly kind = input.required<MediaType>();
  readonly selectedProvider = input<string | null>(null);
  readonly saving = input(false);
  readonly saved = input(false);
  /** Folders of the selected library; the choice shows when there are several. */
  readonly folders = input<LibraryFolderChoice[]>([]);
  /** `null` keeps the current folder (or takes the default one in another library). */
  readonly selectedFolderId = input<number | null>(null);
  readonly libraryChanged = input(false);

  readonly selectedLibraryIdChange = output<number | null>();
  readonly selectedFolderIdChange = output<number | null>();
  readonly selectedProviderChange = output<string | null>();
  readonly save = output<void>();

  private readonly metadata = inject(MetadataService);
  private readonly serving = signal<ServingProvider[]>([]);
  readonly providerOptions = computed(() => withStoredProvider(this.serving(), this.selectedProvider()));

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  showModal() {
    void this.metadata
      .providersServing(this.kind())
      .then((p) => this.serving.set(p))
      .catch(() => undefined);
    this.dialogEl()?.nativeElement.showModal();
  }

  close() {
    this.dialogEl()?.nativeElement.close();
  }
}
