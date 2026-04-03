import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MetadataService, SeasonStub } from '../../../../core/services/api/metadata.service';
import { RequestsService } from '../../../../core/services/api/requests.service';
import { RootFolder } from '../../../../core/services/api/root-folders-api.service';
import { ToastService } from '../../../../core/services/toast.service';
import { MediaType } from '../../../../core/enums/media-type.enum';

@Component({
  selector: 'app-request-modal',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './request-modal.component.html',
})
export class RequestModalComponent {
  private readonly metadata = inject(MetadataService);
  private readonly requestsApi = inject(RequestsService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly qualityProfiles = input<{ id: number; name: string }[]>([]);
  readonly languageProfiles = input<{ id: number; name: string }[]>([]);
  readonly rootFolders = input<RootFolder[]>([]);
  readonly requested = output<void>();

  readonly compatibleFolders = computed(() =>
    this.rootFolders().filter((f) => f.mediaTypes.includes(this.mediaType())),
  );

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  readonly title = signal('');
  readonly mediaType = signal<MediaType>('movie');
  readonly tmdbId = signal(0);
  readonly qualityProfileId = signal<number | null>(null);
  readonly languageProfileId = signal<number | null>(null);
  readonly rootFolderId = signal<number | null>(null);
  readonly requesting = signal(false);

  readonly seasons = signal<SeasonStub[]>([]);
  readonly selectedSeasons = signal<Set<number>>(new Set());
  readonly seasonsLoading = signal(false);

  open(params: { title: string; mediaType: MediaType; tmdbId: number }) {
    this.title.set(params.title);
    this.mediaType.set(params.mediaType);
    this.tmdbId.set(params.tmdbId);
    this.qualityProfileId.set(this.qualityProfiles()[0]?.id ?? null);
    this.languageProfileId.set(this.languageProfiles()[0]?.id ?? null);
    const compatible = this.rootFolders().filter((f) => f.mediaTypes.includes(params.mediaType));
    // Only pre-select if multiple choices (select will be shown)
    this.rootFolderId.set(compatible.length > 1 ? (compatible[0]?.id ?? null) : null);
    this.seasons.set([]);
    this.selectedSeasons.set(new Set());
    this.dialogEl()?.nativeElement.showModal();

    if (params.mediaType === 'series') {
      this.seasonsLoading.set(true);
      this.metadata.getTvSeasons(params.tmdbId).then((s) => {
        this.seasons.set(s);
        this.selectedSeasons.set(new Set(s.map((x) => x.seasonNumber)));
      }).catch(() => {
        this.seasons.set([]);
      }).finally(() => {
        this.seasonsLoading.set(false);
      });
    }
  }

  close() {
    this.dialogEl()?.nativeElement.close();
  }

  toggleSeason(n: number) {
    this.selectedSeasons.update((set) => {
      const next = new Set(set);
      next.has(n) ? next.delete(n) : next.add(n);
      return next;
    });
  }

  toggleAllSeasons() {
    const all = this.seasons();
    if (this.selectedSeasons().size === all.length) {
      this.selectedSeasons.set(new Set());
    } else {
      this.selectedSeasons.set(new Set(all.map((s) => s.seasonNumber)));
    }
  }

  async confirm() {
    this.requesting.set(true);
    try {
      const isSeries = this.mediaType() === 'series';
      await this.requestsApi.create({
        mediaType: this.mediaType(),
        tmdbId: this.tmdbId(),
        title: this.title(),
        qualityProfileId: this.qualityProfileId() ?? undefined,
        languageProfileId: this.languageProfileId() ?? undefined,
        rootFolderId: this.rootFolderId() ?? undefined,
        ...(isSeries && this.selectedSeasons().size > 0
          ? { seasons: [...this.selectedSeasons()].sort((a, b) => a - b) }
          : {}),
      });
      this.toast.success(this.translate.instant('discover.request_success'));
      this.close();
      this.requested.emit();
    } catch {
      // error toast handled by global interceptor
    } finally {
      this.requesting.set(false);
    }
  }
}
