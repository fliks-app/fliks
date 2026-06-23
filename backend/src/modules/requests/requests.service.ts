import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, In, Repository } from 'typeorm';
import { FliksRequest } from './entities/request.entity';
import { RequestComment } from './entities/request-comment.entity';
import {
  AutoApprovalRule,
  AutoApprovalCondition,
} from './entities/auto-approval-rule.entity';
import { User } from '../users/entities/user.entity';
import { QualityProfile } from '../profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../profiles/entities/language-profile.entity';
import { Library } from '../libraries/entities/library.entity';
import { LibrariesService } from '../libraries/libraries.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { ListRequestsDto } from './dto/list-requests.dto';
import { UpdateRequestDto } from './dto/update-request.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { MediaType, RequestStatus } from '../../common/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { MediaService } from '../media/media.service';
import { Media } from '../media/entities/media.entity';
import { ProfilesService } from '../profiles/profiles.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { CaslAbilityFactory } from '../auth/casl/casl-ability.factory';
import { Action } from '../auth/casl/actions.enum';
import { ImageService } from '../images/image.service';
import { TmdbProvider } from '../metadata-providers/providers/tmdb.provider';
import { ACTIVE_REQUEST_STATUSES } from './request-status.constants';

export interface TitleRequestState {
  /** A movie or whole-series active request exists (blocks re-request). */
  requested: boolean;
  wholeSeriesRequested: boolean;
  /** Union of active per-season scopes (series). */
  requestedSeasons: number[];
  /** Series profiles are fixed (an active request OR a library row already
   *  set them): a further request must inherit `locked*` and can't change. */
  profilesLocked: boolean;
  lockedQualityProfileId: number | null;
  lockedLanguageProfileId: number | null;
}

@Injectable()
export class RequestsService {
  constructor(
    @InjectRepository(FliksRequest)
    private readonly requestRepo: Repository<FliksRequest>,
    @InjectRepository(RequestComment)
    private readonly commentRepo: Repository<RequestComment>,
    @InjectRepository(AutoApprovalRule)
    private readonly ruleRepo: Repository<AutoApprovalRule>,
    private readonly notifications: NotificationsService,
    private readonly mediaService: MediaService,
    private readonly profilesService: ProfilesService,
    private readonly scheduler: SchedulerService,
    private readonly caslAbilityFactory: CaslAbilityFactory,
    private readonly imageService: ImageService,
    private readonly tmdb: TmdbProvider,
    private readonly libraries: LibrariesService,
  ) {}

  private readonly logger = new Logger(RequestsService.name);

  /** Aligné sur PoliciesGuard / CaslAbilityFactory (manage:all → Manage sur tout). */
  private canManageRequests(user: User): boolean {
    return this.caslAbilityFactory
      .createForUser(user)
      .can(Action.Manage, FliksRequest);
  }

  /** Super-admins see every library, so the per-library scoping is a no-op. */
  private isSuperAdmin(user: User): boolean {
    return user.isAdmin || user.permissions.includes('manage:all');
  }

  /**
   * A user may only target a library they have access to. Used when a request
   * is created or edited with an explicit `libraryId` — both the requester and
   * a validator can only point a request at a library in their own access set.
   */
  private async assertCanUseLibrary(
    user: User,
    libraryId: number,
  ): Promise<void> {
    if (this.isSuperAdmin(user)) return;
    const accessible = await this.libraries.getAccessibleLibraryIds(user);
    if (!accessible.includes(libraryId)) {
      throw new ForbiddenException(
        'You do not have access to the selected library',
      );
    }
  }

  /**
   * Gate a validator's visibility/actions on a request by its target library:
   * a request anchored to a library the validator can't access is off-limits.
   * Unassigned requests (`libraryId === null`) target no library yet and stay
   * visible to every validator; a user always retains access to their own
   * requests regardless of library access.
   */
  private async assertCanAccessRequestLibrary(
    user: User,
    libraryId: number | null,
    ownerId: number | null,
  ): Promise<void> {
    if (libraryId == null) return;
    if (this.isSuperAdmin(user)) return;
    if (ownerId != null && ownerId === user.id) return;
    const accessible = await this.libraries.getAccessibleLibraryIds(user);
    if (!accessible.includes(libraryId)) {
      throw new ForbiddenException(
        "You do not have access to this request's target library",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-approval
  // ---------------------------------------------------------------------------

  private evalCondition(
    cond: AutoApprovalCondition,
    context: {
      role: string;
      userId: number;
      mediaType: string;
      tmdbId: number;
      title: string;
    },
  ): boolean {
    let actual: string | number;
    switch (cond.field) {
      case 'role':
        actual = context.role;
        break;
      case 'userId':
        actual = context.userId;
        break;
      default:
        return true; // genre/year/seasons require metadata lookup — skip for now
    }
    switch (cond.operator) {
      case 'equals':
        return String(actual) === String(cond.value);
      case 'notEquals':
        return String(actual) !== String(cond.value);
      case 'greaterThan':
        return Number(actual) > Number(cond.value);
      case 'lessThan':
        return Number(actual) < Number(cond.value);
      case 'contains':
        return String(actual).includes(String(cond.value));
      default:
        return false;
    }
  }

  private async shouldAutoApprove(
    user: User,
    dto: CreateRequestDto,
  ): Promise<boolean> {
    const rules = await this.ruleRepo.find({
      where: { enabled: true },
      order: { priority: 'DESC' },
    });
    if (!rules.length) return false;

    const context = {
      role: user.userRole?.name?.toLowerCase() ?? 'user',
      userId: user.id,
      mediaType: dto.mediaType,
      tmdbId: dto.tmdbId,
      title: dto.title,
    };

    return rules.some((rule) =>
      rule.conditions.every((cond) => this.evalCondition(cond, context)),
    );
  }

  // ---------------------------------------------------------------------------
  // Quota enforcement
  // ---------------------------------------------------------------------------

  private async checkQuota(user: User, mediaType: MediaType): Promise<void> {
    const limit =
      mediaType === MediaType.MOVIE
        ? user.movieQuotaLimit
        : user.seriesQuotaLimit;

    if (!limit) return; // 0 or undefined = unlimited

    const periodDays = user.quotaPeriodDays || 7;
    const since = new Date();
    since.setDate(since.getDate() - periodDays);

    const count = await this.requestRepo
      .createQueryBuilder('r')
      .where('r.userId = :userId', { userId: user.id })
      .andWhere('r.mediaType = :mediaType', { mediaType })
      .andWhere('r.status IN (:...statuses)', {
        statuses: [RequestStatus.PENDING, RequestStatus.APPROVED],
      })
      .andWhere('r.createdAt >= :since', { since })
      .getCount();

    if (count >= limit) {
      throw new ForbiddenException(
        `Quota exceeded: ${count}/${limit} ${mediaType} requests in last ${periodDays} days`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Requests CRUD
  // ---------------------------------------------------------------------------

  async create(user: User, dto: CreateRequestDto): Promise<FliksRequest> {
    await this.checkQuota(user, dto.mediaType);
    await this.assertNoActiveDuplicate(dto);
    if (dto.libraryId != null) {
      await this.assertCanUseLibrary(user, dto.libraryId);
    }

    // Series share one profile set across seasons: a later-season request
    // inherits the quality and language profiles fixed by the first request
    // and cannot diverge from them.
    if (dto.mediaType === MediaType.SERIES) {
      const locked = await this.existingSeriesProfiles(dto.tmdbId);
      if (locked) {
        dto.qualityProfileId = locked.qualityProfileId ?? undefined;
        dto.languageProfileId = locked.languageProfileId ?? undefined;
      }
    }

    const autoApprove = await this.shouldAutoApprove(user, dto);

    // Whenever we auto-approve we also ensure a Media row exists so the
    // auto-grab pipeline can actually pick up the title. Idempotent: if
    // the media is already there (another user's request brought it in,
    // or an admin imported it manually) we just link to the existing row.
    const media = autoApprove
      ? await this.ensureMediaForApprovedRequest(
          {
            mediaType: dto.mediaType,
            tmdbId: dto.tmdbId,
            qualityProfileId: dto.qualityProfileId ?? null,
            languageProfileId: dto.languageProfileId ?? null,
            libraryId: dto.libraryId ?? null,
            seasons: dto.seasons ?? null,
          },
          user.id,
        )
      : null;

    const partial: DeepPartial<FliksRequest> = {
      user,
      mediaType: dto.mediaType,
      tmdbId: dto.tmdbId,
      title: dto.title,
      seasons: dto.seasons ?? null,
      qualityProfile: dto.qualityProfileId
        ? ({ id: dto.qualityProfileId } as QualityProfile)
        : null,
      languageProfile: dto.languageProfileId
        ? ({ id: dto.languageProfileId } as LanguageProfile)
        : null,
      library: dto.libraryId ? ({ id: dto.libraryId } as Library) : null,
      status: autoApprove ? RequestStatus.APPROVED : RequestStatus.PENDING,
      approvedBy: autoApprove ? user : null,
      media: media ?? null,
    };
    const row = this.requestRepo.create(partial);
    const saved = await this.requestRepo.save(row);
    this.projectEmbeddedUsers(saved);

    const event = autoApprove ? 'request.approved' : 'request.created';
    void this.notifications.dispatch(event, {
      title: dto.title,
      mediaType: dto.mediaType,
    });

    // Bounded wait: the art typically lands within a couple seconds and the
    // first render gets it. On a degraded TMDB the response returns with
    // null art after the deadline and the client's metadata fallback covers
    // the row while the download finishes in the background (the columns
    // are persisted by a separate UPDATE).
    await Promise.race([
      this.populateRequestArt(saved),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);

    return saved;
  }

  /**
   * Stores the title's poster/fanart through the local image pipeline and
   * stamps their API paths on the request, so cards render from the cached
   * `/api/images` endpoint instead of fetching metadata + the TMDB CDN per
   * card. Art is keyed by `{mediaType}-{tmdbId}` — TMDB ids are namespaced
   * per media type — so requests for the same title share files and a
   * repeat request only downloads whichever variant is still missing.
   * Best-effort: any failure leaves the columns null and the client falls
   * back to the metadata lookup.
   */
  private async populateRequestArt(row: FliksRequest): Promise<void> {
    try {
      const key = `${row.mediaType}-${row.tmdbId}`;
      let posterUrl = this.imageService.hasImage('request', key, 'poster')
        ? this.imageService.getApiPath('request', key, 'poster')
        : null;
      let fanartUrl = this.imageService.hasImage('request', key, 'fanart')
        ? this.imageService.getApiPath('request', key, 'fanart')
        : null;

      if (!posterUrl || !fanartUrl) {
        const details =
          row.mediaType === MediaType.MOVIE
            ? await this.tmdb.getMovieDetails(String(row.tmdbId))
            : await this.tmdb.getTvShowDetails(String(row.tmdbId));
        [posterUrl, fanartUrl] = await Promise.all([
          posterUrl ??
            (details.posterUrl
              ? this.imageService.downloadAndStore(
                  details.posterUrl,
                  'request',
                  key,
                  'poster',
                )
              : Promise.resolve(null)),
          fanartUrl ??
            (details.fanartUrl
              ? this.imageService.downloadAndStore(
                  details.fanartUrl,
                  'request',
                  key,
                  'fanart',
                )
              : Promise.resolve(null)),
        ]);
      }

      if (!posterUrl && !fanartUrl) return;
      row.posterUrl = posterUrl;
      row.fanartUrl = fanartUrl;
      await this.requestRepo.update(row.id, { posterUrl, fanartUrl });
    } catch (err) {
      // Never block request creation on artwork.
      this.logger.warn(
        `Request #${row.id}: art prefetch failed: ${(err as Error).message}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  /**
   * One active request per (tmdbId, mediaType) across all users, regardless
   * of profiles. For series carrying an explicit season list the rule is
   * finer-grained: a new request is allowed as long as its seasons don't
   * overlap with any active per-season request, AND no active whole-series
   * request is blocking everything.
   */
  private async assertNoActiveDuplicate(dto: CreateRequestDto): Promise<void> {
    const existing = await this.requestRepo.find({
      where: {
        tmdbId: dto.tmdbId,
        mediaType: dto.mediaType,
        status: In([...ACTIVE_REQUEST_STATUSES]),
      },
    });
    if (existing.length === 0) return;

    const isSeriesWithSeasons =
      dto.mediaType === MediaType.SERIES && !!dto.seasons?.length;

    if (!isSeriesWithSeasons) {
      throw new ConflictException('This title has already been requested');
    }

    // Series + season list: collect taken seasons, factor in whole-series
    // requests (`seasons === null`) which cover everything.
    const taken = new Set<number>();
    for (const e of existing) {
      if (!e.seasons || e.seasons.length === 0) {
        throw new ConflictException(
          'The whole series has already been requested',
        );
      }
      for (const n of e.seasons) taken.add(n);
    }
    const overlap = dto.seasons!.filter((s) => taken.has(s));
    if (overlap.length > 0) {
      throw new ConflictException(
        `Season(s) ${overlap.join(', ')} have already been requested`,
      );
    }
  }

  /**
   * Profiles a series is locked to: the quality + language profiles of the
   * earliest active request for the title, or — when none exists — the
   * library Media row's profiles. Series share one profile set across
   * seasons, so any later-season request inherits these. Null only when the
   * series is neither requested nor in the library (the first request picks
   * freely).
   */
  private async existingSeriesProfiles(tmdbId: number): Promise<{
    qualityProfileId: number | null;
    languageProfileId: number | null;
  } | null> {
    const existing = await this.requestRepo.findOne({
      where: {
        tmdbId,
        mediaType: MediaType.SERIES,
        status: In([...ACTIVE_REQUEST_STATUSES]),
      },
      order: { createdAt: 'ASC' },
    });
    if (existing) {
      return {
        qualityProfileId: existing.qualityProfileId ?? null,
        languageProfileId: existing.languageProfileId ?? null,
      };
    }
    const media = await this.mediaService.findByTmdbId(
      tmdbId,
      MediaType.SERIES,
    );
    if (media) {
      return {
        qualityProfileId: media.qualityProfileId ?? null,
        languageProfileId: media.languageProfileId ?? null,
      };
    }
    return null;
  }

  /**
   * Aggregate active-request state for a title, computed across all users
   * without exposing who requested it — drives the global "already
   * requested" gate and the per-season + profile-lock hints in the UI.
   */
  async getTitleState(
    tmdbId: number,
    mediaType: MediaType,
  ): Promise<TitleRequestState> {
    const active = await this.requestRepo.find({
      where: {
        tmdbId,
        mediaType,
        status: In([...ACTIVE_REQUEST_STATUSES]),
      },
      order: { createdAt: 'ASC' },
    });
    const wholeSeriesRequested =
      mediaType === MediaType.SERIES &&
      active.some((r) => !r.seasons || r.seasons.length === 0);
    const requestedSeasons = Array.from(
      new Set(active.flatMap((r) => r.seasons ?? [])),
    ).sort((a, b) => a - b);
    const requested =
      mediaType === MediaType.SERIES ? wholeSeriesRequested : active.length > 0;
    const locked =
      mediaType === MediaType.SERIES
        ? await this.existingSeriesProfiles(tmdbId)
        : null;
    return {
      requested,
      wholeSeriesRequested,
      requestedSeasons,
      profilesLocked: locked !== null,
      lockedQualityProfileId: locked?.qualityProfileId ?? null,
      lockedLanguageProfileId: locked?.languageProfileId ?? null,
    };
  }

  async findAll(
    user: User,
    query: ListRequestsDto,
  ): Promise<{ data: FliksRequest[]; total: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const qb = this.requestRepo
      .createQueryBuilder('r')
      // Embedded users are projected down to the public identity fields —
      // the full User row carries credentials and account settings that
      // don't belong in a request payload.
      .leftJoin('r.user', 'user')
      .addSelect(['user.id', 'user.username', 'user.avatar'])
      .leftJoin('r.approvedBy', 'approvedBy')
      .addSelect(['approvedBy.id', 'approvedBy.username', 'approvedBy.avatar'])
      // Resolve the linked library media by (tmdbId, type) rather than the
      // request's FK so partial-library titles (another user's request
      // already brought it in, or only some seasons are present) surface a
      // `media` object. The UI routes to the library detail when any match
      // exists; the FK `mediaId` is left untouched for lifecycle bookkeeping.
      .leftJoinAndMapOne(
        'r.media',
        Media,
        'media',
        // `media.type` and `r.mediaType` are declared as two distinct Postgres
        // enums (each entity got its own `*_enum` type at migration time), so
        // they need an explicit text cast for the equality to type-check.
        'media."tmdbId" = r."tmdbId" AND media.type::text = r."mediaType"::text',
      )
      .orderBy('r.createdAt', 'DESC');

    if (!this.canManageRequests(user)) {
      qb.andWhere('r.userId = :uid', { uid: user.id });
    } else {
      // A validator only sees requests whose target library they can access.
      // Unassigned requests (libraryId IS NULL) target no library yet and stay
      // visible to every validator. Super-admins skip the scope entirely.
      if (!this.isSuperAdmin(user)) {
        const accessible = await this.libraries.getAccessibleLibraryIds(user);
        qb.andWhere(
          '(r."libraryId" IS NULL OR r."libraryId" IN (:...libs))',
          { libs: accessible.length ? accessible : [0] },
        );
      }
      if (query.userId) {
        qb.andWhere('r.userId = :uid', { uid: query.userId });
      }
    }
    if (query.status) {
      qb.andWhere('r.status = :st', { st: query.status });
    }

    const [data, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { data, total };
  }

  async findOne(id: number, user: User): Promise<FliksRequest> {
    const row = await this.requestRepo.findOne({
      where: { id },
      relations: ['user', 'approvedBy', 'media', 'comments', 'comments.user'],
    });
    if (!row) throw new NotFoundException(`Request #${id} not found`);
    const isOwner = row.userId === user.id;
    if (!this.canManageRequests(user) && !isOwner) {
      throw new ForbiddenException();
    }
    await this.assertCanAccessRequestLibrary(user, row.libraryId, row.userId);
    return this.projectEmbeddedUsers(row);
  }

  /**
   * Projects an embedded User down to its public identity. Request payloads
   * expose who acted, never the account itself — and a nested FindOptions
   * `select` can't enforce this because eager relations hydrate all columns
   * regardless.
   */
  private toPublicIdentity(
    user: User | null,
  ): Pick<User, 'id' | 'username' | 'avatar'> | null {
    if (!user) return null;
    const { id, username, avatar } = user;
    return { id, username, avatar };
  }

  /**
   * In-place projection of every embedded user on a row about to be
   * returned. Every request endpoint must route its response through this
   * (or findOne) — the eager relations otherwise hydrate full accounts.
   */
  private projectEmbeddedUsers(row: FliksRequest): FliksRequest {
    row.user = this.toPublicIdentity(row.user) as User;
    row.approvedBy = this.toPublicIdentity(row.approvedBy) as User | null;
    row.comments?.forEach((c) => {
      c.user = this.toPublicIdentity(c.user) as User;
    });
    return row;
  }

  async update(
    id: number,
    dto: UpdateRequestDto,
    user: User,
  ): Promise<FliksRequest> {
    const row = await this.findOne(id, user);
    if (row.status !== RequestStatus.PENDING) {
      throw new ForbiddenException('Only pending requests can be updated');
    }
    if (!this.canManageRequests(user) && row.userId !== user.id) {
      throw new ForbiddenException();
    }
    if (dto.qualityProfileId !== undefined) {
      row.qualityProfile = dto.qualityProfileId
        ? ({ id: dto.qualityProfileId } as QualityProfile)
        : null;
    }
    if (dto.languageProfileId !== undefined) {
      row.languageProfile = dto.languageProfileId
        ? ({ id: dto.languageProfileId } as LanguageProfile)
        : null;
    }
    if (dto.libraryId !== undefined) {
      if (dto.libraryId != null) {
        await this.assertCanUseLibrary(user, dto.libraryId);
      }
      row.library = dto.libraryId ? ({ id: dto.libraryId } as Library) : null;
    }
    return this.requestRepo.save(row);
  }

  async remove(id: number, user: User): Promise<void> {
    const row = await this.findOne(id, user);
    const isManager = this.canManageRequests(user);
    if (isManager) {
      await this.requestRepo.remove(row);
      return;
    }
    if (row.status !== RequestStatus.PENDING) {
      throw new ForbiddenException('Only pending requests can be cancelled');
    }
    if (row.userId !== user.id) {
      throw new ForbiddenException();
    }
    await this.requestRepo.remove(row);
  }

  async approve(id: number, admin: User): Promise<FliksRequest> {
    if (!this.canManageRequests(admin)) throw new ForbiddenException();
    const row = await this.requestRepo.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Request #${id} not found`);
    await this.assertCanAccessRequestLibrary(admin, row.libraryId, row.userId);
    if (row.status !== RequestStatus.PENDING) {
      throw new ConflictException('Request is not pending');
    }

    // Validate up front that the title can land in a library: a new import
    // needs a resolvable target (the chosen library, or a configured default
    // for the type). Resolving it here throws a clear error — surfaced to the
    // admin as a toast — and leaves the request PENDING, instead of flipping to
    // APPROVED and then failing silently in the out-of-band import tail when no
    // default library is set. Skipped when the media already exists: that path
    // only links/monitors, no import is needed.
    const existingMedia = await this.mediaService.findByTmdbId(
      row.tmdbId,
      row.mediaType,
    );
    if (!existingMedia) {
      await this.mediaService.assertImportTarget(
        row.mediaType,
        row.libraryId ?? undefined,
      );
    }

    row.status = RequestStatus.APPROVED;
    row.approvedBy = admin;
    row.declinedReason = null;
    await this.requestRepo.save(row);

    // Import (or reuse) the media SYNCHRONOUSLY so the response carries the
    // real linked + monitored state — the client renders the correct badge
    // immediately, no SSE/refresh needed. A failure here (TMDB error, profile
    // conflict) rolls the approval back to PENDING and rethrows so the admin
    // gets the error as a toast instead of an approved-but-empty request.
    // Only the post-approval auto-grab (SearchMissing) stays asynchronous —
    // the slow release search/download must not block the response.
    let media: Media | null;
    try {
      media = await this.ensureMediaForApprovedRequest(
        {
          mediaType: row.mediaType,
          tmdbId: row.tmdbId,
          qualityProfileId: row.qualityProfileId ?? null,
          languageProfileId: row.languageProfileId ?? null,
          libraryId: row.libraryId ?? null,
          seasons: row.seasons ?? null,
        },
        row.userId ?? null,
      );
    } catch (err) {
      row.status = RequestStatus.PENDING;
      row.approvedBy = null;
      await this.requestRepo.save(row);
      throw err;
    }

    if (media) {
      // A fresh import links the request inside onMediaImported; the
      // existing-media path does not, so link here when still unlinked.
      const linked = await this.requestRepo.findOne({ where: { id } });
      if (linked && linked.status === RequestStatus.APPROVED && !linked.mediaId) {
        linked.media = media;
        await this.requestRepo.save(linked);
      }
      void this.scheduler.searchMissingForMedia([media.id]);
    }

    void this.notifications.dispatch('request.approved', { title: row.title });

    return this.findResolvedRow(id);
  }

  /**
   * Fetch a single request with its linked library media resolved by
   * (tmdbId, type) — mirrors the list query so the monitored badge is accurate
   * right after approval, without waiting on a list refresh.
   */
  private async findResolvedRow(id: number): Promise<FliksRequest> {
    const row = await this.requestRepo
      .createQueryBuilder('r')
      .leftJoin('r.user', 'user')
      .addSelect(['user.id', 'user.username', 'user.avatar'])
      .leftJoin('r.approvedBy', 'approvedBy')
      .addSelect(['approvedBy.id', 'approvedBy.username', 'approvedBy.avatar'])
      .leftJoinAndMapOne(
        'r.media',
        Media,
        'media',
        'media."tmdbId" = r."tmdbId" AND media.type::text = r."mediaType"::text',
      )
      .where('r.id = :id', { id })
      .getOne();
    if (!row) throw new NotFoundException(`Request #${id} not found`);
    return this.projectEmbeddedUsers(row);
  }

  /**
   * Idempotent "approve-side" import. Whenever a request transitions to
   * `APPROVED` (admin click, rule-based auto-approve, or profile-match
   * auto-approve), the matching Media row must exist so the auto-grab
   * pipeline has something to monitor. The first caller creates the
   * row via `importFromTmdb`; subsequent callers hit the 409 path —
   * but we only link to that existing row when its profile envelope
   * actually covers the request, otherwise we refuse: silently
   * fulfilling a VO request with an FR media (or 1080p with 720p) is
   * worse UX than asking the admin to decline or re-import.
   *
   * `addedByUserId` becomes the Media's `addedBy` only when this call
   * actually inserts the row — TypeORM's import flow ignores it for
   * the 409 fallback (the existing row keeps its original creator).
   */
  private async ensureMediaForApprovedRequest(
    spec: {
      mediaType: MediaType;
      tmdbId: number;
      qualityProfileId: number | null;
      languageProfileId: number | null;
      libraryId: number | null;
      /** Seasons the request targets, for per-season monitoring sync.
       *  `null` / empty → whole movie / whole series. */
      seasons: number[] | null;
    },
    addedByUserId: number | null,
  ): Promise<Media | null> {
    let media: Media | null;
    try {
      media = await this.mediaService.importFromTmdb(
        {
          type: spec.mediaType,
          tmdbId: spec.tmdbId,
          qualityProfileId: spec.qualityProfileId ?? undefined,
          languageProfileId: spec.languageProfileId ?? undefined,
          libraryId: spec.libraryId ?? undefined,
        },
        addedByUserId,
      );
    } catch (err: any) {
      if (err?.status !== 409) throw err;
      const existing = await this.mediaService.findByTmdbId(
        spec.tmdbId,
        spec.mediaType,
      );
      if (!existing) return null;
      const covers = await this.profilesService.envelopeCovers(
        {
          qualityProfileId: existing.qualityProfile?.id ?? null,
          languageProfileId: existing.languageProfile?.id ?? null,
        },
        {
          qualityProfileId: spec.qualityProfileId,
          languageProfileId: spec.languageProfileId,
        },
      );
      if (!covers) {
        throw new ConflictException(
          "This title is already in the library with a different profile and can't satisfy the request — decline it or update the library media's profiles.",
        );
      }
      media = existing;
    }
    if (media) {
      // Monitor the request scope so the auto-grab pipeline picks it
      // up. Idempotent — flips false → true only, never the reverse.
      await this.mediaService.applyMonitoredForRequestScope(
        media,
        spec.seasons,
      );
    }
    return media;
  }

  async decline(
    id: number,
    admin: User,
    reason?: string,
  ): Promise<FliksRequest> {
    if (!this.canManageRequests(admin)) throw new ForbiddenException();
    const row = await this.requestRepo.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Request #${id} not found`);
    await this.assertCanAccessRequestLibrary(admin, row.libraryId, row.userId);
    if (row.status !== RequestStatus.PENDING) {
      throw new ConflictException('Request is not pending');
    }
    row.status = RequestStatus.DECLINED;
    row.approvedBy = admin;
    row.declinedReason = reason ?? null;
    const saved = await this.requestRepo.save(row);
    this.projectEmbeddedUsers(saved);
    void this.notifications.dispatch('request.declined', {
      title: saved.title,
      reason: reason ?? '',
    });
    return saved;
  }

  // ---------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------

  async addComment(
    requestId: number,
    user: User,
    dto: CreateCommentDto,
  ): Promise<RequestComment> {
    const request = await this.requestRepo.findOne({
      where: { id: requestId },
    });
    if (!request)
      throw new NotFoundException(`Request #${requestId} not found`);
    if (!this.canManageRequests(user) && request.userId !== user.id) {
      throw new ForbiddenException();
    }
    await this.assertCanAccessRequestLibrary(
      user,
      request.libraryId,
      request.userId,
    );
    const comment = this.commentRepo.create({
      request,
      user,
      message: dto.message,
    });
    const saved = await this.commentRepo.save(comment);
    saved.user = this.toPublicIdentity(saved.user) as User;
    if (saved.request) this.projectEmbeddedUsers(saved.request);
    return saved;
  }

  async getComments(requestId: number, user: User): Promise<RequestComment[]> {
    const request = await this.requestRepo.findOne({
      where: { id: requestId },
    });
    if (!request)
      throw new NotFoundException(`Request #${requestId} not found`);
    if (!this.canManageRequests(user) && request.userId !== user.id) {
      throw new ForbiddenException();
    }
    await this.assertCanAccessRequestLibrary(
      user,
      request.libraryId,
      request.userId,
    );
    const comments = await this.commentRepo.find({
      where: { request: { id: requestId } },
      relations: ['user'],
      order: { createdAt: 'ASC' },
    });
    comments.forEach((c) => {
      c.user = this.toPublicIdentity(c.user) as User;
    });
    return comments;
  }

  async removeComment(commentId: number, user: User): Promise<void> {
    const comment = await this.commentRepo.findOne({
      where: { id: commentId },
      relations: ['request'],
    });
    if (!comment)
      throw new NotFoundException(`Comment #${commentId} not found`);
    if (!this.canManageRequests(user) && comment.userId !== user.id) {
      throw new ForbiddenException();
    }
    if (comment.request) {
      await this.assertCanAccessRequestLibrary(
        user,
        comment.request.libraryId,
        comment.request.userId,
      );
    }
    await this.commentRepo.remove(comment);
  }
}
