import { Component, computed, inject, OnInit, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { TvSelectDirective } from '../../shared/directives/tv-select.directive';
import { FolderPickerService } from '../../core/services/folder-picker.service';
import { LibrariesApiService, Library } from '../../core/services/api/libraries-api.service';
import { TransferMethod } from '../../core/services/api/imports-api.service';
import { MediaType } from '../../core/enums/media-type.enum';
import { OrphanScanPanelComponent } from '../settings/libraries/library-detail/orphan-scan-panel/orphan-scan-panel';

@Component({
  selector: 'app-import-disk',
  imports: [TvSelectDirective, FormsModule, TranslatePipe, OrphanScanPanelComponent],
  templateUrl: './import-disk.html',
})
export class ImportDiskComponent implements OnInit {
  private readonly folderPicker = inject(FolderPickerService);
  private readonly librariesApi = inject(LibrariesApiService);

  readonly scanPanel = viewChild<OrphanScanPanelComponent>('panel');

  readonly folderPath = signal('');
  readonly method = signal<TransferMethod>('copy');
  readonly libraries = signal<Library[]>([]);
  readonly librariesLoading = signal(true);
  readonly libraryId = signal<number | null>(null);

  readonly library = computed(() => this.libraries().find((l) => l.id === this.libraryId()) ?? null);

  async ngOnInit() {
    try {
      const libs = (await this.librariesApi.list()).filter((l) => !!l.path);
      this.libraries.set(libs);
      this.libraryId.set(libs[0]?.id ?? null);
    } finally {
      this.librariesLoading.set(false);
    }
  }

  async browse() {
    const picked = await this.folderPicker.open(this.folderPath().trim());
    if (picked) this.folderPath.set(picked);
  }

  /** The scan filters by the library's media types, so a new target needs a new scan. */
  async setLibrary(id: number) {
    this.libraryId.set(id);
    if (this.scanPanel()?.started()) await this.scan();
  }

  async scan() {
    const folder = this.folderPath().trim();
    const lib = this.library();
    if (!folder || !lib) return;
    await this.scanPanel()?.scanPath(
      folder,
      lib.mediaTypes as MediaType[],
      lib.preferredProvider,
      lib.id,
    );
  }
}
