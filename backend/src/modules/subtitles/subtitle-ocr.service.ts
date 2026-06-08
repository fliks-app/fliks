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
  async ocrSubtitle(
    subtitleId: number,
    language?: string,
  ): Promise<SubtitleFile> {
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

    // Caller-chosen language wins (used when the track is untagged 'und' and
    // the language can't be inferred from metadata). It tags the result and
    // drives the OCR engine's language pack.
    if (language?.trim()) source.language = language.trim().toLowerCase();

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
        `OCR end (ok) — sub #${placeholderId} "${media.title}" [${source.language}] → ${relativePath}`,
      );
      this.events.emit({
        type: 'subtitle.downloaded',
        mediaId: source.mediaId,
        title: media.title,
        language: source.language,
        provider: 'ocr',
      });

      if ((await this.settings.get('subtitle_ocr_delete_source')) === 'true') {
        await this.repo.delete(source.id);
        this.log.log(`OCR: removed source image subtitle #${source.id} after extraction`);
      }
    } catch (err) {
      this.log.warn(
        `OCR end (failed) — sub #${placeholderId} "${media?.title ?? ''}" [${source.language}]: ${err}`,
      );
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
    const lower = (language ?? '').toLowerCase();
    // pgsrip filters out tracks whose language doesn't intersect `--language`
    // and picks the tesseract pack from the language baked into the .sup
    // filename — so the filename and `--language` must carry the same IETF
    // code. These tracks are usually untagged ('und'); default to English.
    const ietf = lower.length === 2 ? lower : 'en';
    // vobsub2srt wants the tesseract (alpha-3) pack name instead.
    const tess = TESSERACT_LANG[lower] ?? 'eng';
    const base = path.join(this.tmpDir, `ocr-${streamIndex}-${process.hrtime.bigint()}`);

    try {
      if (codec === 'hdmv_pgs_subtitle') {
        const sup = `${base}.${ietf}.sup`;
        await execFileAsync('ffmpeg', [
          '-y', '-i', videoPath, '-map', `0:${streamIndex}`, '-c:s', 'copy', sup,
        ], { timeout: 120_000 });
        const { stdout, stderr } = await execFileAsync(
          'pgsrip',
          ['--language', ietf, sup],
          { timeout: 600_000, maxBuffer: 1 << 24 },
        );
        // pgsrip names the output "<base>.<lang>.srt" (babelfish's own form),
        // so find it by prefix rather than reconstructing the exact name.
        const srt = await this.readProducedSrt(base);
        if (srt == null) {
          throw new Error(
            `pgsrip produced no SRT for language "${ietf}" — ${(stderr || stdout || '').trim().slice(0, 300)}`,
          );
        }
        return srt;
      }

      if (codec === 'dvd_subtitle') {
        // ffmpeg emits the paired .idx/.sub from the .idx output path;
        // vobsub2srt takes the basename and writes "<base>.srt".
        await execFileAsync('ffmpeg', [
          '-y', '-i', videoPath, '-map', `0:${streamIndex}`, '-c:s', 'copy', `${base}.idx`,
        ], { timeout: 120_000 });
        await execFileAsync('vobsub2srt', ['--tesseract-lang', tess, base], {
          timeout: 600_000,
          maxBuffer: 1 << 24,
        });
        return await fs.readFile(`${base}.srt`, 'utf-8');
      }

      throw new Error(`OCR not supported for codec "${codec}"`);
    } finally {
      await this.cleanupTemp(base);
    }
  }

  /** Read the SRT pgsrip produced for `base`, located by prefix (its name
   *  carries a language tag in babelfish's form). Null when none was written. */
  private async readProducedSrt(base: string): Promise<string | null> {
    const dir = path.dirname(base);
    const prefix = path.basename(base);
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    const match = entries.find((e) => e.startsWith(prefix) && e.endsWith('.srt'));
    return match ? fs.readFile(path.join(dir, match), 'utf-8') : null;
  }

  /** Remove every temp artefact staged under `base` (sup/idx/sub/srt/pngs). */
  private async cleanupTemp(base: string): Promise<void> {
    const dir = path.dirname(base);
    const prefix = path.basename(base);
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((e) => e.startsWith(prefix))
        .map((e) => fs.rm(path.join(dir, e), { force: true }).catch(() => {})),
    );
  }

  private async exists(p: string): Promise<boolean> {
    return fs.access(p).then(
      () => true,
      () => false,
    );
  }
}
