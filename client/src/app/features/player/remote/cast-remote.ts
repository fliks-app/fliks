import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CastService } from '../../../core/services/cast.service';
import { AppSettingsService } from '../../../core/services/app-settings.service';
import { DropdownMenuComponent } from '../../../shared/components/dropdown-menu';
import { TranslateModule } from '@ngx-translate/core';
import {
  LucideCaptions,
  LucideCast,
  LucideCheck,
  LucideChevronLeft,
  LucideHeadphones,
  LucidePause,
  LucidePlay,
  LucideRotateCcw,
  LucideRotateCw,
  LucideSettings,
  LucideSquare,
  LucideVolume2,
  LucideVolumeX,
} from '@lucide/angular';

export interface CastSubtitleOption {
  id: string;
  label: string;
  language: string;
  burnIn: boolean;
  castTrackId?: number;
}

export interface CastAudioOption {
  id: string;
  label: string;
  language?: string;
}

export interface CastQualityOption {
  id: string;
  label: string;
  lowBandwidth?: boolean;
}

@Component({
  selector: 'app-cast-remote',
  imports: [
    LucideCaptions, LucideCast, LucideCheck, LucideChevronLeft,
    LucideHeadphones, LucidePause, LucidePlay, LucideRotateCcw, LucideRotateCw,
    LucideSettings, LucideSquare, LucideVolume2, LucideVolumeX,
    TranslateModule,
    DropdownMenuComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './cast-remote.html',
  styles: [`
    .player-container {
      position: fixed;
      inset: 0;
      background-color: #000;
      z-index: 100;
      overflow: hidden;
    }
  `],
})
export class CastRemoteComponent {
  readonly cast = inject(CastService);
  private readonly appSettings = inject(AppSettingsService);

  readonly sortedSubtitles = computed(() =>
    this.appSettings.sortTracks(this.availableSubtitles()),
  );
  readonly sortedAudioTracks = computed(() =>
    this.appSettings.sortTracks(this.availableAudioTracks()),
  );

  readonly mediaTitle = input('');
  readonly episodeTitle = input('');
  readonly fanartUrl = input<string | null>(null);
  readonly availableSubtitles = input<CastSubtitleOption[]>([]);
  readonly availableAudioTracks = input<CastAudioOption[]>([]);
  readonly availableQualities = input<CastQualityOption[]>([]);
  readonly initialSubtitleId = input<string | null>(null);
  readonly initialQualityId = input('auto');
  readonly initialAudioTrackId = input<string | null>(null);

  readonly back = output<void>();
  readonly disconnect = output<void>();
  readonly selectBurnIn = output<number | null>();
  readonly qualityChange = output<string>();
  readonly audioChange = output<number>();

  readonly dragging = signal(false);
  readonly dragTime = signal(0);
  readonly activeSubId = signal<string | null>(null);
  readonly activeAudioId = signal<string | null>(null);
  readonly activeQualityId = signal('auto');

  // Sync initial values from local player
  private readonly initEffect = effect(() => {
    const initialSub = this.initialSubtitleId();
    if (initialSub && !this.activeSubId()) this.activeSubId.set(initialSub);
    const initialQuality = this.initialQualityId();
    if (initialQuality && this.activeQualityId() === 'auto') this.activeQualityId.set(initialQuality);
    const initialAudio = this.initialAudioTrackId();
    if (initialAudio && !this.activeAudioId()) this.activeAudioId.set(initialAudio);
  });

  progressPercent(): number {
    const d = this.cast.duration() || 1;
    return (this.cast.currentTime() / d) * 100;
  }

  dragPercent(): number {
    const d = this.cast.duration() || 1;
    return (this.dragTime() / d) * 100;
  }

  togglePlay() {
    this.cast.togglePlayPause();
  }

  selectSubtitle(sub: CastSubtitleOption | null) {
    if (!sub) {
      this.activeSubId.set(null);
      this.cast.setActiveSubtitle(0);
      this.selectBurnIn.emit(null);
      return;
    }
    this.activeSubId.set(sub.id);
    if (sub.burnIn) {
      this.selectBurnIn.emit(sub.castTrackId ?? 0);
    } else if (sub.castTrackId) {
      this.cast.setActiveSubtitle(sub.castTrackId);
    }
  }

  selectAudio(track: CastAudioOption | null) {
    if (!track) return;
    this.activeAudioId.set(track.id);
    // Extract index from id (si-N, shaka-N, or audio-N)
    const idx = parseInt(track.id.replace(/^(si-|shaka-|audio-)/, ''), 10);
    this.audioChange.emit(idx);
  }

  selectQuality(quality: CastQualityOption) {
    if (quality.id === this.activeQualityId()) return;
    this.activeQualityId.set(quality.id);
    this.qualityChange.emit(quality.id);
  }

  onProgressDown(event: PointerEvent) {
    const bar = event.currentTarget as HTMLElement;
    bar.setPointerCapture(event.pointerId);
    event.preventDefault();
    this.dragging.set(true);
    this.updateDrag(event, bar);

    const onMove = (e: PointerEvent) => this.updateDrag(e, bar);
    const onUp = () => {
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', onUp);
      bar.removeEventListener('pointercancel', onUp);
      this.cast.seek(this.dragTime());
      this.dragging.set(false);
    };
    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onUp);
    bar.addEventListener('pointercancel', onUp);
  }

  private updateDrag(e: PointerEvent, bar: HTMLElement) {
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    this.dragTime.set(ratio * (this.cast.duration() || 0));
  }

  formatTime(seconds: number): string {
    if (!seconds || !isFinite(seconds)) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
}
