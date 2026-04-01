import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SubtitleFile } from './entities/subtitle-file.entity';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { SubtitleProviderType, SubtitleStatus } from '../../common/enums';

const execFileAsync = promisify(execFile);

@Injectable()
export class SubtitleSyncService {
  private readonly logger = new Logger(SubtitleSyncService.name);

  constructor(
    @InjectRepository(SubtitleFile)
    private readonly repo: Repository<SubtitleFile>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
  ) {}

  async syncSubtitle(id: number): Promise<SubtitleFile> {
    const subtitle = await this.repo.findOne({ where: { id } });
    if (!subtitle) throw new NotFoundException(`SubtitleFile #${id} not found`);
    if (subtitle.providerType === SubtitleProviderType.EMBEDDED) {
      throw new BadRequestException('Cannot sync an embedded subtitle');
    }

    const mediaFilePath = await this.resolveMediaFilePath(
      subtitle.mediaId,
      subtitle.mediaFileId,
    );

    const subPath = subtitle.filePath!;
    try {
      await execFileAsync('ffsubsync', [
        mediaFilePath,
        '-i',
        subPath,
        '-o',
        subPath,
      ]);
      subtitle.synced = true;
      subtitle.status = SubtitleStatus.SYNCED;
    } catch (err) {
      this.logger.warn(`ffsubsync failed for ${subPath}, trying alass...`);
      try {
        await execFileAsync('alass', [mediaFilePath, subPath, subPath]);
        subtitle.synced = true;
        subtitle.status = SubtitleStatus.SYNCED;
      } catch (alassErr) {
        this.logger.error(`Subtitle sync failed for #${id}: ${alassErr}`);
        subtitle.status = SubtitleStatus.FAILED;
      }
    }

    return this.repo.save(subtitle);
  }

  private async resolveMediaFilePath(
    mediaId: number,
    mediaFileId: number,
  ): Promise<string> {
    const media = await this.mediaRepo.findOne({ where: { id: mediaId } });
    if (!media?.path) {
      throw new NotFoundException(
        `Media #${mediaId} not found or has no root path`,
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

  async reencodeToUtf8(id: number): Promise<void> {
    const subtitle = await this.repo.findOne({ where: { id } });
    if (!subtitle) throw new NotFoundException(`SubtitleFile #${id} not found`);
    if (!subtitle.filePath) return;

    const buffer = await fs.readFile(subtitle.filePath);
    const content = buffer.toString('utf-8');
    await fs.writeFile(subtitle.filePath, content, 'utf-8');
  }
}
