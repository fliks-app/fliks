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
    private readonly providerService: SubtitleProviderService,
    private readonly factory: SubtitleProviderFactory,
  ) {}

  async searchSubtitles(
    params: SubtitleSearchParams,
  ): Promise<SubtitleSearchResult[]> {
    const providers = await this.providerService.findEnabled();
    const allResults: SubtitleSearchResult[] = [];

    for (const provider of providers) {
      const start = Date.now();
      try {
        this.logger.log(
          `Searching subtitles via ${provider.name} (${provider.type})…`,
        );
        const impl = this.factory.create(provider.type, provider.settings);
        const results = await impl.search(params);
        this.logger.log(`${provider.name}: ${results.length} result(s)`);
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

    allResults.sort((a, b) => b.score - a.score);
    return allResults;
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
      (p) => p.type === searchResult.providerType,
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
      throw err;
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

    await fs.mkdir(parsed.dir, { recursive: true });
    await fs.writeFile(subtitlePath, buffer);
    this.logger.log(`Subtitle saved: ${subtitlePath}`);

    const subtitleFile = this.repo.create({
      mediaId,
      episodeId,
      mediaFileId,
      language: searchResult.language,
      forced: searchResult.forced,
      hearingImpaired: searchResult.hearingImpaired,
      providerType: provider.type,
      providerFileId: searchResult.providerFileId,
      filePath: subtitlePath,
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

    if (subtitle.filePath) {
      try {
        await fs.unlink(subtitle.filePath);
      } catch {
        this.logger.warn(`Could not delete file: ${subtitle.filePath}`);
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

    if (existing.filePath) {
      try {
        await fs.unlink(existing.filePath);
      } catch {
        this.logger.warn(`Could not delete old file: ${existing.filePath}`);
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
}
