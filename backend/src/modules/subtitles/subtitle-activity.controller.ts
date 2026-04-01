import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SubtitleFile } from './entities/subtitle-file.entity';
import { SubtitleProviderService } from './subtitle-provider.service';
import { SubtitleProviderFactory } from './providers/subtitle-provider.factory';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';

@Controller('subtitles')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class SubtitleActivityController {
  constructor(
    @InjectRepository(SubtitleFile)
    private readonly subtitleFileRepo: Repository<SubtitleFile>,
    private readonly providerService: SubtitleProviderService,
    private readonly factory: SubtitleProviderFactory,
  ) {}

  @Get('history')
  @CheckPolicies((ability) => ability.can(Action.Read, SubtitleFile))
  async history(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('language') language?: string,
    @Query('providerType') providerType?: string,
  ) {
    const p = Math.max(1, Number(page) || 1);
    const l = Math.min(100, Math.max(1, Number(limit) || 25));

    const qb = this.subtitleFileRepo
      .createQueryBuilder('sf')
      .leftJoinAndSelect('sf.media', 'media')
      .orderBy('sf.createdAt', 'DESC');

    if (status) qb.andWhere('sf.status = :status', { status });
    if (language) qb.andWhere('sf.language = :language', { language });
    if (providerType)
      qb.andWhere('sf.providerType = :providerType', { providerType });

    const [data, total] = await qb
      .skip((p - 1) * l)
      .take(l)
      .getManyAndCount();

    return {
      data: data.map((sf) => ({
        id: sf.id,
        mediaId: sf.mediaId,
        mediaTitle: sf.media?.title ?? '?',
        language: sf.language,
        providerType: sf.providerType,
        score: sf.score,
        status: sf.status,
        forced: sf.forced,
        hearingImpaired: sf.hearingImpaired,
        synced: sf.synced,
        createdAt: sf.createdAt,
      })),
      total,
      page: p,
      limit: l,
    };
  }

  @Get('stats')
  @CheckPolicies((ability) => ability.can(Action.Read, SubtitleFile))
  async stats() {
    const [totalSubs, byStatus, byProvider, recent] = await Promise.all([
      this.subtitleFileRepo.count(),
      this.subtitleFileRepo
        .createQueryBuilder('sf')
        .select('sf.status', 'status')
        .addSelect('COUNT(*)::int', 'count')
        .groupBy('sf.status')
        .getRawMany(),
      this.subtitleFileRepo
        .createQueryBuilder('sf')
        .select('sf.providerType', 'providerType')
        .addSelect('COUNT(*)::int', 'count')
        .groupBy('sf.providerType')
        .getRawMany(),
      this.subtitleFileRepo.find({
        relations: ['media'],
        order: { createdAt: 'DESC' },
        take: 10,
      }),
    ]);

    return {
      total: totalSubs,
      byStatus: Object.fromEntries(
        byStatus.map((r: any) => [r.status, r.count]),
      ),
      byProvider: Object.fromEntries(
        byProvider.map((r: any) => [r.providerType, r.count]),
      ),
      recent: recent.map((sf) => ({
        id: sf.id,
        mediaTitle: sf.media?.title ?? '?',
        language: sf.language,
        providerType: sf.providerType,
        score: sf.score,
        status: sf.status,
        createdAt: sf.createdAt,
      })),
    };
  }

  @Get('health')
  @CheckPolicies((ability) => ability.can(Action.Read, SubtitleFile))
  async health() {
    const providers = await this.providerService.findEnabled();
    const results = [];

    for (const provider of providers) {
      try {
        const impl = this.factory.create(provider.type, provider.settings);
        const ok = await impl.testConnection(provider.settings);
        results.push({
          id: provider.id,
          name: provider.name,
          type: provider.type,
          ok,
          error: null,
        });
      } catch (err) {
        results.push({
          id: provider.id,
          name: provider.name,
          type: provider.type,
          ok: false,
          error: String(err),
        });
      }
    }

    return results;
  }
}
