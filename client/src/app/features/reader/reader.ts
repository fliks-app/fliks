import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewEncapsulation,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideArrowLeft, LucideListTree, LucideSettings, LucideX } from '@lucide/angular';
import { EpubNavigator, EpubPreferences, type EpubNavigatorListeners } from '@readium/navigator';
import { Locator, ReadingProgression, type Link } from '@readium/shared';
import { DismissableStackService } from '../../core/services/dismissable-stack.service';
import { NavbarService } from '../../core/services/navbar.service';
import { ToastService } from '../../core/services/toast.service';
import { provideCssSelectorGenerator, sandboxContentFrames } from './frame-hardening';
import { bookProgression } from './book-progress';
import { allowedExternalLink } from './link-scheme';
import { ReaderApiService } from './reader-api.service';
import { READER_KEY_BINDINGS, readerKeyAction, type ReaderKeyAction } from './reader-keys';
import { ReaderProgressService } from './reader-progress.service';
import {
  FONT_SIZE_RANGE,
  LINE_HEIGHT_RANGE,
  READER_FONTS,
  READER_MARGINS,
  READER_THEMES,
  ReaderSettingsService,
  readerThemeColors,
  toReaderPreferences,
  type ReaderSettings,
} from './reader-settings.service';

interface TocRow {
  link: Link;
  title: string;
  depth: number;
}

type Panel = 'toc' | 'settings';

const flattenToc = (links: Link[], depth = 0): TocRow[] =>
  links.flatMap((link) => [
    { link, title: link.title || link.href, depth },
    ...flattenToc(link.children?.items ?? [], depth + 1),
  ]);

const pathOf = (href: string): string => href.split('#')[0];

/** 0..1 from the progress slider, which runs 0..1000 so a book of a few hundred positions still steps finely. */
const sliderValue = (e: Event): number => Number((e.target as HTMLInputElement).value) / 1000;

@Component({
  selector: 'app-reader',
  imports: [TranslatePipe, LucideArrowLeft, LucideListTree, LucideSettings, LucideX],
  templateUrl: './reader.html',
  styleUrl: './reader.css',
  encapsulation: ViewEncapsulation.None,
  providers: [ReaderSettingsService, ReaderProgressService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:keydown)': 'onKeydown($event)',
    '(window:pagehide)': 'flushProgress()',
    '(document:visibilitychange)': 'flushProgress()',
  },
})
export class ReaderComponent implements OnDestroy {
  private readonly api = inject(ReaderApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly navbar = inject(NavbarService);
  private readonly dismissStack = inject(DismissableStackService);
  private readonly settingsStore = inject(ReaderSettingsService);
  private readonly progress = inject(ReaderProgressService);

  private readonly pageHost = viewChild.required<ElementRef<HTMLElement>>('pageHost');
  private readonly itemId = Number(this.route.snapshot.paramMap.get('itemId'));
  private navigator: EpubNavigator | null = null;
  private positions: Locator[] = [];
  private stopSandbox: (() => void) | null = null;
  private destroyed = false;

  protected readonly settings = this.settingsStore.settings;
  protected readonly colors = computed(() => readerThemeColors(this.settings().theme));
  protected readonly title = signal('');
  protected readonly loading = signal(true);
  protected readonly chromeVisible = signal(true);
  protected readonly panel = signal<Panel | null>(null);
  protected readonly toc = signal<TocRow[]>([]);
  private readonly currentHref = signal('');
  /** The first entry of the chapter on screen; later ones for the same file are its sections. */
  protected readonly currentRow = computed(() =>
    this.toc().findIndex((row) => pathOf(row.link.href) === this.currentHref()),
  );
  protected readonly rtl = signal(false);
  protected readonly totalProgression = signal(0);
  /** The slider's value while it is being dragged, before the jump is made. */
  protected readonly scrubbing = signal<number | null>(null);
  protected readonly shownProgression = computed(() => this.scrubbing() ?? this.totalProgression());

  protected readonly fontSizeRange = FONT_SIZE_RANGE;
  protected readonly lineHeightRange = LINE_HEIGHT_RANGE;
  protected readonly fonts = READER_FONTS;
  protected readonly themes = READER_THEMES;
  protected readonly margins = READER_MARGINS;
  protected readonly swatches = READER_THEMES.map((theme) => ({
    theme,
    color: readerThemeColors(theme).background,
  }));

  private readonly dismissPanel = () => this.closePanel();

  constructor() {
    afterNextRender(() => void this.open());
    effect(() => {
      const prefs = toReaderPreferences(this.settings(), this.colors());
      untracked(() => void this.navigator?.submitPreferences(new EpubPreferences(prefs)));
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.closePanel();
    this.stopSandbox?.();
    void this.progress.flush();
    void this.navigator?.destroy();
  }

  private async open(): Promise<void> {
    try {
      const [{ publication, positions }, saved] = await Promise.all([
        this.api.open(this.itemId),
        this.api.loadProgress(this.itemId),
      ]);
      if (this.destroyed) return;
      this.positions = positions;
      this.title.set(publication.metadata.title.getTranslation() || '');
      this.toc.set(flattenToc(publication.toc?.items ?? []));
      this.rtl.set(publication.metadata.effectiveReadingProgression === ReadingProgression.rtl);
      const container = this.pageHost().nativeElement;
      this.stopSandbox = sandboxContentFrames(container);
      const prefs = toReaderPreferences(this.settings(), this.colors());
      this.navigator = new EpubNavigator(
        container,
        publication,
        // The toolkit fills in the listeners left out.
        this.listeners() as EpubNavigatorListeners,
        positions,
        parseLocator(saved?.locator),
        {
          preferences: prefs,
          defaults: {},
          keyboardPeripherals: READER_KEY_BINDINGS,
          upgradeInsecureRequests: 'auto',
        },
      );
      await this.navigator.load();
      this.loading.set(false);
    } catch {
      if (this.destroyed) return;
      this.toast.error(this.translate.instant('reader.open_failed'));
      this.back();
    }
  }

  private listeners(): Partial<EpubNavigatorListeners> {
    return {
      frameLoaded: provideCssSelectorGenerator,
      positionChanged: (locator) => this.onPosition(locator),
      handleLocator: (locator) => {
        const url = allowedExternalLink(locator.href);
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
        return true;
      },
      miscPointer: () => (this.panel() ? this.closePanel() : this.chromeVisible.update((v) => !v)),
      peripheral: (e) => this.act(e.type as ReaderKeyAction),
    };
  }

  private onPosition(locator: Locator): void {
    const total = bookProgression(locator, this.positions);
    this.totalProgression.set(total);
    this.currentHref.set(pathOf(locator.href));
    this.progress.report(this.itemId, {
      progression: total,
      locator: JSON.stringify(locator.serialize()),
    });
  }

  protected onKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, select, textarea')) return;
    const action = readerKeyAction(e);
    if (!action) return;
    e.preventDefault();
    this.act(action);
  }

  private act(action: ReaderKeyAction): void {
    const nav = this.navigator;
    const noop = () => undefined;
    switch (action) {
      case 'left':
        nav?.goLeft(false, noop);
        break;
      case 'right':
        nav?.goRight(false, noop);
        break;
      case 'next':
        nav?.goForward(false, noop);
        break;
      case 'prev':
        nav?.goBackward(false, noop);
        break;
      case 'close':
        if (this.panel()) this.closePanel();
        else this.back();
        break;
    }
  }

  protected back(): void {
    this.navbar.goBack(['/']);
  }

  protected openPanel(panel: Panel): void {
    if (this.panel() === panel) return this.closePanel();
    if (!this.panel()) this.dismissStack.push(this.dismissPanel);
    this.panel.set(panel);
  }

  protected closePanel(): void {
    if (!this.panel()) return;
    this.panel.set(null);
    this.dismissStack.remove(this.dismissPanel);
  }

  protected goToChapter(link: Link): void {
    this.navigator?.goLink(link, false, () => undefined);
    this.closePanel();
  }

  protected onScrub(e: Event): void {
    this.scrubbing.set(sliderValue(e));
  }

  protected onSeek(e: Event): void {
    const target = this.positions[Math.min(this.positions.length - 1, Math.floor(sliderValue(e) * this.positions.length))];
    this.scrubbing.set(null);
    if (target) this.navigator?.go(target, false, () => undefined);
  }

  protected change<K extends keyof ReaderSettings>(key: K, value: ReaderSettings[K]): void {
    this.settingsStore.save({ [key]: value });
  }

  protected numberOf(e: Event): number {
    return Number((e.target as HTMLInputElement).value);
  }

  protected flushProgress(): void {
    void this.progress.flush();
  }
}

function parseLocator(raw: string | undefined): Locator | undefined {
  if (!raw) return undefined;
  try {
    return Locator.deserialize(JSON.parse(raw));
  } catch {
    return undefined;
  }
}
