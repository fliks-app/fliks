import { Component, Signal, computed, inject, input, output, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { RouterLink } from '@angular/router';
import {
  LucideAirplay,
  LucideCast,
  LucideMonitor,
  LucideSmartphone,
  LucideTablet,
  LucidePlus,
  LucideTv,
} from '@lucide/angular';
import { AirPlayService } from '../../core/services/airplay.service';
import { CastService } from '../../core/services/cast.service';
import { CastPlaybackTarget } from '../../core/services/cast-playback-target';
import { RemoteService, RemoteTarget } from '../../core/services/remote.service';
import { ToastService } from '../../core/services/toast.service';
import { remoteOverlayOpen } from '../../core/services/remote-playback-target';
import { parseDeviceLabel } from '../../core/utils/format-device-label';

const LAST_USED_KEY = 'fliks.remote.lastUsedPickerRow';

export interface PickerRow {
  kind: 'remote' | 'cast' | 'cast-web' | 'airplay';
  id: string;
  icon: 'tv' | 'tablet' | 'phone' | 'monitor' | 'cast' | 'airplay';
  label: string;
  subtitle: string | null;
  /** Casting to this row already: pressing it leaves the device instead. */
  connected?: boolean;
}

/**
 * The destination list itself (Cast devices + remote targets, one list),
 * without the surface that holds it: the top bar wraps it in
 * `app-remote-picker`, the player in its own dropdown / bottom sheet.
 */
@Component({
  selector: 'app-remote-picker-list',
  standalone: true,
  imports: [
    TranslatePipe,
    LucideTv, LucideTablet, LucideSmartphone, LucideMonitor, LucideCast, LucideAirplay, LucidePlus,
    RouterLink,
  ],
  styles: [':host { display: block; }'],
  templateUrl: './remote-picker-list.html',
})
export class RemotePickerListComponent {
  /** Emit the pick instead of acting on it: a host with a running session (the
   *  player) moves that playback to the destination itself. Leaving a device is
   *  never delegated — it has no handoff to do. */
  readonly delegate = input(false);
  readonly picked = output<PickerRow>();

  protected readonly remote = inject(RemoteService);
  protected readonly castService = inject(CastService);
  private readonly airPlay = inject(AirPlayService);
  private readonly castTarget = inject(CastPlaybackTarget);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  /** Whether the Cast backend lists devices itself (mobile plugin, desktop
   *  bridge) — a browser has no enumeration API and delegates to its own
   *  dialog through the single `cast-web` row. */
  protected readonly enumerates = this.castService.enumerates;

  private readonly lastUsedId = signal<string | null>(this.readLastUsed());

  protected readonly castSearching = computed(
    () => this.enumerates && this.castService.isAvailable() && this.castService.castDevices().length === 0,
  );

  protected readonly pickerRows: Signal<PickerRow[]> = computed(() => {
    const rows: PickerRow[] = [];
    if (!this.enumerates) {
      const connected = this.castService.isConnected();
      rows.push({
        kind: 'cast-web',
        id: 'web-chromecast',
        icon: 'cast',
        label: this.translate.instant('remote.chromecast_row'),
        subtitle: connected ? this.translate.instant('remote.disconnect_row') : null,
        connected,
      });
    }
    for (const d of this.castService.castDevices()) {
      rows.push({
        kind: 'cast',
        id: d.id,
        icon: 'cast',
        label: d.name,
        // The device's own model name is what the row says until we are on it;
        // then the row's only remaining action is to leave, so it says that.
        subtitle: d.connected
          ? this.translate.instant('remote.disconnect_row')
          : (d.modelName ?? null),
        connected: d.connected,
      });
    }
    if (this.airPlay.available()) {
      const name = this.airPlay.deviceName();
      const active = this.airPlay.routeActive() || this.airPlay.videoActive();
      rows.push({
        kind: 'airplay',
        id: 'airplay',
        icon: 'airplay',
        label: this.translate.instant('remote.airplay_row'),
        subtitle: name ?? (active ? this.translate.instant('remote.airplay_connected') : null),
        connected: active,
      });
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
    // AirPlay, then Cast devices, then remote targets, last-used first inside
    // each group. The sort is stable, so rows that tie keep discovery order.
    const last = this.lastUsedId();
    const group = (r: PickerRow) => (r.kind === 'airplay' ? 0 : r.kind === 'remote' ? 2 : 1);
    const recent = (r: PickerRow) => (r.id === last ? 0 : 1);
    rows.sort((a, b) => group(a) - group(b) || recent(a) - recent(b));
    return rows;
  });

  /** The sheet branch mounts the list only while it is open, so this covers
   *  every open there; a host that keeps it mounted calls `refresh()` itself. */
  constructor() {
    this.refresh();
  }

  /** Re-read both sources. Neither pushes a full listing on its own. */
  refresh(): void {
    void this.remote.refreshTargets();
    if (this.enumerates) void this.castService.getCastDevices();
  }

  selectRow(row: PickerRow): void {
    // The system picker is also where AirPlay is left, so `connected` changes
    // nothing here.
    if (row.kind === 'airplay') {
      this.setLastUsed(row.id);
      if (this.delegate()) this.picked.emit(row);
      else this.airPlay.showPicker();
      return;
    }
    // Pressing the device already being cast to is the only way out of a Cast
    // session: the control card can stop the media but never leaves the device.
    if (row.connected) {
      this.castTarget.disconnect();
      return;
    }
    this.setLastUsed(row.id);
    if (this.delegate()) {
      this.picked.emit(row);
      return;
    }
    if (row.kind === 'cast' || row.kind === 'cast-web') {
      // One destination at a time, the same rule `selectTarget` applies the
      // other way round.
      this.remote.selectTarget(null);
    }
    if (row.kind === 'cast') {
      void this.selectCastDevice(row.id);
    } else if (row.kind === 'cast-web') {
      this.castService.requestSession();
    } else {
      this.remote.selectTarget(row.id);
      // Only hand off to the control card when there is already something to
      // control; picking an idle device would otherwise land on a dead end.
      const playing = this.remote.targets().find((t) => t.targetId === row.id)?.nowPlaying;
      if (playing) remoteOverlayOpen.set(true);
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
    const label = parseDeviceLabel(t.userAgent, t.systemName, t.deviceName);
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
