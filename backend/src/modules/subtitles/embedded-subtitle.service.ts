import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as path from 'path';
import { SubtitleFile } from './entities/subtitle-file.entity';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { FfprobeService } from './ffprobe.service';
import { SettingsService } from '../settings/settings.service';
import { SubtitleProviderType, SubtitleStatus } from '../../common/enums';

import { normalizeLanguageCode } from '../../common/constants/app-languages';

@Injectable()
export class EmbeddedSubtitleService {
  private readonly logger = new Logger(EmbeddedSubtitleService.name);

  constructor(
    private readonly ffprobe: FfprobeService,
    @InjectRepository(SubtitleFile)
    private readonly subtitleFileRepo: Repository<SubtitleFile>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    private readonly settings: SettingsService,
  ) {}

  async detectAndStore(
    mediaId: number,
    mediaFileId: number,
    episodeId?: number,
  ): Promise<SubtitleFile[]> {
    const videoPath = await this.resolveVideoPath(mediaId, mediaFileId);
    if (!videoPath) return [];

    const streams = await this.ffprobe.detectEmbeddedSubtitles(videoPath);
    if (!streams.length) {
      this.logger.log(`No embedded subtitles in "${path.basename(videoPath)}"`);
      return [];
    }

    this.logger.log(
      `Found ${streams.length} embedded subtitle(s) in "${path.basename(videoPath)}"`,
    );

    // When "delete burn-required after OCR" is on, don't re-add an image track
    // that was already OCR'd and removed — matched by source stream index, since
    // such tracks are often language-untagged.
    let skipIndices = new Set<number>();
    if ((await this.settings.get('subtitle_ocr_delete_source')) === 'true') {
      const ocrSubs = await this.subtitleFileRepo.find({
        where: {
          mediaFile: { id: mediaFileId },
          providerType: SubtitleProviderType.OCR,
        },
      });
      skipIndices = new Set(
        ocrSubs
          .map((s) => s.sourceStreamIndex)
          .filter((i): i is number => i != null),
      );
    }

    // Remove all existing embedded subs for this file, then recreate
    await this.subtitleFileRepo.delete({
      mediaFile: { id: mediaFileId },
      providerType: SubtitleProviderType.EMBEDDED,
    });

    // repo.save() directly (not create+save) — TypeORM resolves partial
    // relation objects { id: X } to FK columns on save.
    const toSave = streams
      .filter((stream) => !(stream.isImageBased && skipIndices.has(stream.streamIndex)))
      .map((stream) => ({
      media: { id: mediaId },
      mediaFile: { id: mediaFileId },
      episode: episodeId ? { id: episodeId } : null,
      language: normalizeLanguageCode(stream.language),
      forced: stream.forced,
      hearingImpaired: stream.hearingImpaired,
      providerType: SubtitleProviderType.EMBEDDED,
      providerFileId: undefined,
      relativePath: undefined,
      status: SubtitleStatus.EMBEDDED,
      score: 100,
      synced: false,
      streamIndex: stream.streamIndex,
      codec: stream.codec,
    }));

    const created = toSave.length
      ? await this.subtitleFileRepo.save(toSave as any[])
      : [];
    this.logger.log(
      `Refreshed embedded subtitles for mediaFile #${mediaFileId}: ${created.length} stored`,
    );

    return created;
  }

  private async resolveVideoPath(
    mediaId: number,
    mediaFileId: number,
  ): Promise<string | null> {
    const media = await this.mediaRepo.findOne({ where: { id: mediaId } });
    if (!media?.path) return null;
    const mediaFile = await this.mediaFileRepo.findOne({
      where: { id: mediaFileId },
    });
    if (!mediaFile) return null;
    return path.join(media.path, mediaFile.relativePath);
  }
}
