import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideChevronDown, LucidePause, LucidePlay, LucideRepeat, LucideRepeat1, LucideShuffle, LucideSkipBack, LucideSkipForward, LucideSmartphone } from '@lucide/angular';
import { MusicApiService, alignTrackRows } from '../../core/services/api/music-api.service';
import type { MusicTrackRequest } from '../../core/services/audio-player/music-queue';
import { RemotePlaybackTarget } from '../../core/services/remote-playback-target';
import { RemoteService, type RemoteCommandInput } from '../../core/services/remote.service';
import { SessionSyncService } from '../../core/services/session-sync.service';
import { formatTime } from '../../core/utils/player.utils';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../directives/cached-src.directive';

const NEXT_REPEAT = { off: 'all', all: 'one', one: 'off' } as const;

/** Full controller of an audio session played on another device: transport, shuffle, repeat, queue, and taking it over. */
@Component({
  selector: 'app-session-audio-controller',
  imports: [
    LucideChevronDown, LucidePause, LucidePlay, LucideRepeat, LucideRepeat1, LucideShuffle,
    LucideSkipBack, LucideSkipForward, LucideSmartphone, CachedSrcDirective, ResolveUrlPipe, TranslatePipe,
  ],
  templateUrl: './session-audio-controller.html',
})
export class SessionAudioControllerComponent {
  protected readonly sync = inject(SessionSyncService);
  private readonly remote = inject(RemoteService);
  private readonly target = inject(RemotePlaybackTarget);
  private readonly music = inject(MusicApiService);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly session = this.sync.session;
  protected readonly queue = computed(() => this.session()?.queue ?? null);
  /** Each row keeps its place in the wire queue, which a queue pick names. */
  protected readonly rows = signal<{ row: MusicTrackRequest; wireIndex: number }[]>([]);
  private readonly idsKey = computed(() => (this.queue()?.itemIds ?? []).join(','));
  protected readonly live = computed(() => !this.sync.parked() && !this.target.isIdle());
  protected readonly paused = computed(() => (this.live() ? this.target.uiPaused() : true));
  protected readonly position = computed(() => (this.live() ? this.target.position() : (this.session()?.positionSeconds ?? 0)));
  protected readonly duration = computed(() => (this.live() ? this.target.duration() : (this.session()?.durationSeconds ?? 0)));
  protected readonly current = computed(() => this.rows().find((r) => r.row.itemId === this.session()?.item.id)?.row ?? null);

  constructor() {
    effect((onCleanup) => {
      const ids = this.idsKey() ? this.idsKey().split(',').map(Number) : [];
      let stale = false;
      onCleanup(() => (stale = true));
      void this.music.trackRequests(ids).then(
        (r) => !stale && this.rows.set(alignTrackRows(ids, r)),
        () => !stale && this.rows.set([]),
      );
    });
  }

  open(): void {
    this.dialog()?.nativeElement.showModal();
  }

  protected close(): void {
    this.dialog()?.nativeElement.close();
  }

  protected formatTime = formatTime;

  private send(input: RemoteCommandInput): void {
    const id = this.remote.observedTargetId();
    if (id) void this.remote.send(id, input);
  }

  protected togglePlay(): void {
    this.send({ action: this.paused() ? 'play' : 'pause' });
  }

  protected prev(): void {
    this.send({ action: 'prev' });
  }

  protected next(): void {
    this.send({ action: 'next' });
  }

  protected shuffle(): void {
    this.send({ action: 'shuffle', shuffle: !this.queue()?.shuffle });
  }

  protected repeat(): void {
    this.send({ action: 'repeat', repeat: NEXT_REPEAT[this.queue()?.repeat ?? 'off'] });
  }

  protected seek(event: Event): void {
    this.target.seek(Number((event.target as HTMLInputElement).value));
  }

  protected playAt(wireIndex: number): void {
    const q = this.queue();
    if (q) this.send({ action: 'queue', queue: { itemIds: q.itemIds, index: wireIndex } });
  }

  protected async listenHere(): Promise<void> {
    this.close();
    await this.sync.playHere();
  }
}
