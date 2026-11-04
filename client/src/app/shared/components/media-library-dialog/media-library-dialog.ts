import { Component, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { LibrariesApiService, type LibrarySummary } from '../../../core/services/api/libraries-api.service';
import { MediaService, type Media } from '../../../core/services/api/media.service';
import { ToastService } from '../../../core/services/toast.service';
import { MediaDetailLibraryModalComponent } from './media-detail-library-modal.component';

/** Moves a title to another library or folder and pins its metadata provider; shared by every title page. */
@Component({
  selector: 'app-media-library-dialog',
  imports: [MediaDetailLibraryModalComponent],
  templateUrl: './media-library-dialog.html',
})
export class MediaLibraryDialogComponent {
  readonly media = input.required<Media>();
  /** The title as saved. */
  readonly updated = output<Media>();

  private readonly modal = viewChild(MediaDetailLibraryModalComponent);
  private readonly mediaService = inject(MediaService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly libraries = signal<LibrarySummary[]>([]);
  protected readonly selectedLibraryId = signal<number | null>(null);
  protected readonly selectedFolderId = signal<number | null>(null);
  protected readonly selectedProvider = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly folders = computed(() => this.libraries().find((l) => l.id === this.selectedLibraryId())?.folders ?? []);

  open(): void {
    const m = this.media();
    this.selectedLibraryId.set(m.libraryId ?? null);
    this.selectedFolderId.set(null);
    this.selectedProvider.set(m.preferredProvider ?? null);
    this.saved.set(false);
    void this.librariesApi.listMine().then((l) => this.libraries.set(l), () => undefined);
    this.modal()?.showModal();
  }

  protected onLibraryChange(id: number | null): void {
    this.selectedLibraryId.set(id);
    this.selectedFolderId.set(null);
  }

  protected async save(): Promise<void> {
    const m = this.media();
    const libId = this.selectedLibraryId();
    if (libId == null) return;
    const provider = this.selectedProvider();
    this.saving.set(true);
    this.saved.set(false);
    try {
      const libraryChanged = libId !== m.libraryId;
      const folderId = this.selectedFolderId() ?? (libraryChanged ? this.folders()[0]?.id : null);
      let updated = m;
      if (folderId != null) {
        await this.mediaService.moveToFolder(m.id, folderId);
        this.toast.info(this.translate.instant('media_detail.move_started'));
      } else if (libraryChanged) {
        updated = await this.mediaService.patchLibrary(m.id, libId);
      }
      if ((m.preferredProvider ?? null) !== provider) {
        updated = await this.mediaService.update(m.id, { preferredProvider: provider });
      }
      this.updated.emit(updated);
      this.saved.set(true);
      setTimeout(() => this.saved.set(false), 3000);
    } finally {
      this.saving.set(false);
    }
  }
}
