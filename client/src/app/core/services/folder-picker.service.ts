import { Injectable, signal } from '@angular/core';

interface FolderPickerState {
  initialPath: string;
  resolve: (path: string | null) => void;
}

/** Imperative folder picker: `open()` returns the chosen absolute path or null; one root `<app-folder-picker-modal>` renders it. Mirrors {@link ConfirmationService}. */
@Injectable({ providedIn: 'root' })
export class FolderPickerService {
  readonly state = signal<FolderPickerState | null>(null);

  open(initialPath = ''): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      this.state.set({ initialPath, resolve });
    });
  }

  select(path: string) {
    this.state()?.resolve(path);
    this.state.set(null);
  }

  cancel() {
    this.state()?.resolve(null);
    this.state.set(null);
  }
}
