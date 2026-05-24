import {
  Injectable,
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
import { CreateRequestDto } from './dto/create-request.dto';
import { ListRequestsDto } from './dto/list-requests.dto';
import { UpdateRequestDto } from './dto/update-request.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { MediaType, RequestStatus } from '../../common/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { MediaService } from '../media/media.service';
import { Media } from '../media/entities/media.entity';
import { ProfilesService } from '../profiles/profiles.service';
import { CaslAbilityFactory } from '../auth/casl/casl-ability.factory';
import { Action } from '../auth/casl/actions.enum';

/** Request statuses that count as "this user already wants this title".
 *  Pending: awaiting decision. Approved/Processing: the system is on it.
 *  Available: already delivered. All four block a same-user re-request. */
const ACTIVE_REQUEST_STATUSES: readonly RequestStatus[] = [
  RequestStatus.PENDING,
  RequestStatus.APPROVED,
  RequestStatus.PROCESSING,
  RequestStatus.AVAILABLE,
] as const;

/** Statuses on which another user's request can satisfy a new one — the
 *  resulting media is (or will be) downloaded under those profiles. */
const SATISFIABLE_REQUEST_STATUSES: readonly RequestStatus[] = [
  RequestStatus.APPROVED,
  RequestStatus.PROCESSING,
  RequestStatus.AVAILABLE,
] as const;

interface ProfileEnvelope {
  qualityProfileId: number | null;
  languageProfileId: number | null;
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
    private readonly caslAbilityFactory: CaslAbilityFactory,
  ) {}

  /** Aligné sur PoliciesGuard / CaslAbilityFactory (manage:all → Manage sur tout). */
  private canManageRequests(user: User): boolean {
    return this.caslAbilityFactory
      .createForUser(user)
      .can(Action.Manage, FliksRequest);
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
    await this.assertNoActiveDuplicateForUser(user, dto);

    // Auto-approve when either the rule engine allows it OR another user
    // already has an active request whose profiles (and seasons, for
    // series) encompass what this user is asking for — the resulting
    // media will already satisfy the new request.
    const autoApprove =
      (await this.shouldAutoApprove(user, dto)) ||
      (await this.satisfiedByExistingApprovedRequest(user, dto));

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

    const event = autoApprove ? 'request.approved' : 'request.created';
    void this.notifications.dispatch(event, {
      title: dto.title,
      mediaType: dto.mediaType,
    });

    return saved;
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  /**
   * One active request per (user, tmdbId, mediaType). For series carrying
   * an explicit season list the rule is finer-grained: a new request is
   * allowed as long as its seasons don't overlap with any of the user's
   * active per-season requests, AND there's no whole-series request from
   * the same user blocking everything.
   */
  private async assertNoActiveDuplicateForUser(
    user: User,
    dto: CreateRequestDto,
  ): Promise<void> {
    const existing = await this.requestRepo.find({
      where: {
        user: { id: user.id },
        tmdbId: dto.tmdbId,
        mediaType: dto.mediaType,
        status: In([...ACTIVE_REQUEST_STATUSES]),
      },
    });
    if (existing.length === 0) return;

    const isSeriesWithSeasons =
      dto.mediaType === MediaType.SERIES && !!dto.seasons?.length;

    if (!isSeriesWithSeasons) {
      throw new ConflictException(
        'You have already requested this title',
      );
    }

    // Series + season list: collect taken seasons, factor in whole-series
    // requests (`seasons === null`) which cover everything.
    const taken = new Set<number>();
    for (const e of existing) {
      if (!e.seasons || e.seasons.length === 0) {
        throw new ConflictException(
          'You have already requested the whole series',
        );
      }
      for (const n of e.seasons) taken.add(n);
    }
    const overlap = dto.seasons!.filter((s) => taken.has(s));
    if (overlap.length > 0) {
      throw new ConflictException(
        `You have already requested season(s) ${overlap.join(', ')}`,
      );
    }
  }

  /**
   * Profile-aware auto-approval. When another user's request — already
   * approved, processing or available — covers the new request both in
   * profile envelope (quality + language) and (for series) season scope,
   * we approve the new one immediately: the requested media is already
   * being produced under at least as good a configuration.
   */
  private async satisfiedByExistingApprovedRequest(
    user: User,
    dto: CreateRequestDto,
  ): Promise<boolean> {
    const others = await this.requestRepo.find({
      where: {
        tmdbId: dto.tmdbId,
        mediaType: dto.mediaType,
        status: In([...SATISFIABLE_REQUEST_STATUSES]),
      },
    });
    const candidates = others.filter((r) => r.userId !== user.id);
    if (candidates.length === 0) return false;

    const requested: ProfileEnvelope = {
      qualityProfileId: dto.qualityProfileId ?? null,
      languageProfileId: dto.languageProfileId ?? null,
    };

    for (const existing of candidates) {
      if (
        !(await this.coversSeasons(existing, dto)) ||
        !(await this.envelopeCovers(existing, requested))
      ) {
        continue;
      }
      return true;
    }
    return false;
  }

  /** For series only: true when `existing` already covers every season
   *  the new request is asking for. `null`/empty seasons on `existing`
   *  means whole series → always covers. Movies skip this check. */
  private async coversSeasons(
    existing: FliksRequest,
    dto: CreateRequestDto,
  ): Promise<boolean> {
    if (dto.mediaType !== MediaType.SERIES) return true;
    if (!existing.seasons || existing.seasons.length === 0) return true;
    if (!dto.seasons || dto.seasons.length === 0) return false;
    const taken = new Set(existing.seasons);
    return dto.seasons.every((s) => taken.has(s));
  }

  /** Thin wrapper — the encompassment rule lives in ProfilesService so
   *  every caller (request auto-approval, import-time request resolution)
   *  reads from the same source of truth. */
  private envelopeCovers(
    existing: ProfileEnvelope,
    requested: ProfileEnvelope,
  ): Promise<boolean> {
    return this.profilesService.envelopeCovers(existing, requested);
  }

  async findAll(
    user: User,
    query: ListRequestsDto,
  ): Promise<{ data: FliksRequest[]; total: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const qb = this.requestRepo
      .createQueryBuilder('r')
      .leftJoinAndSelect('r.user', 'user')
      .leftJoinAndSelect('r.approvedBy', 'approvedBy')
      // Joined so the UI can display the live media title (the cached
      // `request.title` may be empty for Seerr-imported orphans).
      .leftJoinAndSelect('r.media', 'media')
      .orderBy('r.createdAt', 'DESC');

    if (!this.canManageRequests(user)) {
      qb.andWhere('r.userId = :uid', { uid: user.id });
    } else if (query.userId) {
      qb.andWhere('r.userId = :uid', { uid: query.userId });
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
    if (!this.canManageRequests(user) && row.userId !== user.id) {
      throw new ForbiddenException();
    }
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
    if (row.status !== RequestStatus.PENDING) {
      throw new ConflictException('Request is not pending');
    }

    row.status = RequestStatus.APPROVED;
    row.approvedBy = admin;
    row.declinedReason = null;

    // Attribute the new Media row to the requester (not the approving
    // admin) so the "Afficher uniquement les médias que j'ai demandé"
    // filter — which matches `addedById = me OR requests.userId = me`
    // — keeps surfacing it even if the request row is later purged.
    row.media = await this.ensureMediaForApprovedRequest(
      {
        mediaType: row.mediaType,
        tmdbId: row.tmdbId,
        qualityProfileId: row.qualityProfileId ?? null,
        languageProfileId: row.languageProfileId ?? null,
        libraryId: row.libraryId ?? null,
      },
      row.userId ?? null,
    );

    const saved = await this.requestRepo.save(row);
    void this.notifications.dispatch('request.approved', {
      title: saved.title,
    });
    return saved;
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
    },
    addedByUserId: number | null,
  ): Promise<Media | null> {
    try {
      return await this.mediaService.importFromTmdb(
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
      return existing;
    }
  }

  async decline(
    id: number,
    admin: User,
    reason?: string,
  ): Promise<FliksRequest> {
    if (!this.canManageRequests(admin)) throw new ForbiddenException();
    const row = await this.requestRepo.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Request #${id} not found`);
    if (row.status !== RequestStatus.PENDING) {
      throw new ConflictException('Request is not pending');
    }
    row.status = RequestStatus.DECLINED;
    row.approvedBy = admin;
    row.declinedReason = reason ?? null;
    const saved = await this.requestRepo.save(row);
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
    const comment = this.commentRepo.create({
      request,
      user,
      message: dto.message,
    });
    return this.commentRepo.save(comment);
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
    return this.commentRepo.find({
      where: { request: { id: requestId } },
      relations: ['user'],
      order: { createdAt: 'ASC' },
    });
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
    await this.commentRepo.remove(comment);
  }
}

