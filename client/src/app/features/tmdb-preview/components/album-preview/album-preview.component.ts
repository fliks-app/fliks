import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucidePlus } from '@lucide/angular';
import { LibrariesApiService, type LibrarySummary } from '../../../../core/services/api/libraries-api.service';
import { MusicApiService } from '../../../../core/services/api/music-api.service';
import { AuthService } from '../../../../core/services/auth.service';
import { ToastService } from '../../../../core/services/toast.service';
import { mediaDetailLink } from '../../../../core/media-kinds';
import { HeroBaseComponent, type HeroChip } from '../../../../shared/components/hero-base/hero-base';
import { LibraryFolderSelectComponent, defaultFolderId } from '../../../../shared/components/library-folder-select/library-folder-select';
import { TvSelectDirective } from '../../../../shared/directives/tv-select.directive';
import { previewPosterName } from '../../../../shared/utils/view-transition';
import { PREVIEW_HOST, type PreviewSeed } from '../../preview-host';

/** The add page of an album: the title and cover of the search hit, a library to pick, and Add. */
@Component({
  selector: 'app-album-preview',
  imports: [FormsModule, TranslatePipe, TvSelectDirective, HeroBaseComponent, LibraryFolderSelectComponent, LucidePlus],
  templateUrl: './album-preview.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlbumPreviewComponent implements OnInit {
  private readonly api = inject(MusicApiService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly auth = inject(AuthService);
  private readonly host = inject(PREVIEW_HOST);

  readonly provider = input.required<string>();
  readonly externalId = input.required<string>();
  readonly seed = input<PreviewSeed | null>(null);

  protected readonly libraries = signal<LibrarySummary[]>([]);
  protected readonly libraryId = signal<number | null>(null);
  protected readonly folderId = signal<number | null>(null);
  protected readonly adding = signal(false);
  protected readonly canImport = computed(() => this.auth.hasPermission('media.create'));
  protected readonly albumLibraries = computed(() => this.libraries().filter((l) => l.mediaTypes.includes('album')));
  protected readonly folders = computed(() => this.albumLibraries().find((l) => l.id === this.libraryId())?.folders ?? []);
  protected readonly chips: HeroChip[] = [{ label: 'kinds.album', cls: 'badge badge-outline badge-sm md:badge-md' }];
  protected readonly posterTransitionName = computed(() => previewPosterName('album', this.provider(), this.externalId()));

  async ngOnInit(): Promise<void> {
    const s = this.seed();
    if (s) this.host.setTitle(s.title);
    this.host.setBackground(s?.posterUrl ?? null, { blur: true });
    if (!this.canImport()) return;
    try {
      this.libraries.set(await this.librariesApi.listMine());
    } catch {
      /* the picker stays empty, Add stays disabled */
    }
    this.selectLibrary(this.albumLibraries()[0]?.id ?? null);
  }

  protected selectLibrary(id: number | null): void {
    this.libraryId.set(id);
    this.folderId.set(defaultFolderId(this.folders()));
  }

  protected async add(): Promise<void> {
    const libraryId = this.libraryId();
    if (libraryId == null || this.adding()) return;
    this.adding.set(true);
    try {
      const folderId = this.folderId();
      const saved = await this.api.importAlbum({
        provider: this.provider(),
        externalId: this.externalId(),
        libraryId,
        ...(this.folders().length > 1 && folderId != null ? { folderId } : {}),
      });
      this.toast.success(this.translate.instant('discover.import_success'));
      void this.router.navigate(mediaDetailLink('album', saved.id));
    } catch {
      // The global HTTP interceptor toasts the failure.
    } finally {
      this.adding.set(false);
    }
  }
}
