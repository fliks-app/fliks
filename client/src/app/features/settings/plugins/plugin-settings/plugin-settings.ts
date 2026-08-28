import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  WritableSignal,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucideX } from '@lucide/angular';
import { ToggleFieldComponent } from '../../../../shared/components/forms/toggle-field/toggle-field';
import { SettingsApiService } from '../../../../core/services/api/settings-api.service';
import { PluginsApiService } from '../../../../core/services/api/plugins-api.service';
import { ToastService } from '../../../../core/services/toast.service';
import { ModalHeaderComponent } from '../../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../../shared/components/modal-footer';

/** Mirrors the backend's `PLUGIN_AUTO_UPDATE_SETTING`. */
const AUTO_UPDATE_KEY = 'plugins.auto_update';
/** Mirrors the backend's `PLUGIN_SKIP_COMPATIBILITY_SETTING`. */
const SKIP_COMPATIBILITY_KEY = 'plugins.skip_compatibility_check';
/** Read by the catalogue alone: it decides whether a card offers other versions to pick. */
const ALLOW_OLDER_VERSIONS_KEY = 'plugins.allow_older_versions';

@Component({
  selector: 'app-plugin-settings',
  imports: [ModalFooterComponent, ModalHeaderComponent, TranslateModule, ToggleFieldComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './plugin-settings.html',
})
export class PluginSettingsComponent {
  private readonly settings = inject(SettingsApiService);
  private readonly plugins = inject(PluginsApiService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);

  private readonly dialogRef = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  /** On unless the stored value is the explicit 'false' — mirrors the backend's own reading. */
  readonly autoUpdate = signal(true);
  /** Both off unless the stored value is the explicit 'true' — same reading as the backend. */
  readonly skipCompatibility = signal(false);
  readonly allowOlderVersions = signal(false);
  readonly loading = signal(true);
  readonly saving = signal(false);

  /** Read on open, not at construction: the value can change while the page stays mounted. */
  async open(): Promise<void> {
    this.dialogRef().nativeElement.showModal();
    this.loading.set(true);
    try {
      const [auto, skip, older] = await Promise.all([
        this.settings.get(AUTO_UPDATE_KEY),
        this.settings.get(SKIP_COMPATIBILITY_KEY),
        this.settings.get(ALLOW_OLDER_VERSIONS_KEY),
      ]);
      this.autoUpdate.set(auto?.value !== 'false');
      this.skipCompatibility.set(skip?.value === 'true');
      this.allowOlderVersions.set(older?.value === 'true');
    } catch {
      this.autoUpdate.set(true);
      this.skipCompatibility.set(false);
      this.allowOlderVersions.set(false);
    } finally {
      this.loading.set(false);
    }
  }

  close(): void {
    this.dialogRef().nativeElement.close();
  }

  async toggleAutoUpdate(next: boolean): Promise<void> {
    await this.persist(AUTO_UPDATE_KEY, next, this.autoUpdate);
  }

  /**
   * The catalogue reads what a source's last refresh cached, and that cache was filtered under
   * whichever value this had at the time. Refreshing every source is what makes the wider (or
   * narrower) version list appear without waiting for the nightly job.
   */
  async toggleSkipCompatibility(next: boolean): Promise<void> {
    if (!(await this.persist(SKIP_COMPATIBILITY_KEY, next, this.skipCompatibility))) return;
    this.saving.set(true);
    try {
      const sources = await this.plugins.listSources();
      await Promise.all(sources.map((s) => this.plugins.refreshSource(s.id).catch(() => null)));
    } finally {
      this.saving.set(false);
    }
  }

  async toggleAllowOlderVersions(next: boolean): Promise<void> {
    await this.persist(ALLOW_OLDER_VERSIONS_KEY, next, this.allowOlderVersions);
  }

  /** False when the write failed, so a caller does not act on a value the server refused. */
  private async persist(
    key: string,
    next: boolean,
    flag: WritableSignal<boolean>,
  ): Promise<boolean> {
    const previous = flag();
    flag.set(next);
    this.saving.set(true);
    try {
      await this.settings.set(key, String(next));
      this.toast.success(this.translate.instant('settings.plugins.settings.saved'));
      return true;
    } catch {
      flag.set(previous);
      return false;
    } finally {
      this.saving.set(false);
    }
  }
}
