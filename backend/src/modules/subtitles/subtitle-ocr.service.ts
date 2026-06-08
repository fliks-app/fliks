import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SubtitleFile } from './entities/subtitle-file.entity';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { SettingsService } from '../settings/settings.service';
import { EventsService } from '../scheduler/events.service';
import { cleanSubtitle } from './subtitle-cleaner';
import { relativePathUnderMediaRoot } from '../../common/utils/media-path.util';
import { isImageBasedSubtitleCodec } from '../../common/constants/subtitle-codecs';
import { SubtitleProviderType, SubtitleStatus } from '../../common/enums';

const execFileAsync = promisify(execFile);

/** ISO 639-1 → tesseract (ISO 639-2/T) traineddata names. The matching pack
 *  must be installed in the image (see Dockerfile). Falls back to `eng`. */
const TESSERACT_LANG: Record<string, string> = {
  en: 'eng', fr: 'fra', es: 'spa', de: 'deu', it: 'ita', pt: 'por',
  nl: 'nld', ja: 'jpn', ko: 'kor', zh: 'chi_sim', ru: 'rus', ar: 'ara',
  pl: 'pol', sv: 'swe', tr: 'tur', cs: 'ces', da: 'dan', fi: 'fin',
  el: 'ell', he: 'heb', hu: 'hun', no: 'nor', ro: 'ron', uk: 'ukr',
};

/**
 * Turns an image-based (burn-required) subtitle track into a servable SRT by
 * OCR'ing it, then stores the result as a normal text sidecar tagged with the
 * `OCR` provider type. The work is heavy (minutes), so callers get a
 * `PROCESSING` placeholder row immediately and the run finishes in the
 * background, flipping the row to `DOWNLOADED` (or `FAILED`) and emitting an
 * SSE event the subtitle modal already reloads on.
 */
@Injectable()
export class SubtitleOcrService {
  private readonly log = new Logger(SubtitleOcrService.name);
  private readonly tmpDir = '/tmp/fliks-ocr';

  constructor(
    @InjectRepository(SubtitleFile)
    private readonly repo: Repository<SubtitleFile>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    private readonly settings: SettingsService,
    private readonly events: EventsService,
  ) {
    fs.mkdir(this.tmpDir, { recursive: true }).catch(() => {});
  }

  /**
   * Manual trigger: OCR a single image-based subtitle. Returns the PROCESSING
   * placeholder immediately; the heavy work runs in the background.
   */
  async ocrSubtitle(subtitleId: number): Promise<SubtitleFile> {
    const source = await this.repo.findOne({
      where: { id: subtitleId },
      relations: ['media', 'mediaFile', 'episode'],
    });
    if (!source) throw new NotFoundException(`Subtitle #${subtitleId} not found`);
    if (!isImageBasedSubtitleCodec(source.codec)) {
      throw new BadRequestException('Subtitle is not image-based');
    }
    if (source.streamIndex == null) {
      throw new BadRequestException(
        'OCR is only supported for embedded image subtitles',
      );
    }

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
      score: 0,
    } as any);

    void this.runOcr(placeholder.id, source).catch((err) => {
      this.log.error(`OCR run crashed for sub #${subtitleId}: ${err}`);
    });
    return placeholder;
  }

  /**
   * Auto path used after import / during the missing-search pass: OCR every
   * image-based embedded subtitle on the file that has no text counterpart yet.
   * Gated by the `subtitle_ocr_burn_in_auto` setting.
   */
  async autoOcrForFile(mediaFileId: number): Promise<void> {
    if ((await this.settings.get('subtitle_ocr_burn_in_auto')) !== 'true') return;

    const subs = await this.repo.find({
      where: { mediaFile: { id: mediaFileId } },
    });
    const hasText = (lang: string) =>
      subs.some(
        (s) =>
          s.language === lang &&
          !isImageBasedSubtitleCodec(s.codec) &&
          s.status !== SubtitleStatus.FAILED,
      );

    for (const sub of subs) {
      if (sub.streamIndex == null) continue;
      if (!isImageBasedSubtitleCodec(sub.codec)) continue;
      if (hasText(sub.language)) continue;
      try {
        await this.ocrSubtitle(sub.id);
      } catch (err) {
        this.log.warn(`Auto-OCR skipped sub #${sub.id}: ${err}`);
      }
    }
  }

  private async runOcr(placeholderId: number, source: SubtitleFile): Promise<void> {
    const media = await this.mediaRepo.findOne({
      where: { id: source.mediaId },
    });
    try {
      if (!media?.path) throw new Error('media root folder not set');
      const videoPath = path.join(media.path, source.mediaFile.relativePath);
      const srt = await this.extractAndOcr(
        videoPath,
        source.streamIndex as number,
        source.codec ?? '',
        source.language,
      );

      const cleaned = cleanSubtitle(Buffer.from(srt, 'utf-8'), {
        removeAds: true,
        removeHiTags:
          (await this.settings.get('subtitle_remove_hi_tags')) === 'true',
        customExclusions: ((await this.settings.get('subtitle_custom_exclusions')) ?? '')
          .split('\n')
          .filter((l) => l.trim()),
      });

      const parsed = path.parse(videoPath);
      const langSuffix = source.forced
        ? `${source.language}.forced`
        : source.hearingImpaired
          ? `${source.language}.hi`
          : source.language;
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
        status: SubtitleStatus.DOWNLOADED,
      });
      this.log.log(
        `OCR subtitle ready: ${source.language} for "${media.title}" → ${relativePath}`,
      );
      this.events.emit({
        type: 'subtitle.downloaded',
        mediaId: source.mediaId,
        title: media.title,
        language: source.language,
        provider: 'ocr',
      });
    } catch (err) {
      this.log.warn(`OCR failed for sub #${source.id}: ${err}`);
      await this.repo.update(placeholderId, { status: SubtitleStatus.FAILED });
      this.events.emit({
        type: 'subtitle.failed',
        mediaId: source.mediaId,
        title: media?.title ?? '',
        language: source.language,
        error: String(err),
      });
    }
  }

  /** Extract the bitmap stream and OCR it to an SRT string (per codec). */
  private async extractAndOcr(
    videoPath: string,
    streamIndex: number,
    codec: string,
    language: string,
  ): Promise<string> {
    const lang = TESSERACT_LANG[(language ?? '').toLowerCase()] ?? 'eng';
    const base = path.join(this.tmpDir, `ocr-${streamIndex}-${process.hrtime.bigint()}`);

    try {
      if (codec === 'hdmv_pgs_subtitle') {
        const sup = `${base}.sup`;
        await execFileAsync('ffmpeg', [
          '-y', '-i', videoPath, '-map', `0:${streamIndex}`, '-c:s', 'copy', sup,
        ], { timeout: 120_000 });
        // pgsrip writes "<sup-without-ext>.srt" next to the input.
        await execFileAsync('pgsrip', ['--language', lang, sup], {
          timeout: 600_000,
          maxBuffer: 1 << 24,
        });
        return await fs.readFile(`${base}.srt`, 'utf-8');
      }

      if (codec === 'dvd_subtitle') {
        // ffmpeg emits the paired .idx/.sub from the .idx output path.
        const idx = `${base}.idx`;
        await execFileAsync('ffmpeg', [
          '-y', '-i', videoPath, '-map', `0:${streamIndex}`, '-c:s', 'copy', idx,
        ], { timeout: 120_000 });
        // vobsub2srt takes the basename (no extension) and writes "<base>.srt".
        await execFileAsync('vobsub2srt', ['--tesseract-lang', lang, base], {
          timeout: 600_000,
          maxBuffer: 1 << 24,
        });
        return await fs.readFile(`${base}.srt`, 'utf-8');
      }

      throw new Error(`OCR not supported for codec "${codec}"`);
    } finally {
      // Best-effort cleanup of the staged temp artefacts.
      for (const ext of ['.sup', '.idx', '.sub', '.srt']) {
        fs.rm(`${base}${ext}`, { force: true }).catch(() => {});
      }
    }
  }

  private async exists(p: string): Promise<boolean> {
    return fs.access(p).then(
      () => true,
      () => false,
    );
  }
}
