import { ChangeDetectionStrategy, Component, ElementRef, Injector, afterNextRender, computed, effect, inject, input, model, output, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDragPlaceholder, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import { LucideChevronDown, LucideChevronUp, LucideGripVertical, LucidePlus, LucideTrash2, LucideUndo2 } from '@lucide/angular';
import { PartyApiService, type PartyDto, type PartyItem } from '../../core/services/api/party-api.service';
import { type Media } from '../../core/services/api/media.service';
import { SseService } from '../../core/services/sse.service';
import { DeviceService } from '../../core/services/device.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { MediaPickerComponent, type MediaPick } from '../../shared/components/media-picker/media-picker';
import { TvRowDirective } from '../../shared/directives/tv-row.directive';
import { episodeLabel } from '../../shared/utils/episode-label';
import { keepFocus, runBusy } from './party-busy';
import { rowTops, slideRows } from './party-flip';
import { itemThumb } from './party-thumb';

export function findEpisode(media: Media | null | undefined, id: number | null | undefined) {
  if (id == null) return null;
  for (const season of media?.seasons ?? []) {
    const episode = season.episodes?.find((e) => e.id === id);
    if (episode) return { season, episode };
  }
  return null;
}

export const sameItem = (a: { mediaId: number; episodeId: number | null }, b: { mediaId: number; episodeId: number | null }) =>
  a.mediaId === b.mediaId && a.episodeId === b.episodeId;

/** The party's ordered programme: everyone sees it, the host reorders, removes and appends. */
@Component({
  selector: 'app-party-programme',
  imports: [TranslatePipe, ResolveUrlPipe, TvRowDirective, MediaPickerComponent, CdkDropList, CdkDrag, CdkDragHandle, CdkDragPlaceholder, LucideChevronDown, LucideChevronUp, LucideGripVertical, LucidePlus, LucideTrash2, LucideUndo2],
  templateUrl: './party-programme.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyProgrammeComponent {
  private readonly api = inject(PartyApiService);
  private readonly sse = inject(SseService);
  protected readonly device = inject(DeviceService);
  private readonly injector = inject(Injector);
  private readonly confirm = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly partyId = input.required<number>();
  readonly isHost = input(false);
  /** The item playing, highlighted once the party is live. */
  readonly current = input<PartyItem | null>(null);
  readonly live = input(false);
  /** The party's new snapshot after an edit. */
  readonly changed = output<PartyDto>();

  protected readonly picker = viewChild.required(MediaPickerComponent);
  /** The programme as loaded and edited here; the page reads it to hide proposals already in it. */
  readonly items = model<PartyItem[]>([]);
  /** Items that came from a proposal, which the host can send back to the proposals. */
  readonly proposed = input<readonly { mediaId: number; episodeId: number | null }[]>([]);
  protected readonly busy = signal(false);
  private seq = 0;

  protected readonly rows = computed(() =>
    this.items().map((item) => {
      const label = episodeLabel({ seasonNumber: item.seasonNumber, episodeNumber: item.episodeNumber, episodeTitle: item.episodeTitle });
      const cur = this.current();
      return {
        item,
        hidden: !!item.hidden,
        title: item.seriesTitle ?? item.title,
        label,
        thumb: itemThumb(item),
        playing: this.live() && !!cur && sameItem(cur, item),
      };
    }),
  );

  /** A TV host reorders with the arrows instead. */
  protected readonly draggable = computed(() => this.isHost() && !this.device.isTv() && this.rows().length > 1);

  constructor() {
    effect(() => {
      this.partyId();
      untracked(() => void this.load());
    });
    this.sse.partyEvents.pipe(takeUntilDestroyed()).subscribe((e) => {
      if ((e.type === 'party.programme' || e.type === 'party.updated') && e.partyId === this.partyId()) void this.load();
    });
  }

  private async load(): Promise<void> {
    const seq = ++this.seq;
    const items = await this.api.queue(this.partyId(), true).catch(() => null);
    if (!items || seq !== this.seq) return;
    const root = this.host.nativeElement;
    const before = rowTops(root);
    this.items.set(items);
    afterNextRender(() => slideRows(root, before), { injector: this.injector });
  }

  /** Sends the full list; the screen follows at once and goes back to the previous list on failure. */
  private async save(next: PartyItem[], optimistic: boolean): Promise<void> {
    if (this.busy()) return;
    const prev = this.items();
    this.seq++;
    if (optimistic) this.items.set(next);
    const dto = await runBusy(this.busy, () =>
      this.api.programme(
        this.partyId(),
        next.map((i) => ({ mediaId: i.mediaId, ...(i.mediaFileId != null && { mediaFileId: i.mediaFileId }), ...(i.episodeId != null && { episodeId: i.episodeId }) })),
      ),
    );
    if (!dto) {
      if (optimistic) this.items.set(prev);
      return;
    }
    this.changed.emit(dto);
    if (!optimistic) await this.load();
  }

  protected drop(e: CdkDragDrop<unknown>): void {
    if (e.previousIndex === e.currentIndex) return;
    const next = [...this.items()];
    moveItemInArray(next, e.previousIndex, e.currentIndex);
    void this.save(next, true);
  }

  protected move(index: number, by: -1 | 1): void {
    const next = [...this.items()];
    const to = index + by;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    void this.save(next, true);
    this.focusRow(to, by < 0 ? 'up' : 'down');
  }

  protected isProposed(item: PartyItem): boolean {
    return this.proposed().some((p) => sameItem(p, item));
  }

  /** Back to the proposals: the proposal kept its votes, only the programme row goes. */
  protected unaccept(index: number): void {
    const next = this.items().filter((_, i) => i !== index);
    void this.save(next, true);
    this.focusRow(Math.min(index, next.length - 1), 'remove');
  }

  protected async remove(index: number): Promise<void> {
    const item = this.items()[index];
    const ok = await this.confirm.confirm({
      title: this.translate.instant('party.programme_remove'),
      message: this.translate.instant('party.programme_remove_message', {
        title: item.hidden ? this.translate.instant('party.proposal_hidden') : episodeLabel(item) || item.title,
      }),
      confirmLabel: this.translate.instant('party.programme_remove'),
      variant: 'danger',
    });
    if (!ok) return;
    const next = this.items().filter((_, i) => i !== index);
    void this.save(next, true);
    this.focusRow(Math.min(index, next.length - 1), 'remove');
  }

  /** The row's button, else any of its buttons, else Add: a re-render must not leave the host on the page body. */
  private focusRow(row: number, act: 'up' | 'down' | 'remove'): void {
    keepFocus(this.injector, () => {
      const li = this.host.nativeElement.querySelectorAll('li')[row];
      return li?.querySelector<HTMLElement>(`[data-act=${act}]:not(:disabled)`) ?? li?.querySelector<HTMLElement>('button:not(:disabled)') ?? this.host.nativeElement.querySelector<HTMLElement>('[data-act=add]');
    });
  }

  protected append(picks: MediaPick[]): void {
    const have = this.items();
    const added: PartyItem[] = [];
    for (const p of picks) {
      const item = { mediaId: p.mediaId, episodeId: p.episodeId } as PartyItem;
      if (![...have, ...added].some((i) => sameItem(i, item))) added.push(item);
    }
    if (added.length) void this.save([...have, ...added], false);
  }
}
