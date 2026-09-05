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
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SubtitleFile } from './entities/subtitle-file.entity';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { SettingsService } from '../settings/settings.service';
import { EventsService } from '../scheduler/events.service';
import { cleanSubtitle } from './subtitle-cleaner';
import { relativePathUnderMediaRoot } from '../../common/utils/media-path.util';
import {
  isImageBasedSubtitleCodec,
  isOcrSupportedSubtitleCodec,
} from '../../common/constants/subtitle-codecs';
import { SubtitleProviderType, SubtitleStatus } from '../../common/enums';
import { normalizeLanguageCode } from '../../common/constants/app-languages';

const execFileAsync = promisify(execFile);
// pgsrip/subtile-ocr batch the whole track through Tesseract in one call —
// a dense 2h+ track can take past 10 minutes, so this needs real headroom.
const OCR_TOOL_TIMEOUT_MS = 1_800_000;
// Demuxing a bitmap track out of a 40 GB remux on a NAS is minutes, not seconds.
const EXTRACT_TIMEOUT_MS = 900_000;

/** execFile's `timeout` option kills the child but throws the same generic
 *  "Command failed" message as a real crash — call this out explicitly so
 *  the OCR failure log says what actually happened. */
async function execFileOrTimeout(
  command: string,
  args: string[],
  options: { timeout: number; maxBuffer?: number },
) {
  const start = Date.now();
  try {
    return await execFileAsync(command, args, options);
  } catch (err: any) {
    if (err?.killed) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      throw new Error(
        `${command} timed out after ${elapsed}s (limit ${Math.round(options.timeout / 1000)}s)`,
      );
    }
    throw err;
  }
}

/** ISO 639-1 → tesseract (ISO 639-2/T) traineddata names, for subtile-ocr's
 *  `-l`. All packs ship via `tesseract-ocr-all`. Falls back to `eng`.
 *  (pgsrip derives its own language from the staged .sup filename.) */
const TESSERACT_LANG: Record<string, string> = {
  en: 'eng', fr: 'fra', es: 'spa', de: 'deu', it: 'ita', pt: 'por',
  nl: 'nld', sv: 'swe', da: 'dan', no: 'nor', fi: 'fin', pl: 'pol',
  cs: 'ces', sk: 'slk', hu: 'hun', ro: 'ron', el: 'ell', ru: 'rus',
  uk: 'ukr', bg: 'bul', sr: 'srp', hr: 'hrv', tr: 'tur', ar: 'ara',
  he: 'heb', fa: 'fas', hi: 'hin', th: 'tha', vi: 'vie', id: 'ind',
  ja: 'jpn', ko: 'kor', zh: 'chi_sim',
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
export class SubtitleOcrService implements OnModuleInit {
  private readonly log = new Logger(SubtitleOcrService.name);
  private readonly tmpDir = '/tmp/fliks-ocr';

  // OCR is CPU-heavy (ffmpeg extract + tesseract). A library-wide sweep can
  // claim a PROCESSING row for every image track at once; this gate keeps the
  // number of heavy runs actually executing in parallel bounded.
  private ocrActive = 0;
  private readonly ocrWaiters: Array<() => void> = [];

  /** No run survives a restart, so any PROCESSING row is a corpse: it would
   *  otherwise cover its language forever and hide its own actions. */
  async onModuleInit(): Promise<void> {
    const { affected } = await this.repo.update(
      { providerType: SubtitleProviderType.OCR, status: SubtitleStatus.PROCESSING },
      { status: SubtitleStatus.FAILED },
    );
    if (affected) this.log.warn(`Marked ${affected} interrupted OCR run(s) as failed`);
  }

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

  /** Max OCR runs allowed to execute their heavy stage at once. */
  private async ocrConcurrencyLimit(): Promise<number> {
    const raw = Number(
      (await this.settings.get('subtitle_ocr_max_concurrency')) ?? '1',
    );
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
  }

  private async acquireOcrSlot(limit: number): Promise<void> {
    while (this.ocrActive >= limit) {
      await new Promise<void>((resolve) => this.ocrWaiters.push(resolve));
    }
    this.ocrActive++;
  }

  private releaseOcrSlot(): void {
    this.ocrActive = Math.max(0, this.ocrActive - 1);
    this.ocrWaiters.shift()?.();
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
      const limit = await this.ocrConcurrencyLimit();
      await this.acquireOcrSlot(limit);
      let srt: string;
      try {
        srt = await this.extractAndOcr(
          videoPath,
          source.streamIndex as number,
          source.codec ?? '',
          source.language,
        );
      } finally {
        this.releaseOcrSlot();
      }

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
      await this.repo.update(placeholderId, { status: SubtitleStatus.FAILED });
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
    // subtile-ocr wants the tesseract (alpha-3) pack name instead.
    const tess = TESSERACT_LANG[lower] ?? 'eng';
    const base = path.join(this.tmpDir, `ocr-${streamIndex}-${process.hrtime.bigint()}`);

    try {
      if (codec === 'hdmv_pgs_subtitle') {
        const sup = `${base}.${ietf}.sup`;
        await execFileOrTimeout('ffmpeg', [
          '-y', '-i', videoPath, '-map', `0:${streamIndex}`, '-c:s', 'copy', sup,
        ], { timeout: EXTRACT_TIMEOUT_MS });
        const { stdout, stderr } = await execFileOrTimeout(
          'pgsrip',
          ['--language', ietf, sup],
          { timeout: OCR_TOOL_TIMEOUT_MS, maxBuffer: 1 << 24 },
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
        // ffmpeg carries no vobsub muxer, so mkvextract writes the paired
        // .idx/.sub. Its track IDs match ffmpeg's stream index (both number
        // Matroska tracks 0-based in file order), so streamIndex selects it.
        // mkvextract only reads Matroska, so a non-mkv source can't be OCR'd.
        if (!/\.(mkv|mka|webm)$/i.test(videoPath)) {
          throw new Error('VobSub OCR requires a Matroska (.mkv) source');
        }
        try {
          await execFileOrTimeout('mkvextract', [
            'tracks', videoPath, `${streamIndex}:${base}.idx`,
          ], { timeout: EXTRACT_TIMEOUT_MS });
        } catch (err) {
          // mkvextract exits non-zero on warnings too; only fatal when the
          // VobSub pair it should have written is missing.
          if (!(await this.exists(`${base}.sub`))) throw err;
        }
        // subtile-ocr reads the .idx (+ paired .sub) and writes "<base>.srt".
        await execFileOrTimeout('subtile-ocr', [
          '-l', tess, '-o', `${base}.srt`, `${base}.idx`,
        ], { timeout: OCR_TOOL_TIMEOUT_MS, maxBuffer: 1 << 24 });
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
