import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import { SubtitleFile } from './entities/subtitle-file.entity';
import { SubtitleStatus } from '../../common/enums';

const execFileAsync = promisify(execFile);

@Injectable()
export class SubtitleSyncService {
  private readonly logger = new Logger(SubtitleSyncService.name);

  constructor(
    @InjectRepository(SubtitleFile)
    private readonly repo: Repository<SubtitleFile>,
  ) {}

  async syncSubtitle(id: number, mediaFilePath: string): Promise<SubtitleFile> {
    const subtitle = await this.repo.findOne({ where: { id } });
    if (!subtitle) throw new NotFoundException(`SubtitleFile #${id} not found`);

    try {
      await execFileAsync('ffsubsync', [
        mediaFilePath,
        '-i',
        subtitle.filePath,
        '-o',
        subtitle.filePath,
      ]);
      subtitle.synced = true;
      subtitle.status = SubtitleStatus.SYNCED;
    } catch (err) {
      this.logger.warn(
        `ffsubsync failed for ${subtitle.filePath}, trying alass...`,
      );
      try {
        await execFileAsync('alass', [
          mediaFilePath,
          subtitle.filePath,
          subtitle.filePath,
        ]);
        subtitle.synced = true;
        subtitle.status = SubtitleStatus.SYNCED;
      } catch (alassErr) {
        this.logger.error(`Subtitle sync failed for #${id}: ${alassErr}`);
        subtitle.status = SubtitleStatus.FAILED;
      }
    }

    return this.repo.save(subtitle);
  }

  async reencodeToUtf8(id: number): Promise<void> {
    const subtitle = await this.repo.findOne({ where: { id } });
    if (!subtitle) throw new NotFoundException(`SubtitleFile #${id} not found`);

    const buffer = await fs.readFile(subtitle.filePath);
    const content = buffer.toString('utf-8');
    await fs.writeFile(subtitle.filePath, content, 'utf-8');
  }
}
