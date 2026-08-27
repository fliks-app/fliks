import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { TranslateModule } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { FolderPickerService } from '../../../core/services/folder-picker.service';
import { ModalHeaderComponent } from '../modal-header';
import { ModalFooterComponent } from '../modal-footer';

interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}
interface FsListing {
  current: string;
  parent: string | null;
  entries: FsEntry[];
}

@Component({
  selector: 'app-folder-picker-modal',
  imports: [ModalFooterComponent, ModalHeaderComponent, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './folder-picker-modal.html',
})
export class FolderPickerModalComponent {
  private readonly picker = inject(FolderPickerService);
  private readonly http = inject(HttpClient);

  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  readonly listing = signal<FsListing | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');

  constructor() {
    effect(() => {
      const el = this.dialog()?.nativeElement;
      const state = this.picker.state();
      if (!el) return;
      if (state) {
        if (!el.open) el.showModal();
        void this.navigate(state.initialPath);
      } else if (el.open) {
        el.close();
      }
    });
  }

  async navigate(path: string) {
    this.loading.set(true);
    this.error.set('');
    try {
      const params: Record<string, string> = path ? { path } : {};
      const listing = await firstValueFrom(this.http.get<FsListing>('/api/fs/browse', { params }));
      this.listing.set(listing);
    } catch {
      // Directory unreadable — stay where we are, surface a message.
      this.error.set('folder_picker.unreadable');
    } finally {
      this.loading.set(false);
    }
  }

  selectCurrent() {
    const current = this.listing()?.current;
    if (current) this.picker.select(current);
  }

  cancel() {
    this.picker.cancel();
  }
}
