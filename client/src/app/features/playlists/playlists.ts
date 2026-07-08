import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  OnInit,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucidePlus } from '@lucide/angular';
import { MosaicCardComponent } from '../../shared/components/mosaic-card/mosaic-card';
import {
  Playlist,
  PlaylistsApiService,
} from '../../core/services/api/playlists-api.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-playlists',
  imports: [MosaicCardComponent, TranslateModule, FormsModule, LucidePlus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './playlists.html',
})
export class PlaylistsComponent implements OnInit {
  private readonly api = inject(PlaylistsApiService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  private readonly createDialog =
    viewChild<ElementRef<HTMLDialogElement>>('createDialog');

  readonly playlists = signal<Playlist[]>([]);
  readonly loading = signal(false);
  readonly creating = signal(false);
  readonly newName = signal('');

  ngOnInit() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const rows = await this.api.list().catch(() => null);
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
}
