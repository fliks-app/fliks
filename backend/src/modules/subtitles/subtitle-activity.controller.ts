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
import {
  hasServableTextSub,
  IMAGE_BASED_SUBTITLE_CODECS,
} from '../../common/constants/subtitle-codecs';
import { SubtitleProviderService } from './subtitle-provider.service';
import { SubtitlesService } from './subtitles.service';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';

/**
 * Season / episode scope of a subtitle row. `SubtitleFile.episode` is only set
 * when the caller passed an episode id, so the media file's own link — the one
 * the import establishes — is the fallback.
 */
export function episodeScope(sf: SubtitleFile) {
  const episode = sf.episode ?? sf.mediaFile?.episode ?? null;
  return {
    episodeId: episode?.id ?? null,
    seasonNumber: episode?.season?.seasonNumber ?? null,
    episodeNumber: episode?.episodeNumber ?? null,
    episodeTitle: episode?.title ?? null,
  };
}

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
      .leftJoinAndSelect('sf.episode', 'episode')
      .leftJoinAndSelect('episode.season', 'season')
      .leftJoinAndSelect('sf.mediaFile', 'mediaFile')
      .leftJoinAndSelect('mediaFile.episode', 'fileEpisode')
      .leftJoinAndSelect('fileEpisode.season', 'fileSeason')
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
        ...episodeScope(sf),
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
        relations: [
          'media',
          'episode',
          'episode.season',
          'mediaFile',
          'mediaFile.episode',
          'mediaFile.episode.season',
        ],
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
        mediaId: sf.mediaId,
        mediaTitle: sf.media?.title ?? '?',
        mediaType: sf.media?.type ?? null,
        ...episodeScope(sf),
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
      const { ok, detail } = await this.providerService.testConnection(
        provider.type,
        provider.settings,
      );
      results.push({
        id: provider.id,
        name: provider.name,
        type: provider.type,
        ok,
        error: detail ?? null,
      });
    }

    return results;
  }

  /**
   * Every (file, profile language) pair with no servable text subtitle.
   *
   * One statement, paginated. It replaced a walk that hydrated the whole
   * monitored library with `files`, `seasons` and `seasons.episodes` joined in,
   * then ran one subtitle query per file — on a real library that is tens of
   * thousands of sequential round trips holding a pool connection, which is why
   * the page hung and took the rest of the server with it.
   *
   * The `NOT EXISTS` mirrors `hasServableTextSub`: an image codec never
   * satisfies a language (it is burn-in/OCR material) and a FAILED row never
   * counts. A NULL codec or status is servable, hence the COALESCE.
   */
  @Get('missing')
  @CheckPolicies((ability) => ability.can(Action.Read, SubtitleFile))
  async missing(@Query('page') page?: string, @Query('limit') limit?: string) {
    const take = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

    const rows = await this.mediaFileRepo.query(
      `
      WITH required AS (
        SELECT m.id            AS media_id,
               m.title         AS media_title,
               m.type::text    AS media_type,
               lang->>'isoCode' AS language
        FROM media m
        JOIN language_profiles lp ON lp.id = m."languageProfileId"
        CROSS JOIN LATERAL jsonb_array_elements(lp."subtitleLanguages") AS lang
        WHERE m.monitored = true
      )
      SELECT r.media_id, r.media_title, r.media_type, r.language,
             f.id AS file_id, f."relativePath", f."episodeId",
             s."seasonNumber", e."episodeNumber",
             COUNT(*) OVER () AS total
      FROM required r
      JOIN media_files f ON f."mediaId" = r.media_id
      LEFT JOIN episodes e ON e.id = f."episodeId"
      LEFT JOIN seasons  s ON s.id = e."seasonId"
      WHERE NOT EXISTS (
        SELECT 1 FROM subtitle_files sf
        WHERE sf."mediaFileId" = f.id
          AND sf.language = r.language
          AND COALESCE(sf.codec, '') <> ALL ($1::text[])
          AND COALESCE(sf.status::text, '') <> 'failed'
      )
      ORDER BY r.media_title, f.id, r.language
      LIMIT $2 OFFSET $3
      `,
      [[...IMAGE_BASED_SUBTITLE_CODECS], take, skip],
    );

    return {
      total: Number(rows[0]?.total ?? 0),
      data: (rows as Record<string, string | number | null>[]).map((r) => ({
        mediaId: Number(r.media_id),
        mediaTitle: String(r.media_title),
        mediaType: String(r.media_type),
        fileId: Number(r.file_id),
        fileName: String(r.relativePath).split('/').pop() ?? String(r.relativePath),
        episodeId: r.episodeId == null ? null : Number(r.episodeId),
        episodeLabel:
          r.seasonNumber == null || r.episodeNumber == null
            ? null
            : `S${String(r.seasonNumber).padStart(2, '0')}E${String(r.episodeNumber).padStart(2, '0')}`,
        language: String(r.language),
      })),
    };
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
