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
import { ResolveUrlPipe } from '../../../../core/pipes/resolve-url.pipe';
import {
  MetadataService,
  MetadataSearchResult,
  searchResultIds,
  searchResultKey,
} from '../../../../core/services/api/metadata.service';
import { MediaService } from '../../../../core/services/api/media.service';
import { ToastService } from '../../../../core/services/toast.service';
import type { MediaType } from '../../../../core/enums/media-type.enum';

/** What the caller knows about the media, used to prefill the criteria. */
export interface IdentifyModalConfig {
  mediaId: number;
  mediaType: MediaType;
  title: string;
  year: number | null;
  path: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
}

@Component({
  selector: 'app-media-detail-identify-modal',
  imports: [TranslateModule, FormsModule, ResolveUrlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-identify-modal.component.html',
})
export class MediaDetailIdentifyModalComponent {
  private readonly metadata = inject(MetadataService);
  private readonly media = inject(MediaService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  /** Emitted after a successful re-identification so the page can reload. */
  readonly identified = output<void>();

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  readonly config = signal<IdentifyModalConfig | null>(null);
  readonly formTitle = signal('');
  readonly formYear = signal<number | null>(null);
  readonly formImdbId = signal('');
  readonly formTmdbId = signal<number | null>(null);
  readonly formTvdbId = signal<number | null>(null);

  readonly searching = signal(false);
  readonly searched = signal(false);
  readonly results = signal<MetadataSearchResult[]>([]);
  /** Key of the result being applied, or 'ids' for the typed-ids button. */
  readonly applyingKey = signal<string | null>(null);

  readonly key = searchResultKey;

  open(config: IdentifyModalConfig) {
    this.config.set(config);
    this.formTitle.set(config.title);
    this.formYear.set(config.year);
    this.formImdbId.set(config.imdbId ?? '');
    this.formTmdbId.set(config.tmdbId);
    this.formTvdbId.set(config.tvdbId);
    this.results.set([]);
    this.searched.set(false);
    this.dialogEl()?.nativeElement.showModal();
  }

  close() {
    this.dialogEl()?.nativeElement.close();
  }

  /** An id criterion identifies outright — no search needed, so applying it
   *  directly is both faster and exact. Otherwise search by title + year. */
  async search() {
    const cfg = this.config();
    if (!cfg) return;
    this.searching.set(true);
    try {
      const isSeries = cfg.mediaType === 'series';
      const title = this.formTitle().trim();
      const year = this.formYear();
      const found = title
        ? isSeries
          ? await this.metadata.searchTv(title, year ?? undefined, undefined, cfg.mediaId)
          : await this.metadata.searchMovie(title, year ?? undefined, undefined, cfg.mediaId)
        : [];
      this.results.set(found);
      this.searched.set(true);
    } finally {
      this.searching.set(false);
    }
  }

  /** True when a candidate is already another title in the library — applying it
   *  would collide on the unique (type, tmdbId), so the backend refuses. */
  isTaken(result: MetadataSearchResult): boolean {
    const cfg = this.config();
    return result.existingMediaId != null && result.existingMediaId !== cfg?.mediaId;
  }

  async apply(result: MetadataSearchResult) {
    const cfg = this.config();
    if (!cfg || this.isTaken(result)) return;
    this.applyingKey.set(searchResultKey(result));
    try {
      await this.media.identify(cfg.mediaId, searchResultIds(result));
      this.toast.success(this.translate.instant('media_detail.identify_success'));
      this.close();
      this.identified.emit();
    } catch {
      // the global interceptor surfaces the 409 / provider error
    } finally {
      this.applyingKey.set(null);
    }
  }

  /** Applies the ids typed by hand, bypassing the results grid. */
  async applyIds() {
    const cfg = this.config();
    if (!cfg) return;
    const target = {
      ...((this.formTmdbId() ?? 0) > 0 ? { tmdbId: this.formTmdbId()! } : {}),
      ...(this.formTvdbId() != null ? { tvdbId: this.formTvdbId()! } : {}),
      ...(this.formImdbId().trim() ? { imdbId: this.formImdbId().trim() } : {}),
    };
    if (!Object.keys(target).length) return;
    this.applyingKey.set('ids');
    try {
      await this.media.identify(cfg.mediaId, target);
      this.toast.success(this.translate.instant('media_detail.identify_success'));
      this.close();
      this.identified.emit();
    } catch {
      // handled by the global interceptor
    } finally {
      this.applyingKey.set(null);
    }
  }
}
