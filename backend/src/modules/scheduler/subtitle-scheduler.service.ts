import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { SubtitlesService } from '../subtitles/subtitles.service';
import { SubtitleSyncService } from '../subtitles/subtitle-sync.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { SubtitleStatus } from '../../common/enums';
import { SubtitleLanguageItem } from '../profiles/entities/language-profile.entity';

@Injectable()
export class SubtitleSchedulerService {
  private readonly log = new Logger(SubtitleSchedulerService.name);

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
  ) {}

  /** Search for missing subtitles — runs every 6 hours */
  @Cron(CronExpression.EVERY_6_HOURS)
  async searchMissingSubtitles(): Promise<void> {
    const autoSearch = await this.settings.get('subtitle_auto_search');
    if (autoSearch === 'false') return;

    const minScore = Number(
      (await this.settings.get('subtitle_min_score')) ?? '70',
    );
    const autoSyncEnabled =
      (await this.settings.get('subtitle_auto_sync')) === 'true';
    const encodeUtf8 =
      (await this.settings.get('subtitle_encode_utf8')) !== 'false';

    const mediaList = await this.mediaRepo.find({
      where: { monitored: true },
      relations: ['languageProfile', 'files'],
    });

    for (const media of mediaList) {
      const subtitleLangs: SubtitleLanguageItem[] =
        media.languageProfile?.subtitleLanguages ?? [];
      if (!subtitleLangs.length) continue;
      if (!media.files?.length) continue;

      for (const file of media.files) {
        const existingSubs = await this.subtitleFileRepo.find({
          where: { mediaFileId: file.id },
        });

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
            });

            const best = results.find((r) => r.score >= minScore);
            if (!best) continue;

            const sub = await this.subtitlesService.downloadSubtitle(
              media.id,
              file.id,
              file.episodeId ?? undefined,
              best,
              file.relativePath,
            );

            if (encodeUtf8) {
              await this.subtitleSync.reencodeToUtf8(sub.id);
            }
            if (autoSyncEnabled) {
              await this.subtitleSync.syncSubtitle(sub.id, file.relativePath);
            }

            void this.notifications.dispatch('subtitle.downloaded', {
              title: media.title,
              language: langItem.isoCode,
              provider: best.providerName,
              score: best.score,
            });

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
      }
    }
  }

  /** Upgrade low-score subtitles — runs every 12 hours */
  @Cron(CronExpression.EVERY_12_HOURS)
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
      .leftJoinAndSelect('sf.media', 'media')
      .leftJoinAndSelect('sf.mediaFile', 'mf')
      .getMany();

    for (const sub of lowScoreSubs) {
      try {
        const results = await this.subtitlesService.searchSubtitles({
          imdbId: sub.media?.imdbId ?? undefined,
          tmdbId: sub.media?.tmdbId,
          title: sub.media?.title ?? '',
          language: sub.language,
        });

        const better = results.find((r) => r.score > sub.score);
        if (!better) continue;

        const mediaFilePath = sub.mediaFile?.relativePath ?? '';
        await this.subtitlesService.upgradeSubtitle(
          sub.id,
          better,
          mediaFilePath,
        );

        void this.notifications.dispatch('subtitle.upgraded', {
          title: sub.media?.title,
          language: sub.language,
          oldScore: sub.score,
          newScore: better.score,
          provider: better.providerName,
        });

        this.log.log(
          `SubtitleUpgrade: upgraded ${sub.language} for "${sub.media?.title}" (${sub.score} → ${better.score})`,
        );
      } catch (err) {
        this.log.warn(`SubtitleUpgrade: failed for sub #${sub.id}: ${err}`);
      }
    }
  }

  /** Called after a media file import to trigger subtitle search */
  async onMediaFileImported(
    mediaId: number,
    mediaFileId: number,
    episodeId?: number,
  ): Promise<void> {
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
    });
    if (!mediaFile) return;

    const minScore = Number(
      (await this.settings.get('subtitle_min_score')) ?? '70',
    );
    const autoSyncEnabled =
      (await this.settings.get('subtitle_auto_sync')) === 'true';
    const encodeUtf8 =
      (await this.settings.get('subtitle_encode_utf8')) !== 'false';

    for (const langItem of subtitleLangs) {
      try {
        const results = await this.subtitlesService.searchSubtitles({
          imdbId: media.imdbId ?? undefined,
          tmdbId: media.tmdbId,
          title: media.title,
          year: media.year ?? undefined,
          language: langItem.isoCode,
        });

        const best = results.find((r) => r.score >= minScore);
        if (!best) continue;

        const sub = await this.subtitlesService.downloadSubtitle(
          mediaId,
          mediaFileId,
          episodeId,
          best,
          mediaFile.relativePath,
        );

        if (encodeUtf8) {
          await this.subtitleSync.reencodeToUtf8(sub.id);
        }
        if (autoSyncEnabled) {
          await this.subtitleSync.syncSubtitle(sub.id, mediaFile.relativePath);
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
