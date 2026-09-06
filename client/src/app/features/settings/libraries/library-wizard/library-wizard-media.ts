import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { FolderPickerService } from '../../../../core/services/folder-picker.service';
import { MediaType } from '../../../../core/enums/media-type.enum';
import { LibraryDetailState } from '../library-detail/library-detail.state';
import { OrphanScanPanelComponent } from '../library-detail/orphan-scan-panel/orphan-scan-panel';

@Component({
  selector: 'app-library-wizard-media',
  imports: [FormsModule, TranslateModule, OrphanScanPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './library-wizard-media.html',
})
export class LibraryWizardMediaComponent {
  private readonly folderPicker = inject(FolderPickerService);
  readonly state = inject(LibraryDetailState);

  readonly scanPanel = viewChild<OrphanScanPanelComponent>('panel');

  private readonly scannedPath = signal('');

  /** A scan only counts for the path it ran on — editing it invalidates it. */
  readonly scanned = computed(
    () => !!this.scannedPath() && this.scannedPath() === this.state.formPath().trim(),
  );

  async browsePath() {
    const picked = await this.folderPicker.open(this.state.formPath().trim());
    if (picked) this.state.formPath.set(picked);
  }

  async scan() {
    const path = this.state.formPath().trim();
    if (!path) return;
    await this.scanPanel()?.scanPath(
      path,
      this.state.mediaTypes() as MediaType[],
      this.state.formProvider(),
    );
    this.scannedPath.set(path);
  }

  /** Import every detected media into the library once it exists. */
  async importAll(libraryId: number): Promise<{ queued: number; skipped: number }> {
    return (await this.scanPanel()?.importAll(libraryId)) ?? { queued: 0, skipped: 0 };
  }
}
