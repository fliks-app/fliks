import { ChangeDetectionStrategy, Component, Signal, computed, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  LucideCast,
  LucideMonitor,
  LucideSmartphone,
  LucideTablet,
  LucideTv,
} from '@lucide/angular';
import { DropdownMenuComponent } from '../components/dropdown-menu';
import { CastService } from '../../core/services/cast.service';
import { RemoteService, RemoteTarget } from '../../core/services/remote.service';
import { ToastService } from '../../core/services/toast.service';
import { remoteOverlayOpen } from '../../core/services/remote-playback-target';
import { parseDeviceLabel } from '../../core/utils/format-device-label';

const LAST_USED_KEY = 'fliks.remote.lastUsedPickerRow';

interface PickerRow {
  kind: 'remote' | 'cast' | 'cast-web';
  id: string;
  icon: 'tv' | 'tablet' | 'phone' | 'monitor' | 'cast';
  label: string;
  subtitle: string | null;
}

/**
 * "Play on another device" trigger + dropdown: a unified picker (Cast
 * devices + remote targets, one list) built on the house `app-dropdown-menu`.
 * Selecting a row hands off to the Cast session or to `app-cast-overlay`
 * (via `remoteOverlayOpen`) instead of duplicating controls here.
 */
@Component({
  selector: 'app-remote-picker',
  imports: [
    TranslateModule,
    DropdownMenuComponent,
    LucideTv, LucideTablet, LucideSmartphone, LucideMonitor, LucideCast,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './remote-picker.html',
})
export class RemotePickerComponent {
  protected readonly remote = inject(RemoteService);
  protected readonly castService = inject(CastService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly isNative = Capacitor.isNativePlatform();

  private readonly lastUsedId = signal<string | null>(this.readLastUsed());

  protected readonly castSearching = computed(
    () => this.isNative && this.castService.isAvailable() && this.castService.castDevices().length === 0,
  );

  protected readonly pickerRows: Signal<PickerRow[]> = computed(() => {
    const rows: PickerRow[] = [];
    if (!this.isNative) {
      rows.push({
        kind: 'cast-web',
        id: 'web-chromecast',
        icon: 'cast',
        label: this.translate.instant('remote.chromecast_row'),
        subtitle: null,
      });
    }
    for (const d of this.castService.castDevices()) {
      rows.push({ kind: 'cast', id: d.id, icon: 'cast', label: d.name, subtitle: d.modelName ?? null });
    }
    for (const t of this.remote.targets()) {
      rows.push({
        kind: 'remote',
        id: t.targetId,
        icon: this.iconForRemote(t),
        label: this.deviceLabel(t),
        subtitle: t.ownerUsername
          ? this.translate.instant('remote.owned_by', { username: t.ownerUsername })
          : null,
      });
    }
    const last = this.lastUsedId();
    if (last) {
      rows.sort((a, b) => {
        if (a.kind === 'cast-web') return -1;
        if (b.kind === 'cast-web') return 1;
        return a.id === last ? -1 : b.id === last ? 1 : 0;
      });
    }
    return rows;
  });

  /** The dropdown owns its own open state, with no exposed "just opened"
   *  signal to key off, so refresh on every trigger press: a redundant GET
   *  on close is harmless. */
  protected onTriggerPress(): void {
    void this.remote.refreshTargets();
    if (this.isNative) void this.castService.getCastDevices();
  }

  selectRow(row: PickerRow): void {
    this.setLastUsed(row.id);
    if (row.kind === 'cast') {
      void this.selectCastDevice(row.id);
    } else if (row.kind === 'cast-web') {
      this.castService.requestSession();
    } else {
      this.remote.selectTarget(row.id);
      // Mirrors quickStart's `castPlayer.expanded.set(true)`: hand off to
      // app-cast-overlay so the control card appears as soon as it has media.
      remoteOverlayOpen.set(true);
    }
  }

  private async selectCastDevice(id: string): Promise<void> {
    try {
      await this.castService.selectCastDevice(id);
    } catch (err) {
      console.warn('[remote-picker] selectCastDevice failed', id, err);
      this.toast.error(this.translate.instant('remote.error_cast_select_failed'));
    }
  }

  deviceLabel(t: RemoteTarget): string {
    const label = parseDeviceLabel(t.userAgent, t.systemName);
    return label ? this.translate.instant(label.key, label.params) : t.targetId;
  }

  private iconForRemote(t: RemoteTarget): 'tv' | 'tablet' | 'phone' | 'monitor' {
    switch (t.formFactor) {
      case 'tv': return 'tv';
      case 'tablet': return 'tablet';
      case 'phone': return 'phone';
      default: return 'monitor';
    }
  }

  private readLastUsed(): string | null {
    try {
      return localStorage.getItem(LAST_USED_KEY);
    } catch {
      return null;
    }
  }

  private setLastUsed(id: string): void {
    this.lastUsedId.set(id);
    try {
      localStorage.setItem(LAST_USED_KEY, id);
    } catch { /* private mode / blocked storage: ordering just resets */ }
  }
}
