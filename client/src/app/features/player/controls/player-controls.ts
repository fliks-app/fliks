import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DeviceService } from '../../../core/services/device.service';
import { DismissableStackService } from '../../../core/services/dismissable-stack.service';
import { PlayerSettingsService } from '../../../core/services/player-settings.service';
import { NgTemplateOutlet } from '@angular/common';
import { BottomSheetComponent } from '../../../shared/components/bottom-sheet';
import { TranslateModule } from '@ngx-translate/core';
import { formatTime, SpriteMetadata } from '../../../core/utils/player.utils';
import { SeekbarComponent } from '../../../shared/components/seekbar/seekbar';
import {
  LucideCaptions,
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
} from '@lucide/angular';

@Component({
  selector: 'app-player-controls',
  imports: [
    TranslateModule,
    LucideCaptions,
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
  private readonly device = inject(DeviceService);
  private readonly dismissStack = inject(DismissableStackService);
  private readonly playerSettings = inject(PlayerSettingsService);
  /** True on Android TV — drives 10-foot UI choices in the template. */
  readonly isTv = this.device.isTv;
  /** Hide the "faible consommation" badge when eco is the forced default —
   *  every visible rung is eco then, so the tag is just noise. */
  readonly showEcoBadge = computed(
    () => !this.playerSettings.settings().ecoByDefault,
  );

  constructor() {
    // Mirror the open dropdown into the global dismissable stack so the
    // Capacitor hardware back button (which never reaches our keydown
    // listener — it's intercepted by the App plugin in app.ts) closes the
    // panel before falling through to "leave the player".
    effect((onCleanup) => {
      if (!this.openDropdown()) return;
      const close = () => {
        this.closeDropdown();
        this.dropdownTrigger?.focus({ preventScroll: true });
      };
      this.dismissStack.push(close);
      onCleanup(() => this.dismissStack.remove(close));
    });
    // TV: snap focus back to play/pause every time the controls bar shows.
    // On a remote, the user can't reach a button without first reactivating
    // the bar, so the next D-pad center always means "toggle playback"
    // regardless of where focus drifted before the bar auto-hid.
    effect(() => {
      const visible = this.visible();
      const wasVisible = this.lastVisible;
      this.lastVisible = visible;
      if (visible && !wasVisible && this.isTv()) {
        this.closeDropdown();
        this.playPauseBtn()?.nativeElement.focus({ preventScroll: true });
      }
    });
    // Propagate any-panel-open state to the parent player so it can suspend
    // its auto-hide timer while a dropdown or bottom sheet is up.
    effect(() => {
      const open = this.openDropdown() !== null || this.activeSheet() !== null;
      if (open === this.lastPanelOpen) return;
      this.lastPanelOpen = open;
      this.panelOpenChange.emit(open);
    });
  }
  private lastPanelOpen = false;
  private lastVisible = true;
  /**
   * Player layout selection. Splits the three concerns the template branches on:
   * - 'tv' → desktop-style toolbar with dropdowns (D-pad-friendly).
   * - 'mobile' → big center play/seek buttons + bottom sheets (touch).
   * - 'desktop' → desktop-style toolbar with dropdowns (mouse + keyboard).
   * Tablets land on 'mobile' so taps reach the controls — the previous
   * `isNative && !isTv` rule excluded tablets that were mis-classified as TV.
   */
  readonly playerLayout = computed<'desktop' | 'mobile' | 'tv'>(() => {
    if (this.device.isTv()) return 'tv';
    if (this.device.isTouch()) return 'mobile';
    return 'desktop';
  });
  /** True when the touch-optimised mobile layout should render. */
  readonly isMobileTouch = computed(() => this.playerLayout() === 'mobile');

  readonly visible = input(true);
  readonly paused = input(true);
  readonly loading = input(false);
  readonly buffering = input(false);
  /** True once the first decoded frame is on the surface. Hides the big
   *  mobile play/pause button on cold start so it doesn't overlay the
   *  centered loading spinner before any frame has rendered. */
  readonly videoStarted = input(true);
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
  readonly pipAvailable = input(true);
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
  /** Mirror of the seekbar's drag state for local layout — true while the
   *  user is scrubbing. Drives a z-index bump on the bottom bar so the
   *  sprite preview tooltip pops above the mobile center buttons (which
   *  sit at z-50 to stay tappable when the bar grows tall). */
  readonly seekDragging = signal(false);
  /**
   * Fires whenever any of the controls' own panels (desktop dropdown OR
   * mobile bottom sheet) opens or closes. Lets the parent player pause its
   * auto-hide timer while a panel is up — otherwise the subtitle/audio sheet
   * on mobile gets orphaned when the 3 s timer hides the controls behind it.
   */
  readonly panelOpenChange = output<boolean>();

  readonly speedOptions = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  /** Settings dropdown panel navigation */
  readonly settingsPanel = signal<'main' | 'quality'>('main');

  /**
   * Which click-driven dropdown is open, or null. Replaces DaisyUI's
   * focus-within trigger so dropdowns no longer pop open just by D-pad
   * focusing their button — a click/Enter is required.
   */
  readonly openDropdown = signal<'subtitles' | 'audio' | 'speed' | 'settings' | null>(null);

  /** True when any desktop dropdown is open — prevents play/pause on backdrop click. */
  readonly hasOpenDropdown = computed(() => this.openDropdown() !== null);

  /** Mobile bottom sheet state */
  readonly activeSheet = signal<'subtitles' | 'audio' | 'speed' | 'settings' | null>(null);

  readonly seekbar = viewChild(SeekbarComponent);
  /** Desktop/TV play-pause button — focused on TV every time the controls
   *  bar reappears, so the next D-pad center triggers play/pause. */
  private readonly playPauseBtn = viewChild<ElementRef<HTMLButtonElement>>('playPauseBtn');
  readonly hostEl: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly injector = inject(Injector);
  private dropdownTrigger: HTMLElement | null = null;

  openSheet(sheet: 'subtitles' | 'audio' | 'speed' | 'settings') {
    if (sheet === 'settings') this.settingsPanel.set('main');
    this.activeSheet.set(sheet);
  }

  closeSheet() {
    this.activeSheet.set(null);
  }

  /**
   * Close the open dropdown when Escape (web) or KEYCODE_BACK (Android remote)
   * fires. We intercept in capture phase so the OS Back button doesn't navigate
   * the player away while a panel is still open.
   */
  @HostListener('window:keydown', ['$event'])
  onWindowKey(e: KeyboardEvent) {
    if (!this.openDropdown()) return;
    const isBack = e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack' || e.keyCode === 4 || e.keyCode === 27;
    if (!isBack) return;
    e.preventDefault();
    e.stopPropagation();
    this.closeDropdown();
    this.dropdownTrigger?.focus({ preventScroll: true });
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
    const next = this.openDropdown() === name ? null : name;
    this.openDropdown.set(next);
    if (next) {
      // Remember the trigger so Back/Escape can refocus it after closing.
      this.dropdownTrigger = (event?.currentTarget as HTMLElement) ?? null;
      // Push focus into the panel so the first item is reachable without
      // having to traverse out of the trigger via spatial nav (D-pad on TV,
      // arrow keys on desktop keyboard). Harmless for mouse users.
      this.focusFirstDropdownItem();
    }
  }

  /** Close current dropdown (called from the click-out backdrop or by Escape).
   *  Item-selection handlers in dropdowns deliberately do NOT call this — the
   *  user can change a setting (subtitle / audio / speed / quality) and then
   *  dismiss the menu themselves with a click outside. */
  closeDropdown(event?: Event) {
    event?.stopPropagation();
    this.openDropdown.set(null);
    this.settingsPanel.set('main');
  }

  private focusFirstDropdownItem() {
    afterNextRender(
      () => {
        const panel = this.hostEl.nativeElement.querySelector<HTMLElement>('.dropdown-open .dropdown-content');
        const first = panel?.querySelector<HTMLElement>('button, a, [tabindex]:not([tabindex="-1"])');
        first?.focus({ preventScroll: true });
      },
      { injector: this.injector },
    );
  }
}
