import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  Injector,
  afterNextRender,
  computed,
  contentChild,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DeviceService } from '../../../core/services/device.service';
import { TvService } from '../../../core/services/tv.service';
import type { EdlRange } from '../../../core/utils/edl-policy';
import { AuthService } from '../../../core/services/auth.service';
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
import { TranslatePipe } from '@ngx-translate/core';
import { AppSettingsService } from '../../../core/services/app-settings.service';
import { formatTime, SpriteMetadata } from '../../../core/utils/player.utils';
import { focusOverlayEntry, initialOverlayFocus, scrollSelectedIntoView } from '../../../core/services/focusable.constants';
import { SeekbarComponent } from '../../../shared/components/seekbar/seekbar';
import { PartyReactionDockComponent } from '../party/party-reaction-dock';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../../shared/directives/cached-src.directive';
import { SelectedOptionDirective } from '../../../shared/directives/selected-option.directive';
import {
  PickerRow,
  RemotePickerListComponent,
} from '../../../shared/remote-picker/remote-picker-list';
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
  LucideSmilePlus,
  LucideCast,
  LucideUsers,
  LucideHeadphones,
  LucideLeaf,
  LucideLock,
  LucideLockOpen,
  LucideVolume2,
  LucideVolumeX,
} from '@lucide/angular';

/** The click-driven panels: a desktop dropdown, or a bottom sheet on touch. */
type PanelName = 'subtitles' | 'audio' | 'speed' | 'settings' | 'devices';

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
    RemotePickerListComponent,
    TranslatePipe,
    LucideCaptions,
    LucideCheck,
    LucideChevronLeft,
    LucideMaximize,
    LucidePictureInPicture2,
    LucideRotateCcw,
    LucideRotateCw,
    LucideSkipForward,
    LucideSmilePlus,
    LucideCast,
    LucideUsers,
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
  templateUrl: './player-controls.html',
  // Bar insets live on the host so the floating cues inherit them and line up
  // with the controls' right edge.
  host: {
    class: '[--ctrl-px:1rem] [--ctrl-pb:0.5rem] sm:[--ctrl-pb:1rem] xl:[--ctrl-inset:1rem]',
    style:
      '--bar-pl: calc(max(var(--ctrl-px), env(safe-area-inset-left)) + 0.25rem + var(--ctrl-inset, 0px)); ' +
      '--bar-pr: calc(max(var(--ctrl-px), env(safe-area-inset-right)) + 0.25rem + var(--ctrl-inset, 0px)); ' +
      '--bar-pb: calc(max(var(--ctrl-pb), var(--safe-bottom)) + var(--ctrl-inset, 0px))',
    '[style.--strip-h]': "dock() ? '3rem' : null",
  },
})
export class PlayerControlsComponent {
  private readonly device = inject(DeviceService);
  private readonly dismissStack = inject(DismissableStackService);
  private readonly auth = inject(AuthService);
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly tv = inject(TvService);
  private readonly appSettings = inject(AppSettingsService);
  /** True on Android TV — drives 10-foot UI choices in the template. */
  readonly isTv = this.device.isTv;
  /** Show a leaf next to the quality value when the active rung is a
   *  low-consumption one. */
  readonly activeQualityIsEco = computed(
    () =>
      this.availableQualities().find((q) => q.id === this.activeQualityId())
        ?.lowBandwidth ?? false,
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.surfaceClickTimer));
    // Mirrors the open dropdown into the dismissable stack so the Capacitor hardware Back (intercepted in app.ts) closes it first.
    effect((onCleanup) => {
      if (!this.openDropdown()) return;
      const close = () => this.dropdownBack();
      this.dismissStack.push(close);
      onCleanup(() => this.dismissStack.remove(close));
    });
    // TV: snap focus to play/pause whenever the bar shows, so D-pad center always toggles playback.
    effect(() => {
      const visible = this.visible();
      const wasVisible = this.lastVisible;
      this.lastVisible = visible;
      // Focus play/pause on keyboard / D-pad reveal only; the seek OSD has no play/pause, so arrow-seek keeps focus on the seekbar.
      if (visible && !wasVisible && this.autoFocusModality()) {
        this.closeDropdown();
        this.playPauseBtn()?.nativeElement.focus({ preventScroll: true });
      }
    });
    // Propagate any-panel-open state to the parent player so it can suspend
    // its auto-hide timer while a dropdown or bottom sheet is up.
    effect(() => {
      // The TV strip leaves with the controls, so an open reaction row keeps them up.
      const open = this.openDropdown() !== null || this.activeSheet() !== null || (this.isTv() && !!this.dock()?.open());
      if (open === this.lastPanelOpen) return;
      this.lastPanelOpen = open;
      this.panelOpenChange.emit(open);
    });
    // Cue countdown mirrors the progress sweep; reset to the full window when a cue (re)appears.
    effect(() => {
      if (this.showSkipIntro() || this.showNextCue()) {
        this.skipCueKey();
        this.cueCountdown.set(Math.ceil(this.cueDurationMs() / 1000));
      }
    });
    // Tick down to 1, held while the bar is up or the cue is focused (the parent freezes its retract timer on the same conditions).
    effect((onCleanup) => {
      if ((!this.showSkipIntro() && !this.showNextCue()) || this.visible() || this.cueFocused()) return;
      const id = setInterval(
        () => this.cueCountdown.update((n) => (n > 1 ? n - 1 : 1)),
        1000,
      );
      onCleanup(() => clearInterval(id));
    });
    // A cue vanishing under focus leaves it on <body>; hand it back to play/pause.
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
    // Focus a floating cue as it mounts; each effect is driven by its cue's view-query signal (set only while its @if is live).
    effect(() => this.autoFocusCue(this.skipIntroBtn()));
    effect(() => this.autoFocusCue(this.nextEpisodeBtn()));
  }
  private lastPanelOpen = false;
  private lastVisible = true;
  /** 'tv' and 'desktop' use the dropdown toolbar; 'mobile' uses big center buttons and bottom sheets.
   *  Tablets land on 'mobile' so taps reach the controls. */
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
  /** The player's centered spinner is up; the big center buttons step aside for it. */
  readonly spinner = input(false);
  /** True once the first frame is on the surface; hides the big mobile play button over the loading spinner. */
  readonly videoStarted = input(true);
  readonly currentTime = input(0);
  readonly duration = input(0);
  readonly bufferedEnd = input(0);
  /** Forwarded to the seekbar: the span a seek can land in. */
  readonly seekableStart = input(0);
  readonly seekableEnd = input(0);
  readonly volume = input(1);
  readonly muted = input(false);
  /** Effective slider position: drops to 0 while muted, so the thumb reflects
   *  what's actually audible; the retained level returns on unmute. */
  readonly displayVolume = computed(() => (this.muted() ? 0 : this.volume()));
  readonly playbackRate = input(1);
  readonly mediaTitle = input('');
  /** Clearlogo shown in place of the title text in the top-left overlay. */
  readonly logoUrl = input<string | null>(null);
  /** Logo URL that failed to load (the backend may return a path whose file is gone); keyed by URL so it resets on the next media. */
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
  readonly availableSubtitles = input<{ id: string; label: string; language?: string; menuHead?: string; menuSub?: string; burnIn?: boolean; isImage?: boolean }[]>([]);
  readonly availableQualities = input<{ id: string; label: string; lowBandwidth?: boolean }[]>([]);
  readonly activeSubtitleId = input<string | null>(null);
  readonly activeQualityId = input('auto');
  readonly availableAudioTracks = input<{ id: string; label: string; language?: string; menuHead?: string; menuSub?: string; supported?: boolean }[]>([]);
  readonly sortedSubtitles = computed(() =>
    this.appSettings.sortTracks(this.availableSubtitles()),
  );
  readonly sortedAudioTracks = computed(() =>
    this.appSettings.sortTracks(this.availableAudioTracks()),
  );
  readonly activeAudioTrackId = input<string | null>(null);
  readonly pipAvailable = input(true);
  readonly canLockOrientation = input(false);
  readonly orientationLocked = input(false);
  /** A destination can be picked: a Cast receiver is reachable, or a remote
   *  target is online. Same gate as the top bar's picker. */
  readonly canPickDevice = input(false);
  readonly castConnected = input(false);
  /** Audio or video goes to an AirPlay receiver: tints the device button. */
  readonly airPlayConnected = input(false);
  readonly castConnecting = input(false);
  readonly spriteUrl = input<string | null>(null);
  readonly spriteMetadata = input<SpriteMetadata | null>(null);
  readonly chapters = input<{ startSeconds: number; endSeconds: number; title?: string }[]>([]);
  readonly introMarker = input<{ startSeconds: number; endSeconds: number } | null>(null);
  readonly outroMarker = input<{ startSeconds: number; endSeconds: number } | null>(null);
  readonly edlRanges = input<readonly EdlRange[]>([]);
  readonly fillScreen = input(false);
  readonly statsVisible = input(false);
  readonly showSkipIntro = input(false);
  readonly showNextCue = input(false);
  /** Translation key of the skip button: the intro by default, or the commercial skip. */
  readonly skipCueLabel = input('player.skip_intro');
  /** Identity of the skip cue: a change while it stays up restarts its sweep and countdown. */
  readonly skipCueKey = input('intro');
  /** Do not gate these on `!visible()`: unmounting a cue while `showSkipIntro` is true strands `cueFocused` (no blur).
   *  Hide them by retracting at the player level. */
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
  /** True while a floating cue holds focus; the player freezes its retract timer and the sweep/countdown freeze on it. */
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
  /** Any focus move inside the bar; the parent restarts its auto-hide countdown. */
  readonly interacted = output<void>();

  @HostListener('focusin', ['$event'])
  protected onBarFocusIn(e: FocusEvent): void {
    // The floating cues self-focus on appearing; counting that as activity would keep the bar up forever.
    const target = e.target as HTMLElement | null;
    if (target?.closest('.player-floating-cue')) return;
    this.interacted.emit();
  }
  readonly pickDevice = output<PickerRow>();
  /** In a watch party: shows the party button, with the unread chat count on it. */
  /** False for a non-host of a host-only party: no play/pause, skip or next, and a read-only seekbar. */
  readonly canControlPlayback = input(true);
  readonly partyActive = input(false);
  /** The host switched reactions off for the party: the settings entry says so. */
  readonly partyReactionsOff = input(false);
  readonly partyUnread = input(0);
  readonly partyOpen = input(false);
  readonly toggleParty = output<void>();
  readonly openReactionSettings = output<void>();
  /** The action strip's content: the party reaction button, projected by the player. */
  protected readonly dock = contentChild(PartyReactionDockComponent);
  readonly toggleFillScreen = output<void>();
  readonly openMedia = output<void>();
  readonly seekDragChange = output<boolean>();
  /** True while scrubbing; bumps the bottom bar's z-index so the sprite preview clears the z-50 mobile center buttons. */
  readonly seekDragging = signal(false);
  /** Fires when a panel (dropdown or bottom sheet) opens or closes, so the parent pauses its auto-hide timer. */
  readonly panelOpenChange = output<boolean>();

  /** Opens the subtitle resync panel; carries the menu trigger so focus can return to it. */
  readonly openSubtitleSync = output<HTMLElement | null>();

  /** AVPlay takes only integer trick-play rates (INVALID_PARAMETER otherwise) and past 2x outruns the server; LG has no variable rate. */
  readonly speedOptions = computed<number[]>(() =>
    this.tv.isTizen()
      ? [1, 2]
      : this.tv.isWebOs()
        ? [1]
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

  /** Resync needs the manage permission and a text track; opening it selects one if none is active. */
  readonly canSyncSubtitle = computed(
    () =>
      this.availableSubtitles().some((s) => !s.isImage && !s.burnIn) &&
      !this.castConnected() &&
      this.auth.hasPermission('subtitles.manage'),
  );

  protected openSyncPanel() {
    this.openSubtitleSync.emit(this.dropdownTrigger);
    this.closeDropdown();
    this.closeSheet();
  }

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
    this.enterPanel(from);
  }

  /** Same as {@link openSubtitlesPanel} for the settings menu. */
  openSettingsPanel(panel: 'main' | 'quality' | 'queue') {
    const from = this.settingsPanel();
    this.settingsPanel.set(panel);
    this.enterPanel(from);
  }

  /** Which click-driven dropdown is open, or null; a click/Enter is required, D-pad focus alone does not open it. */
  readonly openDropdown = signal<PanelName | null>(null);

  /** True when any desktop dropdown is open — prevents play/pause on backdrop click. */
  readonly hasOpenDropdown = computed(() => this.openDropdown() !== null);

  /** Mobile bottom sheet state */
  readonly activeSheet = signal<PanelName | null>(null);

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

  /** True under keyboard / D-pad input, the only modality where stealing focus is wanted. */
  private autoFocusModality(): boolean {
    return (
      this.isTv() ||
      (typeof document !== 'undefined' &&
        document.documentElement.classList.contains('keyboard-modality'))
    );
  }

  /** Focus a floating cue on appearance, for TV and keyboard navigation only. */
  private autoFocusCue(btn: ElementRef<HTMLButtonElement> | undefined): void {
    if (!btn || !this.autoFocusModality()) return;
    // Never steal focus from something the user holds: a cue appearing mid-scrub would drop the seekbar.
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && this.hostEl.nativeElement.contains(active)) return;
    btn.nativeElement.focus({ preventScroll: true });
  }
  readonly hostEl: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly injector = inject(Injector);
  private dropdownTrigger: HTMLElement | null = null;

  openSheet(sheet: PanelName) {
    if (sheet === 'settings') this.settingsPanel.set('main');
    if (sheet === 'subtitles') this.subtitlesPanel.set('tracks');
    this.activeSheet.set(sheet);
  }

  closeSheet() {
    this.activeSheet.set(null);
    this.subtitlesPanel.set('tracks');
  }

  /** Closes the open dropdown on Escape or KEYCODE_BACK; captured so Back doesn't leave the player while a panel is open. */
  @HostListener('window:keydown', ['$event'])
  onWindowKey(e: KeyboardEvent) {
    if (!this.openDropdown()) return;
    const isBack = e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack' || e.keyCode === 4 || e.keyCode === 27;
    if (!isBack) return;
    e.preventDefault();
    e.stopPropagation();
    this.dropdownBack();
  }

  /** One step back: a sub-panel returns to its parent, the root closes and refocuses its trigger. Returns true while the dropdown stays open. */
  private dropdownBack(): boolean {
    if (this.openDropdown() === 'settings' && this.settingsPanel() !== 'main') {
      this.openSettingsPanel('main');
      return true;
    }
    if (this.openDropdown() === 'subtitles' && this.subtitlesPanel() !== 'tracks') {
      this.openSubtitlesPanel(this.activeAppearanceRow() ? 'appearance' : 'tracks');
      return true;
    }
    this.closeDropdown();
    this.dropdownTrigger?.focus({ preventScroll: true });
    return false;
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
  toggleDropdown(name: PanelName, event?: Event) {
    event?.stopPropagation();
    if (name === 'settings') this.settingsPanel.set('main');
    if (name === 'subtitles') this.subtitlesPanel.set('tracks');
    const next = this.openDropdown() === name ? null : name;
    this.openDropdown.set(next);
    if (next) {
      // Remember the trigger so Back/Escape can refocus it after closing.
      this.dropdownTrigger = (event?.currentTarget as HTMLElement) ?? null;
      // Push focus into the panel so the first item is reachable without spatial nav out of the trigger.
      this.focusDropdownEntry();
    }
  }

  /** Close current dropdown. Item selection deliberately does not call this: the user dismisses with a click outside. */
  private surfaceClickTimer?: ReturnType<typeof setTimeout>;

  /** Play/pause waits out the double-click window, so a double click only
   *  toggles fullscreen. */
  onSurfaceClick(event: MouseEvent) {
    if (this.isMobileTouch()) return this.tapOverlay.emit();
    if (this.hasOpenDropdown()) return this.closeDropdown(event);
    clearTimeout(this.surfaceClickTimer);
    if (event.detail > 1 || !this.canControlPlayback()) return;
    this.surfaceClickTimer = setTimeout(() => this.togglePlay.emit(), 250);
  }

  onSurfaceDblClick() {
    clearTimeout(this.surfaceClickTimer);
    this.toggleFullscreen.emit();
  }

  closeDropdown(event?: Event) {
    event?.stopPropagation();
    this.openDropdown.set(null);
    this.settingsPanel.set('main');
    this.subtitlesPanel.set('tracks');
  }

  /** Dropdown: focus the new panel. Sheet: only scroll it to the current choice. */
  private enterPanel(from: string) {
    if (this.openDropdown()) return this.focusDropdownEntry(from);
    afterNextRender(() => scrollSelectedIntoView(this.hostEl.nativeElement), { injector: this.injector });
  }

  /** `fromPanel` is the panel being left: if the new panel holds its opening row (`data-panel-row`), focus returns there. */
  private focusDropdownEntry(fromPanel?: string) {
    afterNextRender(
      () => {
        const panel = this.hostEl.nativeElement.querySelector<HTMLElement>('.dropdown-open .dropdown-content');
        const back = fromPanel
          ? panel?.querySelector<HTMLElement>(`[data-panel-row="${fromPanel}"]`)
          : null;
        focusOverlayEntry(back ?? initialOverlayFocus(panel));
      },
      { injector: this.injector },
    );
  }
}
