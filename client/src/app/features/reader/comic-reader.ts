import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  ViewEncapsulation,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideArrowLeft, LucideZoomIn, LucideZoomOut } from '@lucide/angular';
import type { ComicPageSize } from '../../core/services/api/comics.models';
import { ComicsApiService } from '../../core/services/api/comics-api.service';
import {
  COMIC_MODES,
  COMIC_PREFS_DEFAULT,
  ZOOM_MAX,
  buildSpreads,
  clampPan,
  drawOrder,
  pageWidth,
  preloadScreens,
  reportedPage,
  spreadIndexOf,
  stepToward,
  widthBucket,
  zoomAt,
  type ComicMode,
  type ComicPrefs,
  type Pan,
} from './comic-layout';
import { pdfPageOf, pdfProgression } from './pdf-position';
import { ReaderApiService, type ReaderTarget } from './reader-api.service';
import { ReaderProgressService } from './reader-progress.service';
import { ReaderSettingsService } from './reader-settings.service';
import { readerKeyAction } from './reader-keys';

const TAP_PX = 8;
const DOUBLE_TAP_MS = 280;
const SWIPE_PX = 50;
const WHEEL_TURN_MS = 350;
const DOUBLE_TAP_SCALE = 2.5;
const KEY_ZOOM_STEP = 0.5;
/** A webtoon column is capped like a phone-width strip: wider than this the art is only stretched. */
const WEBTOON_MAX_CSS = 900;
const WEBTOON_ZOOM = { min: 0.5, max: 2, step: 0.25 } as const;

/** The image pages of a comic issue: paged (single or spread, left-to-right or manga) or a webtoon strip. */
@Component({
  selector: 'app-comic-reader',
  imports: [TranslatePipe, LucideArrowLeft, LucideZoomIn, LucideZoomOut],
  templateUrl: './comic-reader.html',
  styleUrl: './comic-reader.css',
  encapsulation: ViewEncapsulation.None,
  providers: [ReaderSettingsService, ReaderProgressService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:keydown)': 'onKeydown($event)',
    '(window:pagehide)': 'flushProgress()',
    '(document:visibilitychange)': 'flushProgress()',
  },
})
export class ComicReaderComponent implements OnDestroy {
  readonly target = input.required<ReaderTarget>();
  readonly title = input('');
  readonly pages = input.required<ComicPageSize[]>();
  readonly closed = output<void>();

  private readonly api = inject(ComicsApiService);
  private readonly readerApi = inject(ReaderApiService);
  private readonly settings = inject(ReaderSettingsService);
  private readonly progress = inject(ReaderProgressService);
  private readonly injector = inject(Injector);
  private readonly stage = viewChild<ElementRef<HTMLElement>>('stage');

  private readonly resizer = new ResizeObserver(() => this.measure());
  private raf = 0;
  private destroyed = false;
  private readonly preloaded = new Set<string>();
  private readonly pointers = new Map<number, Pan & { x0: number; y0: number }>();
  private pinch: { dist: number; scale: number } | null = null;
  private moved = 0;
  private lastTap = { t: 0, x: 0, y: 0 };
  private tapTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWheelTurn = 0;

  protected readonly modes = COMIC_MODES;
  protected readonly prefs = signal<ComicPrefs>(COMIC_PREFS_DEFAULT);
  protected readonly webtoon = computed(() => this.prefs().mode === 'webtoon');
  protected readonly rtl = computed(() => this.prefs().mode === 'manga');
  protected readonly spreads = computed(() => buildSpreads(this.pages(), this.prefs().spread && !this.webtoon()));
  protected readonly index = signal(0);
  protected readonly shown = computed(() => drawOrder(this.spreads()[this.index()] ?? [], this.rtl()));
  protected readonly page = signal(1);
  protected readonly total = computed(() => this.pages().length);
  /** The page named by the slider while it is dragged, before the jump. */
  protected readonly scrubbing = signal<number | null>(null);
  protected readonly shownPage = computed(() => this.scrubbing() ?? this.page());
  protected readonly ready = signal(false);
  protected readonly chrome = signal(true);
  protected readonly view = signal({ w: 0, h: 0 });
  protected readonly scale = signal(1);
  protected readonly pan = signal<Pan>({ x: 0, y: 0 });
  protected readonly webZoom = signal(1);
  protected readonly zoomTier = computed(() => (this.scale() > 1.25 ? 2 : 1));
  protected readonly transform = computed(() => `translate(${this.pan().x}px, ${this.pan().y}px) scale(${this.scale()})`);
  protected readonly canZoomOut = computed(() => (this.webtoon() ? this.webZoom() > WEBTOON_ZOOM.min : this.scale() > 1));
  protected readonly canZoomIn = computed(() => (this.webtoon() ? this.webZoom() < WEBTOON_ZOOM.max : this.scale() < ZOOM_MAX));
  protected readonly webtoonWidth = computed(() => Math.round(Math.min(this.view().w, WEBTOON_MAX_CSS) * this.webZoom()));

  constructor() {
    afterNextRender(() => void this.open());
    // A mode switch replaces the stage element.
    effect(() => {
      const el = this.stage()?.nativeElement;
      untracked(() => {
        this.resizer.disconnect();
        if (el) this.resizer.observe(el);
      });
    });
    effect(() => {
      const at = this.index();
      const spreads = this.spreads();
      const view = this.view();
      if (!this.ready() || this.webtoon() || !view.w) return;
      untracked(() => {
        this.resetZoom();
        this.report(reportedPage(spreads[at] ?? [1]));
        this.preload(spreads, at);
      });
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.resizer.disconnect();
    if (this.tapTimer) clearTimeout(this.tapTimer);
    void this.progress.flush();
  }

  private measure(): void {
    const el = this.stage()?.nativeElement;
    if (el) this.view.set({ w: el.clientWidth, h: el.clientHeight });
  }

  private async open(): Promise<void> {
    const t = this.target();
    this.prefs.set(this.settings.comicPrefs(t.mediaId));
    const saved = await this.readerApi.loadProgress(t).catch(() => null);
    if (this.destroyed) return;
    this.measure();
    const at = pdfPageOf(saved?.locator, this.total());
    this.page.set(at);
    this.index.set(spreadIndexOf(this.spreads(), at));
    this.ready.set(true);
    if (this.webtoon()) afterNextRender(() => this.scrollToPage(at), { injector: this.injector });
    else if (this.total() === 1) this.report(1);
  }

  /** The URL of a page at the width its place on screen asks for. */
  protected src(n: number, count = this.shown().length, tier = this.zoomTier()): string {
    const size = this.pages()[n - 1];
    const dpr = window.devicePixelRatio || 1;
    const width = this.webtoon() ? widthBucket(this.webtoonWidth(), dpr) : pageWidth(size, this.view(), count, dpr, tier);
    return this.api.pageUrl(this.target().itemId, n - 1, width);
  }

  protected aspect(n: number): string {
    const p = this.pages()[n - 1];
    return `${p.width} / ${p.height}`;
  }

  /** Warms the cache for the next screens: the browser reuses the response when they come up. */
  private preload(spreads: number[][], at: number): void {
    for (const i of preloadScreens(spreads, at)) {
      for (const n of spreads[i]) {
        const url = this.src(n, spreads[i].length, 1);
        if (this.preloaded.has(url)) continue;
        this.preloaded.add(url);
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
      }
    }
  }

  private report(n: number): void {
    this.page.set(n);
    this.progress.report(this.target(), { progression: pdfProgression(n, this.total()), locator: { page: n } });
  }

  protected setMode(mode: ComicMode): void {
    if (mode === this.prefs().mode) return;
    const at = this.page();
    this.savePrefs({ ...this.prefs(), mode });
    this.resetZoom();
    this.index.set(spreadIndexOf(this.spreads(), at));
    if (mode === 'webtoon') afterNextRender(() => this.scrollToPage(at), { injector: this.injector });
  }

  protected toggleSpread(): void {
    const at = this.page();
    this.savePrefs({ ...this.prefs(), spread: !this.prefs().spread });
    this.index.set(spreadIndexOf(this.spreads(), at));
  }

  private savePrefs(p: ComicPrefs): void {
    this.prefs.set(p);
    this.settings.saveComicPrefs(this.target().mediaId, p);
  }

  /** `dir` follows the reading order: 1 is forward whatever side of the screen it is on. */
  protected step(dir: 1 | -1): void {
    const next = this.index() + dir;
    if (next >= 0 && next < this.spreads().length) this.index.set(next);
  }

  protected goTo(n: number): void {
    if (this.webtoon()) this.scrollToPage(n);
    else this.index.set(spreadIndexOf(this.spreads(), n));
  }

  private scrollToPage(n: number): void {
    this.stage()!.nativeElement.querySelector(`[data-page="${n}"]`)?.scrollIntoView({ block: 'start' });
  }

  protected onScrub(e: Event): void {
    this.scrubbing.set(Number((e.target as HTMLInputElement).value));
  }

  protected onSeek(e: Event): void {
    this.scrubbing.set(null);
    this.goTo(Number((e.target as HTMLInputElement).value));
  }

  // ---- webtoon

  protected onScroll(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => {
      const root = this.stage()!.nativeElement;
      const probe = root.getBoundingClientRect().top + root.clientHeight / 3;
      const slots = Array.from(root.querySelectorAll<HTMLElement>('[data-page]'));
      const hit = slots.filter((s) => s.getBoundingClientRect().top <= probe).pop() ?? slots[0];
      const n = Number(hit?.dataset['page'] ?? 1);
      if (this.ready() && n !== this.page()) this.report(n);
    });
  }

  // ---- zoom

  protected zoomBy(dir: 1 | -1): void {
    if (this.webtoon()) {
      const at = this.page();
      this.webZoom.set(Math.min(WEBTOON_ZOOM.max, Math.max(WEBTOON_ZOOM.min, this.webZoom() + dir * WEBTOON_ZOOM.step)));
      afterNextRender(() => this.scrollToPage(at), { injector: this.injector });
    } else {
      this.zoomTo(this.scale() + dir * KEY_ZOOM_STEP, { x: 0, y: 0 });
    }
  }

  private zoomTo(next: number, anchor: Pan): void {
    const r = zoomAt(this.pan(), this.scale(), next, anchor, this.view());
    this.scale.set(r.scale);
    this.pan.set(r.pan);
  }

  private resetZoom(): void {
    this.scale.set(1);
    this.pan.set({ x: 0, y: 0 });
  }

  /** Pointer position from the stage centre, the origin the scale and pan are taken from. */
  private fromCentre(x: number, y: number): Pan {
    const r = this.stage()!.nativeElement.getBoundingClientRect();
    return { x: x - r.left - r.width / 2, y: y - r.top - r.height / 2 };
  }

  // ---- paged gestures

  protected onPointerDown(e: PointerEvent): void {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    if (this.pointers.size === 1) this.moved = 0;
    if (this.pointers.size === 2) {
      this.moved = Infinity;
      this.pinch = { dist: this.pointerDistance(), scale: this.scale() };
    }
  }

  protected onPointerMove(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    this.moved = Math.max(this.moved, Math.hypot(p.x - p.x0, p.y - p.y0));
    if (this.pointers.size === 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()];
      this.zoomTo(this.pinch.scale * (this.pointerDistance() / this.pinch.dist), this.fromCentre((a.x + b.x) / 2, (a.y + b.y) / 2));
    } else if (this.scale() > 1) {
      this.pan.set(clampPan({ x: this.pan().x + dx, y: this.pan().y + dy }, this.scale(), this.view()));
    }
  }

  protected onPointerUp(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (!p || this.pointers.size) return;
    const dx = p.x - p.x0;
    const dy = p.y - p.y0;
    if (this.moved < TAP_PX) this.onTap(e.clientX, e.clientY);
    else if (this.scale() === 1 && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > 2 * Math.abs(dy)) {
      this.step(stepToward(dx < 0 ? 'right' : 'left', this.rtl()));
    }
  }

  protected onPointerCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    this.pinch = null;
  }

  private pointerDistance(): number {
    const [a, b] = [...this.pointers.values()];
    return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
  }

  /** A second tap close to the first zooms; a lone one waits out the double-tap window before it turns the page. */
  private onTap(x: number, y: number): void {
    const now = Date.now();
    const twice = now - this.lastTap.t < DOUBLE_TAP_MS && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < 30;
    this.lastTap = { t: twice ? 0 : now, x, y };
    if (this.tapTimer) clearTimeout(this.tapTimer);
    if (twice) {
      this.tapTimer = null;
      if (this.scale() > 1) this.resetZoom();
      else this.zoomTo(DOUBLE_TAP_SCALE, this.fromCentre(x, y));
      return;
    }
    this.tapTimer = setTimeout(() => this.tapZone(x), DOUBLE_TAP_MS);
  }

  private tapZone(x: number): void {
    const r = this.stage()!.nativeElement.getBoundingClientRect();
    const f = (x - r.left) / r.width;
    if (this.scale() > 1 || (f >= 1 / 3 && f <= 2 / 3)) this.chrome.update((v) => !v);
    else this.step(stepToward(f < 0.5 ? 'left' : 'right', this.rtl()));
  }

  protected onWheel(e: WheelEvent): void {
    if (this.webtoon()) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.zoomBy(e.deltaY < 0 ? 1 : -1);
      return;
    }
    e.preventDefault();
    if (e.ctrlKey) {
      this.zoomTo(this.scale() * Math.exp(-e.deltaY * 0.01), this.fromCentre(e.clientX, e.clientY));
    } else if (this.scale() > 1) {
      this.pan.set(clampPan({ x: this.pan().x - e.deltaX, y: this.pan().y - e.deltaY }, this.scale(), this.view()));
    } else if (Math.abs(e.deltaY) > 20 && Date.now() - this.lastWheelTurn > WHEEL_TURN_MS) {
      this.lastWheelTurn = Date.now();
      this.step(e.deltaY > 0 ? 1 : -1);
    }
  }

  protected onKeydown(e: KeyboardEvent): void {
    if ((e.target as HTMLElement | null)?.closest('input, select, textarea, button, a')) return;
    const root = this.stage()!.nativeElement;
    const last = this.total();
    const action = readerKeyAction(e);
    const extra: Record<string, () => void> = {
      '+': () => this.zoomBy(1),
      '=': () => this.zoomBy(1),
      '-': () => this.zoomBy(-1),
      '0': () => (this.webtoon() ? this.webZoom.set(1) : this.resetZoom()),
    };
    let act: (() => void) | undefined = action ? undefined : extra[e.key];
    if (action === 'close') act = () => (this.scale() > 1 ? this.resetZoom() : this.closed.emit());
    else if (action === 'start') act = () => this.goTo(1);
    else if (action === 'end') act = () => this.goTo(last);
    else if (this.webtoon()) {
      if (action === 'next') act = () => root.scrollBy({ top: root.clientHeight * 0.9 });
      else if (action === 'prev') act = () => root.scrollBy({ top: -root.clientHeight * 0.9 });
    } else if (action === 'left' || action === 'right') act = () => this.step(stepToward(action, this.rtl()));
    else if (action === 'next') act = () => this.step(1);
    else if (action === 'prev') act = () => this.step(-1);
    if (!act) return;
    e.preventDefault();
    act();
  }

  protected flushProgress(): void {
    void this.progress.flush();
  }
}
