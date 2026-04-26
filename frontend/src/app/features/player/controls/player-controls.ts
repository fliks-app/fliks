import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TvService } from '../../../core/services/tv.service';
import { NgTemplateOutlet } from '@angular/common';
import { BottomSheetComponent } from '../../../shared/components/bottom-sheet';
import { TranslateModule } from '@ngx-translate/core';
import { formatTime, SpriteMetadata } from '../../../core/utils/player.utils';
import { SeekbarComponent } from '../../../shared/components/seekbar/seekbar';
import {
  LucideCaptions,
  LucideChartNoAxesColumnIncreasing,
  LucideCheck,
  LucideChevronLeft,
  LucideChevronRight,
  LucideArrowLeft,
  LucideExternalLink,
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
  LucideScan,
  LucideMinimize,
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
    LucideSkipForward,
    LucideCast,
    LucideHeadphones,
    LucideVolume2,
    LucideVolumeX,
    LucideScan,
    LucideMinimize,
    LucideSettings,
    LucideChevronRight,
    LucideArrowLeft,
    LucideExternalLink,
    NgTemplateOutlet,
    BottomSheetComponent,
    SeekbarComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './player-controls.html',
})
export class PlayerControlsComponent {
  private readonly tvService = inject(TvService);
  /** True on Android TV — drives 10-foot UI choices in the template. */
  readonly isTv = this.tvService.isTv;
  /**
   * On TV we want the desktop-style layout (dropdowns instead of bottom-sheets,
   * left/right toolbars instead of stacked mobile rows) because focus + D-pad
   * navigation is far more natural with that structure. Templates use this
   * computed instead of `isNative()` whenever a touch-only behavior is gated.
   */
  readonly isMobileTouch = computed(() => this.isNative() && !this.isTv());

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
  readonly availableQualities = input<{ id: string; label: string; lowBandwidth?: boolean }[]>([]);
  readonly activeSubtitleId = input<string | null>(null);
  readonly activeQualityId = input('auto');
  readonly availableAudioTracks = input<{ id: string; label: string }[]>([]);
  readonly activeAudioTrackId = input<string | null>(null);
  readonly castAvailable = input(false);
  readonly castConnected = input(false);
  readonly castConnecting = input(false);
  readonly spriteUrl = input<string | null>(null);
  readonly spriteMetadata = input<SpriteMetadata | null>(null);
  readonly chapters = input<{ startSeconds: number; endSeconds: number; title?: string }[]>([]);
  readonly fillScreen = input(false);
  readonly statsVisible = input(false);
  readonly showSkipIntro = input(false);
  readonly showNextEpisode = input(false);
  readonly togglePlay = output<void>();
  readonly skipIntro = output<void>();
  readonly skipToNextEpisode = output<void>();
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
  readonly toggleFillScreen = output<void>();
  readonly openMedia = output<void>();
  readonly seekDragChange = output<boolean>();

  readonly speedOptions = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  /** Settings dropdown panel navigation */
  readonly settingsPanel = signal<'main' | 'quality'>('main');

  /**
   * Which click-driven dropdown is open, or null. Replaces DaisyUI's
   * focus-within trigger so dropdowns no longer pop open just by D-pad
   * focusing their button — a click/Enter is required (Jellyfin-aligned).
   */
  readonly openDropdown = signal<'subtitles' | 'audio' | 'speed' | 'settings' | null>(null);

  /** True when any desktop dropdown is open — prevents play/pause on backdrop click. */
  readonly hasOpenDropdown = computed(() => this.openDropdown() !== null);

  /** Mobile bottom sheet state */
  readonly activeSheet = signal<'subtitles' | 'audio' | 'speed' | 'settings' | null>(null);

  readonly seekbar = viewChild(SeekbarComponent);

  openSheet(sheet: 'subtitles' | 'audio' | 'speed' | 'settings') {
    if (sheet === 'settings') this.settingsPanel.set('main');
    this.activeSheet.set(sheet);
  }

  closeSheet() {
    this.activeSheet.set(null);
  }

  readonly formatTime = formatTime;

  formatRemaining(current: number, total: number): string {
    if (!total || !isFinite(total)) return '';
    return '-' + formatTime(Math.max(0, total - current));
  }

  onVolumeChange(event: Event) {
    const value = +(event.target as HTMLInputElement).value;
    this.volumeChange.emit(value);
  }

  getDisplayTime(): number {
    return this.seekbar()?.displayTime() ?? this.currentTime();
  }

  /** Toggle a click-driven dropdown. Closes any other open one. */
  toggleDropdown(name: 'subtitles' | 'audio' | 'speed' | 'settings', event?: Event) {
    event?.stopPropagation();
    if (name === 'settings') this.settingsPanel.set('main');
    this.openDropdown.set(this.openDropdown() === name ? null : name);
  }

  /** Close current dropdown after an item selection (and reset settings panel). */
  closeDropdown(event?: Event) {
    event?.stopPropagation();
    this.openDropdown.set(null);
    this.settingsPanel.set('main');
  }
}
