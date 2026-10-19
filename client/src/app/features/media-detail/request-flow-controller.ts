import { computed, signal } from '@angular/core';
import type { TranslateService } from '@ngx-translate/core';
import type { MediaType } from '../../core/enums/media-type.enum';
import type { Media, Season } from '../../core/services/api/media.service';
import type { RequestsService, TitleRequestState } from '../../core/services/api/requests.service';
import type { AuthService } from '../../core/services/auth.service';
import type { ConfirmationService } from '../../core/services/confirmation.service';
import type { ToastService } from '../../core/services/toast.service';
import type { RequestModalComponent } from '../tmdb-preview/components/request-modal/request-modal.component';

export interface RequestFlowHost {
  media(): Media | null;
  requestModal(): RequestModalComponent | undefined;
}

export interface RequestFlowDeps {
  auth: AuthService;
  requests: RequestsService;
  confirmation: ConfirmationService;
  toast: ToastService;
  translate: TranslateService;
}

/** Requesting and deleting through requests: who may, what is already pending, the dialogs. */
export class RequestFlowController {
  /** Regular requester (no `media.create`) with a tmdbId to request against;
   *  an unidentified title has none, so the Demander actions stay hidden. */
  readonly canRequest = computed(
    () =>
      !this.deps.auth.hasPermission('media.create') &&
      this.deps.auth.hasPermission('requests.create') &&
      this.host.media()?.tmdbId != null,
  );

  /** Requester (no `media.delete`) can ask an admin to delete this library
   *  title. Admins with `media.delete` delete directly and never see it. */
  readonly canRequestDeletion = computed(
    () =>
      this.deps.auth.hasPermission('requests.create') &&
      !this.deps.auth.hasPermission('media.delete') &&
      this.host.media()?.tmdbId != null,
  );

  /** A deletion request is already pending (this session or found on load); hides the deletion entry. */
  readonly deleteRequestPending = signal(false);

  /** Surfaces the "request deletion" entry: the viewer may request it and no
   *  deletion request is already pending. */
  readonly showRequestDeletion = computed(
    () => this.canRequestDeletion() && !this.deleteRequestPending(),
  );

  /** Global active-request state for the current title (any user). Drives
   *  the Demander gates and the series profile lock. Null until fetched. */
  readonly titleState = signal<TitleRequestState | null>(null);

  /** An active whole-title request exists (any user): movie or whole-series; blocks the header Demander entry. */
  readonly hasBlockingRequest = computed(() => this.titleState()?.requested ?? false);

  /** Season numbers already covered by an active per-season request (any
   *  user). Gates the season-level Demander entry and pre-fed to the modal. */
  readonly requestedSeasons = computed<number[]>(() => this.titleState()?.requestedSeasons ?? []);

  constructor(
    private readonly host: RequestFlowHost,
    private readonly deps: RequestFlowDeps,
  ) {}

  /** Fetch what the viewer's gates depend on; admins skip the round-trips. */
  load(m: Media): void {
    if (this.canRequest()) void this.loadTitleState(m.tmdbId, m.type);
    if (this.canRequestDeletion()) void this.loadDeleteRequestState(m.tmdbId, m.type);
  }

  /** Fetch the title's active-request state; re-run after submit so gates and profile lock flip without reload. */
  private async loadTitleState(tmdbId: number | null, mediaType: MediaType) {
    if (tmdbId == null) return;
    try {
      this.titleState.set(await this.deps.requests.getTitleState(tmdbId, mediaType));
    } catch {
      /* swallowed; global interceptor surfaces it */
    }
  }

  /** Seed the pending-deletion gate from the viewer's visible requests so the
   *  entry hides when a deletion request already exists on this title. */
  private async loadDeleteRequestState(tmdbId: number | null, mediaType: MediaType) {
    if (tmdbId == null) return;
    try {
      const res = await this.deps.requests.list({ kind: 'delete', status: 'pending' });
      this.deleteRequestPending.set(
        res.data.some((r) => r.tmdbId === tmdbId && r.mediaType === mediaType),
      );
    } catch {
      /* swallowed; the backend still rejects a duplicate on submit */
    }
  }

  /** Ask an admin to delete this library title. Confirms first, then submits a
   *  deletion request scoped to the whole title (movie or series). */
  async requestDeletion() {
    const m = this.host.media();
    if (!m || m.tmdbId == null) return;
    if (
      !(await this.deps.confirmation.confirm({
        title: this.deps.translate.instant('media_detail.request_deletion_title'),
        message: this.deps.translate.instant('media_detail.request_deletion_confirm', {
          title: m.title,
        }),
        variant: 'danger',
      }))
    ) {
      return;
    }
    try {
      await this.deps.requests.create({
        kind: 'delete',
        mediaType: m.type,
        tmdbId: m.tmdbId,
        title: m.title,
      });
      this.deleteRequestPending.set(true);
      this.deps.toast.success(this.deps.translate.instant('media_detail.request_deletion_success'));
    } catch {
      /* error toast surfaced by the global interceptor */
    }
  }

  /** Open the request modal for the current title — movie or
   *  whole-series scope (no seasons pre-selected). */
  openForMedia() {
    this.openModal({});
  }

  /** Open the request modal with a single season preselected; the user can still toggle seasons. */
  openForSeason(season: Season) {
    this.openModal({ preselectedSeasons: [season.seasonNumber] });
  }

  private openModal(extra: { preselectedSeasons?: number[] }) {
    const m = this.host.media();
    if (!m || m.tmdbId == null) return;
    const state = this.titleState();
    this.host.requestModal()?.open({
      title: m.title,
      mediaType: m.type,
      tmdbId: m.tmdbId,
      alreadyRequestedSeasons: this.requestedSeasons(),
      ...extra,
      profilesLocked: state?.profilesLocked ?? false,
      lockedQualityProfileId: state?.lockedQualityProfileId ?? null,
      lockedLanguageProfileId: state?.lockedLanguageProfileId ?? null,
    });
  }

  /** Re-fetch on submit so the More-menu Demander disappears and the
   *  season list flips its already-requested badges. */
  onSubmitted() {
    const m = this.host.media();
    if (m) void this.loadTitleState(m.tmdbId, m.type);
  }
}
