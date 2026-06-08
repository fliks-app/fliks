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
  SubtitleLanguageItem,
  resolveHearingImpairedMode,
} from '../profiles/entities/language-profile.entity';
import { EmbeddedSubtitleService } from '../subtitles/embedded-subtitle.service';
import { MediaServersService } from '../media-servers/media-servers.service';

@Injectable()
export class SubtitleSchedulerService {
  private readonly log = new Logger(SubtitleSchedulerService.name);
  private lastSearchRun = 0;
  private lastUpgradeRun = 0;

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
    private readonly mediaServers: MediaServersService,
  ) {}

  /** Check every minute if it's time to run search or upgrade */
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

    const mediaList = await this.mediaRepo.find({
      where: { monitored: true },
      relations: [
        'languageProfile',
        'files',
        'files.episode',
        'files.episode.season',
      ],
    });

    for (const media of mediaList) {
      if (!media.files?.length) continue;
      for (const file of media.files) {
        await this.searchMissingForFile(media, file, opts);
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
  ): Promise<string[]> {
    const subtitleLangs: SubtitleLanguageItem[] =
      media.languageProfile?.subtitleLanguages ?? [];
    if (!subtitleLangs.length) return [];

    // Ensure embedded subtitles are detected before checking for missing ones
    await this.embeddedSubtitle.detectAndStore(
      media.id,
      file.id,
      file.episodeId ?? undefined,
    );

    const existingSubs = await this.subtitleFileRepo.find({
      where: { mediaFile: { id: file.id } },
    });

    const videoReleaseName = path.basename(
      file.relativePath,
      path.extname(file.relativePath),
    );
    const fileSeason = file.episode?.season?.seasonNumber ?? undefined;
    const fileEpisode = file.episode?.episodeNumber ?? undefined;

    const downloaded: string[] = [];

    for (const langItem of subtitleLangs) {
      const hasSub = existingSubs.some(
        (s) =>
          s.language === langItem.isoCode &&
          s.status !== SubtitleStatus.FAILED,
      );
      if (hasSub) continue;

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
          await this.subtitleSync.syncSubtitle(sub.id);
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
          `SubtitleSearch: downloaded ${langItem.isoCode} sub for "${media.title}" (score: ${best.score})`,
        );
      } catch (err) {
        this.log.warn(
          `SubtitleSearch: failed for "${media.title}" [${langItem.isoCode}]: ${err}`,
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

    const lowScoreSubs = await this.subtitleFileRepo
      .createQueryBuilder('sf')
      .where('sf.score < :threshold', { threshold })
      .andWhere('sf.status != :failed', { failed: SubtitleStatus.FAILED })
      .andWhere('sf.locked = false')
      .leftJoinAndSelect('sf.media', 'media')
      .leftJoinAndSelect('media.languageProfile', 'lp')
      .leftJoinAndSelect('sf.mediaFile', 'mf')
      .leftJoinAndSelect('mf.episode', 'mfEpisode')
      .leftJoinAndSelect('mfEpisode.season', 'mfSeason')
      .getMany();

    // Build "languages still missing on file F" map upfront so we don't pay
    // an N+1 inside the upgrade loop. A file with even one required language
    // and zero (non-failed) subs for it counts as "still missing" — upgrade
    // defers to the next missing-search pass on those files so we don't
    // spend provider quota on score bumps while gaps remain.
    const fileIds = [
      ...new Set(
        lowScoreSubs.map((s) => s.mediaFile?.id).filter((id): id is number => id != null),
      ),
    ];
    const missingByFileId = await this.buildMissingLangsByFile(
      fileIds,
      lowScoreSubs,
    );

    for (const sub of lowScoreSubs) {
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
        const langItem = sub.media?.languageProfile?.subtitleLanguages?.find(
          (l) => l.isoCode === sub.language,
        );
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
          hearingImpairedMode: langItem
            ? resolveHearingImpairedMode(langItem)
            : 'avoid',
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

        await this.subtitlesService.upgradeSubtitle(sub.id, better);

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

        this.log.log(
          `SubtitleUpgrade: upgraded ${sub.language} for "${sub.media?.title}" (${sub.score} → ${better.score})`,
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
    const embeddedSubs = await this.embeddedSubtitle.detectAndStore(
      mediaId,
      mediaFileId,
      episodeId,
    );
    const embeddedLangs = new Set(embeddedSubs.map((s) => s.language));

    const autoSearch = await this.settings.get('subtitle_auto_search');
    if (autoSearch === 'false') return;

    const media = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: ['languageProfile'],
    });
    if (!media) return;

    const subtitleLangs: SubtitleLanguageItem[] =
      media.languageProfile?.subtitleLanguages ?? [];
    if (!subtitleLangs.length) return;

    const mediaFile = await this.mediaFileRepo.findOne({
      where: { id: mediaFileId },
      relations: ['episode', 'episode.season'],
    });
    if (!mediaFile) return;

    const minScore = Number(
      (await this.settings.get('subtitle_min_score')) ?? '70',
    );
    const autoSyncEnabled =
      (await this.settings.get('subtitle_auto_sync')) === 'true';
    const encodeUtf8 =
      (await this.settings.get('subtitle_encode_utf8')) !== 'false';

    const videoReleaseName = path.basename(
      mediaFile.relativePath,
      path.extname(mediaFile.relativePath),
    );
    const fileSeason = mediaFile.episode?.season?.seasonNumber ?? undefined;
    const fileEpisode = mediaFile.episode?.episodeNumber ?? undefined;

    for (const langItem of subtitleLangs) {
      if (embeddedLangs.has(langItem.isoCode)) {
        this.log.log(
          `PostImport: skipping ${langItem.isoCode} for "${media.title}" — embedded subtitle found`,
        );
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
          moviehash: mediaFile.osdbHash ?? undefined,
          moviebytesize: mediaFile.osdbBytesize ?? undefined,
          hearingImpairedMode: resolveHearingImpairedMode(langItem),
        });

        const best = results.find((r) => r.score >= minScore);
        if (!best) {
          this.log.log(
            `PostImport: no ${langItem.isoCode} subtitle for "${media.title}" cleared min score ${minScore} (best candidate ${results[0]?.score ?? 'none'})`,
          );
          continue;
        }

        const sub = await this.subtitlesService.downloadSubtitle(
          mediaId,
          mediaFileId,
          episodeId,
          best,
        );

        if (encodeUtf8) {
          await this.subtitleSync.reencodeToUtf8(sub.id);
        }
        if (autoSyncEnabled) {
          await this.subtitleSync.syncSubtitle(sub.id);
        }

        this.log.log(
          `PostImport subtitle: ${langItem.isoCode} for "${media.title}"`,
        );
      } catch (err) {
        this.log.warn(
          `PostImport subtitle failed for "${media.title}" [${langItem.isoCode}]: ${err}`,
        );
      }
    }
  }
}
