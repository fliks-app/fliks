import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { LucideCheck, LucideChevronLeft, LucideChevronRight, LucideRotateCcw, LucideWandSparkles } from '@lucide/angular';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { DeviceService } from '../../../../core/services/device.service';
import { ConfirmationService } from '../../../../core/services/confirmation.service';
import { DismissableStackService } from '../../../../core/services/dismissable-stack.service';
import { restoreOpenerFocus } from '../../../../core/services/focusable.constants';
import { PlayerSettingsService } from '../../../../core/services/player-settings.service';
import { SubtitleOverlay, type VttCue } from '../../../../core/services/playback-engine/subtitle-overlay.util';
import { SseService } from '../../../../core/services/sse.service';
import { SubtitleActionsService } from '../../../../core/services/subtitle-actions.service';
import { ToastService } from '../../../../core/services/toast.service';
import { TvSelectDirective } from '../../../../shared/directives/tv-select.directive';
import { SyncReferenceSelectComponent } from '../../../../shared/components/sync-reference-select/sync-reference-select';
import {
  SubtitlesApiService,
  type MediaStream,
  type SubtitleFileRow,
} from '../../../../core/services/api/subtitles-api.service';
import type { SubtitleOption } from '../../../../core/services/track-manager.service';
import {
  holdStep,
  KEY_STEP_SEC,
  PX_PER_SEC,
  SETTLE_MS,
  SmoothClock,
  activeCues,
  boxTop,
  layoutCues,
  formatOffset,
  isUserScroll,
  offsetFromScroll,
  TimeMap,
  visibleCues,
  visibleTicks,
  RULER_PX,
  CHEVRON_PX,
} from './subtitle-sync.util';

/** Side panel to preview a subtitle track against the playing video and shift its timing. */
@Component({
  selector: 'app-subtitle-sync-panel',
  imports: [FormsModule, LucideCheck, LucideChevronLeft, LucideChevronRight, LucideRotateCcw, LucideWandSparkles, TranslatePipe, TvSelectDirective, SyncReferenceSelectComponent],
  templateUrl: './subtitle-sync-panel.html',
  styleUrl: './subtitle-sync-panel.scss',
})
export class SubtitleSyncPanelComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly dismissStack = inject(DismissableStackService);
  private readonly settings = inject(PlayerSettingsService);
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly subtitleActions = inject(SubtitleActionsService);
  private readonly toast = inject(ToastService);
  private readonly sse = inject(SseService);
  protected readonly phone = inject(DeviceService).isPhone;

  readonly subtitle = input.required<SubtitleOption>();
  readonly subtitles = input<SubtitleOption[]>([]);
  readonly mediaId = input.required<number>();
  readonly mediaFileId = input.required<number>();
  readonly duration = input(0);
  /** Current video time in seconds, read every frame. */
  readonly timeSource = input.required<() => number>();
  readonly paused = input(true);
  readonly playbackRate = input(1);
  /** Element to refocus on close. */
  readonly opener = input<HTMLElement | null>(null);

  readonly selectTrack = output<string>();
  /** The stored file changed: the player must reload this track under a fresh URL. */
  readonly contentChanged = output<string>();
  readonly closed = output<void>();

  protected readonly formatOffset = formatOffset;
  protected readonly scale = PX_PER_SEC;
  protected readonly boxTop = boxTop;

  protected readonly textTracks = computed(() => this.subtitles().filter((s) => !s.isImage && !s.burnIn));
  protected readonly editable = computed(() => !!this.subtitle().subtitleDbId && !this.subtitle().id.startsWith('emb-'));
  protected readonly cues = signal<VttCue[]>([]);
  /** Offset applied to the preview; `base` is the one the list is laid out with. */
  protected readonly offset = signal(0);
  protected readonly base = signal(0);
  protected readonly viewH = signal(0);
  private readonly viewTop = signal(0);
  protected readonly now = signal(0);
  protected readonly busy = signal(false);
  protected readonly grabbing = signal(false);
  /** D-pad edit mode of the list: Up/Down shift the offset until Back or Escape. */
  protected readonly editing = signal(false);
  /** The server queue is the source: it survives a reopen of the panel. */
  protected readonly syncing = computed(() => this.subtitleActions.syncing().has(this.subtitle().subtitleDbId ?? 0));

  private readonly boxes = computed(() => layoutCues(this.cues()));
  private readonly timeMap = computed(() => new TimeMap(this.cues(), this.boxes(), this.base()));
  protected readonly height = computed(() => this.timeMap().height(this.duration(), this.viewH()));
  protected readonly visible = computed(() =>
    visibleCues(this.cues(), this.boxes(), this.base(), this.viewTop(), this.viewH()),
  );
  protected readonly ticks = computed(() => visibleTicks(this.timeMap(), this.viewTop(), this.viewH(), this.duration()));
  protected readonly rulerPx = RULER_PX;
  protected readonly chevronPx = CHEVRON_PX;
  protected readonly scrollbarW = signal(0);
  /** Height of the controls bar, kept clear below the panel. */
  protected readonly barH = signal(0);
  /** Phone: the controls are hidden, so the panel fills the side (landscape) or the lower sheet (portrait). */
  protected readonly panelClass = computed(() =>
    this.phone()
      ? 'p-3 gap-2 landscape:top-0 landscape:w-[40%] landscape:rounded-l-2xl portrait:inset-x-0 portrait:h-[55%] portrait:rounded-t-2xl'
      : 'top-0 w-[32%] min-w-80 max-sm:w-full max-sm:min-w-0 p-4 gap-3 rounded-bl-2xl',
  );
  protected readonly active = computed(
    () => new Set(activeCues(this.cues(), this.now(), this.offset())),
    { equal: (a, b) => a.size === b.size && [...a].every((i) => b.has(i)) },
  );
  protected readonly dirty = computed(() => this.offset() !== 0);

  protected readonly syncReference = signal('auto');
  protected readonly streams = signal<MediaStream[]>([]);
  protected readonly externalRefs = signal<SubtitleFileRow[]>([]);
  protected readonly audioStreams = computed(() => this.streams().filter((s) => s.type === 'audio'));
  protected readonly subtitleStreams = computed(() => this.streams().filter((s) => s.type === 'subtitle'));

  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');
  private readonly syncDialog = viewChild.required<ElementRef<HTMLDialogElement>>('syncDialog');
  private readonly overlay = new SubtitleOverlay(1, 'fliks-sync-subtitle');
  private readonly clock = new SmoothClock();
  private t = 0;
  private lastWritten = 0;
  private interacting = false;
  private heldSince = 0;
  private pointerDown = false;
  private settleTimer?: ReturnType<typeof setTimeout>;
  private raf = 0;
  private loadSeq = 0;

  constructor() {
    const close = () => {
      if (this.syncDialog().nativeElement.open) {
        this.syncDialog().nativeElement.close();
        return true;
      }
      void this.requestClose();
      return;
    };
    this.dismissStack.push(close);
    inject(DestroyRef).onDestroy(() => {
      this.dismissStack.remove(close);
      this.dismissStack.remove(this.stopEdit);
      cancelAnimationFrame(this.raf);
      clearTimeout(this.settleTimer);
      this.overlay.destroy();
    });
    afterNextRender(() => {
      const el = this.scroller().nativeElement;
      const measure = () => {
        this.viewH.set(el.clientHeight);
        this.scrollbarW.set(el.offsetWidth - el.clientWidth);
      };
      new ResizeObserver(measure).observe(el);
      measure();
      const bar = document.querySelector('[data-controls-bottom]');
      if (bar) {
        new ResizeObserver(() => this.barH.set(bar.getBoundingClientRect().height)).observe(bar);
        this.barH.set(bar.getBoundingClientRect().height);
      }
      el.focus({ preventScroll: true });
      this.raf = requestAnimationFrame(this.tick);
    });
    effect(() => {
      const s = this.settings.settings();
      this.overlay.setStyle({
        size: s.subtitleSize,
        color: s.subtitleColor,
        shadow: s.subtitleShadow,
        background: s.subtitleBackground,
        bottomMargin: s.subtitleBottomMargin,
        topMargin: s.subtitleTopMargin,
      });
    });
    effect(() => {
      const url = this.subtitle().url;
      untracked(() => {
        this.offset.set(0);
        this.base.set(0);
        void this.loadCues(url);
      });
    });
    void this.subtitleActions.refreshSyncing();
    effect(() => {
      if (this.syncing()) this.stopEdit();
    });
    this.sse.subtitleSynced.pipe(takeUntilDestroyed()).subscribe((id) => {
      if (id === this.subtitle().subtitleDbId) this.contentChanged.emit(this.subtitle().id);
    });
    this.sse.subtitleSyncFailed.pipe(takeUntilDestroyed()).subscribe(({ subtitleId }) => {
      if (subtitleId !== this.subtitle().subtitleDbId) return;
      this.toast.error(this.translate.instant('player.subtitle_sync.sync_failed'));
    });
  }

  private async loadCues(url: string) {
    const seq = ++this.loadSeq;
    try {
      const handle = await this.overlay.load(url);
      if (seq !== this.loadSeq) return;
      this.cues.set(handle.cues);
      this.overlay.select(handle);
      this.overlay.setVisible(true);
    } catch {
      this.toast.error(this.translate.instant('player.subtitle_load_failed'));
    }
  }

  // One frame: follow the video, or, while the user scrolls, derive the offset from where they are.
  private readonly tick = () => {
    const el = this.scroller().nativeElement;
    const t = (this.t = this.clock.read(this.timeSource()(), performance.now(), !this.paused(), this.playbackRate()));
    if (this.interacting) {
      this.offset.set(offsetFromScroll(el.scrollTop, t, this.timeMap()));
    } else {
      const top = this.timeMap().px(t);
      if (Math.abs(el.scrollTop - top) >= 0.5) {
        el.scrollTop = top;
        this.lastWritten = el.scrollTop;
      }
    }
    this.viewTop.set(Math.floor(el.scrollTop / Math.max(1, this.viewH() / 2)) * (this.viewH() / 2));
    this.now.set(Math.round(t * 20) / 20);
    this.overlay.updateAt(t - this.offset());
    this.raf = requestAnimationFrame(this.tick);
  };

  protected onScroll() {
    if (!isUserScroll(this.scroller().nativeElement.scrollTop, this.lastWritten, this.interacting)) return;
    this.touch();
  }

  /** Marks a user gesture; the offset is committed once it has been quiet for {@link SETTLE_MS}. */
  protected touch(down = false) {
    if (this.syncing()) return;
    this.interacting = true;
    if (down) this.pointerDown = true;
    this.armSettle();
  }

  protected onPointerDown(e: PointerEvent) {
    const el = this.scroller().nativeElement;
    // Touch scrolls natively; a mouse grabs the list, except on its scrollbar.
    if (e.pointerType !== 'mouse') {
      this.touch(true);
      return;
    }
    if (e.button !== 0 || e.offsetX >= el.clientWidth || this.syncing()) return;
    el.setPointerCapture(e.pointerId);
    this.grabbing.set(true);
    this.touch(true);
  }

  protected onPointerMove(e: PointerEvent) {
    if (this.grabbing()) this.scroller().nativeElement.scrollTop -= e.movementY;
  }

  protected onWheel(e: WheelEvent) {
    if (this.syncing()) e.preventDefault();
    else this.touch();
  }

  @HostListener('window:pointerup')
  @HostListener('window:pointercancel')
  protected onPointerUp() {
    this.grabbing.set(false);
    if (!this.pointerDown) return;
    this.pointerDown = false;
    this.armSettle();
  }

  private armSettle() {
    clearTimeout(this.settleTimer);
    if (this.pointerDown) return;
    this.settleTimer = setTimeout(() => this.commit(), SETTLE_MS);
  }

  private commit() {
    if (!this.interacting) return;
    const el = this.scroller().nativeElement;
    const off = Math.round(offsetFromScroll(el.scrollTop, this.t, this.timeMap()) * 1000) / 1000;
    this.interacting = false;
    this.offset.set(off);
    this.base.set(off);
  }

  protected onKeyDown(e: KeyboardEvent) {
    if (!this.editing()) {
      if (e.key !== 'Enter' || this.syncing()) return;
      this.editing.set(true);
      this.dismissStack.push(this.stopEdit);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!e.repeat) this.heldSince = performance.now();
      const step = e.repeat ? holdStep(performance.now() - this.heldSince) : KEY_STEP_SEC;
      const off = Math.round((this.offset() + (e.key === 'ArrowUp' ? step : -step)) * 1000) / 1000;
      this.offset.set(off);
      this.base.set(off);
    } else if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** Leaves edit mode and keeps the offset; also the dismiss-stack entry of that mode. */
  protected readonly stopEdit = () => {
    if (!this.editing()) return;
    this.editing.set(false);
    this.dismissStack.remove(this.stopEdit);
  };

  protected async changeTrack(id: string) {
    if (id === this.subtitle().id) return;
    if (this.dirty() && !(await this.confirmDiscard())) {
      // The select already shows the new value: snap it back.
      this.host.nativeElement.querySelector<HTMLSelectElement>('select')!.value = this.subtitle().id;
      return;
    }
    this.selectTrack.emit(id);
  }

  private confirmDiscard() {
    return this.confirmation.confirm({
      title: this.translate.instant('player.subtitle_sync.discard_title'),
      message: this.translate.instant('player.subtitle_sync.discard_message'),
      confirmLabel: this.translate.instant('player.subtitle_sync.discard'),
      cancelLabel: this.translate.instant('common.cancel'),
      variant: 'warning',
    });
  }

  protected cancelSync() {
    const dbId = this.subtitle().subtitleDbId;
    if (dbId) void this.subtitleActions.cancelSync(this.mediaId(), dbId);
  }

  protected reset() {
    this.offset.set(0);
    this.base.set(0);
  }

  protected async requestClose() {
    if (this.dirty() && !(await this.confirmDiscard())) return;
    this.close();
  }

  private close() {
    this.closed.emit();
    restoreOpenerFocus(this.opener());
  }

  protected async save() {
    const dbId = this.subtitle().subtitleDbId;
    if (!dbId || this.busy()) return;
    this.busy.set(true);
    try {
      await this.subtitleActions.postProcess(this.mediaId(), dbId, 'adjustTimes', {
        offsetMs: Math.round(this.offset() * 1000),
      });
      this.contentChanged.emit(this.subtitle().id);
      this.close();
    } finally {
      this.busy.set(false);
    }
  }

  protected async openSyncModal() {
    this.syncReference.set('auto');
    this.syncDialog().nativeElement.showModal();
    try {
      const [streams, subs] = await Promise.all([
        this.subtitlesApi.getStreams(this.mediaId(), this.mediaFileId()),
        this.subtitlesApi.getForMedia(this.mediaId()),
      ]);
      this.streams.set(streams);
      this.externalRefs.set(subs.filter((s) => s.relativePath && s.id !== this.subtitle().subtitleDbId));
    } catch { /* global interceptor */ }
  }

  protected async applySync() {
    const dbId = this.subtitle().subtitleDbId;
    if (!dbId) return;
    const reference = this.syncReference();
    this.syncDialog().nativeElement.close();
    await this.subtitleActions.sync(this.mediaId(), dbId, reference !== 'auto' ? { reference } : {});
  }
}
