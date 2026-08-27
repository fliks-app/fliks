import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucideX } from '@lucide/angular';
import { ToggleFieldComponent } from '../../../../shared/components/forms/toggle-field/toggle-field';
import { SettingsApiService } from '../../../../core/services/api/settings-api.service';
import { ToastService } from '../../../../core/services/toast.service';
import { ModalHeaderComponent } from '../../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../../shared/components/modal-footer';

/** Mirrors the backend's `PLUGIN_AUTO_UPDATE_SETTING`. */
const AUTO_UPDATE_KEY = 'plugins.auto_update';

@Component({
  selector: 'app-plugin-settings',
  imports: [ModalFooterComponent, ModalHeaderComponent, TranslateModule, ToggleFieldComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './plugin-settings.html',
})
export class PluginSettingsComponent {
  private readonly settings = inject(SettingsApiService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);

  private readonly dialogRef = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  /** On unless the stored value is the explicit 'false' — mirrors the backend's own reading. */
  readonly autoUpdate = signal(true);
  readonly loading = signal(true);
  readonly saving = signal(false);

  /** Read on open, not at construction: the value can change while the page stays mounted. */
  async open(): Promise<void> {
    this.dialogRef().nativeElement.showModal();
    this.loading.set(true);
    try {
      const row = await this.settings.get(AUTO_UPDATE_KEY);
      this.autoUpdate.set(row?.value !== 'false');
    } catch {
      this.autoUpdate.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  close(): void {
    this.dialogRef().nativeElement.close();
  }

  async toggleAutoUpdate(next: boolean): Promise<void> {
    const previous = this.autoUpdate();
    this.autoUpdate.set(next);
    this.saving.set(true);
    try {
      await this.settings.set(AUTO_UPDATE_KEY, String(next));
      this.toast.success(this.translate.instant('settings.plugins.settings.saved'));
    } catch {
      this.autoUpdate.set(previous);
    } finally {
      this.saving.set(false);
    }
  }
}
