import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SubtitleFile } from './entities/subtitle-file.entity';
import { SubtitleProviderStat } from './entities/subtitle-provider-stat.entity';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { SubtitleProviderService } from './subtitle-provider.service';
import { SubtitleProviderFactory } from './providers/subtitle-provider.factory';
import {
  SubtitleSearchParams,
  SubtitleSearchResult,
} from './providers/subtitle-provider.interface';
import { SubtitleProviderType, SubtitleStatus } from '../../common/enums';
import { SubtitleBlacklist } from './entities/subtitle-blacklist.entity';
import { computeMovieHash } from './moviehash';
import { cleanSubtitle } from './subtitle-cleaner';
import * as postProcess from './subtitle-post-processor';
import { SettingsService } from '../settings/settings.service';
import { resolveSubtitleAbsolutePath } from './subtitle-path.util';

@Injectable()
export class SubtitlesService {
  private readonly logger = new Logger(SubtitlesService.name);

  constructor(
    @InjectRepository(SubtitleFile)
    private readonly repo: Repository<SubtitleFile>,
    @InjectRepository(SubtitleProviderStat)
    private readonly statRepo: Repository<SubtitleProviderStat>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    @InjectRepository(SubtitleBlacklist)
    private readonly blacklistRepo: Repository<SubtitleBlacklist>,
    private readonly providerService: SubtitleProviderService,
    private readonly factory: SubtitleProviderFactory,
    private readonly settingsService: SettingsService,
  ) {}

  async searchSubtitles(
    params: SubtitleSearchParams,
  ): Promise<SubtitleSearchResult[]> {
    // Compute moviehash if filePath is provided and hash not yet set
    if (params.filePath && !params.moviehash) {
      const hashResult = computeMovieHash(params.filePath);
      if (hashResult) {
        params.moviehash = hashResult.hash;
        params.moviebytesize = hashResult.bytesize;
        this.logger.log(
          `Computed moviehash=${hashResult.hash} for ${params.filePath}`,
        );
      }
    }

    const providers = await this.providerService.findEnabled();
    const allResults: SubtitleSearchResult[] = [];

    for (const provider of providers) {
      const start = Date.now();
      try {
        const impl = this.factory.create(provider.type, provider.settings);
        const results = await impl.search(params);
        void this.statRepo.save(
          this.statRepo.create({
            providerId: provider.id,
            queryType: 'search',
            responseTimeMs: Date.now() - start,
            resultCount: results.length,
            errorMessage: null,
          }),
        );
        allResults.push(...results);
      } catch (err) {
        void this.statRepo.save(
          this.statRepo.create({
            providerId: provider.id,
            queryType: 'search',
            responseTimeMs: Date.now() - start,
            resultCount: 0,
            errorMessage: (err as Error).message,
          }),
        );
        this.logger.warn(`Search failed for provider ${provider.name}: ${err}`);
      }
    }

    this.logger.log(
      `Subtitle search for "${params.title}" [${params.language}]: ${allResults.length} result(s) from ${providers.length} provider(s)`,
    );

    // Filter out blacklisted subtitles
    const blacklisted = await this.blacklistRepo.find();
    const blacklistSet = new Set(
      blacklisted.map((b) => `${b.providerType}:${b.providerFileId}`),
    );
    const filtered = allResults.filter(
      (r) => !blacklistSet.has(`${r.providerType}:${r.providerFileId}`),
    );

    filtered.sort((a, b) => b.score - a.score);
    return filtered;
  }

  async autoDownload(
    mediaId: number,
    mediaFileId: number,
    episodeId: number | undefined,
    params: SubtitleSearchParams,
  ): Promise<SubtitleFile | null> {
    const results = await this.searchSubtitles(params);
    if (!results.length) {
      this.logger.log(
        `Auto subtitle: no results for "${params.title}" (${params.language})`,
      );
      return null;
    }
    const best = results[0];
    this.logger.log(
      `Auto subtitle: picking "${best.title}" (score=${best.score}, provider=${best.providerType})`,
    );
    return this.downloadSubtitle(mediaId, mediaFileId, episodeId, best);
  }

  async downloadSubtitle(
    mediaId: number,
    mediaFileId: number,
    episodeId: number | undefined,
    searchResult: SubtitleSearchResult,
  ): Promise<SubtitleFile> {
    const providers = await this.providerService.findEnabled();
    const provider = providers.find(
      (p) => String(p.type) === searchResult.providerType,
    );
    if (!provider) throw new NotFoundException('No matching provider found');

    // Resolve the absolute path of the media file
    const absolutePath = await this.resolveMediaFilePath(mediaId, mediaFileId);

    this.logger.log(
      `Downloading subtitle "${searchResult.title}" via ${provider.name} (${provider.type})`,
    );
    const impl = this.factory.create(provider.type, provider.settings);
    const dlStart = Date.now();
    let buffer: Buffer;
    try {
      buffer = await impl.download(searchResult);
      void this.statRepo.save(
        this.statRepo.create({
          providerId: provider.id,
          queryType: 'download',
          responseTimeMs: Date.now() - dlStart,
          resultCount: 1,
          errorMessage: null,
        }),
      );
    } catch (err) {
      void this.statRepo.save(
        this.statRepo.create({
          providerId: provider.id,
          queryType: 'download',
          responseTimeMs: Date.now() - dlStart,
          resultCount: 0,
          errorMessage: (err as Error).message,
        }),
      );
      throw new BadRequestException(
        `Download failed (${provider.name}): ${(err as Error).message}`,
      );
    }

    const langSuffix = searchResult.forced
      ? `${searchResult.language}.forced`
      : searchResult.hearingImpaired
        ? `${searchResult.language}.hi`
        : searchResult.language;

    const parsed = path.parse(absolutePath);
    let subtitlePath = path.join(
      parsed.dir,
      `${parsed.name}.${langSuffix}.srt`,
    );

    // Avoid overwriting existing subtitle files — append -1, -2, etc.
    let counter = 0;
    while (
      await fs.access(subtitlePath).then(
        () => true,
        () => false,
      )
    ) {
      counter++;
      subtitlePath = path.join(
        parsed.dir,
        `${parsed.name}.${langSuffix}-${counter}.srt`,
      );
    }

    // Clean subtitle content (remove ads, optionally HI tags)
    const removeHiTags =
      (await this.settingsService.get('subtitle_remove_hi_tags')) === 'true';
    const customExclusions = (
      (await this.settingsService.get('subtitle_custom_exclusions')) ?? ''
    )
      .split('\n')
      .filter((l) => l.trim());
    buffer = cleanSubtitle(buffer, {
      removeAds: true,
      removeHiTags,
      customExclusions,
    });

    await fs.mkdir(parsed.dir, { recursive: true });
    await fs.writeFile(subtitlePath, buffer);
    this.logger.log(`Subtitle saved: ${subtitlePath}`);

    const media = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: ['rootFolder'],
    });
    if (!media?.path) {
      throw new BadRequestException(
        'Assign a root folder to this media before downloading subtitles',
      );
    }
    const relativePath = path.relative(media.path, subtitlePath);
    if (
      !relativePath ||
      relativePath.startsWith('..' + path.sep) ||
      relativePath === '..'
    ) {
      throw new BadRequestException(
        'Subtitle file would be outside the media folder; check root folder configuration',
      );
    }

    const subtitleFile = this.repo.create({
      mediaId,
      episodeId,
      mediaFileId,
      language: searchResult.language,
      forced: searchResult.forced,
      hearingImpaired: searchResult.hearingImpaired,
      providerType: provider.type,
      providerFileId: searchResult.providerFileId,
      relativePath,
      status: SubtitleStatus.DOWNLOADED,
      score: searchResult.score,
      synced: false,
    });

    return this.repo.save(subtitleFile);
  }

  /**
   * Resolves the absolute filesystem path of a media file
   * by joining media.path (root folder) with mediaFile.relativePath.
   */
  private async resolveMediaFilePath(
    mediaId: number,
    mediaFileId: number,
  ): Promise<string> {
    const media = await this.mediaRepo.findOne({ where: { id: mediaId } });
    if (!media) {
      throw new NotFoundException(`Media #${mediaId} not found`);
    }
    if (!media.path) {
      throw new BadRequestException(
        'Assign a root folder to this media before downloading subtitles',
      );
    }
    const mediaFile = await this.mediaFileRepo.findOne({
      where: { id: mediaFileId },
    });
    if (!mediaFile) {
      throw new NotFoundException(`MediaFile #${mediaFileId} not found`);
    }
    return path.join(media.path, mediaFile.relativePath);
  }

  private async resolveSubtitleAbsolute(
    sub: Pick<SubtitleFile, 'mediaId' | 'relativePath'>,
  ): Promise<string | null> {
    const media = await this.mediaRepo.findOne({
      where: { id: sub.mediaId },
      relations: ['rootFolder'],
    });
    return resolveSubtitleAbsolutePath(media?.path ?? null, sub.relativePath);
  }

  async getSubtitlesForMedia(mediaId: number): Promise<SubtitleFile[]> {
    return this.repo.find({
      where: { mediaId },
      order: { language: 'ASC', score: 'DESC' },
    });
  }

  async getSubtitlesForMediaFile(mediaFileId: number): Promise<SubtitleFile[]> {
    return this.repo.find({
      where: { mediaFileId },
      order: { language: 'ASC', score: 'DESC' },
    });
  }

  async deleteSubtitle(id: number): Promise<void> {
    const subtitle = await this.repo.findOne({ where: { id } });
    if (!subtitle) throw new NotFoundException(`SubtitleFile #${id} not found`);
    if (subtitle.providerType === SubtitleProviderType.EMBEDDED) {
      throw new BadRequestException('Cannot delete an embedded subtitle');
    }

    const abs = await this.resolveSubtitleAbsolute(subtitle);
    if (abs) {
      try {
        await fs.unlink(abs);
      } catch {
        this.logger.warn(`Could not delete file: ${abs}`);
      }
    }

    await this.repo.remove(subtitle);
  }

  async upgradeSubtitle(
    id: number,
    newResult: SubtitleSearchResult,
  ): Promise<SubtitleFile> {
    const existing = await this.repo.findOne({ where: { id } });
    if (!existing) throw new NotFoundException(`SubtitleFile #${id} not found`);
    if (existing.providerType === SubtitleProviderType.EMBEDDED) {
      throw new BadRequestException('Cannot upgrade an embedded subtitle');
    }

    const oldAbs = await this.resolveSubtitleAbsolute(existing);
    if (oldAbs) {
      try {
        await fs.unlink(oldAbs);
      } catch {
        this.logger.warn(`Could not delete old file: ${oldAbs}`);
      }
    }

    const updated = await this.downloadSubtitle(
      existing.mediaId,
      existing.mediaFileId,
      existing.episodeId,
      newResult,
    );
    updated.status = SubtitleStatus.UPGRADED;
    await this.repo.save(updated);

    await this.repo.remove(existing);
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Subtitle blacklist
  // ---------------------------------------------------------------------------

  async blacklistSubtitle(dto: {
    providerType: string;
    providerFileId: string;
    mediaId?: number;
    language?: string;
    sourceTitle?: string;
    reason?: string;
  }): Promise<SubtitleBlacklist> {
    const entry = this.blacklistRepo.create(dto);
    return this.blacklistRepo.save(entry);
  }

  async getBlacklist(
    page = 1,
    limit = 25,
  ): Promise<{ data: SubtitleBlacklist[]; total: number }> {
    const [data, total] = await this.blacklistRepo.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total };
  }

  async removeFromBlacklist(id: number): Promise<void> {
    const entry = await this.blacklistRepo.findOne({ where: { id } });
    if (!entry) throw new NotFoundException(`Blacklist entry #${id} not found`);
    await this.blacklistRepo.remove(entry);
  }

  async clearBlacklist(): Promise<{ deleted: number }> {
    const result = await this.blacklistRepo.delete({});
    return { deleted: result.affected ?? 0 };
  }

  // ---------------------------------------------------------------------------
  // Post-processing actions
  // ---------------------------------------------------------------------------

  async applyPostProcessing(
    subtitleId: number,
    action: string,
    params?: Record<string, unknown>,
  ): Promise<SubtitleFile> {
    const sub = await this.repo.findOne({ where: { id: subtitleId } });
    if (!sub)
      throw new NotFoundException(`SubtitleFile #${subtitleId} not found`);
    if (!sub.relativePath)
      throw new BadRequestException('Subtitle has no file path');

    const abs = await this.resolveSubtitleAbsolute(sub);
    if (!abs)
      throw new NotFoundException('Subtitle file path could not be resolved');

    const paramsStr = params ? JSON.stringify(params) : '';
    this.logger.log(
      `PostProcess #${subtitleId}: ${action}${paramsStr ? ` ${paramsStr}` : ''} on "${sub.relativePath}" → ${abs}`,
    );

    let content = await fs.readFile(abs, 'utf-8');
    const sizeBefore = content.length;

    switch (action) {
      case 'removeHiTags': {
        const buf = cleanSubtitle(Buffer.from(content, 'utf-8'), {
          removeAds: false,
          removeHiTags: true,
        });
        content = buf.toString('utf-8');
        break;
      }
      case 'removeStyleTags':
        content = postProcess.removeStyleTags(content);
        break;
      case 'removeEmoji':
        content = postProcess.removeEmoji(content);
        break;
      case 'ocrFixes':
        content = postProcess.fixOcr(content);
        break;
      case 'commonFixes':
        content = postProcess.commonFixes(content);
        break;
      case 'fixUppercase':
        content = postProcess.fixUppercase(content);
        break;
      case 'reverseRtl':
        content = postProcess.reverseRtl(content);
        break;
      case 'adjustTimes':
        content = postProcess.adjustTimes(
          content,
          Number(params?.offsetMs ?? 0),
        );
        break;
      case 'changeFrameRate':
        content = postProcess.changeFrameRate(
          content,
          Number(params?.fromFps ?? 23.976),
          Number(params?.toFps ?? 25),
        );
        break;
      case 'convertToSrt':
        content = postProcess.assToSrt(content);
        break;
      default:
        throw new BadRequestException(
          `Unknown post-processing action: ${action}`,
        );
    }

    await fs.writeFile(abs, content, 'utf-8');
    sub.locked = true;
    await this.repo.save(sub);
    // Log a sample of the first timestamp to verify the change
    const sampleMatch = content.match(/\d{2}:\d{2}:\d{2},\d{3}/);
    this.logger.log(
      `PostProcess #${subtitleId}: ${action} done (${sizeBefore} → ${content.length} chars, first timestamp: ${sampleMatch?.[0] ?? 'none'})`,
    );
    return sub;
  }
}
