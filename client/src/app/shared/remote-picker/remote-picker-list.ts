import { Component, Signal, computed, inject, input, output, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { RouterLink } from '@angular/router';
import { LucideArrowRightLeft, LucidePlus } from '@lucide/angular';
import { AirPlayService } from '../../core/services/airplay.service';
import { CastService } from '../../core/services/cast.service';
import { CastPlaybackTarget } from '../../core/services/cast-playback-target';
import { RemoteService, RemoteTarget } from '../../core/services/remote.service';
import { ToastService } from '../../core/services/toast.service';
import { NowPlayingMetadataService, nowPlayingLine } from '../../core/services/playback/now-playing-metadata.service';
import { PlaybackSession } from '../../core/services/playback/playback-session';
import { SessionSyncService } from '../../core/services/session-sync.service';
import { PlaybackSurface } from '../../core/services/playback/playback-surface';
import { formatTime } from '../../core/utils/player.utils';
import { DeviceService } from '../../core/services/device.service';
import { parseDeviceLabel } from '../../core/utils/format-device-label';
import { PlaybackDevice } from '../../core/services/playback-device.service';
import { deviceIconFor, type DeviceIcon } from '../../core/utils/device-icon';
import { DeviceIconComponent } from '../device-chip/device-icon';

const LAST_USED_KEY = 'fliks.remote.lastUsedPickerRow';

export interface PickerRow {
  kind: 'local' | 'remote' | 'cast' | 'cast-web' | 'airplay';
  id: string;
  icon: DeviceIcon;
  label: string;
  /** Tells two tabs of one device apart; shown after the label so a long label never hides it. */
  tab?: string;
  subtitle: string | null;
  /** Casting to this row already: pressing it leaves the device instead. */
  connected?: boolean;
  /** Pressing it does nothing: the session already sits on this device. */
  disabled?: boolean;
}

/** The destination list (Cast devices + remote targets) without its surface: wrapped by `app-remote-picker` in the top bar, a dropdown/sheet in the player. */
@Component({
  selector: 'app-remote-picker-list',
  standalone: true,
  imports: [
    TranslatePipe,
    LucideArrowRightLeft, LucidePlus, DeviceIconComponent,
    RouterLink,
  ],
  styles: [':host { display: block; }'],
  templateUrl: './remote-picker-list.html',
})
export class RemotePickerListComponent {
  /** Emit the pick instead of acting, so a host with a running session moves that playback itself; leaving a device is never delegated. */
  readonly delegate = input(false);
  readonly picked = output<PickerRow>();
  /** The main press of a device row moves the account session to it instead of selecting it. */
  readonly transferOnly = input(false);
  /** Shows the device playing now above the rows, with its volume. */
  readonly card = input(false);

  protected readonly remote = inject(RemoteService);
  protected readonly castService = inject(CastService);
  private readonly airPlay = inject(AirPlayService);
  private readonly castTarget = inject(CastPlaybackTarget);
  private readonly session = inject(PlaybackSession);
  protected readonly sync = inject(SessionSyncService);
  private readonly device = inject(DeviceService);
  private readonly surface = inject(PlaybackSurface);
  protected readonly playing = inject(PlaybackDevice);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  /** Whether the Cast backend lists devices itself; a browser has no enumeration API and delegates to the single `cast-web` row. */
  protected readonly enumerates = this.castService.enumerates;

  private readonly lastUsedId = signal<string | null>(this.readLastUsed());

  protected readonly castSearching = computed(
    () => this.enumerates && this.castService.isAvailable() && this.castService.castDevices().length === 0,
  );

  /** The account session another device plays, offered above the rows; null once this device owns it. */
  protected readonly followed = computed(() => {
    const s = this.sync.session();
    if (!s || this.sync.role() !== 'observer') return null;
    const reading = this.sync.isReading(s);
    if (this.surface.here()) return null;
    const position = reading ? `${this.readPercent(s)}%` : formatTime(this.sync.positionNow(s));
    return {
      title: s.item.title,
      detail: s.item.subtitle ? `${s.item.subtitle} · ${position}` : position,
      line: this.sync.line(s),
    };
  });

  /** The parked or observed album session's track, whose item title is the album. */
  private readonly sessionTrack = inject(NowPlayingMetadataService).track(() => {
    const item = this.sync.session()?.item;
    return item?.kind === 'album' ? { mediaId: item.mediaId, episodeId: item.episodeId ?? undefined, itemId: item.id } : null;
  });

  /** What the current device plays: the account session's item (a track with its artists for an album), else the cast or remote output's. */
  protected readonly cardTrack = computed(() => {
    const item = this.sync.session()?.item;
    if (!item) return nowPlayingLine(this.session.nowPlaying()) || null;
    return nowPlayingLine(this.sessionTrack()) || (item.kind === 'album' ? (item.subtitle ?? item.title) : item.title);
  });

  protected onVolume(event: Event): void {
    this.playing.setVolume(+(event.target as HTMLInputElement).value / 100);
  }

  private readPercent(s: { positionSeconds: number; durationSeconds: number | null }): number {
    return Math.round(Math.min(1, s.positionSeconds / (s.durationSeconds || 1)) * 100);
  }

  protected readonly pickerRows: Signal<PickerRow[]> = computed(() => {
    const rows: PickerRow[] = [];
    const session = this.sync.session();
    const resumable = this.sync.canPlayHere() && this.session.isLocal() && !this.surface.here();
    rows.push({
      kind: 'local',
      id: 'local',
      icon: this.device.isTouch() ? 'phone' : 'monitor',
      label: this.translate.instant('remote.this_device'),
      subtitle:
        resumable && session
          ? this.sync.isReading(session)
            ? this.translate.instant('session.open_here')
            : this.translate.instant('session.resume_at', { position: formatTime(this.sync.positionNow(session)) })
          : null,
      connected: this.session.isLocal() && !resumable,
      disabled: this.surface.here() && this.session.isLocal(),
    });
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
    const selected = this.remote.selectedTargetId();
    const labels = this.remote.targets().map((t) => this.deviceLabel(t));
    this.remote.targets().forEach((t, i) => {
      const connected = t.targetId === selected;
      // Two tabs of one device read alike: the tab part of the id tells them apart.
      const tab = labels.filter((l) => l === labels[i]).length > 1 ? t.targetId.split('#')[1] : undefined;
      rows.push({
        kind: 'remote',
        id: t.targetId,
        icon: deviceIconFor(t.formFactor),
        label: labels[i],
        tab: tab?.slice(0, 4),
        subtitle: connected
          ? this.translate.instant('remote.stop_controlling')
          : t.ownerUsername
            ? this.translate.instant('remote.owned_by', { username: t.ownerUsername })
            : null,
        connected,
      });
    });
    // AirPlay, then Cast devices, then remote targets, last-used first inside
    // each group. The sort is stable, so rows that tie keep discovery order.
    const last = this.lastUsedId();
    const group = (r: PickerRow) => (r.kind === 'local' ? -1 : r.kind === 'airplay' ? 0 : r.kind === 'remote' ? 2 : 1);
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
    if (this.enumerates) void this.castService.getCastDevices({ browse: true });
  }

  /** Another device of the account can take the session over, unless it already plays it. */
  protected canTransfer(row: PickerRow): boolean {
    const s = this.sync.session();
    return row.kind === 'remote' && !!s && this.sync.canTransfer() && this.remote.canLoad(row.id, s.item.mediaFileId) && (this.sync.parked() || s.owner.targetId !== row.id);
  }

  /** This device observes the session itself, or controls the device that owns it. */
  private observesSession(): boolean {
    const s = this.sync.session();
    return this.session.isLocal() || (!!s && s.state !== 'parked' && s.owner.targetId === this.remote.selectedTargetId());
  }

  protected pressable(row: PickerRow): boolean {
    if (row.disabled) return false;
    if (this.delegate() && row.kind === 'remote' && !row.connected && !this.session.canMoveTo('remote', row.id)) return false;
    return !(this.transferOnly() && row.kind === 'remote' && !this.canTransfer(row));
  }

  protected async transfer(row: PickerRow): Promise<void> {
    try {
      await this.sync.transferTo(row.id);
    } catch (err) {
      console.warn('[remote-picker] transfer failed', row.id, err);
    }
  }

  selectRow(row: PickerRow): void {
    if (this.transferOnly() && row.kind === 'remote') {
      if (this.canTransfer(row)) void this.transfer(row);
      return;
    }
    // The system picker is also where AirPlay is left, so `connected` changes
    // nothing here.
    if (row.kind === 'airplay') {
      this.setLastUsed(row.id);
      if (this.delegate()) this.picked.emit(row);
      else this.airPlay.showPicker();
      return;
    }
    if (row.kind === 'local') {
      if (this.sync.canPlayHere() && this.session.isLocal()) void this.sync.playHere();
      else if (!row.connected) this.session.takeBack();
      return;
    }
    // Pressing the device in use is the way out of it: a Cast session ends, a remote device plays on alone.
    if (row.connected) {
      if (row.kind === 'remote') this.session.stopControlling();
      else this.castTarget.disconnect();
      return;
    }
    this.setLastUsed(row.id);
    if (this.delegate()) {
      this.picked.emit(row);
      return;
    }
    // Another device plays the account session (the one controlled here included): a press moves it there instead of selecting a second one.
    if (row.kind === 'remote' && this.sync.role() === 'observer' && this.observesSession() && this.canTransfer(row)) {
      void this.transfer(row);
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
      // Only open the player when there is already something to control.
      const playing = this.remote.targets().find((t) => t.targetId === row.id)?.nowPlaying;
      if (playing?.mediaFileId && playing.mediaId) {
        this.session.openPlayer({ fileId: playing.mediaFileId, mediaId: playing.mediaId, episodeId: playing.episodeId ?? undefined });
      }
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
