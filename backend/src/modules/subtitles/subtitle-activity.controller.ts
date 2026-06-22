import {
  Controller,
  Get,
  Post,
  Delete,
  Query,
  Param,
  Body,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { SubtitleFile } from './entities/subtitle-file.entity';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { SubtitleProviderType } from '../../common/enums/subtitle-provider-type.enum';
import { hasServableTextSub } from '../../common/constants/subtitle-codecs';
import { SubtitleProviderService } from './subtitle-provider.service';
import { SubtitleProviderFactory } from './providers/subtitle-provider.factory';
import { SubtitlesService } from './subtitles.service';
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
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    private readonly providerService: SubtitleProviderService,
    private readonly factory: SubtitleProviderFactory,
    private readonly subtitlesService: SubtitlesService,
  ) {}

  @Get('history')
  @CheckPolicies((ability) => ability.can(Action.Read, SubtitleFile))
  async history(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('language') language?: string,
    @Query('providerType') providerType?: string,
    @Query('excludeEmbedded') excludeEmbedded?: string,
  ) {
    const p = Math.max(1, Number(page) || 1);
    const l = Math.min(100, Math.max(1, Number(limit) || 25));

    const qb = this.subtitleFileRepo
      .createQueryBuilder('sf')
      .leftJoinAndSelect('sf.media', 'media')
      .orderBy('sf.createdAt', 'DESC');

    if (excludeEmbedded === 'true') {
      qb.andWhere('sf.providerType != :emb', {
        emb: SubtitleProviderType.EMBEDDED,
      });
    }
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
        mediaType: sf.media?.type ?? null,
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
    const notEmbedded = { providerType: Not(SubtitleProviderType.EMBEDDED) };
    const [totalSubs, byStatus, byProvider, recent] = await Promise.all([
      this.subtitleFileRepo.count({ where: notEmbedded }),
      this.subtitleFileRepo
        .createQueryBuilder('sf')
        .select('sf.status', 'status')
        .addSelect('COUNT(*)::int', 'count')
        .where('sf.providerType != :emb', {
          emb: SubtitleProviderType.EMBEDDED,
        })
        .groupBy('sf.status')
        .getRawMany(),
      this.subtitleFileRepo
        .createQueryBuilder('sf')
        .select('sf.providerType', 'providerType')
        .addSelect('COUNT(*)::int', 'count')
        .where('sf.providerType != :emb', {
          emb: SubtitleProviderType.EMBEDDED,
        })
        .groupBy('sf.providerType')
        .getRawMany(),
      this.subtitleFileRepo.find({
        where: notEmbedded,
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

  @Get('missing')
  @CheckPolicies((ability) => ability.can(Action.Read, SubtitleFile))
  async missing() {
    const mediaList = await this.mediaRepo.find({
      where: { monitored: true },
      relations: ['languageProfile', 'files', 'seasons', 'seasons.episodes'],
    });

    const results: {
      mediaId: number;
      mediaTitle: string;
      mediaType: string;
      fileId: number;
      fileName: string;
      episodeId: number | null;
      episodeLabel: string | null;
      language: string;
    }[] = [];

    for (const media of mediaList) {
      const subtitleLangs = media.languageProfile?.subtitleLanguages ?? [];
      if (!subtitleLangs.length || !media.files?.length) continue;

      for (const file of media.files) {
        const existingSubs = await this.subtitleFileRepo.find({
          where: { mediaFile: { id: file.id } },
        });

        for (const lang of subtitleLangs) {
          // Image-based tracks don't satisfy a language — they still need OCR
          // to become servable text, so the language stays "missing" until then.
          if (hasServableTextSub(existingSubs, lang.isoCode)) continue;

          // Build episode label
          let episodeLabel: string | null = null;
          if (file.episodeId) {
            for (const season of media.seasons ?? []) {
              const ep = season.episodes?.find((e) => e.id === file.episodeId);
              if (ep) {
                episodeLabel = `S${String(season.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}`;
                break;
              }
            }
          }

          results.push({
            mediaId: media.id,
            mediaTitle: media.title,
            mediaType: media.type,
            fileId: file.id,
            fileName: file.relativePath.split('/').pop() ?? file.relativePath,
            episodeId: file.episodeId ?? null,
            episodeLabel,
            language: lang.isoCode,
          });
        }
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Subtitle blacklist
  // ---------------------------------------------------------------------------

  @Get('blacklist')
  @CheckPolicies((ability) => ability.can(Action.Read, SubtitleFile))
  getBlacklist(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.subtitlesService.getBlacklist(
      Number(page) || 1,
      Number(limit) || 25,
    );
  }

  @Post('blacklist')
  @CheckPolicies((ability) => ability.can(Action.Create, SubtitleFile))
  addToBlacklist(
    @Body()
    dto: {
      providerType: string;
      providerFileId: string;
      mediaId?: number;
      language?: string;
      sourceTitle?: string;
      reason?: string;
    },
  ) {
    return this.subtitlesService.blacklistSubtitle(dto);
  }

  @Delete('blacklist/:id')
  @CheckPolicies((ability) => ability.can(Action.Delete, SubtitleFile))
  removeFromBlacklist(@Param('id', ParseIntPipe) id: number) {
    return this.subtitlesService.removeFromBlacklist(id);
  }

  @Delete('blacklist')
  @CheckPolicies((ability) => ability.can(Action.Delete, SubtitleFile))
  clearBlacklist() {
    return this.subtitlesService.clearBlacklist();
  }
}
