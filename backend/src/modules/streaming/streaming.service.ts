import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import * as path from 'path';
import * as fs from 'fs';

export interface ResolvedFile {
  absolutePath: string;
  relativePath: string;
  size: number;
  ext: string;
  contentType: string;
  mediaFile: MediaFile;
  media: Media;
}

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
};

/** Extensions that browsers can direct play (no transcoding needed) */
export const DIRECT_PLAY_EXTS = new Set(['.mp4', '.m4v', '.webm']);

@Injectable()
export class StreamingService {
  private readonly log = new Logger(StreamingService.name);

  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
  ) {}

  async resolveFile(mediaFileId: number): Promise<ResolvedFile> {
    const file = await this.mediaFileRepo.findOne({
      where: { id: mediaFileId },
      relations: ['media', 'media.rootFolder'],
    });
    if (!file) throw new NotFoundException(`MediaFile #${mediaFileId} not found`);

    const media = file.media;
    if (!media?.path) {
      throw new NotFoundException(
        `Media "${media?.title ?? file.mediaId}" has no root folder assigned. Go to the media detail page and set a root folder.`,
      );
    }

    const absolutePath = path.join(media.path, file.relativePath);
    this.log.log(`Resolve: media.path="${media.path}" + relative="${file.relativePath}" → "${absolutePath}"`);
    if (!fs.existsSync(absolutePath)) {
      throw new NotFoundException(`File not found on disk: ${absolutePath}`);
    }

    const ext = path.extname(file.relativePath).toLowerCase();
    const stat = fs.statSync(absolutePath);

    return {
      absolutePath,
      relativePath: file.relativePath,
      size: stat.size,
      ext,
      contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
      mediaFile: file,
      media,
    };
  }
}
