import { computed, signal } from '@angular/core';
import type { FliksRequestRow } from '../../core/services/api/requests.service';
import type { LibrarySummary } from '../../core/services/api/libraries-api.service';
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

/** State and open/close of the edit dialog; the page owns the save call. */
export class RequestEditFlow {
  readonly row = signal<FliksRequestRow | null>(null);
  readonly qualityProfileId = signal<number | null>(null);
  readonly languageProfileId = signal<number | null>(null);
  readonly libraryId = signal<number | null>(null);
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

  open(row: FliksRequestRow): void {
    this.row.set(row);
    this.qualityProfileId.set(row.qualityProfileId);
    this.languageProfileId.set(row.languageProfileId);
    this.libraryId.set(row.libraryId);
    this.modal()?.showModal();
  }

  close(): void {
    this.modal()?.close();
    this.row.set(null);
  }

  /** The update to send; the library only when it changed, so a plain profile edit
   *  does not re-run the backend's library access check. */
  changes(row: FliksRequestRow) {
    return {
      qualityProfileId: this.qualityProfileId() ?? undefined,
      languageProfileId: this.languageProfileId() ?? undefined,
      ...(this.libraryId() !== row.libraryId ? { libraryId: this.libraryId() } : {}),
    };
  }
}
