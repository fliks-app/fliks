import { ChangeDetectionStrategy, Component, ElementRef, Injector, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideChevronDown, LucideChevronUp, LucideTrash2 } from '@lucide/angular';
import { PartyApiService, type PartyDto, type PartyItem } from '../../core/services/api/party-api.service';
import { MediaService, type Media } from '../../core/services/api/media.service';
import { SseService } from '../../core/services/sse.service';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { MediaPickerComponent, type MediaPick } from '../../shared/components/media-picker/media-picker';
import { TvRowDirective } from '../../shared/directives/tv-row.directive';
import { episodeLabel } from '../../shared/utils/episode-label';
import { keepFocus, runBusy } from './party-busy';

export function findEpisode(media: Media | null | undefined, id: number | null | undefined) {
  if (id == null) return null;
  for (const season of media?.seasons ?? []) {
    const episode = season.episodes?.find((e) => e.id === id);
    if (episode) return { season, episode };
  }
  return null;
}

const sameItem = (a: { mediaId: number; episodeId: number | null }, b: { mediaId: number; episodeId: number | null }) =>
  a.mediaId === b.mediaId && a.episodeId === b.episodeId;

/** The party's ordered programme: everyone sees it, the host reorders, removes and appends. */
@Component({
  selector: 'app-party-programme',
  imports: [TranslatePipe, ResolveUrlPipe, TvRowDirective, MediaPickerComponent, LucideChevronDown, LucideChevronUp, LucideTrash2],
  templateUrl: './party-programme.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyProgrammeComponent {
  private readonly api = inject(PartyApiService);
  private readonly mediaService = inject(MediaService);
  private readonly sse = inject(SseService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly partyId = input.required<number>();
  readonly isHost = input(false);
  /** The item playing, highlighted once the party is live. */
  readonly current = input<PartyItem | null>(null);
  readonly live = input(false);
  /** The party's new snapshot after an edit. */
  readonly changed = output<PartyDto>();

  protected readonly picker = viewChild.required(MediaPickerComponent);
  protected readonly items = signal<PartyItem[]>([]);
  protected readonly busy = signal(false);
  private readonly series = signal<ReadonlyMap<number, Media>>(new Map());
  private readonly asked = new Set<number>();
  private seq = 0;

  protected readonly rows = computed(() =>
    this.items().map((item) => {
      const media = this.series().get(item.mediaId);
      const found = findEpisode(media, item.episodeId);
      const label = found
        ? episodeLabel({ seasonNumber: found.season.seasonNumber, episodeNumber: found.episode.episodeNumber, episodeTitle: found.episode.title })
        : '';
      const cur = this.current();
      return { item, hidden: !!item.hidden, title: found ? media!.title : item.title, label, playing: this.live() && !!cur && sameItem(cur, item) };
    }),
  );

  constructor() {
    effect(() => {
      this.partyId();
      untracked(() => void this.load());
    });
    effect(() => {
      for (const { mediaId, episodeId, hidden } of this.items()) {
        if (episodeId != null && !hidden && !this.asked.has(mediaId)) untracked(() => void this.loadSeries(mediaId));
      }
    });
    this.sse.partyEvents.pipe(takeUntilDestroyed()).subscribe((e) => {
      if (e.type === 'party.programme' && e.partyId === this.partyId()) void this.load();
    });
  }

  private async load(): Promise<void> {
    const seq = ++this.seq;
    const items = await this.api.queue(this.partyId()).catch(() => null);
    if (items && seq === this.seq) this.items.set(items);
  }

  private async loadSeries(id: number): Promise<void> {
    this.asked.add(id);
    const media = await this.mediaService.getOne(id).catch(() => null);
    if (media) this.series.update((m) => new Map(m).set(id, media));
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

  protected move(index: number, by: -1 | 1): void {
    const next = [...this.items()];
    const to = index + by;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    void this.save(next, true);
    this.focusRow(to, by < 0 ? 'up' : 'down');
  }

  protected remove(index: number): void {
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
