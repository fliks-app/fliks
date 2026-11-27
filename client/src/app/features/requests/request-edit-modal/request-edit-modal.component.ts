import {
  Component,
  ElementRef,
  computed,
  input,
  output,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';
import { TranslatePipe } from '@ngx-translate/core';
import { FliksRequestRow } from '../../../core/services/api/requests.service';
import { LibrarySummary } from '../../../core/services/api/libraries-api.service';
import type { WantSpec } from '../../../core/services/api/wants-api.service';
import { LibraryFolderSelectComponent } from '../../../shared/components/library-folder-select/library-folder-select';
import { WantsEditorComponent } from '../../../shared/components/wants-editor/wants-editor';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../shared/components/modal-footer';
import { ModalComponent } from '../../../shared/components/modal';

@Component({
  selector: 'app-request-edit-modal',
  imports: [ModalComponent, TvSelectDirective, WantsEditorComponent, LibraryFolderSelectComponent, ModalFooterComponent, ModalHeaderComponent, FormsModule, TranslatePipe],
  templateUrl: './request-edit-modal.component.html',
})
export class RequestEditModalComponent {
  readonly row = input<FliksRequestRow | null>(null);
  readonly qualityProfiles = input<{ id: number; name: string }[]>([]);
  readonly languageProfiles = input<{ id: number; name: string }[]>([]);
  /** Libraries compatible with this request's media type that the caller can
   *  target — the picker is offered only when more than one is available. */
  readonly libraries = input<LibrarySummary[]>([]);
  readonly qualityProfileId = input<number | null>(null);
  readonly languageProfileId = input<number | null>(null);
  readonly libraryId = input<number | null>(null);
  readonly wants = input<WantSpec[]>([]);
  readonly saving = input(false);
  readonly mode = input<'edit' | 'approve'>('edit');
  readonly folderId = input<number | null>(null);
  readonly monitorNewSeasons = input(true);
  protected readonly folders = computed(() => this.libraries().find((l) => l.id === this.libraryId())?.folders ?? []);

  readonly qualityProfileIdChange = output<number | null>();
  readonly languageProfileIdChange = output<number | null>();
  readonly libraryIdChange = output<number | null>();
  readonly folderIdChange = output<number | null>();
  readonly monitorNewSeasonsChange = output<boolean>();
  readonly wantsChange = output<WantSpec[]>();
  readonly dismissed = output<void>();
  readonly save = output<void>();

  private readonly dialogEl = viewChild<string, ElementRef<HTMLDialogElement>>('dialog', { read: ElementRef });

  showModal() {
    this.dialogEl()?.nativeElement.showModal();
  }

  close() {
    this.dialogEl()?.nativeElement.close();
  }
}
