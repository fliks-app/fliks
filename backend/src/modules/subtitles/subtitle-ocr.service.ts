import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SubtitleFile } from './entities/subtitle-file.entity';
import { Media } from '../media/entities/media.entity';
import { SettingsService } from '../settings/settings.service';
import { EventsService } from '../scheduler/events.service';
import { EngineService } from '../engine/engine.service';
import { cleanSubtitle } from './subtitle-cleaner';
import { relativePathUnderMediaRoot } from '../../common/utils/media-path.util';
import { assertSafeLangSuffix } from './subtitle-path.util';
import {
  isImageBasedSubtitleCodec,
  isOcrSupportedSubtitleCodec,
} from '../../common/constants/subtitle-codecs';
import { SubtitleProviderType, SubtitleStatus } from '../../common/enums';
import { normalizeLanguageCode } from '../../common/constants/app-languages';

/**
 * Turns an image-based (burn-required) subtitle track into a servable SRT by
 * OCR'ing it, then stores the result as a normal text sidecar tagged with the
 * `OCR` provider type. The work is heavy (minutes), so callers get a
 * `PROCESSING` placeholder row immediately and the run finishes in the
 * background, flipping the row to `DOWNLOADED` (or `FAILED`) and emitting an
 * SSE event the subtitle modal already reloads on.
 */
@Injectable()
export class SubtitleOcrService implements OnModuleInit {
  private readonly log = new Logger(SubtitleOcrService.name);

  /** No run survives a restart, so any PROCESSING row is a corpse: it would
   *  otherwise cover its language forever and hide its own actions. */
  async onModuleInit(): Promise<void> {
    const { affected } = await this.repo.update(
      { providerType: SubtitleProviderType.OCR, status: SubtitleStatus.PROCESSING },
      {
        status: SubtitleStatus.FAILED,
        errorMessage: 'activity.subtitle_error_interrupted',
      },
    );
    if (affected) this.log.warn(`Marked ${affected} interrupted OCR run(s) as failed`);
  }

  constructor(
    @InjectRepository(SubtitleFile)
    private readonly repo: Repository<SubtitleFile>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    private readonly settings: SettingsService,
    private readonly events: EventsService,
    private readonly engine: EngineService,
  ) {}

  /**
   * Manual trigger: OCR a single image-based subtitle. Returns the PROCESSING
   * placeholder immediately; the heavy work runs in the background.
   */
  async ocrSubtitle(
    subtitleId: number,
    language?: string,
    options: { automatic?: boolean } = {},
  ): Promise<SubtitleFile> {
    const source = await this.repo.findOne({
      where: { id: subtitleId },
      relations: ['media', 'mediaFile', 'episode'],
    });
    if (!source) throw new NotFoundException(`Subtitle #${subtitleId} not found`);
    if (!isImageBasedSubtitleCodec(source.codec)) {
      throw new BadRequestException('Subtitle is not image-based');
    }
    // Reject codecs with no OCR path (DVB, XSUB) up front so no PROCESSING
    // placeholder is ever created for work that can't complete.
    if (!isOcrSupportedSubtitleCodec(source.codec)) {
      throw new BadRequestException(
        `OCR is not available for "${source.codec}" subtitles`,
      );
    }
    if (source.streamIndex == null) {
      throw new BadRequestException(
        'OCR is only supported for embedded image subtitles',
      );
    }

    // Caller-chosen language wins (used when the track is untagged 'und' and
    // the language can't be inferred from metadata). It tags the result and
    // drives the OCR engine's language pack.
    if (language?.trim()) source.language = normalizeLanguageCode(language);

    this.log.log(
      `OCR start — sub #${subtitleId} "${source.media?.title ?? '?'}" [${source.language}] codec=${source.codec} stream=${source.streamIndex}`,
    );

    const placeholder = await this.repo.save({
      media: { id: source.mediaId },
      mediaFile: { id: source.mediaFileId },
      episode: source.episodeId ? { id: source.episodeId } : null,
      language: source.language,
      forced: source.forced,
      hearingImpaired: source.hearingImpaired,
      providerType: SubtitleProviderType.OCR,
      status: SubtitleStatus.PROCESSING,
      codec: 'subrip',
      score: 100,
      sourceStreamIndex: source.streamIndex,
    } as any);

    // The row exists as PROCESSING from here; without this the UI only learns of the run
    // when it ends, so a long OCR looks like nothing is happening.
    this.events.emit({ type: 'subtitle.list_changed', mediaId: source.mediaId });

    void this.runOcr(placeholder.id, source, options.automatic).catch((err) => {
      this.log.error(`OCR run crashed for sub #${subtitleId}: ${err}`);
    });
    return placeholder;
  }

  private async runOcr(
    placeholderId: number,
    source: SubtitleFile,
    automatic?: boolean,
  ): Promise<void> {
    // Fetched inside the try: a query failure here must still land the sub
    // in FAILED (not leave the PROCESSING placeholder stuck forever).
    let media: Media | null = null;
    try {
      media = await this.mediaRepo.findOne({ where: { id: source.mediaId } });
      if (!media?.path) throw new Error('media root folder not set');
      const videoPath = path.join(media.path, source.mediaFile.relativePath);

      const srt = await this.ocrViaEngine(source, videoPath, automatic);

      const removeHiTags =
        (await this.settings.get('subtitle_remove_hi_tags')) === 'true';
      const cleaned = cleanSubtitle(Buffer.from(srt, 'utf-8'), {
        removeAds: true,
        removeHiTags,
        customExclusions: ((await this.settings.get('subtitle_custom_exclusions')) ?? '')
          .split('\n')
          .filter((l) => l.trim()),
      });

      const parsed = path.parse(videoPath);
      // The HI cues are stripped, so the output no longer warrants the tag
      const hearingImpaired = source.hearingImpaired && !removeHiTags;
      const langSuffix = source.forced
        ? `${source.language}.forced`
        : hearingImpaired
          ? `${source.language}.hi`
          : source.language;
      assertSafeLangSuffix(langSuffix);
      let outPath = path.join(parsed.dir, `${parsed.name}.${langSuffix}.ocr.srt`);
      let counter = 0;
      while (await this.exists(outPath)) {
        counter++;
        outPath = path.join(
          parsed.dir,
          `${parsed.name}.${langSuffix}.ocr-${counter}.srt`,
        );
      }
      await fs.writeFile(outPath, cleaned);

      const relativePath = relativePathUnderMediaRoot(media.path, outPath);
      if (!relativePath) throw new Error('OCR output fell outside the media folder');

      await this.repo.update(placeholderId, {
        relativePath,
        hearingImpaired,
        status: SubtitleStatus.DOWNLOADED,
      });
      this.log.log(
        `OCR end (ok) — sub #${placeholderId} "${media.title}" [${source.language}] → ${relativePath}`,
      );
      this.events.emit({
        type: 'subtitle.downloaded',
        mediaId: source.mediaId,
        title: media.title,
        language: source.language,
        provider: 'ocr',
        automatic,
      });

      if ((await this.settings.get('subtitle_ocr_delete_source')) === 'true') {
        await this.repo.delete(source.id);
        this.log.log(`OCR: removed source image subtitle #${source.id} after extraction`);
      }
    } catch (err) {
      this.log.warn(
        `OCR end (failed) — sub #${placeholderId} "${media?.title ?? ''}" [${source.language}]: ${err}`,
      );
      this.events.emit({
        type: 'subtitle.failed',
        mediaId: source.mediaId,
        title: media?.title ?? '',
        language: source.language,
        error: String(err),
        automatic,
      });
      // The row stays as FAILED: it's what tells the auto pass this track was
      // already tried, so the language falls through to the providers instead
      // of re-running a 30-minute OCR on every scheduled sweep. Deleting it
      // re-arms the automatic retry.
      await this.repo.update(placeholderId, {
        status: SubtitleStatus.FAILED,
        // Bounded: an ffmpeg/tesseract failure can carry a whole stderr dump.
        errorMessage: String(err).slice(0, 2000),
      });
    }
  }

  private async ocrViaEngine(
    source: SubtitleFile,
    absoluteVideoPath: string,
    automatic?: boolean,
  ): Promise<string> {
    const info = source.mediaFile?.streamInfo;
    if (!info) {
      throw new Error('No probe data for this file; rescan the media first');
    }
    if (!this.engine.engineFeatures.includes('subtitle-ocr')) {
      throw new Error('The engine has no subtitle-ocr feature');
    }
    const language = /^[a-zA-Z]{2}$/.test(source.language)
      ? source.language.toLowerCase()
      : undefined;
    const { srt } = await this.engine.runJob({
      kind: {
        type: 'SubtitleOcr',
        info,
        streamIndex: source.streamIndex as number,
        language,
      },
      media: {
        mediaFileId: source.mediaFile.id,
        path: absoluteVideoPath,
      },
      priority: automatic ? 'low' : 'high',
    });
    return srt;
  }

  private async exists(p: string): Promise<boolean> {
    return fs.access(p).then(
      () => true,
      () => false,
    );
  }
}
