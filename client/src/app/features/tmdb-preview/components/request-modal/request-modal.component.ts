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
import { MetadataService, MetadataSeason } from '../../../../core/services/api/metadata.service';
import { RequestsService } from '../../../../core/services/api/requests.service';
import { LibrarySummary } from '../../../../core/services/api/libraries-api.service';
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
  readonly libraries = input<LibrarySummary[]>([]);
  readonly requested = output<void>();

  readonly compatibleLibraries = computed(() =>
    this.libraries().filter((l) => l.mediaTypes.includes(this.mediaType())),
  );

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  readonly title = signal('');
  readonly mediaType = signal<MediaType>('movie');
  readonly tmdbId = signal(0);
  readonly qualityProfileId = signal<number | null>(null);
  readonly languageProfileId = signal<number | null>(null);
  readonly libraryId = signal<number | null>(null);
  readonly requesting = signal(false);

  readonly seasons = signal<MetadataSeason[]>([]);
  readonly selectedSeasons = signal<Set<number>>(new Set());
  readonly seasonsLoading = signal(false);
  /** Season numbers already covered by an active request — passed in by
   *  the parent so the row is disabled in the table (cannot re-request). */
  readonly alreadyRequestedSeasons = signal<Set<number>>(new Set());
  /** A series already has an active request: its profiles are fixed and the
   *  selectors are locked to them (all seasons share one profile set). */
  readonly profilesLocked = signal(false);

  open(params: {
    title: string;
    mediaType: MediaType;
    tmdbId: number;
    alreadyRequestedSeasons?: number[];
    /** Pre-tick these season numbers on open (the user can still
     *  un-tick them or add more). Filtered against
     *  `alreadyRequestedSeasons` so we never re-add disabled rows. */
    preselectedSeasons?: number[];
    /** Set when an active request already fixes this series' profiles: the
     *  quality/language selectors are pre-filled with these and locked. */
    profilesLocked?: boolean;
    lockedQualityProfileId?: number | null;
    lockedLanguageProfileId?: number | null;
  }) {
    this.title.set(params.title);
    this.mediaType.set(params.mediaType);
    this.tmdbId.set(params.tmdbId);
    this.alreadyRequestedSeasons.set(new Set(params.alreadyRequestedSeasons ?? []));
    const locked = !!params.profilesLocked;
    this.profilesLocked.set(locked);
    this.qualityProfileId.set(
      locked
        ? (params.lockedQualityProfileId ?? null)
        : (this.qualityProfiles()[0]?.id ?? null),
    );
    this.languageProfileId.set(
      locked
        ? (params.lockedLanguageProfileId ?? null)
        : (this.languageProfiles()[0]?.id ?? null),
    );
    const compatible = this.libraries().filter((l) => l.mediaTypes.includes(params.mediaType));
    const defaultLib =
      compatible.find((l) =>
        params.mediaType === 'series' ? l.isDefaultForSeries : l.isDefaultForMovies,
      ) ?? compatible[0];
    // Only pre-select if multiple choices (select will be shown)
    this.libraryId.set(compatible.length > 1 ? (defaultLib?.id ?? null) : null);
    this.seasons.set([]);
    this.selectedSeasons.set(new Set());
    this.dialogEl()?.nativeElement.showModal();

    if (params.mediaType === 'series') {
      this.seasonsLoading.set(true);
      const preselected = new Set(params.preselectedSeasons ?? []);
      this.metadata.getTvSeasons(params.tmdbId).then((s) => {
        this.seasons.set(s);
        // Default empty unless the caller passed `preselectedSeasons`
        // (e.g. the season-level Demander entry pre-fills the season
        // it was clicked on). Already-requested rows are filtered out
        // — they're disabled and can't be re-picked anyway.
        const taken = this.alreadyRequestedSeasons();
        this.selectedSeasons.set(
          new Set(
            s
              .map((x) => x.seasonNumber)
              .filter((n) => preselected.has(n) && !taken.has(n)),
          ),
        );
      }).catch(() => {
        this.seasons.set([]);
      }).finally(() => {
        this.seasonsLoading.set(false);
      });
    }
  }

  /** Seasons the user can still pick (= total minus already-requested).
   *  Drives the header toggle's checked state so it reflects only the
   *  selectable rows, not the disabled "déjà demandé" rows. */
  readonly selectableSeasonCount = computed(
    () => this.seasons().length - this.alreadyRequestedSeasons().size,
  );

  /** True iff every selectable row is currently picked. */
  readonly allSelectableChosen = computed(
    () =>
      this.selectableSeasonCount() > 0 &&
      this.selectedSeasons().size === this.selectableSeasonCount(),
  );

  close() {
    this.dialogEl()?.nativeElement.close();
  }

  toggleSeason(n: number) {
    if (this.alreadyRequestedSeasons().has(n)) return;
    this.selectedSeasons.update((set) => {
      const next = new Set(set);
      next.has(n) ? next.delete(n) : next.add(n);
      return next;
    });
  }

  toggleAllSeasons() {
    const taken = this.alreadyRequestedSeasons();
    const selectable = this.seasons()
      .map((s) => s.seasonNumber)
      .filter((n) => !taken.has(n));
    if (this.selectedSeasons().size === selectable.length) {
      this.selectedSeasons.set(new Set());
    } else {
      this.selectedSeasons.set(new Set(selectable));
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
        libraryId: this.libraryId() ?? undefined,
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
