import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucideListPlus, LucidePlus } from '@lucide/angular';
import {
  AddToPlaylistBody,
  Playlist,
  PlaylistsApiService,
} from '../../../core/services/api/playlists-api.service';
import { ToastService } from '../../../core/services/toast.service';
import { AutoDownloadService } from '../../../core/services/auto-download.service';

/**
 * Small dialog to add a media to an existing playlist or create a new one on
 * the fly. Mounted once at the layout level and opened from anywhere (media
 * cards, the media-detail header) through {@link AddToPlaylistService}. Only
 * playlists the user can add to are listed (viewers are filtered out).
 */
@Component({
  selector: 'app-add-to-playlist-modal',
  imports: [FormsModule, TranslateModule, LucideListPlus, LucidePlus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './add-to-playlist-modal.component.html',
})
export class AddToPlaylistModalComponent {
  private readonly api = inject(PlaylistsApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly autoDownload = inject(AutoDownloadService);

  private readonly dialogEl =
    viewChild<ElementRef<HTMLDialogElement>>('dialog');

  readonly added = output<void>();

  readonly target = signal<AddToPlaylistBody | null>(null);
  readonly playlists = signal<Playlist[]>([]);
  readonly loading = signal(false);
  readonly busyId = signal<number | null>(null);
  readonly creating = signal(false);
  readonly newName = signal('');

  async open(target: AddToPlaylistBody): Promise<void> {
    this.target.set(target);
    this.newName.set('');
    this.playlists.set([]);
    this.dialogEl()?.nativeElement.showModal();
    this.loading.set(true);
    try {
      // Only playlists the user can actually add to (viewers can't).
      const all = await this.api.list({ force: true });
      this.playlists.set(all.filter((p) => p.role !== 'viewer'));
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    } finally {
      this.loading.set(false);
    }
  }

  close() {
    this.dialogEl()?.nativeElement.close();
  }

  async addTo(playlist: Playlist): Promise<void> {
    const target = this.target();
    if (!target || this.busyId() !== null) return;
    this.busyId.set(playlist.id);
    try {
      await this.api.addItem(playlist.id, target);
      this.toast.success(this.translate.instant('playlists.added_toast'));
      this.added.emit();
      this.close();
      // Fetch the new item straight away when the target playlist auto-downloads.
      if (this.autoDownload.isAutoDownload(playlist.id)) {
        void this.autoDownload.reconcile('add');
      }
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    } finally {
      this.busyId.set(null);
    }
  }

  async createAndAdd(): Promise<void> {
    const target = this.target();
    const name = this.newName().trim();
    if (!target || !name || this.creating()) return;
    this.creating.set(true);
    try {
      const created = await this.api.create({ name });
      await this.api.addItem(created.id, target);
      this.toast.success(
        this.translate.instant('playlists.created_and_added_toast'),
      );
      this.added.emit();
      this.close();
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    } finally {
      this.creating.set(false);
    }
  }
}
