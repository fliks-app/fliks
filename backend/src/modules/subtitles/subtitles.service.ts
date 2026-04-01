import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SubtitleFile } from './entities/subtitle-file.entity';
import { SubtitleProviderService } from './subtitle-provider.service';
import { SubtitleProviderFactory } from './providers/subtitle-provider.factory';
import {
  SubtitleSearchParams,
  SubtitleSearchResult,
} from './providers/subtitle-provider.interface';
import { SubtitleStatus } from '../../common/enums';

@Injectable()
export class SubtitlesService {
  private readonly logger = new Logger(SubtitlesService.name);

  constructor(
    @InjectRepository(SubtitleFile)
    private readonly repo: Repository<SubtitleFile>,
    private readonly providerService: SubtitleProviderService,
    private readonly factory: SubtitleProviderFactory,
  ) {}

  async searchSubtitles(
    params: SubtitleSearchParams,
  ): Promise<SubtitleSearchResult[]> {
    const providers = await this.providerService.findEnabled();
    const allResults: SubtitleSearchResult[] = [];

    for (const provider of providers) {
      try {
        const impl = this.factory.create(provider.type, provider.settings);
        const results = await impl.search(params);
        allResults.push(...results);
      } catch (err) {
        this.logger.warn(`Search failed for provider ${provider.name}: ${err}`);
      }
    }

    allResults.sort((a, b) => b.score - a.score);
    return allResults;
  }

  async downloadSubtitle(
    mediaId: number,
    mediaFileId: number,
    episodeId: number | undefined,
    searchResult: SubtitleSearchResult,
    mediaFilePath: string,
  ): Promise<SubtitleFile> {
    const providers = await this.providerService.findEnabled();
    const provider = providers.find(
      (p) => p.type === searchResult.providerType,
    );
    if (!provider) throw new NotFoundException('No matching provider found');

    const impl = this.factory.create(provider.type, provider.settings);
    const buffer = await impl.download(searchResult);

    const langSuffix = searchResult.forced
      ? `${searchResult.language}.forced`
      : searchResult.hearingImpaired
        ? `${searchResult.language}.hi`
        : searchResult.language;

    const parsed = path.parse(mediaFilePath);
    const subtitlePath = path.join(
      parsed.dir,
      `${parsed.name}.${langSuffix}.srt`,
    );

    await fs.writeFile(subtitlePath, buffer);

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

    try {
      await fs.unlink(subtitle.filePath);
    } catch {
      this.logger.warn(`Could not delete file: ${subtitle.filePath}`);
    }

    await this.repo.remove(subtitle);
  }

  async upgradeSubtitle(
    id: number,
    newResult: SubtitleSearchResult,
    mediaFilePath: string,
  ): Promise<SubtitleFile> {
    const existing = await this.repo.findOne({ where: { id } });
    if (!existing) throw new NotFoundException(`SubtitleFile #${id} not found`);

    try {
      await fs.unlink(existing.filePath);
    } catch {
      this.logger.warn(`Could not delete old file: ${existing.filePath}`);
    }

    const updated = await this.downloadSubtitle(
      existing.mediaId,
      existing.mediaFileId,
      existing.episodeId,
      newResult,
      mediaFilePath,
    );
    updated.status = SubtitleStatus.UPGRADED;
    await this.repo.save(updated);

    await this.repo.remove(existing);
    return updated;
  }
}
