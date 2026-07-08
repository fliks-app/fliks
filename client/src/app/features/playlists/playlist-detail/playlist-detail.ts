import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
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
  LucideEllipsisVertical,
  LucideGripVertical,
  LucidePencil,
  LucideSettings,
  LucideTrash2,
} from '@lucide/angular';
import { MediaCardComponent } from '../../../shared/components/media-card/media-card';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';
import { DropdownMenuComponent } from '../../../shared/components/dropdown-menu';
import {
  Playlist,
  PlaylistItem,
  PlaylistsApiService,
} from '../../../core/services/api/playlists-api.service';
import { ToastService } from '../../../core/services/toast.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { TvService } from '../../../core/services/tv.service';

@Component({
  selector: 'app-playlist-detail',
  imports: [
    TranslateModule,
    FormsModule,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    LucideArrowDown,
    LucideArrowUp,
    LucideEllipsisVertical,
    LucideGripVertical,
    LucidePencil,
    LucideSettings,
    LucideTrash2,
    MediaCardComponent,
    ToggleFieldComponent,
    DropdownMenuComponent,
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

  private readonly routeParams = toSignal(this.route.paramMap);
  readonly playlistId = computed(() => Number(this.routeParams()?.get('id')));

  private readonly renameDialog =
    viewChild<ElementRef<HTMLDialogElement>>('renameDialog');
  private readonly settingsDialog =
    viewChild<ElementRef<HTMLDialogElement>>('settingsDialog');

  readonly loading = signal(true);
  readonly playlist = signal<Playlist | null>(null);
  readonly items = signal<PlaylistItem[]>([]);
  readonly renameValue = signal('');
  readonly renaming = signal(false);
  // Settings edits stay local until the user clicks "Save".
  readonly savingSettings = signal(false);
  readonly draftAutoRemoveWatched = signal(false);
  readonly draftAutoDownload = signal(false);

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

  constructor() {
    // The router reuses this component across playlists; reload on id change.
    effect(() => {
      const id = this.playlistId();
      if (Number.isFinite(id) && id > 0) void this.load(id);
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
    this.draftAutoDownload.set(p.autoDownload);
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
        autoDownload: this.draftAutoDownload(),
      });
      this.playlist.set(updated);
      this.toast.success(this.translate.instant('playlists.saved'));
      this.closeSettings();
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    } finally {
      this.savingSettings.set(false);
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

  drop(event: CdkDragDrop<PlaylistItem[]>): void {
    const next = [...this.items()];
    moveItemInArray(next, event.previousIndex, event.currentIndex);
    this.items.set(next);
    this.persistOrder();
  }

  move(index: number, delta: number): void {
    const next = [...this.items()];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    this.items.set(next);
    this.persistOrder();
  }

  // ── Remove item ──
  async removeItem(item: PlaylistItem): Promise<void> {
    const id = this.playlist()?.id;
    if (id == null) return;
    this.items.update((list) => list.filter((i) => i.itemId !== item.itemId));
    try {
      await this.api.removeItem(id, item.itemId);
    } catch {
      void this.load(id);
    }
  }
}
