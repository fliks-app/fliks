import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Signal,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  LucideCaptions,
  LucideCast,
  LucideCheck,
  LucideChevronLeft,
  LucideHeadphones,
  LucideMonitor,
  LucidePause,
  LucidePlay,
  LucideRotateCcw,
  LucideRotateCw,
  LucideSkipForward,
  LucideSmartphone,
  LucideTablet,
  LucideTv,
  LucideVolume2,
  LucideVolumeX,
  LucideX,
} from '@lucide/angular';
import { BottomSheetComponent } from '../components/bottom-sheet';
import { DropdownMenuComponent } from '../components/dropdown-menu';
import { SeekbarComponent } from '../components/seekbar/seekbar';
import { CastService } from '../../core/services/cast.service';
import { DeviceService } from '../../core/services/device.service';
import { RemoteService, RemoteTarget } from '../../core/services/remote.service';
import { ToastService } from '../../core/services/toast.service';
import { MediaService } from '../../core/services/api/media.service';
import { SubtitlesApiService } from '../../core/services/api/subtitles-api.service';
import { buildCastAudioOptions, CastAudioOption } from '../../core/services/cast-player.service';
import { buildSubtitleTracks } from '../../core/utils/subtitle-tracks';
import { formatSubtitleLabel, formatTime } from '../../core/utils/player.utils';
import { parseDeviceLabel } from '../../core/utils/format-device-label';

/** Single app-wide switch: services outside this component's injector tree
 *  (layout's cast icon, playable-media's "play elsewhere" branch) flip this
 *  directly rather than through a dedicated service for one boolean. */
export const remoteOverlayOpen = signal(false);

const LAST_USED_KEY = 'fliks.remote.lastUsedPickerRow';

interface PickerRow {
  kind: 'remote' | 'cast' | 'cast-web';
  id: string;
  icon: 'tv' | 'tablet' | 'phone' | 'monitor' | 'cast';
  label: string;
  subtitle: string | null;
}

interface SubtitleOption {
  id: string;
  label: string;
  streamIndex: number | null;
}

/**
 * The single "play on another device" entry point: a unified picker (Cast
 * devices + remote targets, one list) and, once a remote target is picked,
 * its live remote control. Selecting a Cast row hands off to the existing
 * Cast session UI instead of duplicating it here.
 */
@Component({
  selector: 'app-remote-overlay',
  imports: [
    NgTemplateOutlet,
    TranslateModule,
    BottomSheetComponent,
    SeekbarComponent,
    DropdownMenuComponent,
    LucideTv, LucideTablet, LucideSmartphone, LucideMonitor, LucideCast,
    LucideX, LucideChevronLeft, LucidePlay, LucidePause, LucideRotateCcw, LucideRotateCw,
    LucideVolume2, LucideVolumeX, LucideSkipForward, LucideHeadphones, LucideCaptions, LucideCheck,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './remote-overlay.html',
})
export class RemoteOverlayComponent {
  protected readonly open = remoteOverlayOpen;
  protected readonly remote = inject(RemoteService);
  protected readonly castService = inject(CastService);
  protected readonly device = inject(DeviceService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly mediaService = inject(MediaService);
  private readonly subtitlesApi = inject(SubtitlesApiService);

  protected readonly isNative = Capacitor.isNativePlatform();
  protected readonly formatTime = formatTime;

  private readonly lastUsedId = signal<string | null>(this.readLastUsed());

  /** Whether a remote target is the current selection: deliberately NOT
   *  `remote.isRemoting()`, which goes false the instant an offline target
   *  drops out of `targets()`. That would silently bounce the user back to
   *  the picker at exactly the moment the offline banner needs to show. */
  protected readonly showRemotePane = computed(() => this.remote.selectedTargetId() !== null);

  /** Cached device label for the pane-B header: `remote.selectedTarget()`
   *  goes null while offline (see above), which would blank the header right
   *  when the device name matters most. */
  private readonly targetLabelCache = signal('');
  protected readonly targetLabel = this.targetLabelCache.asReadonly();

  protected readonly castSearching = computed(
    () => this.isNative && this.castService.isAvailable() && this.castService.castDevices().length === 0,
  );

  protected readonly pickerRows: Signal<PickerRow[]> = computed(() => {
    const rows: PickerRow[] = [];
    for (const d of this.castService.castDevices()) {
      rows.push({ kind: 'cast', id: d.id, icon: 'cast', label: d.name, subtitle: d.modelName ?? null });
    }
    if (!this.isNative) {
      rows.push({
        kind: 'cast-web',
        id: 'web-chromecast',
        icon: 'cast',
        label: this.translate.instant('remote.chromecast_row'),
        subtitle: null,
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
    const last = this.lastUsedId();
    if (last) rows.sort((a, b) => (a.id === last ? -1 : b.id === last ? 1 : 0));
    return rows;
  });

  protected readonly remoteViewState = computed<
    'offline' | 'blocked' | 'starting' | 'idle' | 'live'
  >(() => {
    if (this.remote.targetOffline()) return 'offline';
    // An in-flight `load` still rides the previous title's report, so wait for
    // the ack instead of flashing it.
    if (this.remote.pendingAction() === 'load') return 'starting';
    if (this.remote.targetBlocked()) return 'blocked';
    if (this.remote.targetState()) return 'live';
    // A reachable target that plays nothing is the normal case right after
    // picking one, and no report will ever arrive to end a spinner.
    return this.remote.selectedTarget()?.nowPlaying ? 'starting' : 'idle';
  });

  protected readonly audioOptions = signal<CastAudioOption[]>([]);
  protected readonly subtitleOptions = signal<SubtitleOption[]>([]);
  private tracksLoadedForKey: string | null = null;

  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  /** daisyUI animates the native open/close transition, so the element is
   *  always rendered and driven through showModal/close, never a class. */
  private readonly dialogSyncEffect = effect(() => {
    const open = this.open();
    const el = this.dialog()?.nativeElement;
    untracked(() => {
      if (!el) return;
      if (open && !el.open) el.showModal();
      else if (!open && el.open) el.close();
    });
  });

  protected onDialogClose(): void {
    if (this.open()) this.closeOverlay();
  }

  constructor() {
    if (this.device.isTv()) {
      console.debug('[remote-overlay] suppressed on tv: no controller UI on the 10-foot surface');
    }

    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        void this.remote.refreshTargets();
        if (this.isNative) void this.castService.getCastDevices();
      });
    });

    effect(() => {
      const t = this.remote.selectedTarget();
      if (t) untracked(() => this.targetLabelCache.set(this.deviceLabel(t)));
    });

    effect(() => {
      // Reset stale track options as soon as the selection itself changes -
      // before ANY state arrives for the (possibly different) new target.
      this.remote.selectedTargetId();
      untracked(() => {
        this.tracksLoadedForKey = null;
        this.audioOptions.set([]);
        this.subtitleOptions.set([]);
      });
    });

    effect(() => {
      const s = this.remote.targetState();
      if (!s?.mediaId || !s.mediaFileId) return;
      const key = `${s.mediaId}:${s.mediaFileId}`;
      if (key === this.tracksLoadedForKey) return;
      this.tracksLoadedForKey = key;
      untracked(() => void this.loadTracks(s.mediaId!, s.mediaFileId));
    });
  }

  closeOverlay(): void {
    remoteOverlayOpen.set(false);
  }

  backToPicker(): void {
    this.remote.selectTarget(null);
  }

  selectRow(row: PickerRow): void {
    this.setLastUsed(row.id);
    if (row.kind === 'cast') {
      void this.selectCastDevice(row.id);
    } else if (row.kind === 'cast-web') {
      this.castService.requestSession();
      this.closeOverlay();
    } else {
      this.remote.selectTarget(row.id);
    }
  }

  private async selectCastDevice(id: string): Promise<void> {
    try {
      await this.castService.selectCastDevice(id);
      this.closeOverlay();
    } catch (err) {
      console.warn('[remote-overlay] selectCastDevice failed', id, err);
      this.toast.error(this.translate.instant('remote.error_cast_select_failed'));
    }
  }

  /** Explicit local fallback for an offline target: never automatic. Uses the
   *  last known now-playing report, which the offline transition does not clear. */
  playHereInstead(): void {
    const s = this.remote.targetState();
    if (!s?.mediaFileId) {
      console.warn('[remote-overlay] play-here-instead with no known now-playing state');
      return;
    }
    const queryParams: Record<string, number> = {};
    if (s.mediaId) queryParams['mediaId'] = s.mediaId;
    if (s.episodeId) queryParams['episodeId'] = s.episodeId;
    if (s.positionSeconds) queryParams['t'] = Math.floor(s.positionSeconds);
    this.remote.selectTarget(null);
    this.closeOverlay();
    void this.router.navigate(['/watch', s.mediaFileId], { queryParams });
  }

  onSeek(positionSeconds: number): void {
    const targetId = this.remote.selectedTargetId();
    if (!targetId) return;
    this.remote.sendCoalesced(targetId, { action: 'seek', positionSeconds });
  }

  skip(deltaSeconds: number): void {
    const targetId = this.remote.selectedTargetId();
    const s = this.remote.targetState();
    if (!targetId || !s) return;
    const duration = s.durationSeconds || Infinity;
    const positionSeconds = Math.max(0, Math.min(this.remote.interpolatedPosition() + deltaSeconds, duration));
    void this.remote.send(targetId, { action: 'seek', positionSeconds });
  }

  togglePlay(): void {
    const targetId = this.remote.selectedTargetId();
    const s = this.remote.targetState();
    if (!targetId || !s) return;
    void this.remote.send(targetId, { action: s.state === 'playing' ? 'pause' : 'play' });
  }

  toggleMute(): void {
    const targetId = this.remote.selectedTargetId();
    const s = this.remote.targetState();
    if (!targetId || !s) return;
    void this.remote.send(targetId, { action: 'mute', muted: !(s.muted ?? false) });
  }

  onVolume(event: Event): void {
    const targetId = this.remote.selectedTargetId();
    if (!targetId) return;
    const level = Number((event.target as HTMLInputElement).value);
    this.remote.sendCoalesced(targetId, { action: 'volume', level });
  }

  next(): void {
    const targetId = this.remote.selectedTargetId();
    if (!targetId) return;
    void this.remote.send(targetId, { action: 'next' });
  }

  selectAudio(trackId: string): void {
    const targetId = this.remote.selectedTargetId();
    if (!targetId) return;
    void this.remote.send(targetId, { action: 'audio', trackId });
  }

  selectSubtitle(subtitleId: string | null): void {
    const targetId = this.remote.selectedTargetId();
    if (!targetId) return;
    void this.remote.send(targetId, { action: 'subtitle', subtitleId });
  }

  isActiveAudio(o: CastAudioOption): boolean {
    const idx = this.remote.targetState()?.audioTrackIndex;
    return idx != null && o.id === `audio-${idx}`;
  }

  isActiveSubtitle(o: SubtitleOption): boolean {
    const idx = this.remote.targetState()?.subtitleTrackIndex;
    return idx != null && o.streamIndex === idx;
  }

  isSubtitlesOff(): boolean {
    return this.remote.targetState()?.subtitleTrackIndex == null;
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

  /** Fetch the file's tracks independent of which device plays it: the
   *  same streamInfo/subtitle rows the Cast picker and the local player use. */
  private async loadTracks(mediaId: number, mediaFileId: number): Promise<void> {
    try {
      const [media, subs] = await Promise.all([
        this.mediaService.getOne(mediaId).catch(() => null),
        this.subtitlesApi.getForMedia(mediaId).catch(() => [] as any[]),
      ]);
      const file = (media?.files ?? []).find((f: any) => f.id === mediaFileId);
      this.audioOptions.set(buildCastAudioOptions(file?.streamInfo?.audio, this.translate));
      const tracks = buildSubtitleTracks(subs, mediaFileId, { hideBurnIn: false });
      this.subtitleOptions.set(
        tracks.map((t, i) => ({
          id: t.key,
          label: formatSubtitleLabel(t, this.translate, i + 1),
          streamIndex: t.streamIndex,
        })),
      );
    } catch (err) {
      console.warn('[remote-overlay] failed to load tracks', mediaId, mediaFileId, err);
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
