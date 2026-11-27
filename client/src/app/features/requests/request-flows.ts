import { computed, signal } from '@angular/core';
import type { ApproveBody, FliksRequestRow } from '../../core/services/api/requests.service';
import type { WantSpec } from '../../core/services/api/wants-api.service';
import type { LibrarySummary } from '../../core/services/api/libraries-api.service';
import { kindOf } from '../../core/media-kinds';
import { defaultFolderId } from '../../shared/components/library-folder-select/library-folder-select';
import type { RequestDeclineModalComponent } from './request-decline-modal/request-decline-modal.component';
import type { RequestEditModalComponent } from './request-edit-modal/request-edit-modal.component';

/** State and open/close of the decline dialog; the page owns the submit call. */
export class RequestDeclineFlow {
  readonly forId = signal<number | null>(null);
  readonly reasonText = signal('');

  constructor(private readonly modal: () => RequestDeclineModalComponent | undefined) {}

  open(id: number): void {
    this.forId.set(id);
    this.reasonText.set('');
    this.modal()?.showModal();
  }

  close(): void {
    this.modal()?.close();
    this.forId.set(null);
  }
}

/** State and open/close of the edit dialog, also used to approve with edits; the page owns the submit call. */
export class RequestEditFlow {
  readonly row = signal<FliksRequestRow | null>(null);
  readonly mode = signal<'edit' | 'approve'>('edit');
  readonly folderId = signal<number | null>(null);
  readonly monitorNewSeasons = signal(true);
  readonly qualityProfileId = signal<number | null>(null);
  readonly languageProfileId = signal<number | null>(null);
  readonly libraryId = signal<number | null>(null);
  readonly wants = signal<WantSpec[]>([]);
  readonly saving = signal(false);

  /** Libraries the request's media type fits, the set the dialog's picker offers. */
  readonly compatibleLibraries = computed(() => {
    const row = this.row();
    if (!row) return [];
    return this.libraries().filter((l) => l.mediaTypes.includes(row.mediaType));
  });

  constructor(
    private readonly modal: () => RequestEditModalComponent | undefined,
    private readonly libraries: () => LibrarySummary[],
  ) {}

  open(row: FliksRequestRow, mode: 'edit' | 'approve' = 'edit'): void {
    this.mode.set(mode);
    this.row.set(row);
    this.folderId.set(defaultFolderId(this.libraries().find((l) => l.id === row.libraryId)?.folders));
    this.monitorNewSeasons.set(row.monitorNewSeasons ?? true);
    this.qualityProfileId.set(row.qualityProfileId);
    this.languageProfileId.set(row.languageProfileId);
    this.libraryId.set(row.libraryId);
    this.wants.set(row.wants ?? []);
    this.modal()?.showModal();
  }

  /** A library picked in the dialog: its folders restart at the default one. */
  setLibrary(id: number | null): void {
    this.libraryId.set(id);
    this.folderId.set(defaultFolderId(this.libraries().find((l) => l.id === id)?.folders));
  }

  close(): void {
    this.modal()?.close();
    this.row.set(null);
  }

  /** What an approve sends: the dialog's fields, the folder only when its library has several. */
  approveBody(row: FliksRequestRow): ApproveBody {
    const libraryId = this.libraryId();
    const folders = this.libraries().find((l) => l.id === libraryId)?.folders ?? [];
    const folderId = this.folderId();
    return {
      ...(this.qualityProfileId() != null ? { qualityProfileId: this.qualityProfileId()! } : {}),
      ...(this.languageProfileId() != null ? { languageProfileId: this.languageProfileId()! } : {}),
      ...(libraryId != null ? { libraryId } : {}),
      ...(folders.length > 1 && folderId != null ? { folderId } : {}),
      ...(kindOf(row.mediaType).hasSeasons ? { monitorNewSeasons: this.monitorNewSeasons() } : {}),
    };
  }

  /** The update to send; the library only when it changed, so a plain profile edit
   *  does not re-run the backend's library access check. */
  changes(row: FliksRequestRow) {
    return {
      qualityProfileId: this.qualityProfileId() ?? undefined,
      languageProfileId: this.languageProfileId() ?? undefined,
      ...(this.libraryId() !== row.libraryId ? { libraryId: this.libraryId() } : {}),
      ...(row.mediaType === 'book' ? { wants: this.wants() } : {}),
    };
  }
}
