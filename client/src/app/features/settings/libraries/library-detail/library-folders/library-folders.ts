import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  CdkDrag,
  CdkDragDrop,
  CdkDragHandle,
  CdkDropList,
} from '@angular/cdk/drag-drop';
import {
  LucideArrowDown,
  LucideArrowUp,
  LucideGripVertical,
  LucidePencil,
  LucideTrash2,
} from '@lucide/angular';
import {
  LibrariesApiService,
  LibraryFolder,
} from '../../../../../core/services/api/libraries-api.service';
import { ConfirmationService } from '../../../../../core/services/confirmation.service';
import { FolderPickerService } from '../../../../../core/services/folder-picker.service';
import { ToastService } from '../../../../../core/services/toast.service';
import { formatBytes } from '../../../../../core/utils/format-bytes';
import { serverMessage } from '../../../../../core/utils/server-message';
import { ModalFooterComponent } from '../../../../../shared/components/modal-footer';
import { ModalHeaderComponent } from '../../../../../shared/components/modal-header';
import { LibraryDetailState } from '../library-detail.state';

const isFolderInUse = (err: unknown): boolean => {
  const body = (err as { error?: { code?: string; message?: string } })?.error;
  return body?.code === 'folder_in_use' || body?.message === 'errors.folder_in_use';
};

/** The folders of a saved library. Every edit is its own request; the server stays the source of truth and the list is re-read after each one. */
@Component({
  selector: 'app-library-folders',
  imports: [
    FormsModule,
    TranslatePipe,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    LucideArrowDown,
    LucideArrowUp,
    LucideGripVertical,
    LucidePencil,
    LucideTrash2,
    ModalFooterComponent,
    ModalHeaderComponent,
  ],
  templateUrl: './library-folders.html',
})
export class LibraryFoldersComponent {
  private readonly api = inject(LibrariesApiService);
  private readonly picker = inject(FolderPickerService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  readonly state = inject(LibraryDetailState);

  private readonly inUseDialog = viewChild<ElementRef<HTMLDialogElement>>('inUseDialog');

  protected readonly formatBytes = formatBytes;
  readonly folders = computed(() => this.state.library()?.folders ?? []);
  readonly busy = signal(false);
  readonly newPath = signal('');
  readonly editId = signal<number | null>(null);
  readonly editPath = signal('');
  /** The folder whose removal the server refused because media are still linked. */
  readonly blocked = signal<LibraryFolder | null>(null);

  async browseNew() {
    const picked = await this.picker.open(this.newPath().trim());
    if (picked) this.newPath.set(picked);
  }

  async add() {
    const path = this.newPath().trim();
    if (!path) return;
    if (await this.run(() => this.api.addFolder(this.state.libraryId(), path))) this.newPath.set('');
  }

  startEdit(folder: LibraryFolder) {
    this.editId.set(folder.id);
    this.editPath.set(folder.path);
  }

  async browseEdit() {
    const picked = await this.picker.open(this.editPath().trim());
    if (picked) this.editPath.set(picked);
  }

  async saveEdit(folder: LibraryFolder) {
    const path = this.editPath().trim();
    if (!path || path === folder.path) return this.editId.set(null);
    if (await this.run(() => this.api.updateFolder(this.state.libraryId(), folder.id, { path }))) {
      this.editId.set(null);
    }
  }

  drop(event: CdkDragDrop<LibraryFolder[]>) {
    return this.reorder(event.previousIndex, event.currentIndex);
  }

  async reorder(from: number, to: number) {
    const list = [...this.folders()];
    if (from === to || to < 0 || to >= list.length) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    // Optimistic: the dropped row must not snap back while the request runs.
    this.state.library.update((lib) =>
      lib ? { ...lib, folders: list.map((f, i) => ({ ...f, position: i })) } : lib,
    );
    await this.run(() => this.api.updateFolder(this.state.libraryId(), moved.id, { position: to }));
  }

  async remove(folder: LibraryFolder) {
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant('settings.libraries.folder_confirm_remove', { path: folder.path }),
      variant: 'danger',
    });
    if (confirmed) await this.removeFolder(folder, false);
  }

  /** Drop the folder's media from Fliks, files kept. */
  async removeWithMedia() {
    const folder = this.blocked();
    if (folder && (await this.removeFolder(folder, true))) this.inUseDialog()?.nativeElement.close();
  }

  private removeFolder(folder: LibraryFolder, removeMedia: boolean) {
    return this.run(
      () => this.api.removeFolder(this.state.libraryId(), folder.id, removeMedia),
      (err) => {
        if (isFolderInUse(err)) {
          this.blocked.set(folder);
          const dialog = this.inUseDialog()?.nativeElement;
          if (dialog && !dialog.open) dialog.showModal();
        } else {
          this.toast.error(serverMessage(err, this.translate, 'settings.libraries.folder_error'));
        }
      },
    );
  }

  /** Failures are toasted by the global interceptor unless `onError` takes them. */
  private async run(action: () => Promise<unknown>, onError?: (err: unknown) => void): Promise<boolean> {
    this.busy.set(true);
    try {
      await action();
      return true;
    } catch (err) {
      onError?.(err);
      return false;
    } finally {
      const lib = await this.api.get(this.state.libraryId()).catch(() => null);
      if (lib) this.state.library.set(lib);
      this.busy.set(false);
    }
  }
}
