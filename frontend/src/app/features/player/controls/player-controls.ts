import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
  TemplateRef,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { BottomSheetComponent } from '../../../shared/components/bottom-sheet';
import { TranslateModule } from '@ngx-translate/core';
import { formatTime, calcDragTime, calcHoverPercent, SpriteMetadata } from '../../../core/utils/player.utils';
import {
  LucideCaptions,
  LucideChartNoAxesColumnIncreasing,
  LucideCheck,
  LucideChevronLeft,
  LucideChevronRight,
  LucideArrowLeft,
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
    NgTemplateOutlet,
    BottomSheetComponent,
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
  readonly spriteUrl = input<string | null>(null);
  readonly spriteMetadata = input<SpriteMetadata | null>(null);
  readonly fillScreen = input(false);
  readonly statsVisible = input(false);
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
  readonly toggleFillScreen = output<void>();

  readonly speedOptions = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  /** Settings dropdown panel navigation */
  readonly settingsPanel = signal<'main' | 'quality'>('main');

  /** Mobile bottom sheet state */
  readonly activeSheet = signal<'subtitles' | 'audio' | 'speed' | 'settings' | null>(null);

  openSheet(sheet: 'subtitles' | 'audio' | 'speed' | 'settings') {
    if (sheet === 'settings') this.settingsPanel.set('main');
    this.activeSheet.set(sheet);
  }

  closeSheet() {
    this.activeSheet.set(null);
  }

  // Progress bar drag state
  readonly dragging = signal(false);
  readonly dragTime = signal(0);
  /** After seek release, hold the drag position until currentTime catches up */
  readonly seekPending = signal(false);
  private seekTarget = 0;

  // Hover state for tooltip
  readonly hovering = signal(false);
  readonly hoverTime = signal(0);
  readonly hoverPercent = signal(0);

  readonly formatTime = formatTime;

  /** CSS background-position to show the correct thumbnail in the sprite */
  readonly thumbnailBgPosition = computed(() => {
    const meta = this.spriteMetadata();
    if (!meta) return '0 0';
    const time = this.dragging() ? this.dragTime() : this.hoverTime();
    const index = Math.min(Math.floor(time / meta.interval), meta.count - 1);
    const col = index % meta.columns;
    const row = Math.floor(index / meta.columns);
    return `-${col * meta.thumbWidth}px -${row * meta.thumbHeight}px`;
  });

  /** CSS background-size for the sprite image */
  readonly spriteBgSize = computed(() => {
    const meta = this.spriteMetadata();
    if (!meta) return 'auto';
    const rows = Math.ceil(meta.count / meta.columns);
    return `${meta.columns * meta.thumbWidth}px ${rows * meta.thumbHeight}px`;
  });

  private static readonly SCALE = 1.5;

  /** Scaled background-position (1.5x) */
  readonly thumbnailBgPositionScaled = computed(() => {
    const meta = this.spriteMetadata();
    if (!meta) return '0 0';
    const s = PlayerControlsComponent.SCALE;
    const time = this.dragging() ? this.dragTime() : this.hoverTime();
    const index = Math.min(Math.floor(time / meta.interval), meta.count - 1);
    const col = index % meta.columns;
    const row = Math.floor(index / meta.columns);
    return `-${col * meta.thumbWidth * s}px -${row * meta.thumbHeight * s}px`;
  });

  /** Scaled background-size (1.5x) */
  readonly spriteBgSizeScaled = computed(() => {
    const meta = this.spriteMetadata();
    if (!meta) return 'auto';
    const s = PlayerControlsComponent.SCALE;
    const rows = Math.ceil(meta.count / meta.columns);
    return `${meta.columns * meta.thumbWidth * s}px ${rows * meta.thumbHeight * s}px`;
  });

  /** Clamped tooltip left position (keeps tooltip within bar bounds) */
  readonly tooltipLeft = computed(() => {
    const pct = this.dragging() ? this.displayPercent() : this.hoverPercent();
    // 120px = half tooltip width (~240px at 160*1.5). Clamp via CSS calc.
    return `clamp(120px, ${pct}%, calc(100% - 120px))`;
  });

  formatRemaining(current: number, total: number): string {
    if (!total || !isFinite(total)) return '';
    return '-' + formatTime(Math.max(0, total - current));
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
    this.dragTime.set(calcDragTime(e, bar, this.duration()));
  }

  onProgressHover(event: PointerEvent) {
    if (this.dragging()) return; // drag already tracks position
    const bar = event.currentTarget as HTMLElement;
    this.hovering.set(true);
    this.hoverTime.set(calcDragTime(event, bar, this.duration()));
    this.hoverPercent.set(calcHoverPercent(event, bar));
  }

  onProgressLeave() {
    this.hovering.set(false);
  }

  /** Close a daisyUI tabindex dropdown by blurring its trigger. */
  closeDropdown(event: Event) {
    const el = (event.target as HTMLElement).closest('.dropdown');
    if (el) (el.querySelector('[tabindex]') as HTMLElement)?.blur();
    this.settingsPanel.set('main');
  }

  /** Reset settings panel when opening the dropdown. */
  openSettings() {
    this.settingsPanel.set('main');
  }
}
