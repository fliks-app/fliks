import {
  Component,
  ChangeDetectionStrategy,
  DestroyRef,
  ElementRef,
  OnInit,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucidePlus } from '@lucide/angular';
import { MosaicCardComponent } from '../../shared/components/mosaic-card/mosaic-card';
import { ModalHeaderComponent } from '../../shared/components/modal-header';
import { Playlist, PlaylistsApiService } from '../../core/services/api/playlists-api.service';
import { ToastService } from '../../core/services/toast.service';
import { CachingReuseStrategy } from '../../core/services/route-reuse.strategy';
import { ModalFooterComponent } from '../../shared/components/modal-footer';

@Component({
  selector: 'app-playlists',
  imports: [
    ModalFooterComponent,
    MosaicCardComponent,
    TranslateModule,
    FormsModule,
    LucidePlus,
    ModalHeaderComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './playlists.html',
})
export class PlaylistsComponent implements OnInit {
  private readonly api = inject(PlaylistsApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly reuseStrategy = inject(CachingReuseStrategy);
  private readonly destroyRef = inject(DestroyRef);

  private readonly createDialog = viewChild<ElementRef<HTMLDialogElement>>('createDialog');

  readonly playlists = signal<Playlist[]>([]);
  readonly loading = signal(false);
  readonly creating = signal(false);
  readonly newName = signal('');

  ngOnInit() {
    void this.load();
    // This route is `reuse: true`, so ngOnInit does NOT re-run when the user
    // navigates back to a cached instance — refresh on reattach so a playlist
    // created/deleted elsewhere shows up (mirrors home/search/history).
    const ownKey = this.reuseStrategy.keyFor(this.route.snapshot);
    this.reuseStrategy.attached$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((key) => {
      if (key === ownKey) void this.load(true);
    });
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
}
