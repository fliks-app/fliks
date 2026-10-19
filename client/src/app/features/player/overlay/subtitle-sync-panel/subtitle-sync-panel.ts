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
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
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
  KEY_STEP_SEC,
  PX_PER_SEC,
  SETTLE_MS,
  activeCues,
  contentHeight,
  cueHeight,
  cueTop,
  formatOffset,
  isUserScroll,
  offsetFromScroll,
  scrollTopForTime,
  visibleCues,
} from './subtitle-sync.util';

/** Side panel to preview a subtitle track against the playing video and shift its timing. */
@Component({
  selector: 'app-subtitle-sync-panel',
  imports: [FormsModule, TranslatePipe, TvSelectDirective, SyncReferenceSelectComponent],
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

  readonly subtitle = input.required<SubtitleOption>();
  readonly subtitles = input<SubtitleOption[]>([]);
  readonly mediaId = input.required<number>();
  readonly mediaFileId = input.required<number>();
  readonly duration = input(0);
  /** Current video time in seconds, read every frame. */
  readonly timeSource = input.required<() => number>();
  /** Element to refocus on close. */
  readonly opener = input<HTMLElement | null>(null);

  readonly selectTrack = output<string>();
  /** The stored file changed: the player must reload this track under a fresh URL. */
  readonly contentChanged = output<string>();
  readonly closed = output<void>();

  protected readonly formatOffset = formatOffset;
  protected readonly scale = PX_PER_SEC;
  protected readonly cueTop = cueTop;
  protected readonly cueHeight = cueHeight;

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
  protected readonly syncing = signal(false);

  protected readonly height = computed(() => contentHeight(this.duration(), this.viewH()));
  protected readonly visible = computed(() =>
    visibleCues(this.cues(), this.base(), this.viewTop(), this.viewH()),
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
  private readonly overlay = new SubtitleOverlay();
  private lastWritten = 0;
  private interacting = false;
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
      this.cancel();
      return;
    };
    this.dismissStack.push(close);
    inject(DestroyRef).onDestroy(() => {
      this.dismissStack.remove(close);
      cancelAnimationFrame(this.raf);
      clearTimeout(this.settleTimer);
      this.overlay.destroy();
    });
    afterNextRender(() => {
      const el = this.scroller().nativeElement;
      new ResizeObserver(() => this.viewH.set(el.clientHeight)).observe(el);
      this.viewH.set(el.clientHeight);
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
    this.sse.subtitleSynced.pipe(takeUntilDestroyed()).subscribe((id) => {
      if (!this.syncing() || id !== this.subtitle().subtitleDbId) return;
      this.syncing.set(false);
      this.contentChanged.emit(this.subtitle().id);
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
    const t = this.timeSource()();
    if (this.interacting) {
      this.offset.set(offsetFromScroll(el.scrollTop, t, this.base(), PX_PER_SEC));
    } else if (Math.abs(el.scrollTop - scrollTopForTime(t)) >= 0.5) {
      el.scrollTop = scrollTopForTime(t);
      this.lastWritten = el.scrollTop;
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
    this.interacting = true;
    if (down) this.pointerDown = true;
    this.armSettle();
  }

  @HostListener('window:pointerup')
  @HostListener('window:pointercancel')
  protected onPointerUp() {
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
    const off = Math.round(offsetFromScroll(el.scrollTop, this.timeSource()(), this.base(), PX_PER_SEC) * 1000) / 1000;
    this.interacting = false;
    this.offset.set(off);
    this.base.set(off);
  }

  protected onKeyDown(e: KeyboardEvent) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const off = Math.round((this.offset() + (e.key === 'ArrowUp' ? -KEY_STEP_SEC : KEY_STEP_SEC)) * 1000) / 1000;
      this.offset.set(off);
      this.base.set(off);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      this.host.nativeElement.querySelector<HTMLElement>('[data-sync-footer] button:not([disabled])')?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

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

  protected cancel() {
    this.offset.set(0);
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
    this.syncing.set(true);
    await this.subtitleActions.sync(this.mediaId(), dbId, reference !== 'auto' ? { reference } : {});
  }
}
