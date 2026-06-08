import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import { SubtitleFile } from './entities/subtitle-file.entity';
import { SubtitleProviderStat } from './entities/subtitle-provider-stat.entity';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { SubtitleProviderService } from './subtitle-provider.service';
import { SubtitleProviderFactory } from './providers/subtitle-provider.factory';
import {
  SubtitleSearchParams,
  SubtitleSearchResult,
} from './providers/subtitle-provider.interface';
import { SubtitleProviderType, SubtitleStatus } from '../../common/enums';
import { SubtitleBlacklist } from './entities/subtitle-blacklist.entity';
import { computeMovieHash } from './moviehash';
import { cleanSubtitle } from './subtitle-cleaner';
import * as postProcess from './subtitle-post-processor';
import { SettingsService } from '../settings/settings.service';
import { resolveSubtitleAbsolutePath } from './subtitle-path.util';
import { relativePathUnderMediaRoot } from '../../common/utils/media-path.util';
import {
  APP_LANGUAGES,
  ISO_639_2_TO_1,
} from '../../common/constants/app-languages';
import {
  SubtitleScore,
  scoreSubtitle,
} from './subtitle-scorer';

@Injectable()
export class SubtitlesService {
  private readonly logger = new Logger(SubtitlesService.name);

  constructor(
    @InjectRepository(SubtitleFile)
    private readonly repo: Repository<SubtitleFile>,
    @InjectRepository(SubtitleProviderStat)
    private readonly statRepo: Repository<SubtitleProviderStat>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    @InjectRepository(SubtitleBlacklist)
    private readonly blacklistRepo: Repository<SubtitleBlacklist>,
    private readonly providerService: SubtitleProviderService,
    private readonly factory: SubtitleProviderFactory,
    private readonly settingsService: SettingsService,
  ) {}

  async searchSubtitles(
    params: SubtitleSearchParams,
  ): Promise<SubtitleSearchResult[]> {
    // Compute moviehash if filePath is provided and hash not yet set
    if (params.filePath && !params.moviehash) {
      const hashResult = computeMovieHash(params.filePath);
      if (hashResult) {
        params.moviehash = hashResult.hash;
        params.moviebytesize = hashResult.bytesize;
        this.logger.log(
          `Computed moviehash=${hashResult.hash} for ${params.filePath}`,
        );
      }
    }

    const providers = await this.providerService.findEnabled();
    const allResults: SubtitleSearchResult[] = [];

    for (const provider of providers) {
      const start = Date.now();
      try {
        const impl = this.factory.create(provider.type, provider.settings);
        const results = await impl.search(params);
        void this.statRepo.save(
          this.statRepo.create({
            provider,
            queryType: 'search',
            responseTimeMs: Date.now() - start,
            resultCount: results.length,
            errorMessage: null,
          }),
        );
        allResults.push(...results);
      } catch (err) {
        void this.statRepo.save(
          this.statRepo.create({
            provider,
            queryType: 'search',
            responseTimeMs: Date.now() - start,
            resultCount: 0,
            errorMessage: (err as Error).message,
          }),
        );
        this.logger.warn(`Search failed for provider ${provider.name}: ${err}`);
      }
    }

    this.logger.log(
      `Subtitle search for "${params.title}" [${params.language}]: ${allResults.length} result(s) from ${providers.length} provider(s)`,
    );

    // Filter out blacklisted subtitles (composite key includes provider).
    const blacklisted = await this.blacklistRepo.find();
    const blacklistSet = new Set(
      blacklisted.map((b) => `${b.providerType}:${b.providerFileId}`),
    );
    const filtered = allResults.filter(
      (r) => !blacklistSet.has(`${r.providerType}:${r.providerFileId}`),
    );

    // Hearing-impaired hard filter. `require` keeps only HI candidates,
    // `forbid` drops them; `prefer` / `avoid` leave the candidate set
    // intact and only nudge the 1-point bit in the scorer below.
    const hiMode = params.hearingImpairedMode ?? 'avoid';
    const hiFiltered = filtered.filter((r) => {
      if (hiMode === 'require') return r.hearingImpaired;
      if (hiMode === 'forbid') return !r.hearingImpaired;
      return true;
    });

    // Cross-provider dedup: when the same release name + language + HI
    // flag appear from two providers, keep the first occurrence (encounter
    // order mirrors provider priority since `findEnabled` returns by
    // priority ASC). Providers that don't expose a releaseName fall back
    // to the `providerType:providerFileId` axis which is already unique.
    const seenReleaseKey = new Set<string>();
    const deduped: SubtitleSearchResult[] = [];
    for (const r of hiFiltered) {
      const releaseKey = r.releaseName
        ? `${r.releaseName.toLowerCase()}|${r.language}|${r.hearingImpaired ? 'hi' : 'normal'}|${r.forced ? 'forced' : 'full'}`
        : `${r.providerType}:${r.providerFileId}`;
      if (seenReleaseKey.has(releaseKey)) continue;
      seenReleaseKey.add(releaseKey);
      deduped.push(r);
    }

    // Central scoring: every candidate is rescored against the video
    // context so the comparison stays fair across providers. The
    // per-provider `score` field is ignored (providers no longer compute
    // it). When the caller didn't supply video context (title only), the
    // scorer still produces a useful ranking via hash + imdb-equivalence
    // + hearing-impaired bit.
    const scoringCtx = {
      kind: (params.season != null && params.episode != null
        ? 'episode'
        : 'movie') as 'episode' | 'movie',
      videoReleaseName: params.videoReleaseName ?? null,
      title: params.title,
      year: params.year ?? null,
      season: params.season ?? null,
      episode: params.episode ?? null,
      imdbId: params.imdbId ?? null,
      hearingImpairedMode: hiMode,
    };
    const scored: (SubtitleSearchResult & { _score: SubtitleScore })[] =
      deduped.map((r) => {
        const s = scoreSubtitle(r, scoringCtx);
        r.score = s.percent;
        return Object.assign(r, { _score: s });
      });

    scored.sort((a, b) => {
      if (a._score.percent !== b._score.percent) {
        return b._score.percent - a._score.percent;
      }
      // Tie-breaker: prefer higher download count when scores are equal —
      // it's the only popularity-style signal left after centralisation.
      return (b.downloadCount ?? 0) - (a.downloadCount ?? 0);
    });

    return scored;
  }

  async autoDownload(
    mediaId: number,
    mediaFileId: number,
    episodeId: number | undefined,
    params: SubtitleSearchParams,
  ): Promise<SubtitleFile | null> {
    const results = await this.searchSubtitles(params);
    if (!results.length) {
      this.logger.log(
        `Auto subtitle: no results for "${params.title}" (${params.language})`,
      );
      return null;
    }
    const best = results[0];
    this.logger.log(
      `Auto subtitle: picking "${best.title}" (score=${best.score}, provider=${best.providerType})`,
    );
    return this.downloadSubtitle(mediaId, mediaFileId, episodeId, best);
  }

  async downloadSubtitle(
    mediaId: number,
    mediaFileId: number,
    episodeId: number | undefined,
    searchResult: SubtitleSearchResult,
  ): Promise<SubtitleFile> {
    const providers = await this.providerService.findEnabled();
    const provider = providers.find(
      (p) => String(p.type) === searchResult.providerType,
    );
    if (!provider) throw new NotFoundException('No matching provider found');

    // Resolve the absolute path of the media file
    const absolutePath = await this.resolveMediaFilePath(mediaId, mediaFileId);

    this.logger.log(
      `Downloading subtitle "${searchResult.title}" via ${provider.name} (${provider.type})`,
    );
    const impl = this.factory.create(provider.type, provider.settings);
    const dlStart = Date.now();
    let buffer: Buffer;
    try {
      buffer = await impl.download(searchResult);
      void this.statRepo.save(
        this.statRepo.create({
          provider,
          queryType: 'download',
          responseTimeMs: Date.now() - dlStart,
          resultCount: 1,
          errorMessage: null,
        }),
      );
    } catch (err) {
      void this.statRepo.save(
        this.statRepo.create({
          provider,
          queryType: 'download',
          responseTimeMs: Date.now() - dlStart,
          resultCount: 0,
          errorMessage: (err as Error).message,
        }),
      );
      throw new BadRequestException(
        `Download failed (${provider.name}): ${(err as Error).message}`,
      );
    }

    const langSuffix = searchResult.forced
      ? `${searchResult.language}.forced`
      : searchResult.hearingImpaired
        ? `${searchResult.language}.hi`
        : searchResult.language;

    const parsed = path.parse(absolutePath);
    let subtitlePath = path.join(
      parsed.dir,
      `${parsed.name}.${langSuffix}.srt`,
    );

    // Avoid overwriting existing subtitle files — append -1, -2, etc.
    let counter = 0;
    while (
      await fs.access(subtitlePath).then(
        () => true,
        () => false,
      )
    ) {
      counter++;
      subtitlePath = path.join(
        parsed.dir,
        `${parsed.name}.${langSuffix}-${counter}.srt`,
      );
    }

    // Clean subtitle content (remove ads, optionally HI tags)
    const removeHiTags =
      (await this.settingsService.get('subtitle_remove_hi_tags')) === 'true';
    const customExclusions = (
      (await this.settingsService.get('subtitle_custom_exclusions')) ?? ''
    )
      .split('\n')
      .filter((l) => l.trim());
    buffer = cleanSubtitle(buffer, {
      removeAds: true,
      removeHiTags,
      customExclusions,
    });

    await fs.mkdir(parsed.dir, { recursive: true });
    await fs.writeFile(subtitlePath, buffer);
    this.logger.log(`Subtitle saved: ${subtitlePath}`);

    const media = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: ['library'],
    });
    if (!media?.path) {
      throw new BadRequestException(
        'Assign a root folder to this media before downloading subtitles',
      );
    }
    const relativePath = relativePathUnderMediaRoot(media.path, subtitlePath);
    if (!relativePath) {
      this.logger.error(
        `Subtitle save path invalid: mediaId=${mediaId} media.path=${media.path} subtitlePath=${subtitlePath}`,
      );
      throw new BadRequestException(
        'Subtitle file would be outside the media folder; check root folder configuration',
      );
    }

    // repo.save() (not create+save) — TypeORM resolves partial relation
    // objects { id: X } to FK columns on save, but create() drops them.
    return this.repo.save({
      media: { id: mediaId },
      mediaFile: { id: mediaFileId },
      episode: episodeId ? { id: episodeId } : null,
      language: searchResult.language,
      forced: searchResult.forced,
      hearingImpaired: searchResult.hearingImpaired,
      providerType: provider.type,
      providerFileId: searchResult.providerFileId,
      relativePath,
      status: SubtitleStatus.DOWNLOADED,
      score: searchResult.score,
      hashMatched: !!searchResult.hashMatched,
      synced: false,
    } as any);
  }

  /**
   * Resolves the absolute filesystem path of a media file
   * by joining media.path (root folder) with mediaFile.relativePath.
   */
  private async resolveMediaFilePath(
    mediaId: number,
    mediaFileId: number,
  ): Promise<string> {
    const media = await this.mediaRepo.findOne({ where: { id: mediaId } });
    if (!media) {
      throw new NotFoundException(`Media #${mediaId} not found`);
    }
    if (!media.path) {
      throw new BadRequestException(
        'Assign a root folder to this media before downloading subtitles',
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

  private async resolveSubtitleAbsolute(
    sub: Pick<SubtitleFile, 'mediaId' | 'relativePath'>,
  ): Promise<string | null> {
    const media = await this.mediaRepo.findOne({
      where: { id: sub.mediaId },
      relations: ['library'],
    });
    return resolveSubtitleAbsolutePath(media?.path ?? null, sub.relativePath);
  }

  async getSubtitlesForMedia(mediaId: number): Promise<SubtitleFile[]> {
    return this.repo.find({
      where: { media: { id: mediaId } },
      order: { language: 'ASC', score: 'DESC' },
    });
  }

  async getSubtitlesForMediaFile(mediaFileId: number): Promise<SubtitleFile[]> {
    return this.repo.find({
      where: { mediaFile: { id: mediaFileId } },
      order: { language: 'ASC', score: 'DESC' },
    });
  }

  /** Reassign a subtitle's language — used when a track was untagged ('und')
   *  and the language was only known after the fact (e.g. an OCR result). */
  async setLanguage(subtitleId: number, language: string): Promise<SubtitleFile> {
    const sub = await this.repo.findOne({ where: { id: subtitleId } });
    if (!sub) throw new NotFoundException(`Subtitle #${subtitleId} not found`);
    const lang = (language ?? '').trim().toLowerCase();
    if (!lang) throw new BadRequestException('Language is required');
    sub.language = lang;
    return this.repo.save(sub);
  }

  /**
   * Called after a media rescan: drop DB rows for external subtitle files that no longer exist on disk,
   * and remove duplicate entries (same path, or same media file + language + forced/HI) keeping the best row.
   */
  async reconcileSubtitleFilesAfterRescan(mediaId: number): Promise<{
    removedMissing: number;
    removedDuplicates: number;
  }> {
    let removedMissing = 0;
    let removedDuplicates = 0;

    const isExternalFile = (s: SubtitleFile) =>
      s.providerType !== SubtitleProviderType.EMBEDDED;

    const pickWinner = (a: SubtitleFile, b: SubtitleFile): number => {
      if (a.locked !== b.locked) return a.locked ? -1 : 1;
      if (a.score !== b.score) return b.score - a.score;
      return b.id - a.id;
    };

    // 1) Stale rows: external subs whose file is gone or path is invalid
    let subs = await this.repo.find({ where: { media: { id: mediaId } } });
    for (const sub of subs) {
      if (!isExternalFile(sub)) continue;
      if (!sub.relativePath?.trim()) {
        await this.repo.remove(sub);
        removedMissing++;
        continue;
      }
      const abs = await this.resolveSubtitleAbsolute(sub);
      if (!abs || !existsSync(abs)) {
        await this.repo.remove(sub);
        removedMissing++;
      }
    }

    subs = await this.repo.find({ where: { media: { id: mediaId } } });
    const external = subs.filter(isExternalFile);

    // 2) Duplicate relativePath (same file referenced more than once)
    const byNormPath = new Map<string, SubtitleFile[]>();
    for (const s of external) {
      if (!s.relativePath?.trim()) continue;
      const k = s.relativePath.replace(/\\/g, '/');
      const list = byNormPath.get(k) ?? [];
      list.push(s);
      byNormPath.set(k, list);
    }
    for (const group of byNormPath.values()) {
      if (group.length < 2) continue;
      group.sort(pickWinner);
      const [, ...losers] = group;
      for (const row of losers) {
        await this.repo.remove(row);
        removedDuplicates++;
      }
    }

    // 3) Logical duplicates: same media file + language + forced + HI, different paths — keep one file
    subs = await this.repo.find({ where: { media: { id: mediaId } } });
    const external2 = subs.filter(isExternalFile);
    const byKey = new Map<string, SubtitleFile[]>();
    for (const s of external2) {
      if (!s.relativePath?.trim()) continue;
      const key = `${s.mediaFileId}\0${s.language}\0${s.forced}\0${s.hearingImpaired}`;
      const list = byKey.get(key) ?? [];
      list.push(s);
      byKey.set(key, list);
    }
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      group.sort(pickWinner);
      const [, ...losers] = group;
      for (const row of losers) {
        try {
          await this.deleteSubtitle(row.id);
          removedDuplicates++;
        } catch (err) {
          this.logger.warn(
            `reconcile: could not delete duplicate subtitle #${row.id}: ${(err as Error).message}`,
          );
        }
      }
    }

    return { removedMissing, removedDuplicates };
  }

  // ---------------------------------------------------------------------------
  // External subtitle discovery (filename-based)
  // ---------------------------------------------------------------------------

  private static readonly SUBTITLE_EXTS = new Set([
    '.srt',
    '.ass',
    '.ssa',
    '.vtt',
    '.sub',
    '.sup',
    '.mks',
    '.smi',
    '.sami',
  ]);

  /** Flags parsed right-to-left from the filename suffix. */
  private static readonly FORCED_FLAGS = new Set(['forced', 'foreign']);
  private static readonly HI_FLAGS = new Set(['hi', 'cc', 'sdh']);
  private static readonly SKIP_FLAGS = new Set(['default']);

  /** Full language names → ISO 639-1 (built from APP_LANGUAGES). */
  private static readonly LANG_NAMES: Record<string, string> =
    Object.fromEntries(
      APP_LANGUAGES.filter((l) => l.isoCode !== 'xx').map((l) => [
        l.name.toLowerCase(),
        l.isoCode,
      ]),
    );

  /**
   * Parse a subtitle filename right-to-left.
   * Pattern: `<videoBaseName>.<lang>.<flags>.<ext>`
   * Returns null if the extension isn't a subtitle extension.
   */
  parseSubtitleFilename(filename: string): {
    language: string;
    forced: boolean;
    hearingImpaired: boolean;
  } | null {
    const ext = path.extname(filename).toLowerCase();
    if (!SubtitlesService.SUBTITLE_EXTS.has(ext)) return null;

    const withoutExt = filename.slice(0, -ext.length);
    const parts = withoutExt.split('.');

    let language = 'und';
    let forced = false;
    let hearingImpaired = false;

    // Parse right-to-left (skip the leftmost parts = video name)
    for (let i = parts.length - 1; i >= 1; i--) {
      const token = parts[i].toLowerCase();
      if (SubtitlesService.FORCED_FLAGS.has(token)) {
        forced = true;
      } else if (SubtitlesService.HI_FLAGS.has(token)) {
        // Ambiguity: 'hi' = Hindi if no language yet, else hearing-impaired.
        if (token === 'hi' && language === 'und') {
          language = 'hi';
        } else {
          hearingImpaired = true;
        }
      } else if (SubtitlesService.SKIP_FLAGS.has(token)) {
        // ignore 'default'
      } else if (this.resolveLanguageCode(token)) {
        language = this.resolveLanguageCode(token)!;
      } else {
        // Stop: this part is the video name, not a flag/lang
        break;
      }
    }

    return { language, forced, hearingImpaired };
  }

  /** Known ISO 639-1 codes from APP_LANGUAGES. */
  private static readonly KNOWN_ISO_CODES = new Set(
    APP_LANGUAGES.map((l) => l.isoCode),
  );

  private resolveLanguageCode(token: string): string | null {
    // ISO 639-1 (2 chars) — validate against known codes
    if (/^[a-z]{2}$/.test(token) && SubtitlesService.KNOWN_ISO_CODES.has(token))
      return token;
    // Culture code: en-us → en
    const cultureMatch = token.match(/^([a-z]{2})-[a-z]{2,}$/i);
    if (cultureMatch) return cultureMatch[1].toLowerCase();
    // ISO 639-2 (3 chars)
    if (ISO_639_2_TO_1[token]) return ISO_639_2_TO_1[token];
    // Full name (from APP_LANGUAGES)
    if (SubtitlesService.LANG_NAMES[token])
      return SubtitlesService.LANG_NAMES[token];
    return null;
  }

  /**
   * Discover external subtitle files on disk for a media and insert missing
   * rows into DB. Matches each .srt/.ass/etc to a MediaFile by comparing the
   * video basename with the subtitle filename prefix.
   *
   * Called after rescan to pick up sidecar files that weren't inserted via
   * the download flow (e.g. manually placed or from a failed download).
   */
  async discoverExternalSubtitles(mediaId: number): Promise<number> {
    const media = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: ['files'],
    });
    if (!media?.path || !media.files?.length) return 0;

    // Build a map: video basename (without ext, lowercase) → MediaFile
    const fileByBasename = new Map<string, MediaFile>();
    for (const f of media.files) {
      const base = path
        .basename(f.relativePath, path.extname(f.relativePath))
        .toLowerCase();
      fileByBasename.set(base, f);
    }

    // Load existing external subtitle relative paths to skip duplicates
    const existingSubs = await this.repo.find({
      where: { media: { id: mediaId } },
    });
    const existingPaths = new Set(
      existingSubs
        .filter((s) => s.relativePath)
        .map((s) => s.relativePath!.replace(/\\/g, '/')),
    );

    // Scan the media folder recursively (max depth 2, same dirs as video files)
    const dirs = new Set<string>();
    dirs.add(media.path);
    for (const f of media.files) {
      const absDir = path.dirname(path.join(media.path, f.relativePath));
      dirs.add(absDir);
    }

    let discovered = 0;

    for (const dir of dirs) {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const ext = path.extname(entry).toLowerCase();
        if (!SubtitlesService.SUBTITLE_EXTS.has(ext)) continue;

        const absPath = path.join(dir, entry);
        const relPath = path.relative(media.path, absPath).replace(/\\/g, '/');

        // Already in DB?
        if (existingPaths.has(relPath)) continue;

        // Match to a video file by basename prefix
        const subBaseParts = path.basename(entry, ext).toLowerCase().split('.');
        let matchedFile: MediaFile | null = null;

        // Try progressively shorter prefixes to find the video name
        for (let len = subBaseParts.length - 1; len >= 1; len--) {
          const candidate = subBaseParts.slice(0, len).join('.');
          if (fileByBasename.has(candidate)) {
            matchedFile = fileByBasename.get(candidate)!;
            break;
          }
        }

        if (!matchedFile) continue;

        // Parse language + flags from filename
        const parsed = this.parseSubtitleFilename(entry);
        if (!parsed) continue;

        await this.repo.save({
          media: { id: mediaId },
          mediaFile: { id: matchedFile.id },
          episode: matchedFile.episodeId ? { id: matchedFile.episodeId } : null,
          language: parsed.language,
          forced: parsed.forced,
          hearingImpaired: parsed.hearingImpaired,
          providerType: SubtitleProviderType.DISK,
          relativePath: relPath,
          status: SubtitleStatus.DOWNLOADED,
          score: 100,
          synced: true,
        } as any);

        existingPaths.add(relPath);
        discovered++;
        this.logger.log(
          `Discovered external subtitle: "${relPath}" (${parsed.language}${parsed.forced ? '.forced' : ''}${parsed.hearingImpaired ? '.hi' : ''}) → media file #${matchedFile.id}`,
        );
      }
    }

    return discovered;
  }

  async deleteSubtitle(id: number): Promise<void> {
    const subtitle = await this.repo.findOne({ where: { id } });
    if (!subtitle) throw new NotFoundException(`SubtitleFile #${id} not found`);
    if (subtitle.providerType === SubtitleProviderType.EMBEDDED) {
      throw new BadRequestException('Cannot delete an embedded subtitle');
    }

    const abs = await this.resolveSubtitleAbsolute(subtitle);
    if (abs) {
      try {
        await fs.unlink(abs);
      } catch {
        this.logger.warn(`Could not delete file: ${abs}`);
      }
    }

    await this.repo.remove(subtitle);
  }

  async upgradeSubtitle(
    id: number,
    newResult: SubtitleSearchResult,
  ): Promise<SubtitleFile> {
    const existing = await this.repo.findOne({ where: { id } });
    if (!existing) throw new NotFoundException(`SubtitleFile #${id} not found`);
    if (existing.providerType === SubtitleProviderType.EMBEDDED) {
      throw new BadRequestException('Cannot upgrade an embedded subtitle');
    }

    const oldAbs = await this.resolveSubtitleAbsolute(existing);
    if (oldAbs) {
      try {
        await fs.unlink(oldAbs);
      } catch {
        this.logger.warn(`Could not delete old file: ${oldAbs}`);
      }
    }

    const updated = await this.downloadSubtitle(
      existing.mediaId,
      existing.mediaFileId,
      existing.episodeId,
      newResult,
    );
    updated.status = SubtitleStatus.UPGRADED;
    await this.repo.save(updated);

    await this.repo.remove(existing);
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Subtitle blacklist
  // ---------------------------------------------------------------------------

  async blacklistSubtitle(dto: {
    providerType: string;
    providerFileId: string;
    mediaId?: number;
    language?: string;
    sourceTitle?: string;
    reason?: string;
  }): Promise<SubtitleBlacklist> {
    const entry = this.blacklistRepo.create(dto);
    return this.blacklistRepo.save(entry);
  }

  async getBlacklist(
    page = 1,
    limit = 25,
  ): Promise<{ data: SubtitleBlacklist[]; total: number }> {
    const [data, total] = await this.blacklistRepo.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total };
  }

  async removeFromBlacklist(id: number): Promise<void> {
    const entry = await this.blacklistRepo.findOne({ where: { id } });
    if (!entry) throw new NotFoundException(`Blacklist entry #${id} not found`);
    await this.blacklistRepo.remove(entry);
  }

  async clearBlacklist(): Promise<{ deleted: number }> {
    const result = await this.blacklistRepo.delete({});
    return { deleted: result.affected ?? 0 };
  }

  // ---------------------------------------------------------------------------
  // Post-processing actions
  // ---------------------------------------------------------------------------

  async applyPostProcessing(
    subtitleId: number,
    action: string,
    params?: Record<string, unknown>,
  ): Promise<SubtitleFile> {
    const sub = await this.repo.findOne({ where: { id: subtitleId } });
    if (!sub)
      throw new NotFoundException(`SubtitleFile #${subtitleId} not found`);
    if (!sub.relativePath)
      throw new BadRequestException('Subtitle has no file path');

    const abs = await this.resolveSubtitleAbsolute(sub);
    if (!abs)
      throw new NotFoundException('Subtitle file path could not be resolved');

    const paramsStr = params ? JSON.stringify(params) : '';
    this.logger.log(
      `PostProcess #${subtitleId}: ${action}${paramsStr ? ` ${paramsStr}` : ''} on "${sub.relativePath}" → ${abs}`,
    );

    let content = await fs.readFile(abs, 'utf-8');
    const sizeBefore = content.length;

    switch (action) {
      case 'removeHiTags': {
        const buf = cleanSubtitle(Buffer.from(content, 'utf-8'), {
          removeAds: false,
          removeHiTags: true,
        });
        content = buf.toString('utf-8');
        break;
      }
      case 'removeStyleTags':
        content = postProcess.removeStyleTags(content);
        break;
      case 'removeEmoji':
        content = postProcess.removeEmoji(content);
        break;
      case 'ocrFixes':
        content = postProcess.fixOcr(content);
        break;
      case 'commonFixes':
        content = postProcess.commonFixes(content);
        break;
      case 'fixUppercase':
        content = postProcess.fixUppercase(content);
        break;
      case 'reverseRtl':
        content = postProcess.reverseRtl(content);
        break;
      case 'adjustTimes':
        content = postProcess.adjustTimes(
          content,
          Number(params?.offsetMs ?? 0),
        );
        break;
      case 'changeFrameRate':
        content = postProcess.changeFrameRate(
          content,
          Number(params?.fromFps ?? 23.976),
          Number(params?.toFps ?? 25),
        );
        break;
      case 'convertToSrt':
        content = postProcess.assToSrt(content);
        break;
      default:
        throw new BadRequestException(
          `Unknown post-processing action: ${action}`,
        );
    }

    await fs.writeFile(abs, content, 'utf-8');
    sub.locked = true;
    await this.repo.save(sub);
    // Log a sample of the first timestamp to verify the change
    const sampleMatch = content.match(/\d{2}:\d{2}:\d{2},\d{3}/);
    this.logger.log(
      `PostProcess #${subtitleId}: ${action} done (${sizeBefore} → ${content.length} chars, first timestamp: ${sampleMatch?.[0] ?? 'none'})`,
    );
    return sub;
  }
}
