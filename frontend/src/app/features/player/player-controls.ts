import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
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
  readonly availableSubtitles = input<{ id: string; label: string }[]>([]);
  readonly availableQualities = input<{ id: string; label: string }[]>([]);
  readonly activeSubtitleId = input<string | null>(null);
  readonly activeQualityId = input('auto');

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

  readonly speedOptions = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

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

  onProgressClick(event: MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    this.seek.emit(ratio * (this.duration() || 0));
  }

  onProgressDrag(event: PointerEvent) {
    const bar = event.currentTarget as HTMLElement;
    bar.setPointerCapture(event.pointerId);

    const onMove = (e: PointerEvent) => {
      const rect = bar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      this.seek.emit(ratio * (this.duration() || 0));
    };

    const onUp = () => {
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', onUp);
    };

    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onUp);
  }
}
