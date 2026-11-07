import {
  DestroyRef,
  Injectable,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { AudioPlayerService } from '../../core/services/audio-player/audio-player.service';
import { DismissableStackService } from '../../core/services/dismissable-stack.service';
import { Immersive } from '../../core/plugins/immersive.plugin';
import { IS_STANDALONE_BUNDLE } from '../../core/utils/standalone-bundle';
import { ControlsVisibilityService } from '../player/controls/controls-visibility';
import type { ReaderTarget } from './reader-api.service';
import type { ReaderEngine } from './reader-engine';
import { READER_FEATURES, type ReaderFormat } from './reader-features';
import { readerKeyAction, type ReaderKeyAction } from './reader-keys';
import { ReaderProgressService } from './reader-progress.service';
import { ReaderSettingsService, isDarkTheme, readerThemeColors } from './reader-settings.service';
import type { SidebarTab } from './reader-sidebar';

/** What the work page knows and the reader shows: the author line, the cover and the audio edition to listen to. */
export interface ReaderBookInfo {
  author: string;
  coverUrl: string | null;
  listen: { itemId: number; coverUrl: string | null } | null;
}

export type ReaderPanel = 'appearance' | 'sidebar';

export interface ReaderInputs {
  format: Signal<ReaderFormat>;
  title: Signal<string>;
  target: Signal<ReaderTarget>;
  info: Signal<ReaderBookInfo | null>;
  close: () => void;
}

const PHONE = '(max-width: 639px)';

/** The state of one open book shared by the reader, its bars and its engine: panels, bars, keys, fullscreen. */
@Injectable()
export class ReaderSession {
  private readonly chrome = inject(ControlsVisibilityService);
  private readonly dismissStack = inject(DismissableStackService);
  private readonly settingsStore = inject(ReaderSettingsService);
  private readonly progress = inject(ReaderProgressService);
  private readonly audio = inject(AudioPlayerService);
  private readonly injector = inject(Injector);
  private readonly inputs = signal<ReaderInputs | null>(null);

  readonly features = computed(() => READER_FEATURES[this.inputs()?.format() ?? 'epub']);
  readonly engine = signal<ReaderEngine | null>(null);
  readonly title = computed(() => this.inputs()?.title() ?? '');
  readonly info = computed(() => this.inputs()?.info() ?? null);

  readonly settings = this.settingsStore.settings;
  /** A format without themes reads on black, like a comic. */
  readonly colors = computed(() =>
    readerThemeColors(this.features().appearance.includes('theme') ? this.settings().theme : 'black'),
  );

  /** A phone-width screen: panels in the bottom sheet, halved margins. */
  private readonly phoneQuery = window.matchMedia(PHONE);
  readonly compact = signal(this.phoneQuery.matches);
  /** Bundles run fullscreen already and some browsers (iOS Safari) refuse it on a page. */
  readonly canFullscreen = !IS_STANDALONE_BUNDLE && document.fullscreenEnabled;
  readonly fullscreen = signal(!!document.fullscreenElement);

  readonly chromeVisible = this.chrome.visible;
  readonly panel = signal<ReaderPanel | null>(null);
  readonly tab = signal<SidebarTab>(this.settingsStore.panel().tab);
  /** The progress bar's value while it is dragged, before the jump. */
  readonly scrubbing = signal<number | null>(null);
  readonly shownProgression = computed(() => this.scrubbing() ?? this.engine()?.progression() ?? 0);
  readonly percent = computed(() => Math.round(this.shownProgression() * 100));
  /** Keyboard or remote focus on a bar control keeps the bars up; hidden bars are inert and would drop it. */
  private readonly barFocused = signal(false);
  private opener: HTMLElement | null = null;
  /** Run before a panel goes: a note still being typed has no blur to save it. */
  beforePanelClose: () => void = () => undefined;
  private readonly dismissPanel = () => this.closePanel();

  constructor() {
    this.chrome.hide();
    this.chrome.configure({
      pinned: computed(() => this.panel() !== null || this.scrubbing() !== null || this.barFocused()),
    });
    const onPhone = (e: MediaQueryListEvent) => this.compact.set(e.matches);
    this.phoneQuery.addEventListener('change', onPhone);
    effect(() => this.settingsStore.savePanel({ tab: this.tab() }));
    // Escape and back put the bars away before they leave the reader; an open panel is its own layer.
    effect((onCleanup) => {
      if (!this.chromeVisible() || this.panel()) return;
      const hide = () => this.chrome.hide();
      this.dismissStack.push(hide);
      onCleanup(() => this.dismissStack.remove(hide));
    });
    // Android system bar icons go dark over a light page; the reader's bars and the app are dark.
    if (Capacitor.isNativePlatform()) {
      effect(() => {
        const light = this.features().appearance.includes('theme') && !isDarkTheme(this.settings().theme) && !this.chromeVisible();
        Immersive.setLightStatusBar({ light }).catch(() => {});
      });
    }
    inject(DestroyRef).onDestroy(() => {
      this.phoneQuery.removeEventListener('change', onPhone);
      this.closePanel();
      void this.progress.flush();
      if (document.fullscreenElement) void document.exitFullscreen();
      if (Capacitor.isNativePlatform()) Immersive.setLightStatusBar({ light: false }).catch(() => {});
    });
  }

  connect(inputs: ReaderInputs): void {
    this.inputs.set(inputs);
  }

  target(): ReaderTarget {
    return this.inputs()!.target();
  }

  attach(engine: ReaderEngine): void {
    this.engine.set(engine);
  }

  close(): void {
    this.inputs()?.close();
  }

  // ---- bars

  toggleChrome(): void {
    this.chrome.toggle();
  }

  showChrome(): void {
    this.chrome.show();
  }

  hideChrome(): void {
    this.chrome.hide();
  }

  onPointerMove(): void {
    this.chrome.onPointerMove();
  }

  onFocusMove(): void {
    queueMicrotask(() => this.barFocused.set(!!document.activeElement?.closest('.rd-bar')));
    this.chrome.onInteraction();
  }

  /** A tap on the page while the bars are up puts them away instead of turning it; true when it did. */
  dismissChrome(): boolean {
    if (this.panel() || !this.chromeVisible()) return false;
    this.chrome.hide();
    return true;
  }

  /** Bars opened from a key put focus on their first control. */
  private focusBar(): void {
    afterNextRender(() => document.querySelector<HTMLElement>('.rd-bar button')?.focus(), {
      injector: this.injector,
    });
  }

  // ---- panels

  /** The list button reopens the tab last browsed; search has its own button. */
  browseTab(): SidebarTab {
    return this.tab() === 'search' ? 'contents' : this.tab();
  }

  openPanel(panel: ReaderPanel, tab?: SidebarTab): void {
    if (this.panel() === panel && (!tab || this.tab() === tab)) return this.closePanel();
    this.showPanel(panel, tab);
  }

  /** Like {@link openPanel}, but a panel already open on that tab stays open. */
  showPanel(panel: ReaderPanel, tab?: SidebarTab): void {
    if (!this.panel()) {
      this.dismissStack.push(this.dismissPanel);
      const active = document.activeElement;
      this.opener = active instanceof HTMLElement && active.closest('.rd-bar') ? active : null;
    }
    if (tab) this.tab.set(tab);
    this.panel.set(panel);
    this.chrome.show();
  }

  closePanel(): void {
    if (!this.panel()) return;
    this.beforePanelClose();
    const engine = this.engine();
    engine?.search?.cancel();
    engine?.notes?.focusId.set(null);
    this.panel.set(null);
    this.dismissStack.remove(this.dismissPanel);
    if (this.opener?.isConnected) this.opener.focus();
    this.opener = null;
  }

  /** A jump from a panel leaves the page in view: the phone sheet covers it. */
  afterJump(): void {
    if (this.compact()) this.closePanel();
  }

  // ---- keys

  onKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, select, textarea')) return;
    if (this.engine()?.onKey?.(e)) return e.preventDefault();
    const action = readerKeyAction(e);
    if (!action) return;
    if ((e.key === 'Enter' || e.key === ' ') && target?.closest('button, a, summary')) return;
    // Arrows move focus in the bars and panels; they turn pages only from the book.
    if ((action === 'left' || action === 'right') && target?.closest('.rd-bar, .rd-panel')) return;
    e.preventDefault();
    this.act(action);
  }

  /** A key's action, from the page or from inside the book's frames. Features that are off ignore theirs. */
  act(action: ReaderKeyAction): void {
    const f = this.features();
    const engine = this.engine();
    switch (action) {
      case 'toc':
        if (f.contents) this.openPanel('sidebar', 'contents');
        break;
      case 'notes':
        if (f.notes) this.openPanel('sidebar', 'notes');
        break;
      case 'search':
        if (f.search) this.openPanel('sidebar', 'search');
        break;
      case 'bookmark':
        if (f.bookmarks) void engine?.notes?.toggleBookmark();
        break;
      case 'settings':
        if (f.appearance.length) this.openPanel('appearance');
        break;
      case 'chrome':
        this.chrome.toggle();
        if (this.chromeVisible()) this.focusBar();
        break;
      case 'close':
        if (this.panel()) this.closePanel();
        else if (!engine?.act('close') && !this.dismissChrome()) this.close();
        break;
      case 'left':
      case 'right':
        // Like the player's: while the bars are up, arrows belong to them, from the book's frames too.
        if (this.chromeVisible() && !this.panel()) {
          if (!document.activeElement?.closest('.rd-bar')) this.focusBar();
        } else engine?.act(action);
        break;
      default:
        engine?.act(action);
    }
  }

  // ---- actions of the bars

  toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  }

  onFullscreenChange(): void {
    this.fullscreen.set(!!document.fullscreenElement);
  }

  canListen(): boolean {
    return this.features().listen && !!this.info()?.listen;
  }

  listen(): void {
    const info = this.info();
    if (!info?.listen) return;
    void this.audio.play({
      mediaId: this.target().mediaId,
      itemId: info.listen.itemId,
      title: this.title(),
      artist: info.author,
      coverUrl: info.listen.coverUrl ?? info.coverUrl ?? null,
    });
    this.close();
  }

  seek(at: number): void {
    this.scrubbing.set(null);
    this.engine()?.seek(at);
  }

  flushProgress(): void {
    this.progress.flushOnExit();
  }
}
