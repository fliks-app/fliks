import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { LibrariesApiService, UpdateLibraryBody } from '../../../../core/services/api/libraries-api.service';
import { OptimizeService } from '../../../../core/services/api/optimize.service';
import type {
  OptimizeLevel,
  OptimizePreview,
  OptimizeProfile,
  OptimizeSummary,
} from '../../../../core/models/optimize';
import { SelectFieldComponent } from '../../../../shared/components/forms/select-field/select-field';
import { ToggleFieldComponent } from '../../../../shared/components/forms/toggle-field/toggle-field';
import { LibraryDetailState } from './library-detail.state';

const LEVELS: OptimizeLevel[] = ['reencode', 'remux', 'metadata'];

@Component({
  selector: 'app-library-optimize',
  imports: [RouterLink, TranslatePipe, SelectFieldComponent, ToggleFieldComponent],
  templateUrl: './library-optimize.html',
})
export class LibraryOptimizeComponent implements OnInit {
  private readonly api = inject(LibrariesApiService);
  private readonly optimize = inject(OptimizeService);
  readonly state = inject(LibraryDetailState);

  readonly levels = LEVELS;
  readonly profiles = signal<OptimizeProfile[]>([]);
  readonly summary = signal<OptimizeSummary | null>(null);
  readonly preview = signal<OptimizePreview | null>(null);
  readonly busy = signal(false);
  readonly previewBusy = signal(false);

  ngOnInit() {
    void this.optimize.profiles().then((p) => this.profiles.set(p));
    void this.loadSummary();
  }

  private async loadSummary() {
    const lib = this.state.library();
    this.summary.set(null);
    if (!lib?.optimizeProfileId) return;
    try {
      this.summary.set(await this.optimize.summary(lib.id));
    } catch {
      // The counter is informative: the settings stay usable without it.
    }
  }

  async setProfile(value: string) {
    const id = value === '' ? null : Number(value);
    // Without a profile there is nothing to apply to new files.
    await this.patch({ optimizeProfileId: id, ...(id == null ? { optimizeNewFiles: false } : {}) });
    this.preview.set(null);
    await this.loadSummary();
  }

  setNewFiles(on: boolean) {
    return this.patch({ optimizeNewFiles: on });
  }

  async setAllowRename(on: boolean) {
    await this.patch({ allowRename: on });
    await this.loadSummary();
  }

  private async patch(body: UpdateLibraryBody) {
    const lib = this.state.library();
    if (!lib) return;
    this.busy.set(true);
    try {
      await this.api.update(lib.id, body);
      this.state.library.set(await this.api.get(lib.id));
    } catch {
      // The global interceptor toasts the reason; the refetch below restores the shown values.
      this.state.library.set(await this.api.get(lib.id));
    } finally {
      this.busy.set(false);
    }
  }

  async loadPreview() {
    const lib = this.state.library();
    if (!lib) return;
    this.previewBusy.set(true);
    try {
      this.preview.set(await this.optimize.preview(lib.id));
    } catch {
      this.preview.set(null);
    } finally {
      this.previewBusy.set(false);
    }
  }
}
