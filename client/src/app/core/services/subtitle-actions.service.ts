import { Injectable, inject, WritableSignal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { SubtitlesApiService, SubtitleFileRow, SyncOptions } from './api/subtitles-api.service';
import { ToastService } from './toast.service';

/**
 * Shared subtitle actions used by both media-detail and episode-detail pages.
 * Each method takes the signals it needs to update, avoiding tight coupling.
 */
@Injectable({ providedIn: 'root' })
export class SubtitleActionsService {
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  async sync(mediaId: number, subtitleId: number, options: SyncOptions) {
    this.toast.info(this.translate.instant('media_detail.sync_started'));
    try {
      await this.subtitlesApi.sync(mediaId, subtitleId, options);
    } catch { /* global interceptor */ }
  }

  async postProcess(mediaId: number, subtitleId: number, action: string, params?: Record<string, unknown>) {
    try {
      await this.subtitlesApi.postProcess(mediaId, subtitleId, action, params);
      this.toast.success(this.translate.instant('media_detail.post_process_success'));
    } catch { /* global interceptor */ }
  }

  async blacklist(mediaId: number, sub: SubtitleFileRow, subtitles: WritableSignal<SubtitleFileRow[]>) {
    try {
      await this.subtitlesApi.addToBlacklist({
        providerType: sub.providerType,
        providerFileId: sub.providerFileId,
        mediaId,
        language: sub.language,
        sourceTitle: sub.providerFileId,
        reason: 'Manually blacklisted',
      });
      await this.subtitlesApi.delete(mediaId, sub.id);
      this.toast.success(this.translate.instant('media_detail.blacklist_success'));
      subtitles.update(list => list.filter(s => s.id !== sub.id));
    } catch { /* global interceptor */ }
  }

  async remove(mediaId: number, subtitleId: number, subtitles: WritableSignal<SubtitleFileRow[]>, busy: WritableSignal<boolean>) {
    busy.set(true);
    try {
      await this.subtitlesApi.delete(mediaId, subtitleId);
      subtitles.update(list => list.filter(s => s.id !== subtitleId));
    } finally {
      busy.set(false);
    }
  }

  async searchMissing(
    mediaId: number, mediaFileId: number,
    subtitles: WritableSignal<SubtitleFileRow[]>, busy: WritableSignal<boolean>,
  ) {
    busy.set(true);
    try {
      await this.subtitlesApi.searchMissing(mediaId, { mediaFileId });
      subtitles.set(await this.subtitlesApi.getForMedia(mediaId));
    } finally {
      busy.set(false);
    }
  }

  async search(mediaId: number, language: string, episodeId?: number) {
    return this.subtitlesApi.search(mediaId, language, episodeId);
  }

  async download(
    mediaId: number, mediaFileId: number, result: any,
    subtitles: WritableSignal<SubtitleFileRow[]>, busy: WritableSignal<boolean>,
    episodeId?: number,
  ) {
    busy.set(true);
    try {
      await this.subtitlesApi.download(mediaId, { searchResult: result, mediaFileId, episodeId });
      subtitles.set(await this.subtitlesApi.getForMedia(mediaId));
    } finally {
      busy.set(false);
    }
  }
}
