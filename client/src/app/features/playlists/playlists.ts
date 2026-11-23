import {
  Component,
  ElementRef,
  OnInit,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../../shared/icons';
import { MosaicCardComponent } from '../../shared/components/mosaic-card/mosaic-card';
import { ModalHeaderComponent } from '../../shared/components/modal-header';
import { M3uImportResult, Playlist, PlaylistsApiService } from '../../core/services/api/playlists-api.service';
import { ToastService } from '../../core/services/toast.service';
import { keepRouteFresh } from '../../core/services/keep-route-fresh';
import { ModalFooterComponent } from '../../shared/components/modal-footer';
import { SmartPlaylistEditorComponent } from './smart-playlist-editor/smart-playlist-editor';
import { CardSkeletonComponent } from '../../shared/components/card-skeleton';
import { EmptyStateComponent } from '../../shared/components/empty-state/empty-state';
import { ModalComponent } from '../../shared/components/modal';

@Component({
  selector: 'app-playlists',
  imports: [ModalComponent, EmptyStateComponent, CardSkeletonComponent,
    ModalFooterComponent,
    MosaicCardComponent,
    TranslatePipe,
    FormsModule,
    ModalHeaderComponent,
    SmartPlaylistEditorComponent, LucideDynamicIcon,
  ],
  templateUrl: './playlists.html',
})
export class PlaylistsComponent implements OnInit {
  protected readonly icons = icons;

  private readonly api = inject(PlaylistsApiService);
  protected readonly m3uSupported = this.api.m3uSupported;
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  private readonly importDialog = viewChild<string, ElementRef<HTMLDialogElement>>('importDialog', { read: ElementRef });
  private readonly createDialog = viewChild<string, ElementRef<HTMLDialogElement>>('createDialog', { read: ElementRef });

  readonly playlists = signal<Playlist[]>([]);
  readonly loading = signal(false);
  readonly creating = signal(false);
  readonly newName = signal('');
  readonly importing = signal(false);
  readonly importResult = signal<M3uImportResult | null>(null);

  /** Cached route: revalidate on return so a playlist created or deleted
   *  elsewhere shows up behind the DOM the cache paints instantly. */
  private readonly routeFresh = keepRouteFresh({
    refresh: () => void this.load(true),
  });

  ngOnInit() {
    void this.load();
  }

  private async load(force = false): Promise<void> {
    this.loading.set(true);
    try {
      const rows = await this.api.list({ force }).catch(() => null);
      if (rows) this.playlists.set(rows);
    } finally {
      this.loading.set(false);
    }
  }

  openPlaylist(id: number) {
    void this.router.navigate(['/playlists', id]);
  }

  openCreate() {
    this.newName.set('');
    this.createDialog()?.nativeElement.showModal();
  }

  closeCreate() {
    this.createDialog()?.nativeElement.close();
  }

  async create(): Promise<void> {
    const name = this.newName().trim();
    if (!name) return;
    this.creating.set(true);
    try {
      const created = await this.api.create({ name });
      this.toast.success(this.translate.instant('playlists.created_toast'));
      this.closeCreate();
      void this.router.navigate(['/playlists', created.id]);
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    } finally {
      this.creating.set(false);
    }
  }

  openSmart(editor: SmartPlaylistEditorComponent) {
    editor.open();
  }

  smartSaved(p: Playlist) {
    void this.router.navigate(['/playlists', p.id]);
  }

  /** An M3U file becomes a playlist named after it; the unmatched lines are listed. */
  async importFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.importing.set(true);
    try {
      const content = await file.text();
      const result = await this.api.importM3u(file.name.replace(/\.[^.]*$/, '') || file.name, content);
      this.importResult.set(result);
      void this.load(true);
      this.importDialog()?.nativeElement.showModal();
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    } finally {
      this.importing.set(false);
    }
  }

  openImported(r: M3uImportResult) {
    this.importDialog()?.nativeElement.close();
    this.openPlaylist(r.playlist.id);
  }
}
