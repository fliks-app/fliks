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
import { TvService } from '../../../core/services/tv.service';
import { DismissableStackService } from '../../../core/services/dismissable-stack.service';
import {
  PlayerSettings,
  PlayerSettingsService,
} from '../../../core/services/player-settings.service';
import {
  SIZE_OPTIONS,
  COLOR_OPTIONS,
  SHADOW_OPTIONS,
  BG_OPTIONS,
  BOTTOM_MARGIN_OPTIONS,
  TOP_MARGIN_OPTIONS,
} from '../../playback-settings/playback-options';
import { QueueItem } from '../../../core/services/playback-queue.service';
import { NgTemplateOutlet } from '@angular/common';
import { BottomSheetComponent } from '../../../shared/components/bottom-sheet';
import { TranslateModule } from '@ngx-translate/core';
import { formatTime, SpriteMetadata } from '../../../core/utils/player.utils';
import { initialOverlayFocus } from '../../../core/services/focusable.constants';
import { SeekbarComponent } from '../../../shared/components/seekbar/seekbar';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../../shared/directives/cached-src.directive';
import { SelectedOptionDirective } from '../../../shared/directives/selected-option.directive';
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
  LucideLeaf,
  LucideLock,
  LucideLockOpen,
  LucideVolume2,
  LucideVolumeX,
} from '@lucide/angular';

/** Panels of the subtitles menu: the track list, the appearance summary, then
 *  one leaf list per appearance field. */
type SubtitlePanel =
  | 'tracks'
  | 'appearance'
  | 'size'
  | 'color'
  | 'shadow'
  | 'bg'
  | 'position-bottom'
  | 'position-top';

/** `labelKey` is translated; `label` carries values that aren't text (margin %). */
interface AppearanceOption {
  value: string | number;
  labelKey?: string;
  label?: string;
}

interface AppearanceRow {
  panel: SubtitlePanel;
  field: keyof PlayerSettings;
  labelKey: string;
  options: AppearanceOption[];
}

@Component({
  selector: 'app-player-controls',
  imports: [
    CachedSrcDirective,
    SelectedOptionDirective,
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
    LucideLeaf,
    LucideLock,
    LucideLockOpen,
    LucideVolume2,
    LucideVolumeX,
    LucideSettings,
    LucideChevronRight,
    LucideArrowLeft,
    LucideExternalLink,
    NgTemplateOutlet,
    BottomSheetComponent,
    SeekbarComponent,
    ResolveUrlPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './player-controls.html',
  // Bar insets live on the host so the floating cues inherit them and line up
  // with the controls' right edge.
  host: { class: '[--ctrl-px:1rem] [--ctrl-pb:0.5rem] sm:[--ctrl-pb:1rem] xl:[--ctrl-inset:1rem]' },
})
export class PlayerControlsComponent {
  private readonly device = inject(DeviceService);
  private readonly dismissStack = inject(DismissableStackService);
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly tv = inject(TvService);
  /** True on Android TV — drives 10-foot UI choices in the template. */
  readonly isTv = this.device.isTv;
  /** Hide the "faible consommation" badge when eco is the forced default —
   *  every visible rung is eco then, so the tag is just noise. */
  readonly showEcoBadge = computed(
    () => !this.playerSettings.settings().ecoByDefault,
  );
  /** Show a leaf next to the quality value when the active rung is a
   *  low-consumption one — and the eco-by-default setting hasn't already made
   *  the tag redundant (every rung eco then). */
  readonly showEcoLeaf = computed(
    () =>
      this.showEcoBadge() &&
      (this.availableQualities().find((q) => q.id === this.activeQualityId())
        ?.lowBandwidth ??
        false),
  );

  constructor() {
    // Mirror the open dropdown into the global dismissable stack so the
    // Capacitor hardware back button (which never reaches our keydown
    // listener — it's intercepted by the App plugin in app.ts) closes the
    // panel before falling through to "leave the player".
    effect((onCleanup) => {
      if (!this.openDropdown()) return;
      const close = () => this.dropdownBack();
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
      // Focus play/pause when the bar appears under keyboard / D-pad so the
      // next Enter/Space toggles playback. Skipped for pointer (mouse-revealed
      // controls shouldn't steal focus). The seek OSD renders no play/pause, so
      // an arrow-seek keeps the focus scrubFromKey put on the seekbar.
      if (visible && !wasVisible && this.autoFocusModality()) {
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
    // Floating-cue countdown — mirrors the progress sweep numerically, for the
    // intro and next-item cues alike. Reset to the full window each time a cue
    // (re)appears.
    effect(() => {
      if (this.showSkipIntro() || this.showNextCue()) {
        this.cueCountdown.set(Math.ceil(this.cueDurationMs() / 1000));
      }
    });
    // Tick down to 1, but hold while the cue is "engaged" — the controls bar is
    // up or the cue itself is focused. The parent freezes the retract timer on
    // the same conditions, so the number stays in lockstep. The cleanup stops
    // the tick on pause and on retract alike.
    effect((onCleanup) => {
      if ((!this.showSkipIntro() && !this.showNextCue()) || this.visible() || this.cueFocused()) return;
      const id = setInterval(
        () => this.cueCountdown.update((n) => (n > 1 ? n - 1 : 1)),
        1000,
      );
      onCleanup(() => clearInterval(id));
    });
    // A cue that disappears under the focus leaves it on <body>: the remote then
    // acts on nothing at all. Hand it back to play/pause, which is where the bar
    // puts focus whenever it appears.
    effect(() => {
      const gone = !this.skipIntroBtn() && !this.nextEpisodeBtn();
      if (!gone || !this.cueFocused()) return;
      this.cueFocused.set(false);
      const active = document.activeElement;
      if (active && active !== document.body) return;
      this.playPauseBtn()?.nativeElement.focus({ preventScroll: true });
    });
    // A cue removed while focused can swallow its blur, leaving the flag stuck;
    // clear it whenever no cue is shown so the next one isn't born frozen.
    effect(() => {
      if (!this.showSkipIntro() && !this.showNextCue()) {
        this.cueFocused.set(false);
      }
    });
    // Focus a floating cue the instant it mounts so a TV / keyboard user can
    // act on it without first hunting for it with the D-pad. Each effect is
    // driven by its cue's view-query signal, which holds the element while the
    // cue's @if is live and is undefined otherwise.
    effect(() => this.autoFocusCue(this.skipIntroBtn()));
    effect(() => this.autoFocusCue(this.nextEpisodeBtn()));
    // Center the currently-playing item when the queue panel opens (in either
    // the dropdown or the bottom sheet), so a long queue doesn't open scrolled
    // to the top. Re-runs if the cursor moves while the panel is up.
    effect(() => {
      if (this.settingsPanel() !== 'queue') return;
      this.queueIndex(); // re-center when the playing item changes
      requestAnimationFrame(() => {
        if (this.settingsPanel() !== 'queue') return;
        this.hostEl.nativeElement
          .querySelector('[data-queue-active="true"]')
          ?.scrollIntoView({ block: 'center' });
      });
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
  /** Reduced bar: only the seekbar and the time row. Raised by an arrow-key
   *  seek, the way TV players surface a scrub OSD instead of the toolbar. */
  readonly seekOsd = input(false);
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
  readonly muted = input(false);
  /** Effective slider position: drops to 0 while muted, so the thumb reflects
   *  what's actually audible; the retained level returns on unmute. */
  readonly displayVolume = computed(() => (this.muted() ? 0 : this.volume()));
  readonly playbackRate = input(1);
  readonly mediaTitle = input('');
  /** Clearlogo shown in place of the title text in the top-left overlay. */
  readonly logoUrl = input<string | null>(null);
  /** The logo URL whose image failed to load. The backend can hand back a
   *  logo path for media whose file was never stored (or got cleaned up), so
   *  the URL is truthy but 404s — fall back to the title instead of a broken
   *  image. Keyed by URL so it resets automatically on the next media. */
  private readonly failedLogoUrl = signal<string | null>(null);
  readonly showLogo = computed(
    () => !!this.logoUrl() && this.failedLogoUrl() !== this.logoUrl(),
  );
  onLogoError(): void {
    this.failedLogoUrl.set(this.logoUrl());
  }
  readonly episodeTitle = input('');
  readonly hasNext = input(false);
  /** i18n key for the next-item control label — episode vs generic item. */
  readonly nextLabelKey = input('player.next_episode');
  /** The active playback queue (playlist) and the index currently playing —
   *  drives the "File d'attente" menu (empty for standalone / series playback). */
  readonly queueItems = input<QueueItem[]>([]);
  readonly queueIndex = input(0);
  readonly activeQualityLabel = input('Auto');
  readonly isNative = input(false);
  /** Desktop (Electron) — native engine but mouse-driven; keeps the fullscreen
   *  button which is otherwise hidden for native (mobile/TV) engines. */
  readonly isDesktop = input(false);
  readonly availableSubtitles = input<{ id: string; label: string; menuHead?: string; menuSub?: string; burnIn?: boolean; isImage?: boolean }[]>([]);
  readonly availableQualities = input<{ id: string; label: string; lowBandwidth?: boolean }[]>([]);
  readonly activeSubtitleId = input<string | null>(null);
  readonly activeQualityId = input('auto');
  readonly availableAudioTracks = input<{ id: string; label: string; menuHead?: string; menuSub?: string }[]>([]);
  readonly activeAudioTrackId = input<string | null>(null);
  readonly pipAvailable = input(true);
  readonly canLockOrientation = input(false);
  readonly orientationLocked = input(false);
  readonly castAvailable = input(false);
  readonly castConnected = input(false);
  readonly castConnecting = input(false);
  readonly spriteUrl = input<string | null>(null);
  readonly spriteMetadata = input<SpriteMetadata | null>(null);
  readonly chapters = input<{ startSeconds: number; endSeconds: number; title?: string }[]>([]);
  readonly introMarker = input<{ startSeconds: number; endSeconds: number } | null>(null);
  readonly outroMarker = input<{ startSeconds: number; endSeconds: number } | null>(null);
  readonly fillScreen = input(false);
  readonly statsVisible = input(false);
  readonly showSkipIntro = input(false);
  readonly showNextCue = input(false);
  /** Gating these on `!visible()` was tried twice and reverted twice: unmounting
   *  a cue while its `showSkipIntro` is still true strands the `cueFocused`
   *  flag (its blur never fires), and the retract/countdown state then no
   *  longer matches what is on screen. Hide them at the player level, by
   *  retracting them, not by unmounting them here. */
  protected readonly skipIntroCue = computed(() => this.showSkipIntro());
  protected readonly nextItemCue = computed(() => this.showNextCue());
  /** Shown for the whole pre-roll item, not a timed cue — no sweep, no countdown. */
  readonly showPreRollSkip = input(false);
  /** How long a floating cue stays up, in ms — drives the in-button progress
   *  sweep so it finishes exactly as the parent retracts the cue. */
  readonly cueDurationMs = input(6000);
  /** Seconds left before the skip-intro cue retracts, shown in the button as a
   *  live countdown next to its progress sweep. */
  readonly cueCountdown = signal(0);
  /** True while a floating cue holds focus. The player reads it to freeze the
   *  retract timer, and the sweep / countdown freeze on it here — a cue the
   *  user has navigated to (keyboard / D-pad) must not vanish from under them. */
  readonly cueFocused = signal(false);
  readonly togglePlay = output<void>();
  readonly skipIntro = output<void>();
  readonly skipPreRoll = output<void>();
  readonly tapOverlay = output<void>();
  readonly seek = output<number>();
  readonly volumeChange = output<number>();
  readonly toggleMute = output<void>();
  readonly toggleFullscreen = output<void>();
  readonly togglePip = output<void>();
  readonly toggleOrientationLock = output<void>();
  readonly toggleStats = output<void>();
  readonly selectSubtitle = output<string | null>();
  readonly selectQuality = output<string>();
  /** Play the queue item at this index (picked from the queue list). */
  readonly selectQueueItem = output<number>();
  readonly speedChange = output<number>();
  /** Advance to the next item — emitted by the toolbar button and the outro cue. */
  readonly next = output<void>();
  readonly back = output<void>();
  readonly selectAudioTrack = output<string>();
  /** Any focus move inside the bar — the parent restarts its auto-hide
   *  countdown, so walking the controls with the D-pad never lets them retract
   *  under the user. */
  readonly interacted = output<void>();

  @HostListener('focusin', ['$event'])
  protected onBarFocusIn(e: FocusEvent): void {
    // The floating cues live in this component but are not the bar. They focus
    // themselves the moment they appear, and counting that as activity restarts
    // the retract countdown — the bar then never goes away, which in turn keeps
    // the cues hidden. Only the bar's own controls are activity.
    const target = e.target as HTMLElement | null;
    if (target?.closest('.player-floating-cue')) return;
    this.interacted.emit();
  }
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

  /** AVPlay only takes integer trick-play rates (it drives them from the HLS
   *  I-frame rendition), so fractional steps raise INVALID_PARAMETER there. */
  readonly speedOptions = computed<number[]>(() =>
    this.tv.isTizen()
      ? [1, 2, 4, 8]
      : [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
  );

  /** Settings dropdown panel navigation */
  readonly settingsPanel = signal<'main' | 'quality' | 'queue'>('main');

  /** Subtitles menu panel navigation — track list, appearance, one leaf per field. */
  readonly subtitlesPanel = signal<SubtitlePanel>('tracks');

  /** One row per appearance field, rendered by a single generic leaf list. */
  protected readonly appearanceRows: AppearanceRow[] = [
    { panel: 'size', field: 'subtitleSize', labelKey: 'playback_settings.sub_size', options: SIZE_OPTIONS },
    { panel: 'color', field: 'subtitleColor', labelKey: 'playback_settings.sub_color', options: COLOR_OPTIONS },
    { panel: 'shadow', field: 'subtitleShadow', labelKey: 'playback_settings.sub_shadow', options: SHADOW_OPTIONS },
    { panel: 'bg', field: 'subtitleBackground', labelKey: 'playback_settings.sub_bg', options: BG_OPTIONS },
    {
      panel: 'position-top',
      field: 'subtitleTopMargin',
      labelKey: 'player.subtitle_position_top',
      options: TOP_MARGIN_OPTIONS.map((v) => ({ value: v, label: `${v}%` })),
    },
    {
      panel: 'position-bottom',
      field: 'subtitleBottomMargin',
      labelKey: 'player.subtitle_position_bottom',
      options: BOTTOM_MARGIN_OPTIONS.map((v) => ({ value: v, label: `${v}%` })),
    },
  ];

  /** The leaf row being edited, or undefined on the track/appearance panels. */
  readonly activeAppearanceRow = computed(() =>
    this.appearanceRows.find((r) => r.panel === this.subtitlesPanel()),
  );

  /** The option currently in effect for a row — drives both the summary value
   *  and the check mark in the leaf list. */
  currentOption(row: AppearanceRow): AppearanceOption | undefined {
    const value = String(this.playerSettings.settings()[row.field]);
    return row.options.find((o) => String(o.value) === value);
  }

  setAppearance(row: AppearanceRow, value: string | number) {
    this.playerSettings.patch({ [row.field]: value } as Partial<PlayerSettings>);
  }

  /** Navigate the subtitles menu. Focus is pulled into the new panel because
   *  the switch destroys the row the user was standing on (D-pad / keyboard). */
  openSubtitlesPanel(panel: SubtitlePanel) {
    const from = this.subtitlesPanel();
    this.subtitlesPanel.set(panel);
    if (this.openDropdown()) this.focusDropdownEntry(from);
  }

  /** Same as {@link openSubtitlesPanel} for the settings menu. */
  openSettingsPanel(panel: 'main' | 'quality' | 'queue') {
    const from = this.settingsPanel();
    this.settingsPanel.set(panel);
    if (this.openDropdown()) this.focusDropdownEntry(from);
  }

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

  /** Wake-and-scrub: focus the seekbar and let it own the press, so the whole
   *  arrow run accumulates into one deferred seek instead of one per key. */
  scrubFromKey(e: KeyboardEvent): void {
    const bar = this.seekbar();
    if (!bar) return;
    bar.focus();
    bar.onKeydown(e);
  }
  /** Desktop/TV play-pause button — focused on TV every time the controls
   *  bar reappears, so the next D-pad center triggers play/pause. */
  private readonly playPauseBtn = viewChild<ElementRef<HTMLButtonElement>>('playPauseBtn');
  /** Floating skip-intro / next-episode cues — focused the instant they mount
   *  (see the constructor effects) so TV / keyboard users can act on them. */
  private readonly skipIntroBtn = viewChild<ElementRef<HTMLButtonElement>>('skipIntroBtn');
  private readonly nextEpisodeBtn = viewChild<ElementRef<HTMLButtonElement>>('nextEpisodeBtn');

  /** True under keyboard / D-pad input — the only modality where stealing focus
   *  is wanted (mouse and touch users are left alone, matching the CSS ring
   *  gate). TV is always keyboard-like; the browser flags it on `body`. */
  private autoFocusModality(): boolean {
    return (
      this.isTv() ||
      (typeof document !== 'undefined' &&
        document.body.classList.contains('keyboard-modality'))
    );
  }

  /** Pull focus onto a floating cue the moment it appears — but only for TV
   *  and keyboard navigation, where there's no pointer to reach it. A
   *  mouse-revealed cue shouldn't steal focus. */
  private autoFocusCue(btn: ElementRef<HTMLButtonElement> | undefined): void {
    if (!btn || !this.autoFocusModality()) return;
    // Never yank focus off something the user is holding: seeking into an intro
    // makes the cue appear mid-scrub, and stealing focus there drops the
    // seekbar under their thumb. The cue is only worth auto-focusing when the
    // user has nothing else in hand.
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && this.hostEl.nativeElement.contains(active)) return;
    btn.nativeElement.focus({ preventScroll: true });
  }
  readonly hostEl: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly injector = inject(Injector);
  private dropdownTrigger: HTMLElement | null = null;

  openSheet(sheet: 'subtitles' | 'audio' | 'speed' | 'settings') {
    if (sheet === 'settings') this.settingsPanel.set('main');
    if (sheet === 'subtitles') this.subtitlesPanel.set('tracks');
    this.activeSheet.set(sheet);
  }

  closeSheet() {
    this.activeSheet.set(null);
    this.subtitlesPanel.set('tracks');
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
    this.dropdownBack();
  }

  /** One step back inside the open dropdown: a sub-panel returns to its parent,
   *  the root panel closes the menu and hands focus back to its trigger. */
  private dropdownBack() {
    if (this.openDropdown() === 'settings' && this.settingsPanel() !== 'main') {
      this.openSettingsPanel('main');
      return;
    }
    if (this.openDropdown() === 'subtitles' && this.subtitlesPanel() !== 'tracks') {
      this.openSubtitlesPanel(this.activeAppearanceRow() ? 'appearance' : 'tracks');
      return;
    }
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
    if (name === 'subtitles') this.subtitlesPanel.set('tracks');
    const next = this.openDropdown() === name ? null : name;
    this.openDropdown.set(next);
    if (next) {
      // Remember the trigger so Back/Escape can refocus it after closing.
      this.dropdownTrigger = (event?.currentTarget as HTMLElement) ?? null;
      // Push focus into the panel so the first item is reachable without
      // having to traverse out of the trigger via spatial nav (D-pad on TV,
      // arrow keys on desktop keyboard). Harmless for mouse users.
      this.focusDropdownEntry();
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
    this.subtitlesPanel.set('tracks');
  }

  /** `fromPanel` is the panel being left: when the new panel holds the row that
   *  opens it (`data-panel-row`), focus returns there instead of the first
   *  item. */
  private focusDropdownEntry(fromPanel?: string) {
    afterNextRender(
      () => {
        const panel = this.hostEl.nativeElement.querySelector<HTMLElement>('.dropdown-open .dropdown-content');
        const back = fromPanel
          ? panel?.querySelector<HTMLElement>(`[data-panel-row="${fromPanel}"]`)
          : null;
        (back ?? initialOverlayFocus(panel))?.focus({ preventScroll: true });
      },
      { injector: this.injector },
    );
  }
}
