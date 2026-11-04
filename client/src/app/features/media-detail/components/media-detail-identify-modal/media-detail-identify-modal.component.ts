import {
  Component,
  ElementRef,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ResolveUrlPipe } from '../../../../core/pipes/resolve-url.pipe';
import {
  MetadataService,
  SearchHit,
  searchResultIds,
  searchResultKey,
} from '../../../../core/services/api/metadata.service';
import { MediaService } from '../../../../core/services/api/media.service';
import { ToastService } from '../../../../core/services/toast.service';
import type { MediaType } from '../../../../core/enums/media-type.enum';
import { ModalHeaderComponent } from '../../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../../shared/components/modal-footer';

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

/** A result identifies by its provider and external id; a video also sends the ids it carries. */
function identifyTarget(r: SearchHit) {
  return { ...searchResultIds(r), provider: r.provider, externalId: r.externalId };
}

const IDS_KINDS: MediaType[] = ['movie', 'series'];

@Component({
  selector: 'app-media-detail-identify-modal',
  imports: [
    ModalFooterComponent,
    ModalHeaderComponent,
    TranslatePipe,
    FormsModule,
    ResolveUrlPipe,
  ],
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
  /** Providers serving the media's kind; '' searches the first one. */
  readonly providers = signal<{ provider: string; label: string }[]>([]);
  readonly formProvider = signal('');

  readonly searching = signal(false);
  readonly searched = signal(false);
  readonly results = signal<SearchHit[]>([]);
  /** Key of the result being applied, or 'ids' for the typed-ids button. */
  readonly applyingKey = signal<string | null>(null);

  readonly key = searchResultKey;

  /** The typed TMDB, TVDB and IMDb ids only name a movie or a series. */
  readonly takesIds = computed(() => IDS_KINDS.includes(this.config()?.mediaType as MediaType));

  open(config: IdentifyModalConfig) {
    this.config.set(config);
    this.formTitle.set(config.title);
    this.formYear.set(config.year);
    this.formImdbId.set(config.imdbId ?? '');
    this.formTmdbId.set(config.tmdbId);
    this.formTvdbId.set(config.tvdbId);
    this.results.set([]);
    this.searched.set(false);
    this.formProvider.set('');
    this.providers.set([]);
    void this.metadata
      .providersServing(config.mediaType)
      .then((p) => this.providers.set(p))
      .catch(() => undefined);
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
      const title = this.formTitle().trim();
      const year = this.formYear();
      const found = title
        ? await this.metadata.search(cfg.mediaType, title, { year: year ?? undefined, provider: this.formProvider() || undefined, mediaId: cfg.mediaId })
        : [];
      this.results.set(found);
      this.searched.set(true);
    } finally {
      this.searching.set(false);
    }
  }

  /** True when a candidate is already another title in the library — applying it
   *  would collide on the unique (type, tmdbId), so the backend refuses. */
  isTaken(result: SearchHit): boolean {
    const cfg = this.config();
    return result.existingMediaId != null && result.existingMediaId !== cfg?.mediaId;
  }

  async apply(result: SearchHit) {
    const cfg = this.config();
    if (!cfg || this.isTaken(result)) return;
    this.applyingKey.set(searchResultKey(result));
    try {
      await this.media.identify(cfg.mediaId, identifyTarget(result));
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
