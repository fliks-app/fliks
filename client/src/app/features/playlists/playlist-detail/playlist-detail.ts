import {
  Component,
  ChangeDetectionStrategy,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  CdkDrag,
  CdkDragDrop,
  CdkDragHandle,
  CdkDropList,
  moveItemInArray,
} from '@angular/cdk/drag-drop';
import {
  LucideArrowDown,
  LucideArrowUp,
  LucideCheck,
  LucideEllipsisVertical,
  LucideGripVertical,
  LucideInfo,
  LucideListVideo,
  LucidePencil,
  LucidePlay,
  LucideSettings,
  LucideTrash2,
  LucideUsers,
  LucideUserPlus,
} from '@lucide/angular';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';
import { DropdownMenuComponent } from '../../../shared/components/dropdown-menu';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { StreamingApiService } from '../../../core/services/api/streaming-api.service';
import { BackgroundService } from '../../../core/services/background.service';
import { AutoDownloadService } from '../../../core/services/auto-download.service';
import { NavbarService } from '../../../core/services/navbar.service';
import { PlayableMediaService } from '../../../core/services/playable-media.service';
import { QueueItem } from '../../../core/services/playback-queue.service';
import {
  Playlist,
  PlaylistItem,
  PlaylistMember,
  PlaylistsApiService,
  PlaylistShareRole,
  PlaylistVisibility,
} from '../../../core/services/api/playlists-api.service';
import {
  SocialApiService,
  SocialUser,
} from '../../../core/services/api/social-api.service';
import { AuthService } from '../../../core/services/auth.service';
import { ToastService } from '../../../core/services/toast.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { TvService } from '../../../core/services/tv.service';

interface PlaylistSeriesGroup {
  seriesId: number;
  media: PlaylistItem['media'];
  episodes: PlaylistItem[];
}

/** A grouped-view root entry: a movie item, or a series block. */
type PlaylistGroupedEntry =
  | { kind: 'movie'; item: PlaylistItem }
  | { kind: 'series'; group: PlaylistSeriesGroup };

@Component({
  selector: 'app-playlist-detail',
  imports: [
    TranslateModule,
    FormsModule,
    NgTemplateOutlet,
    RouterLink,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    LucideArrowDown,
    LucideArrowUp,
    LucideCheck,
    LucideEllipsisVertical,
    LucideGripVertical,
    LucideInfo,
    LucideListVideo,
    LucidePencil,
    LucidePlay,
    LucideSettings,
    LucideTrash2,
    LucideUsers,
    LucideUserPlus,
    ToggleFieldComponent,
    DropdownMenuComponent,
    ResolveUrlPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './playlist-detail.html',
})
export class PlaylistDetailComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(PlaylistsApiService);
  private readonly toast = inject(ToastService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);
  readonly tv = inject(TvService);
  readonly navbar = inject(NavbarService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly background = inject(BackgroundService);
  private readonly autoDownload = inject(AutoDownloadService);
  private readonly playable = inject(PlayableMediaService);
  private readonly social = inject(SocialApiService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  /** The signed-in user's id — a member can't edit their own role. */
  readonly myUserId = computed(() => this.auth.user()?.id ?? 0);

  private readonly routeParams = toSignal(this.route.paramMap);
  readonly playlistId = computed(() => Number(this.routeParams()?.get('id')));

  private readonly renameDialog =
    viewChild<ElementRef<HTMLDialogElement>>('renameDialog');
  private readonly settingsDialog =
    viewChild<ElementRef<HTMLDialogElement>>('settingsDialog');
  private readonly membersDialog =
    viewChild<ElementRef<HTMLDialogElement>>('membersDialog');

  readonly loading = signal(true);
  readonly playlist = signal<Playlist | null>(null);
  readonly items = signal<PlaylistItem[]>([]);
  readonly renameValue = signal('');
  readonly renaming = signal(false);
  // Settings edits stay local until the user clicks "Save".
  readonly savingSettings = signal(false);
  readonly draftAutoRemoveWatched = signal(false);
  readonly draftAutoDownload = signal(false);
  readonly draftAutoPlay = signal(false);
  readonly draftVisibility = signal<PlaylistVisibility>('private');
  // Members / collaboration
  readonly members = signal<PlaylistMember[]>([]);
  readonly memberQuery = signal('');
  readonly memberResults = signal<SocialUser[]>([]);
  readonly memberBusy = signal(false);
  /** Auto-download is native-mobile only, so its toggle is hidden elsewhere. */
  readonly showAutoDownload = this.autoDownload.enabled;

  /** Add / remove / reorder items — editor and above. */
  readonly canEditItems = computed(() => {
    const r = this.playlist()?.role;
    return r === 'owner' || r === 'editor' || r === 'administrator';
  });
  /** Rename + settings — administrator and above. */
  readonly canManage = computed(() => {
    const r = this.playlist()?.role;
    return r === 'owner' || r === 'administrator';
  });
  readonly isOwner = computed(() => this.playlist()?.role === 'owner');

  readonly expandedSeries = signal<Set<number>>(new Set());

  toggleSeries(seriesId: number) {
    this.expandedSeries.update((s) => {
      const next = new Set(s);
      if (next.has(seriesId)) next.delete(seriesId);
      else next.add(seriesId);
      return next;
    });
  }

  /** Episode items grouped by their series. Episodes are always kept in
   *  SERIES order (season, then episode), independent of playlist position. */
  readonly seriesGroups = computed<PlaylistSeriesGroup[]>(() => {
    const groups = new Map<number, PlaylistSeriesGroup>();
    for (const it of this.items()) {
      if (!it.episode) continue;
      let g = groups.get(it.media.id);
      if (!g) {
        g = { seriesId: it.media.id, media: it.media, episodes: [] };
        groups.set(it.media.id, g);
      }
      g.episodes.push(it);
    }
    for (const g of groups.values()) {
      g.episodes.sort(
        (a, b) =>
          (a.episode?.season?.seasonNumber ?? 0) -
            (b.episode?.season?.seasonNumber ?? 0) ||
          (a.episode?.episodeNumber ?? 0) - (b.episode?.episodeNumber ?? 0),
      );
    }
    return [...groups.values()];
  });

  /** Grouped-view root entries (movies + one block per series), ordered by
   *  first appearance in the current playlist order. This root order is what
   *  the user reorders in grouped view. */
  readonly groupedEntries = computed<PlaylistGroupedEntry[]>(() => {
    const seriesById = new Map<number, PlaylistSeriesGroup>();
    for (const g of this.seriesGroups()) seriesById.set(g.seriesId, g);
    const entries: PlaylistGroupedEntry[] = [];
    const seenSeries = new Set<number>();
    for (const it of this.items()) {
      if (!it.episode) {
        entries.push({ kind: 'movie', item: it });
      } else if (!seenSeries.has(it.media.id)) {
        seenSeries.add(it.media.id);
        const group = seriesById.get(it.media.id);
        if (group) entries.push({ kind: 'series', group });
      }
    }
    return entries;
  });

  episodeLabel(ep: NonNullable<PlaylistItem['episode']>): string {
    const s = ep.season?.seasonNumber;
    const end =
      ep.endEpisodeNumber && ep.endEpisodeNumber !== ep.episodeNumber
        ? `-${ep.endEpisodeNumber}`
        : '';
    const code =
      s != null
        ? `S${s}E${ep.episodeNumber}${end}`
        : `E${ep.episodeNumber}${end}`;
    return ep.title ? `${code} · ${ep.title}` : code;
  }

  episodeLink(it: PlaylistItem): string[] {
    return ['/series', String(it.media.id), 'episode', String(it.episode!.id)];
  }

  /** Route for a row: the episode page for an episode item, else the movie or
   *  series detail. */
  itemLink(it: PlaylistItem): string[] {
    if (it.episode) return this.episodeLink(it);
    const kind = it.media.type === 'series' ? 'series' : 'movies';
    return ['/' + kind, String(it.media.id)];
  }

  itemThumb(it: PlaylistItem): string | null {
    // Prefer a landscape image (episode still, else the movie/series fanart),
    // like the history list; fall back to the poster.
    return (
      it.episode?.stillUrl ?? it.media.fanartUrl ?? it.media.posterUrl ?? null
    );
  }

  // ── Playback ──

  /** Items in the exact order the grouped view shows them (movies + series
   *  blocks, episodes in series order) — this is the order playback follows, so
   *  the queue never diverges from what the user sees. */
  readonly orderedItems = computed<PlaylistItem[]>(() => {
    const out: PlaylistItem[] = [];
    for (const e of this.groupedEntries()) {
      if (e.kind === 'movie') out.push(e.item);
      else out.push(...e.group.episodes);
    }
    return out;
  });

  /** Map a playlist row to a queue item. The file id is resolved later (on
   *  launch / advance) since the playlist payload doesn't carry it. */
  private toQueueItem(it: PlaylistItem): QueueItem {
    return {
      mediaId: it.media.id,
      episodeId: it.episode?.id ?? undefined,
      title: it.media.title,
      episodeTitle: it.episode ? this.episodeLabel(it.episode) : undefined,
      fanartUrl: it.media.fanartUrl ?? null,
      stillUrl: it.episode?.stillUrl ?? null,
    };
  }

  /** Play the whole playlist, starting at the first unwatched item (or the
   *  first item when everything is watched). */
  playAll(): void {
    const list = this.orderedItems();
    if (!list.length) return;
    const firstUnwatched = list.findIndex((i) => !i.watched);
    void this.launchQueue(firstUnwatched >= 0 ? firstUnwatched : 0);
  }

  /** Play from a specific row, queueing the rest of the playlist after it. */
  playFrom(item: PlaylistItem): void {
    const index = this.orderedItems().findIndex((i) => i.itemId === item.itemId);
    if (index >= 0) void this.launchQueue(index);
  }

  private async launchQueue(startIndex: number): Promise<void> {
    const p = this.playlist();
    if (!p) return;
    const queue = this.orderedItems().map((i) => this.toQueueItem(i));
    const launched = await this.playable.playFromPlaylist(
      p.id,
      queue,
      startIndex,
      p.autoPlay,
    );
    if (!launched) {
      this.toast.error(this.translate.instant('playlists.item_unavailable'));
    }
  }

  private patchItem(itemId: number, patch: Partial<PlaylistItem>): void {
    this.items.update((list) =>
      list.map((i) => (i.itemId === itemId ? { ...i, ...patch } : i)),
    );
  }

  /** Toggle the viewer's watched state for a movie or episode item. */
  async toggleItemWatched(item: PlaylistItem): Promise<void> {
    const nextWatched = !item.watched;
    this.patchItem(item.itemId, {
      watched: nextWatched,
      progressPercent: nextWatched ? 100 : 0,
    });
    try {
      const state = await this.streamingApi.toggleWatched(
        item.media.id,
        undefined,
        item.episode?.id ?? undefined,
      );
      // On an auto-remove playlist the server drops the row once it is watched
      // (owner-scoped), so mirror that by removing it from the list instead of
      // just flagging it.
      if (state.completed && this.playlist()?.autoRemoveWatched && this.isOwner()) {
        this.items.update((list) =>
          list.filter((i) => i.itemId !== item.itemId),
        );
      } else {
        this.patchItem(item.itemId, {
          watched: state.completed,
          progressPercent: state.completed ? 100 : 0,
        });
      }
    } catch {
      // Revert on failure (global interceptor surfaces the error).
      this.patchItem(item.itemId, {
        watched: item.watched,
        progressPercent: item.progressPercent,
      });
    }
  }

  constructor() {
    // The router reuses this component across playlists; reload on id change.
    effect(() => {
      const id = this.playlistId();
      if (Number.isFinite(id) && id > 0) void this.load(id);
    });
    // Drive the global page background from the playlist's media, like the
    // media-detail pages.
    effect(() => {
      const pool = [
        ...new Set(
          this.items()
            .map((i) => i.media.fanartUrl)
            .filter((u): u is string => !!u),
        ),
      ];
      if (pool.length) this.background.setBackgrounds(pool);
      else this.background.clear();
    });
    // Reuse the layout's desktop back button (no hero styling, so mobile keeps
    // its normal top padding).
    this.navbar.showBackButton.set(true);
    this.destroyRef.onDestroy(() => {
      this.background.clear();
      this.navbar.showBackButton.set(false);
    });
  }

  private async load(id: number): Promise<void> {
    this.loading.set(true);
    try {
      const [playlist, items] = await Promise.all([
        this.api.get(id),
        this.api.items(id),
      ]);
      this.playlist.set(playlist);
      this.items.set(items);
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    } finally {
      this.loading.set(false);
    }
  }

  // ── Settings ──
  openSettings() {
    const p = this.playlist();
    if (!p) return;
    this.draftAutoRemoveWatched.set(p.autoRemoveWatched);
    this.draftAutoDownload.set(this.autoDownload.isAutoDownload(p.id));
    this.draftAutoPlay.set(p.autoPlay);
    this.draftVisibility.set(p.visibility);
    this.settingsDialog()?.nativeElement.showModal();
  }

  closeSettings() {
    this.settingsDialog()?.nativeElement.close();
  }

  async saveSettings(): Promise<void> {
    const p = this.playlist();
    if (!p) return;
    this.savingSettings.set(true);
    try {
      const updated = await this.api.update(p.id, {
        autoRemoveWatched: this.draftAutoRemoveWatched(),
        autoPlay: this.draftAutoPlay(),
        visibility: this.draftVisibility(),
      });
      this.playlist.set(updated);
      // Auto-download is stored on-device only, not on the server.
      this.autoDownload.setAutoDownload(p.id, this.draftAutoDownload());
      this.toast.success(this.translate.instant('playlists.saved'));
      this.closeSettings();
      // Kick the reconciler now so enabling it starts fetching immediately.
      if (this.draftAutoDownload()) void this.autoDownload.reconcile('settings');
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    } finally {
      this.savingSettings.set(false);
    }
  }

  // ── Members (collaboration) ──
  async openMembers(): Promise<void> {
    const p = this.playlist();
    if (!p) return;
    this.memberQuery.set('');
    this.memberResults.set([]);
    this.membersDialog()?.nativeElement.showModal();
    try {
      this.members.set(await this.api.members(p.id));
    } catch {
      // Errors surfaced by the global interceptor.
    }
    // Propose connectable members right away, before the user types.
    void this.onMemberQuery('');
  }

  closeMembers() {
    this.membersDialog()?.nativeElement.close();
  }

  /** Search connectable members; an empty query returns default suggestions,
   *  so results appear as soon as the field is focused. */
  async onMemberQuery(q: string): Promise<void> {
    this.memberQuery.set(q);
    const query = q.trim();
    try {
      const found = await this.social.searchConnectable(query);
      if (this.memberQuery().trim() !== query) return; // stale response
      const memberIds = new Set(this.members().map((m) => m.userId));
      this.memberResults.set(found.filter((u) => !memberIds.has(u.id)));
    } catch {
      this.memberResults.set([]);
    }
  }

  async addMember(user: SocialUser, role: PlaylistShareRole = 'editor'): Promise<void> {
    const p = this.playlist();
    if (!p || this.memberBusy()) return;
    this.memberBusy.set(true);
    try {
      this.members.set(await this.api.addMember(p.id, user.id, role));
      this.memberResults.update((r) => r.filter((u) => u.id !== user.id));
    } finally {
      this.memberBusy.set(false);
    }
  }

  async changeMemberRole(userId: number, role: PlaylistShareRole): Promise<void> {
    const p = this.playlist();
    if (!p || this.memberBusy()) return;
    this.memberBusy.set(true);
    try {
      this.members.set(await this.api.addMember(p.id, userId, role));
    } finally {
      this.memberBusy.set(false);
    }
  }

  async removeMember(userId: number): Promise<void> {
    const p = this.playlist();
    if (!p || this.memberBusy()) return;
    this.memberBusy.set(true);
    try {
      this.members.set(await this.api.removeMember(p.id, userId));
    } finally {
      this.memberBusy.set(false);
    }
  }

  // ── Rename ──
  openRename() {
    const p = this.playlist();
    if (!p) return;
    this.renameValue.set(p.name);
    this.renameDialog()?.nativeElement.showModal();
  }

  closeRename() {
    this.renameDialog()?.nativeElement.close();
  }

  async confirmRename(): Promise<void> {
    const p = this.playlist();
    const name = this.renameValue().trim();
    if (!p || !name) return;
    this.renaming.set(true);
    try {
      const updated = await this.api.update(p.id, { name });
      this.playlist.set(updated);
      this.closeRename();
      this.toast.success(this.translate.instant('playlists.saved'));
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    } finally {
      this.renaming.set(false);
    }
  }

  // ── Delete ──
  async deletePlaylist(): Promise<void> {
    const p = this.playlist();
    if (!p) return;
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('playlists.delete_title'),
      message: this.translate.instant('playlists.delete_confirm', {
        name: p.name,
      }),
      confirmLabel: this.translate.instant('common.delete'),
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await this.api.remove(p.id);
      this.toast.success(this.translate.instant('playlists.deleted_toast'));
      void this.router.navigate(['/playlists']);
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    }
  }

  // ── Reorder (persists itemId order) ──
  private persistOrder(): void {
    const id = this.playlist()?.id;
    if (id == null) return;
    this.api
      .reorder(
        id,
        this.items().map((i) => i.itemId),
      )
      .catch(() => {
        // Keep the shown order truthful if the server rejects it (e.g. a
        // shared editor who only sees a library-filtered subset).
        void this.load(id);
      });
  }

  // ── Grouped reorder: reorders the root media (movies + series blocks);
  //    episodes stay in series order inside their block. ──
  private applyGroupedOrder(entries: PlaylistGroupedEntry[]): void {
    const ids: number[] = [];
    for (const e of entries) {
      if (e.kind === 'movie') ids.push(e.item.itemId);
      else for (const ep of e.group.episodes) ids.push(ep.itemId);
    }
    const byId = new Map(this.items().map((i) => [i.itemId, i]));
    this.items.set(
      ids.map((id) => byId.get(id)).filter((x): x is PlaylistItem => !!x),
    );
    this.persistOrder();
  }

  dropGroup(event: CdkDragDrop<PlaylistGroupedEntry[]>): void {
    const entries = [...this.groupedEntries()];
    moveItemInArray(entries, event.previousIndex, event.currentIndex);
    this.applyGroupedOrder(entries);
  }

  moveGroup(index: number, delta: number): void {
    const entries = [...this.groupedEntries()];
    const target = index + delta;
    if (target < 0 || target >= entries.length) return;
    [entries[index], entries[target]] = [entries[target], entries[index]];
    this.applyGroupedOrder(entries);
  }

  // ── Remove item ──
  async removeItem(item: PlaylistItem): Promise<void> {
    const id = this.playlist()?.id;
    if (id == null) return;
    const title = item.episode
      ? this.episodeLabel(item.episode)
      : item.media.title;
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('playlists.remove_item_title'),
      message: this.translate.instant('playlists.remove_item_confirm', {
        title,
      }),
      confirmLabel: this.translate.instant('playlists.remove_item_action'),
      variant: 'danger',
    });
    if (!confirmed) return;
    this.items.update((list) => list.filter((i) => i.itemId !== item.itemId));
    try {
      await this.api.removeItem(id, item.itemId);
    } catch {
      void this.load(id);
    }
  }

  /** Remove every episode of a series from the playlist (grouped view). */
  async removeSeries(group: PlaylistSeriesGroup): Promise<void> {
    const id = this.playlist()?.id;
    if (id == null) return;
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('playlists.remove_series_title'),
      message: this.translate.instant('playlists.remove_series_confirm', {
        title: group.media.title,
        count: group.episodes.length,
      }),
      confirmLabel: this.translate.instant('playlists.remove_item_action'),
      variant: 'danger',
    });
    if (!confirmed) return;
    const ids = new Set(group.episodes.map((e) => e.itemId));
    this.items.update((list) => list.filter((i) => !ids.has(i.itemId)));
    try {
      await this.api.removeItemsByMedia(id, group.seriesId);
    } catch {
      void this.load(id);
    }
  }
}
