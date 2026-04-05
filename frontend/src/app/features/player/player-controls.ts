import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import {
  LucideCaptions,
  LucideChartNoAxesColumnIncreasing,
  LucideCheck,
  LucideChevronLeft,
  LucideMaximize,
  LucidePictureInPicture2,
  LucideRotateCcw,
  LucideRotateCw,
  LucideSettings,
  LucideSkipForward,
  LucideCast,
  LucideHeadphones,
  LucideVolume2,
  LucideVolumeX,
} from '@lucide/angular';

@Component({
  selector: 'app-player-controls',
  imports: [
    TranslateModule,
    LucideCaptions,
    LucideChartNoAxesColumnIncreasing,
    LucideCheck,
    LucideChevronLeft,
    LucideMaximize,
    LucidePictureInPicture2,
    LucideRotateCcw,
    LucideRotateCw,
    LucideSettings,
    LucideSkipForward,
    LucideCast,
    LucideHeadphones,
    LucideVolume2,
    LucideVolumeX,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './player-controls.html',
})
export class PlayerControlsComponent {
  readonly visible = input(true);
  readonly paused = input(true);
  readonly loading = input(false);
  readonly buffering = input(false);
  readonly currentTime = input(0);
  readonly duration = input(0);
  readonly bufferedEnd = input(0);
  readonly volume = input(1);
  readonly playbackRate = input(1);
  readonly mediaTitle = input('');
  readonly episodeTitle = input('');
  readonly hasNextEpisode = input(false);
  readonly hasPrevEpisode = input(false);
  readonly activeQualityLabel = input('Auto');
  readonly isNative = input(false);
  readonly subtitlePickerOpen = input(false);
  readonly qualityPickerOpen = input(false);
  readonly availableSubtitles = input<{ id: string; label: string; burnIn?: boolean }[]>([]);
  readonly availableQualities = input<{ id: string; label: string }[]>([]);
  readonly activeSubtitleId = input<string | null>(null);
  readonly activeQualityId = input('auto');
  readonly availableAudioTracks = input<{ id: string; label: string }[]>([]);
  readonly activeAudioTrackId = input<string | null>(null);
  readonly castAvailable = input(false);
  readonly castConnected = input(false);
  readonly castConnecting = input(false);

  readonly togglePlay = output<void>();
  readonly tapOverlay = output<void>();
  readonly seek = output<number>();
  readonly volumeChange = output<number>();
  readonly toggleMute = output<void>();
  readonly toggleFullscreen = output<void>();
  readonly togglePip = output<void>();
  readonly toggleSubtitlePicker = output<void>();
  readonly toggleStats = output<void>();
  readonly toggleQualityPicker = output<void>();
  readonly selectSubtitle = output<string | null>();
  readonly selectQuality = output<string>();
  readonly speedChange = output<number>();
  readonly nextEpisode = output<void>();
  readonly prevEpisode = output<void>();
  readonly back = output<void>();
  readonly selectAudioTrack = output<string>();
  readonly toggleCast = output<void>();

  readonly speedOptions = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  // Progress bar drag state
  readonly dragging = signal(false);
  readonly dragTime = signal(0);
  /** After seek release, hold the drag position until currentTime catches up */
  readonly seekPending = signal(false);
  private seekTarget = 0;

  formatTime(seconds: number): string {
    if (!seconds || !isFinite(seconds)) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  formatRemaining(current: number, total: number): string {
    if (!total || !isFinite(total)) return '';
    return '-' + this.formatTime(Math.max(0, total - current));
  }

  onSeek(event: Event) {
    const value = +(event.target as HTMLInputElement).value;
    this.seek.emit(value);
  }

  onVolumeChange(event: Event) {
    const value = +(event.target as HTMLInputElement).value;
    this.volumeChange.emit(value);
  }

  /** The displayed position: dragTime during drag/seekPending, currentTime otherwise */
  readonly displayTime = computed(() => {
    if (this.dragging()) return this.dragTime();
    if (this.seekPending()) {
      // Check if currentTime caught up — clear seekPending outside render via setTimeout
      if (Math.abs(this.currentTime() - this.seekTarget) < 2) {
        setTimeout(() => this.seekPending.set(false), 0);
        return this.currentTime();
      }
      return this.dragTime();
    }
    return this.currentTime();
  });

  readonly displayPercent = computed(() => {
    const d = this.duration() || 1;
    return (this.displayTime() / d) * 100;
  });

  onProgressDown(event: PointerEvent) {
    const bar = event.currentTarget as HTMLElement;
    bar.setPointerCapture(event.pointerId);
    event.preventDefault();

    this.dragging.set(true);
    this.updateDragFromPointer(event, bar);

    const onMove = (e: PointerEvent) => {
      this.updateDragFromPointer(e, bar);
    };

    const onUp = () => {
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', onUp);
      bar.removeEventListener('pointercancel', onUp);
      this.dragging.set(false);
      // Keep showing dragTime until currentTime catches up
      this.seekTarget = this.dragTime();
      this.seekPending.set(true);
      this.seek.emit(this.seekTarget);
    };

    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onUp);
    bar.addEventListener('pointercancel', onUp);
  }

  private updateDragFromPointer(e: PointerEvent, bar: HTMLElement) {
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    this.dragTime.set(ratio * (this.duration() || 0));
  }
}
