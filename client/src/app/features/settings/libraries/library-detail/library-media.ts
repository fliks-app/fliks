import {
  Component,
  ChangeDetectionStrategy,
  computed,
  inject,
  signal,
  viewChild,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { LucideSearch } from '@lucide/angular';
import { PaginationComponent } from '../../../../shared/components/pagination/pagination';
import { ResolveUrlPipe } from '../../../../core/pipes/resolve-url.pipe';
import { MediaService, Media } from '../../../../core/services/api/media.service';
import { FolderPickerService } from '../../../../core/services/folder-picker.service';
import { LibraryDetailState } from './library-detail.state';
import { OrphanScanModalComponent } from './orphan-scan-modal/orphan-scan-modal';

const PAGE_SIZE = 30;

@Component({
  selector: 'app-library-media',
  imports: [
    FormsModule,
    TranslateModule,
    RouterLink,
    LucideSearch,
    ResolveUrlPipe,
    PaginationComponent,
    OrphanScanModalComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './library-media.html',
})
export class LibraryMediaComponent implements OnInit {
  private readonly mediaService = inject(MediaService);
  private readonly folderPicker = inject(FolderPickerService);
  readonly state = inject(LibraryDetailState);

  private readonly scanModal = viewChild<OrphanScanModalComponent>('scanModal');

  readonly items = signal<Media[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly search = signal('');
  readonly loading = signal(true);
  readonly loadError = signal(false);

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / PAGE_SIZE)));

  ngOnInit() {
    void this.load();
  }

  async load() {
    const libraryId = this.state.libraryId();
    if (!libraryId) return;
    this.loading.set(true);
    this.loadError.set(false);
    try {
      const res = await this.mediaService.getAll({
        libraryId,
        q: this.search().trim() || undefined,
        page: this.page(),
        limit: PAGE_SIZE,
        sortBy: 'title',
        sortOrder: 'ASC',
      });
      this.items.set(res.data);
      this.total.set(res.total);
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  onSearch(value: string) {
    this.search.set(value);
    this.page.set(1);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.load(), 300);
  }

  goToPage(page: number) {
    if (page < 1 || page > this.pageCount() || page === this.page()) return;
    this.page.set(page);
    void this.load();
  }

  save() {
    void this.state.save();
  }

  async browsePath() {
    const picked = await this.folderPicker.open(this.state.formPath().trim());
    if (picked) this.state.formPath.set(picked);
  }

  openScan() {
    this.scanModal()?.open(this.state.libraryId());
  }

  mediaLink(m: Media): string[] {
    return ['/' + (m.type === 'movie' ? 'movies' : 'series'), String(m.id)];
  }
}
