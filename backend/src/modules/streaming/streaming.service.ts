import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { User } from '../users/entities/user.entity';
import { LibrariesService } from '../libraries/libraries.service';
import * as path from 'path';
import * as fs from 'fs/promises';

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
    private readonly libraries: LibrariesService,
  ) {}

  /**
   * Resolve a media file for streaming/download. When `user` is passed,
   * enforces library ACL — non-admin users get NotFoundException for media
   * outside their accessible libraries (same shape as "missing" so we don't
   * leak existence). Internal callers (subtitle workers, etc.) call without
   * `user` to bypass.
   */
  async resolveFile(mediaFileId: number, user?: User): Promise<ResolvedFile> {
    const file = await this.mediaFileRepo.findOne({
      where: { id: mediaFileId },
      relations: ['media', 'media.library'],
    });
    if (!file)
      throw new NotFoundException(`MediaFile #${mediaFileId} not found`);

    const media = file.media;

    if (user) {
      const accessible = await this.libraries.getAccessibleLibraryIds(user);
      if (accessible !== null) {
        if (media.libraryId == null || !accessible.includes(media.libraryId)) {
          // Mirror the "not found" shape so users can't probe for media in
          // libraries they don't have access to.
          throw new NotFoundException(`MediaFile #${mediaFileId} not found`);
        }
      }
    }

    if (!media?.path) {
      throw new NotFoundException(
        `Media "${media?.title ?? file.mediaId}" has no root folder assigned. Go to the media detail page and set a root folder.`,
      );
    }

    const absolutePath = path.resolve(media.path, file.relativePath);

    // Ensure the resolved path stays within the media root folder
    const normalizedRoot = path.resolve(media.path);
    if (
      !absolutePath.startsWith(normalizedRoot + path.sep) &&
      absolutePath !== normalizedRoot
    ) {
      throw new NotFoundException(`Invalid file path`);
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(absolutePath);
    } catch {
      throw new NotFoundException(`File not found on disk: ${absolutePath}`);
    }

    // Reject symlinks pointing outside the root folder
    const realPath = await fs.realpath(absolutePath);
    if (
      !realPath.startsWith(normalizedRoot + path.sep) &&
      realPath !== normalizedRoot
    ) {
      throw new NotFoundException(`Invalid file path`);
    }

    const ext = path.extname(file.relativePath).toLowerCase();

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
