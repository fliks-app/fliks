import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { SuitarrRequest } from './entities/request.entity';
import { RequestComment } from './entities/request-comment.entity';
import {
  AutoApprovalRule,
  AutoApprovalCondition,
} from './entities/auto-approval-rule.entity';
import { User } from '../users/entities/user.entity';
import { CreateRequestDto } from './dto/create-request.dto';
import { ListRequestsDto } from './dto/list-requests.dto';
import { UpdateRequestDto } from './dto/update-request.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { MediaType, RequestStatus } from '../../common/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { MediaService } from '../media/media.service';

@Injectable()
export class RequestsService {
  constructor(
    @InjectRepository(SuitarrRequest)
    private readonly requestRepo: Repository<SuitarrRequest>,
    @InjectRepository(RequestComment)
    private readonly commentRepo: Repository<RequestComment>,
    @InjectRepository(AutoApprovalRule)
    private readonly ruleRepo: Repository<AutoApprovalRule>,
    private readonly notifications: NotificationsService,
    private readonly mediaService: MediaService,
  ) {}

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

  async create(user: User, dto: CreateRequestDto): Promise<SuitarrRequest> {
    await this.checkQuota(user, dto.mediaType);

    const dup = await this.requestRepo.findOne({
      where: {
        userId: user.id,
        tmdbId: dto.tmdbId,
        mediaType: dto.mediaType,
        status: RequestStatus.PENDING,
      },
    });
    if (dup) {
      throw new ConflictException(
        'A pending request already exists for this title',
      );
    }

    const autoApprove = await this.shouldAutoApprove(user, dto);

    const partial: DeepPartial<SuitarrRequest> = {
      userId: user.id,
      mediaType: dto.mediaType,
      tmdbId: dto.tmdbId,
      title: dto.title,
      seasons: dto.seasons ?? null,
      qualityProfileId: dto.qualityProfileId ?? null,
      languageProfileId: dto.languageProfileId ?? null,
      rootFolder: dto.rootFolder ?? null,
      status: autoApprove ? RequestStatus.APPROVED : RequestStatus.PENDING,
      approvedById: autoApprove ? user.id : null,
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

  async findAll(
    user: User,
    query: ListRequestsDto,
  ): Promise<{ data: SuitarrRequest[]; total: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const qb = this.requestRepo
      .createQueryBuilder('r')
      .leftJoinAndSelect('r.user', 'user')
      .leftJoinAndSelect('r.approvedBy', 'approvedBy')
      .orderBy('r.createdAt', 'DESC');

    if (!user.permissions.includes('requests.manage')) {
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

  async findOne(id: number, user: User): Promise<SuitarrRequest> {
    const row = await this.requestRepo.findOne({
      where: { id },
      relations: ['user', 'approvedBy', 'comments', 'comments.user'],
    });
    if (!row) throw new NotFoundException(`Request #${id} not found`);
    if (!user.permissions.includes('requests.manage') && row.userId !== user.id) {
      throw new ForbiddenException();
    }
    return row;
  }

  async update(
    id: number,
    dto: UpdateRequestDto,
    user: User,
  ): Promise<SuitarrRequest> {
    const row = await this.findOne(id, user);
    if (row.status !== RequestStatus.PENDING) {
      throw new ForbiddenException('Only pending requests can be updated');
    }
    if (!user.permissions.includes('requests.manage') && row.userId !== user.id) {
      throw new ForbiddenException();
    }
    if (dto.qualityProfileId !== undefined) row.qualityProfileId = dto.qualityProfileId;
    if (dto.languageProfileId !== undefined) row.languageProfileId = dto.languageProfileId;
    if (dto.rootFolder !== undefined) row.rootFolder = dto.rootFolder;
    return this.requestRepo.save(row);
  }

  async remove(id: number, user: User): Promise<void> {
    const row = await this.findOne(id, user);
    const isManager = user.permissions.includes('requests.manage');
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

  async approve(id: number, admin: User): Promise<SuitarrRequest> {
    if (!admin.permissions.includes('requests.manage')) throw new ForbiddenException();
    const row = await this.requestRepo.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Request #${id} not found`);
    if (row.status !== RequestStatus.PENDING) {
      throw new ConflictException('Request is not pending');
    }

    row.status = RequestStatus.APPROVED;
    row.approvedById = admin.id;
    row.declinedReason = null;

    // Import the media into the library
    try {
      const media = await this.mediaService.importFromTmdb({
        type: row.mediaType,
        tmdbId: row.tmdbId,
        qualityProfileId: row.qualityProfileId ?? undefined,
        languageProfileId: row.languageProfileId ?? undefined,
        rootFolderId: undefined,
      });
      row.mediaId = media.id;
    } catch (err) {
      // If already in library, resolve the existing media ID
      if ((err as any)?.status === 409) {
        const existing = await this.mediaService.findByTmdbId(
          row.tmdbId,
          row.mediaType,
        );
        if (existing) row.mediaId = existing.id;
      }
    }

    const saved = await this.requestRepo.save(row);
    void this.notifications.dispatch('request.approved', {
      title: saved.title,
    });
    return saved;
  }

  async decline(
    id: number,
    admin: User,
    reason?: string,
  ): Promise<SuitarrRequest> {
    if (!admin.permissions.includes('requests.manage')) throw new ForbiddenException();
    const row = await this.requestRepo.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Request #${id} not found`);
    if (row.status !== RequestStatus.PENDING) {
      throw new ConflictException('Request is not pending');
    }
    row.status = RequestStatus.DECLINED;
    row.approvedById = admin.id;
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
    if (!user.permissions.includes('requests.manage') && request.userId !== user.id) {
      throw new ForbiddenException();
    }
    const comment = this.commentRepo.create({
      requestId,
      userId: user.id,
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
    if (!user.permissions.includes('requests.manage') && request.userId !== user.id) {
      throw new ForbiddenException();
    }
    return this.commentRepo.find({
      where: { requestId },
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
    if (!user.permissions.includes('requests.manage') && comment.userId !== user.id) {
      throw new ForbiddenException();
    }
    await this.commentRepo.remove(comment);
  }
}
