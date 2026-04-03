import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-player-controls',
  imports: [TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './player-controls.html',
})
export class PlayerControlsComponent {
  readonly visible = input(true);
  readonly paused = input(true);
  readonly currentTime = input(0);
  readonly duration = input(0);
  readonly volume = input(1);
  readonly playbackRate = input(1);
  readonly mediaTitle = input('');
  readonly episodeTitle = input('');
  readonly hasNextEpisode = input(false);
  readonly hasPrevEpisode = input(false);

  readonly togglePlay = output<void>();
  readonly seek = output<number>();
  readonly volumeChange = output<number>();
  readonly toggleMute = output<void>();
  readonly toggleFullscreen = output<void>();
  readonly togglePip = output<void>();
  readonly toggleSubtitlePicker = output<void>();
  readonly toggleStats = output<void>();
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

  onSeek(event: Event) {
    const value = +(event.target as HTMLInputElement).value;
    this.seek.emit(value);
  }

  onVolumeChange(event: Event) {
    const value = +(event.target as HTMLInputElement).value;
    this.volumeChange.emit(value);
  }
}
