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
import { SettingsService } from '../settings/settings.service';
import { EventsService } from '../scheduler/events.service';
import {
  ResolvedTranslationSettings,
  SubtitleTranslationSettingsCache,
} from './subtitle-translation-settings-cache.service';
import {
  TranslationRateLimitError,
  type TranslationRequest,
} from './translation-core';
import { translateWithGemini } from './gemini-translator';
import { translateWithOpenAi } from './openai-translator';
import { translateWithLibreTranslate } from './libretranslate-translator';
import { parseSrt, serializeSrt } from './srt.util';
import { cleanSubtitle } from './subtitle-cleaner';
import { relativePathUnderMediaRoot } from '../../common/utils/media-path.util';
import { resolveSubtitleAbsolutePath } from './subtitle-path.util';
import { isImageBasedSubtitleCodec } from '../../common/constants/subtitle-codecs';
import { SubtitleProviderType, SubtitleStatus } from '../../common/enums';
import { normalizeLanguageCode } from '../../common/constants/app-languages';

const execFileAsync = promisify(execFile);

/**
 * Machine-translates an existing text subtitle into another language via the
 * configured engine (Gemini, an OpenAI-compatible endpoint, or LibreTranslate),
 * storing the result as a normal text sidecar tagged with the `TRANSLATED`
 * provider type and carrying the source subtitle's score. The work is slow (many
 * API calls), so callers get a `PROCESSING` placeholder row immediately and the
 * run finishes in the background — flipping the row to `DOWNLOADED` (or deleting
 * it on failure) and emitting SSE events the subtitle modal already reloads on,
 * plus a per-batch progress event.
 */
@Injectable()
export class SubtitleTranslationService {
  private readonly log = new Logger(SubtitleTranslationService.name);
  private readonly tmpDir = '/tmp/fliks-translate';

  // Translation fans out to a paid API; a library-wide sweep could claim a
  // PROCESSING row for every subtitle at once. This gate bounds how many runs
  // actually execute their heavy stage in parallel.
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    @InjectRepository(SubtitleFile)
    private readonly repo: Repository<SubtitleFile>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    private readonly settings: SettingsService,
    private readonly events: EventsService,
    private readonly translationSettings: SubtitleTranslationSettingsCache,
  ) {
    fs.mkdir(this.tmpDir, { recursive: true }).catch(() => {});
  }

  /**
   * Manual trigger: translate a single text subtitle into `targetLanguage`.
   * Returns the PROCESSING placeholder immediately; the work runs in the
   * background.
   */
  async translateSubtitle(
    subtitleId: number,
    targetLanguage: string,
  ): Promise<SubtitleFile> {
    const config = await this.translationSettings.get();
    if (!config.enabled) {
      throw new BadRequestException('Subtitle translation is disabled');
    }
    this.assertEngineConfigured(config);

    const source = await this.repo.findOne({
      where: { id: subtitleId },
      relations: ['media', 'mediaFile', 'episode'],
    });
    if (!source) throw new NotFoundException(`Subtitle #${subtitleId} not found`);
    if (isImageBasedSubtitleCodec(source.codec)) {
      throw new BadRequestException(
        'Image-based subtitles must be OCR’d to text before translation',
      );
    }
    if (!source.relativePath && source.streamIndex == null) {
      throw new BadRequestException('Subtitle has no readable text to translate');
    }

    const target = normalizeLanguageCode(targetLanguage);
    if (!target || target === 'und') {
      throw new BadRequestException('A target language is required');
    }
    if (target === source.language) {
      throw new BadRequestException(
        'Source and target languages are identical',
      );
    }

    this.log.log(
      `Translate start — sub #${subtitleId} "${source.media?.title ?? '?'}" [${source.language} → ${target}]`,
    );

    const placeholder = await this.repo.save({
      media: { id: source.mediaId },
      mediaFile: { id: source.mediaFileId },
      episode: source.episodeId ? { id: source.episodeId } : null,
      language: target,
      forced: source.forced,
      hearingImpaired: source.hearingImpaired,
      providerType: SubtitleProviderType.TRANSLATED,
      status: SubtitleStatus.PROCESSING,
      codec: 'subrip',
      score: source.score,
    } as any);

    void this.runTranslation(placeholder.id, source, target, config).catch((err) => {
      this.log.error(`Translate run crashed for sub #${subtitleId}: ${err}`);
    });
    return placeholder;
  }

  private assertEngineConfigured(config: ResolvedTranslationSettings): void {
    if (config.engine === 'gemini' && !config.gemini.apiKey) {
      throw new BadRequestException('Gemini API key is not set');
    }
    if (
      config.engine === 'openai' &&
      (!config.openai.baseUrl || !config.openai.model)
    ) {
      throw new BadRequestException(
        'An OpenAI-compatible base URL and model are required',
      );
    }
    if (config.engine === 'libretranslate' && !config.libretranslate.url) {
      throw new BadRequestException('The LibreTranslate URL is not set');
    }
  }

  private async acquireSlot(limit: number): Promise<void> {
    while (this.active >= limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
  }

  private releaseSlot(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.();
  }

  private async runTranslation(
    placeholderId: number,
    source: SubtitleFile,
    target: string,
    config: ResolvedTranslationSettings,
  ): Promise<void> {
    const media = await this.mediaRepo.findOne({ where: { id: source.mediaId } });
    const base = path.join(
      this.tmpDir,
      `tr-${source.id}-${process.hrtime.bigint()}`,
    );
    try {
      if (!media?.path) throw new Error('media root folder not set');
      const videoPath = path.join(media.path, source.mediaFile.relativePath);

      const srtIn = await this.loadSourceSrt(media.path, source, videoPath, base);
      const cues = parseSrt(srtIn);
      if (cues.length === 0) throw new Error('source subtitle has no text');

      const req: TranslationRequest = {
        sourceLanguage: source.language,
        targetLanguage: target,
        context: {
          title: media.title,
          year: media.year,
          mediaType: media.type,
          genres: media.genres,
          overview: media.overview,
        },
      };
      const onProgress = (done: number, total: number) => {
        this.events.emit({
          type: 'subtitle.translation_progress',
          subtitleId: placeholderId,
          mediaId: source.mediaId,
          progress: total > 0 ? Math.round((done / total) * 100) : 0,
        });
      };
      const texts = cues.map((c) => c.text);

      await this.acquireSlot(config.maxConcurrency);
      let translated: string[];
      try {
        if (config.engine === 'openai') {
          translated = await translateWithOpenAi(texts, req, config.openai, onProgress);
        } else if (config.engine === 'libretranslate') {
          translated = await translateWithLibreTranslate(
            texts,
            req,
            config.libretranslate,
            onProgress,
          );
        } else {
          translated = await translateWithGemini(texts, req, config.gemini, onProgress);
        }
      } finally {
        this.releaseSlot();
      }

      const outCues = cues.map((c, i) => ({
        timing: c.timing,
        text: translated[i] ?? c.text,
      }));
      const cleaned = cleanSubtitle(Buffer.from(serializeSrt(outCues), 'utf-8'), {
        removeAds: true,
        removeHiTags:
          (await this.settings.get('subtitle_remove_hi_tags')) === 'true',
        customExclusions: (
          (await this.settings.get('subtitle_custom_exclusions')) ?? ''
        )
          .split('\n')
          .filter((l) => l.trim()),
      });

      const parsed = path.parse(videoPath);
      const langSuffix = source.forced
        ? `${target}.forced`
        : source.hearingImpaired
          ? `${target}.hi`
          : target;
      let outPath = path.join(parsed.dir, `${parsed.name}.${langSuffix}.srt`);
      let counter = 0;
      while (await this.exists(outPath)) {
        counter++;
        outPath = path.join(
          parsed.dir,
          `${parsed.name}.${langSuffix}-${counter}.srt`,
        );
      }
      await fs.writeFile(outPath, cleaned);

      const relativePath = relativePathUnderMediaRoot(media.path, outPath);
      if (!relativePath) {
        throw new Error('translation output fell outside the media folder');
      }

      await this.repo.update(placeholderId, {
        relativePath,
        status: SubtitleStatus.DOWNLOADED,
      });
      this.log.log(
        `Translate end (ok) — sub #${placeholderId} "${media.title}" [${target}] → ${relativePath}`,
      );
      this.events.emit({
        type: 'subtitle.downloaded',
        mediaId: source.mediaId,
        title: media.title,
        language: target,
        provider: 'gemini',
      });
    } catch (err) {
      this.log.warn(
        `Translate end (failed) — sub #${placeholderId} "${media?.title ?? ''}" [${target}]: ${err}`,
      );
      this.events.emit({
        type: 'subtitle.failed',
        mediaId: source.mediaId,
        title: media?.title ?? '',
        language: target,
        error: String(err),
        ...(err instanceof TranslationRateLimitError ? { reason: 'rate_limit' } : {}),
      });
      await this.repo.delete(placeholderId);
    } finally {
      await this.cleanupTemp(base);
    }
  }

  /** Read the source subtitle as SRT: convert on-disk non-SRT files and extract
   *  embedded text tracks with ffmpeg so parsing is always uniform. */
  private async loadSourceSrt(
    mediaRoot: string,
    source: SubtitleFile,
    videoPath: string,
    base: string,
  ): Promise<string> {
    if (source.relativePath) {
      const absolute = resolveSubtitleAbsolutePath(mediaRoot, source.relativePath);
      if (!absolute) throw new Error('source subtitle path is invalid');
      if (source.codec === 'subrip' || /\.srt$/i.test(absolute)) {
        return fs.readFile(absolute, 'utf-8');
      }
      const out = `${base}.src.srt`;
      await execFileAsync('ffmpeg', ['-y', '-i', absolute, '-f', 'srt', out], {
        timeout: 120_000,
      });
      return fs.readFile(out, 'utf-8');
    }
    // Embedded text track: extract the selected stream to SRT.
    const out = `${base}.src.srt`;
    await execFileAsync(
      'ffmpeg',
      ['-y', '-i', videoPath, '-map', `0:${source.streamIndex}`, '-f', 'srt', out],
      { timeout: 120_000 },
    );
    return fs.readFile(out, 'utf-8');
  }

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
