import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import * as path from 'path';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { SubtitlesService } from '../subtitles/subtitles.service';
import { SubtitleSyncService } from '../subtitles/subtitle-sync.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { SubtitleProviderType, SubtitleStatus } from '../../common/enums';
import {
  hasServableTextSub,
  isOcrSupportedSubtitleCodec,
} from '../../common/constants/subtitle-codecs';
import {
  SubtitleLanguageItem,
  resolveHearingImpairedMode,
} from '../profiles/entities/language-profile.entity';
import { EmbeddedSubtitleService } from '../subtitles/embedded-subtitle.service';
import { SubtitleOcrService } from '../subtitles/subtitle-ocr.service';
import { MediaServersService } from '../media-servers/media-servers.service';

@Injectable()
export class SubtitleSchedulerService {
  private readonly log = new Logger(SubtitleSchedulerService.name);
  private lastSearchRun = 0;
  private lastUpgradeRun = 0;
  /** Guards against the manual "search missing" action racing the scheduled
   *  pass on the same file, which would search and download the same
   *  language twice. */
  private readonly filesSearching = new Set<number>();

  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    @InjectRepository(SubtitleFile)
    private readonly subtitleFileRepo: Repository<SubtitleFile>,
    private readonly subtitlesService: SubtitlesService,
    private readonly subtitleSync: SubtitleSyncService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly embeddedSubtitle: EmbeddedSubtitleService,
    private readonly subtitleOcr: SubtitleOcrService,
    private readonly mediaServers: MediaServersService,
  ) {}

  /** Every 6 hours, run the search/upgrade passes whose configured interval
   *  has elapsed (intervals shorter than the tick are effectively floored to
   *  6 hours). */
  @Cron(CronExpression.EVERY_6_HOURS)
  async tick(): Promise<void> {
    const now = Date.now();
    const searchInterval =
      Number((await this.settings.get('subtitle_search_interval')) ?? '360') *
      60_000;
    const upgradeInterval =
      Number((await this.settings.get('subtitle_upgrade_interval')) ?? '720') *
      60_000;

    if (now - this.lastSearchRun >= searchInterval) {
      this.lastSearchRun = now;
      await this.searchMissingSubtitles();
    }
    if (now - this.lastUpgradeRun >= upgradeInterval) {
      this.lastUpgradeRun = now;
      await this.upgradeSubtitles();
    }
  }

  async searchMissingSubtitles(): Promise<void> {
    const autoSearch = await this.settings.get('subtitle_auto_search');
    if (autoSearch === 'false') return;

    const opts = await this.resolveSearchOpts();

    // Walked in batches: hydrating every monitored media with `files` and the
    // episode/season joins in one query builds the whole library in memory
    // before the first search even starts. Ordered by id so a batch boundary
    // cannot skip or repeat a row.
    const BATCH = 50;
    for (let skip = 0; ; skip += BATCH) {
      const batch = await this.mediaRepo.find({
        where: { monitored: true },
        relations: [
          'languageProfile',
          'files',
          'files.episode',
          'files.episode.season',
        ],
        order: { id: 'ASC' },
        take: BATCH,
        skip,
      });
      if (!batch.length) return;

      for (const media of batch) {
        if (!media.files?.length) continue;
        for (const file of media.files) {
          await this.searchMissingForFile(media, file, opts);
        }
      }
    }
  }

  /** Read the shared search/download settings in one place (no per-call drift). */
  private async resolveSearchOpts(): Promise<{
    minScore: number;
    autoSyncEnabled: boolean;
    encodeUtf8: boolean;
  }> {
    // `subtitle_min_score` is read as PERCENT (0-100) of the centralised
    // scorer's max — see `subtitle-scorer.ts`.
    return {
      minScore: Number((await this.settings.get('subtitle_min_score')) ?? '70'),
      autoSyncEnabled:
        (await this.settings.get('subtitle_auto_sync')) === 'true',
      encodeUtf8: (await this.settings.get('subtitle_encode_utf8')) !== 'false',
    };
  }

  /**
   * Search and download every required subtitle language still missing on one
   * file. A non-FAILED sub (downloaded or EMBEDDED) counts as present, so an
   * embedded track suppresses its language. Shared by the scheduled pass and
   * the manual "search missing" action. Returns the iso codes downloaded.
   */
  private async searchMissingForFile(
    media: Media,
    file: MediaFile,
    opts: { minScore: number; autoSyncEnabled: boolean; encodeUtf8: boolean },
    skipEmbeddedDetect = false,
  ): Promise<string[]> {
    if (this.filesSearching.has(file.id)) return [];
    this.filesSearching.add(file.id);
    try {
      return await this.doSearchMissingForFile(media, file, opts, skipEmbeddedDetect);
    } finally {
      this.filesSearching.delete(file.id);
    }
  }

  private async doSearchMissingForFile(
    media: Media,
    file: MediaFile,
    opts: { minScore: number; autoSyncEnabled: boolean; encodeUtf8: boolean },
    skipEmbeddedDetect = false,
  ): Promise<string[]> {
    const subtitleLangs: SubtitleLanguageItem[] =
      media.languageProfile?.subtitleLanguages ?? [];
    if (!subtitleLangs.length) return [];

    // Skipped when the caller (onMediaFileImported) just ran this same probe.
    if (!skipEmbeddedDetect) {
      await this.embeddedSubtitle.detectAndStore(
        media.id,
        file.id,
        file.episodeId ?? undefined,
      );
    }

    const existingSubs = await this.subtitleFileRepo.find({
      where: { mediaFile: { id: file.id } },
    });

    const videoReleaseName = path.basename(
      file.relativePath,
      path.extname(file.relativePath),
    );
    const fileSeason = file.episode?.season?.seasonNumber ?? undefined;
    const fileEpisode = file.episode?.episodeNumber ?? undefined;
    const episodeTag =
      fileSeason != null && fileEpisode != null
        ? ` S${String(fileSeason).padStart(2, '0')}E${String(fileEpisode).padStart(2, '0')}`
        : '';

    const downloaded: string[] = [];

    for (const langItem of subtitleLangs) {
      if (hasServableTextSub(existingSubs, langItem.isoCode)) continue;

      // OCR-first: an embedded image track in this language is converted to
      // text in preference to a provider download — it's perfectly synced to
      // this exact file and costs no provider quota. Falls through to the
      // providers when there's no image track (or OCR is disabled).
      if (await this.tryOcrFirst(existingSubs, langItem.isoCode)) {
        downloaded.push(langItem.isoCode);
        continue;
      }

      try {
        const results = await this.subtitlesService.searchSubtitles({
          imdbId: media.imdbId ?? undefined,
          tmdbId: media.tmdbId,
          title: media.title,
          year: media.year ?? undefined,
          language: langItem.isoCode,
          season: fileSeason,
          episode: fileEpisode,
          videoReleaseName,
          moviehash: file.osdbHash ?? undefined,
          moviebytesize: file.osdbBytesize ?? undefined,
          hearingImpairedMode: resolveHearingImpairedMode(langItem),
        });

        const best = results.find((r) => r.score >= opts.minScore);
        if (!best) continue;

        const sub = await this.subtitlesService.downloadSubtitle(
          media.id,
          file.id,
          file.episodeId ?? undefined,
          best,
        );

        if (opts.encodeUtf8) {
          await this.subtitleSync.reencodeToUtf8(sub.id);
        }
        if (opts.autoSyncEnabled) {
          await this.subtitleSync.syncSubtitle(sub.id, { automatic: true });
        }

        void this.notifications.dispatch('subtitle.downloaded', {
          title: media.title,
          language: langItem.isoCode,
          provider: best.providerName,
          score: best.score,
        });

        void this.mediaServers.dispatch('subtitle.downloaded', {
          title: media.title,
          path: media.path,
        });

        downloaded.push(langItem.isoCode);

        this.log.log(
          `SubtitleSearch: downloaded ${langItem.isoCode} sub for "${media.title}"${episodeTag} (score: ${best.score})`,
        );
      } catch (err) {
        this.log.warn(
          `SubtitleSearch: failed for "${media.title}"${episodeTag} [${langItem.isoCode}]: ${err}`,
        );
        void this.notifications.dispatch('subtitle.failed', {
          title: media.title,
          language: langItem.isoCode,
          error: String(err),
        });
      }
    }

    return downloaded;
  }

  /**
   * OCR-first source for one wanted language. Kicks off a background OCR of an
   * embedded image track in `isoCode` and returns true when OCR handles the
   * language (a run started, or one is already in progress/done) so the caller
   * skips the provider search. Returns false when OCR is disabled, no image
   * track exists, or the run couldn't start — letting providers take over.
   * Gated by `subtitle_ocr_burn_in_auto`. Untagged ('und') tracks are excluded
   * since auto can't pick the OCR language; those stay to the manual flow.
   */
  private async tryOcrFirst(
    existingSubs: SubtitleFile[],
    isoCode: string,
  ): Promise<boolean> {
    if ((await this.settings.get('subtitle_ocr_burn_in_auto')) !== 'true') {
      return false;
    }
    if (!isoCode || isoCode === 'und') return false;

    const alreadyHandled = existingSubs.some(
      (s) =>
        s.language === isoCode &&
        s.providerType === SubtitleProviderType.OCR &&
        s.status !== SubtitleStatus.FAILED,
    );
    if (alreadyHandled) return true;

    const imageSub = existingSubs.find(
      (s) =>
        s.language === isoCode &&
        isOcrSupportedSubtitleCodec(s.codec) &&
        s.streamIndex != null &&
        s.status !== SubtitleStatus.FAILED,
    );
    if (!imageSub) return false;

    try {
      await this.subtitleOcr.ocrSubtitle(imageSub.id, isoCode, { automatic: true });
      return true;
    } catch (err) {
      this.log.warn(`SubtitleOcr: OCR-first failed for ${isoCode}: ${err}`);
      return false;
    }
  }

  /**
   * Manual "search missing" for one media file. Same gap-filling logic as the
   * scheduled pass, but user-initiated, so it deliberately ignores the
   * `subtitle_auto_search` toggle (that gate governs only the automatic passes).
   */
  async searchMissingForMedia(
    mediaId: number,
    mediaFileId: number,
  ): Promise<{ downloaded: string[] }> {
    const media = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: [
        'languageProfile',
        'files',
        'files.episode',
        'files.episode.season',
      ],
    });
    const file = media?.files?.find((f) => f.id === mediaFileId);
    if (!media || !file) return { downloaded: [] };

    const opts = await this.resolveSearchOpts();
    return { downloaded: await this.searchMissingForFile(media, file, opts) };
  }

  async upgradeSubtitles(): Promise<void> {
    const autoSearch = await this.settings.get('subtitle_auto_search');
    if (autoSearch === 'false') return;

    const threshold = Number(
      (await this.settings.get('subtitle_upgrade_threshold')) ?? '90',
    );
    const opts = await this.resolveSearchOpts();

    // Walked by ascending id rather than OFFSET: an upgrade raises the sub's
    // score past the threshold, so the row leaves the filtered set mid-walk and
    // a positional cursor would step over its successors. An id cursor cannot.
    // Batching also bounds `buildMissingLangsByFile`'s `IN (...)` list, which
    // took every low-score file id at once.
    const BATCH = 100;
    let lastId = 0;
    for (;;) {
      const lowScoreSubs = await this.subtitleFileRepo
        .createQueryBuilder('sf')
        .where('sf.score < :threshold', { threshold })
        .andWhere('sf.status != :failed', { failed: SubtitleStatus.FAILED })
        .andWhere('sf.locked = false')
        .andWhere('sf.id > :lastId', { lastId })
        .leftJoinAndSelect('sf.media', 'media')
        .leftJoinAndSelect('media.languageProfile', 'lp')
        .leftJoinAndSelect('sf.mediaFile', 'mf')
        .leftJoinAndSelect('mf.episode', 'mfEpisode')
        .leftJoinAndSelect('mfEpisode.season', 'mfSeason')
        .orderBy('sf.id', 'ASC')
        .take(BATCH)
        .getMany();
      if (!lowScoreSubs.length) return;
      lastId = lowScoreSubs[lowScoreSubs.length - 1].id;

      // "Languages still missing on file F", resolved per batch so the upgrade
      // loop pays no N+1. A file with even one required language and zero
      // (non-failed) subs for it counts as still missing — upgrade defers to the
      // next missing-search pass there, rather than spending provider quota on
      // score bumps while gaps remain.
      const fileIds = [
        ...new Set(
          lowScoreSubs.map((s) => s.mediaFile?.id).filter((id): id is number => id != null),
        ),
      ];
      const missingByFileId = await this.buildMissingLangsByFile(
        fileIds,
        lowScoreSubs,
      );

      await this.upgradeBatch(lowScoreSubs, missingByFileId, opts);
    }
  }

  private async upgradeBatch(
    lowScoreSubs: SubtitleFile[],
    missingByFileId: Map<number, boolean>,
    opts: { minScore: number; autoSyncEnabled: boolean; encodeUtf8: boolean },
  ): Promise<void> {
    for (const sub of lowScoreSubs) {
      // The profile is the contract: a language it doesn't ask for is never
      // searched, downloaded, nor allowed to replace a file on disk.
      const langItem = sub.media?.languageProfile?.subtitleLanguages?.find(
        (l) => l.isoCode === sub.language,
      );
      if (!langItem) continue;
      if (sub.mediaFile?.id != null && missingByFileId.get(sub.mediaFile.id)) {
        this.log.debug?.(
          `SubtitleUpgrade: skipping sub #${sub.id} ("${sub.media?.title}", ${sub.language}) — file still has missing required languages, deferring to next missing-search pass`,
        );
        continue;
      }
      try {
        const fileRel = sub.mediaFile?.relativePath;
        const videoReleaseName = fileRel
          ? path.basename(fileRel, path.extname(fileRel))
          : undefined;
        const results = await this.subtitlesService.searchSubtitles({
          imdbId: sub.media?.imdbId ?? undefined,
          tmdbId: sub.media?.tmdbId,
          title: sub.media?.title ?? '',
          year: sub.media?.year ?? undefined,
          language: sub.language,
          season: sub.mediaFile?.episode?.season?.seasonNumber ?? undefined,
          episode: sub.mediaFile?.episode?.episodeNumber ?? undefined,
          videoReleaseName,
          moviehash: sub.mediaFile?.osdbHash ?? undefined,
          moviebytesize: sub.mediaFile?.osdbBytesize ?? undefined,
          hearingImpairedMode: resolveHearingImpairedMode(langItem),
        });

        // Invariant: a hash-matched sub is the perfect time sync — refuse
        // to replace it with a non-hash candidate, no matter what the
        // score says. A non-hash sub from a slightly-better release
        // doesn't beat a verified hash match.
        const candidates = sub.hashMatched
          ? results.filter((r) => r.hashMatched)
          : results;
        const better = candidates.find((r) => r.score > sub.score);
        if (!better) continue;

        const upgraded = await this.subtitlesService.upgradeSubtitle(
          sub.id,
          better,
        );

        if (opts.encodeUtf8) {
          await this.subtitleSync.reencodeToUtf8(upgraded.id);
        }
        if (opts.autoSyncEnabled) {
          await this.subtitleSync.syncSubtitle(upgraded.id, { automatic: true });
        }

        void this.notifications.dispatch('subtitle.upgraded', {
          title: sub.media?.title,
          language: sub.language,
          oldScore: sub.score,
          newScore: better.score,
          provider: better.providerName,
        });

        void this.mediaServers.dispatch('subtitle.upgraded', {
          title: sub.media?.title,
          path: sub.media?.path,
        });

        const upgradeSeason = sub.mediaFile?.episode?.season?.seasonNumber;
        const upgradeEpisode = sub.mediaFile?.episode?.episodeNumber;
        const upgradeEpisodeTag =
          upgradeSeason != null && upgradeEpisode != null
            ? ` S${String(upgradeSeason).padStart(2, '0')}E${String(upgradeEpisode).padStart(2, '0')}`
            : '';
        this.log.log(
          `SubtitleUpgrade: upgraded ${sub.language} for "${sub.media?.title}"${upgradeEpisodeTag} (${sub.score} → ${better.score})`,
        );
      } catch (err) {
        this.log.warn(`SubtitleUpgrade: failed for sub #${sub.id}: ${err}`);
      }
    }
  }

  /**
   * For each media file id, decides whether it still has at least one
   * required-by-profile subtitle language with no usable file. The map
   * value is `true` when the upgrade pass should skip the file and leave
   * the work to the next missing-search pass.
   */
  private async buildMissingLangsByFile(
    fileIds: number[],
    candidatesWithMedia: SubtitleFile[],
  ): Promise<Map<number, boolean>> {
    const result = new Map<number, boolean>();
    if (!fileIds.length) return result;

    const subsByFile = new Map<number, SubtitleFile[]>();
    const allFileSubs = await this.subtitleFileRepo.find({
      where: { mediaFile: { id: In(fileIds) } },
      relations: ['mediaFile'],
    });
    for (const s of allFileSubs) {
      const fid = s.mediaFile?.id;
      if (fid == null) continue;
      const list = subsByFile.get(fid) ?? [];
      list.push(s);
      subsByFile.set(fid, list);
    }

    const profileByFile = new Map<number, SubtitleLanguageItem[]>();
    for (const cand of candidatesWithMedia) {
      const fid = cand.mediaFile?.id;
      if (fid == null || profileByFile.has(fid)) continue;
      profileByFile.set(
        fid,
        cand.media?.languageProfile?.subtitleLanguages ?? [],
      );
    }

    for (const fid of fileIds) {
      const required = profileByFile.get(fid) ?? [];
      if (!required.length) {
        result.set(fid, false);
        continue;
      }
      const present = new Set(
        (subsByFile.get(fid) ?? [])
          .filter((s) => s.status !== SubtitleStatus.FAILED)
          .map((s) => s.language),
      );
      result.set(fid, required.some((l) => !present.has(l.isoCode)));
    }
    return result;
  }

  /** Called after a media file import to trigger subtitle search */
  async onMediaFileImported(
    mediaId: number,
    mediaFileId: number,
    episodeId?: number,
  ): Promise<void> {
    // Always detect & store embedded subtitles first — independent of the
    // auto-search setting and the language profile. Skipping this when
    // auto_search is disabled (or no languages are configured) used to
    // leave embedded tracks invisible in the subtitle_files table even
    // though ffprobe sees them.
    await this.embeddedSubtitle.detectAndStore(mediaId, mediaFileId, episodeId);

    const autoSearch = await this.settings.get('subtitle_auto_search');
    if (autoSearch === 'false') return;

    const media = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: [
        'languageProfile',
        'files',
        'files.episode',
        'files.episode.season',
      ],
    });
    const file = media?.files?.find((f) => f.id === mediaFileId);
    if (!media || !file) return;

    // Same gap-filling as the scheduled pass: servable-text gate, OCR-first on
    // embedded image tracks, then providers. Keeps the post-import and periodic
    // paths from drifting. `true`: embedded subtitles were just detected above.
    await this.searchMissingForFile(
      media,
      file,
      await this.resolveSearchOpts(),
      true,
    );
  }
}
