import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { serverMessage } from '../utils/server-message';
import { ConfirmationService } from './confirmation.service';
import { IdentifyModalService } from './identify-modal.service';
import { MediaService, type Media } from './api/media.service';
import { ToastService } from './toast.service';

/** The admin actions every title page shares (video, book, comic): one implementation behind the hero menu. */
@Injectable({ providedIn: 'root' })
export class MediaAdminService {
  private readonly media = inject(MediaService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly identifyModal = inject(IdentifyModalService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);

  identify(m: Media): void {
    this.identifyModal.open({
      mediaId: m.id,
      mediaType: m.type,
      title: m.title,
      year: m.year ?? null,
      path: m.path ?? null,
      tmdbId: m.tmdbId ?? null,
      tvdbId: m.tvdbId ?? null,
      imdbId: m.imdbId ?? null,
    });
  }

  /** Fire-and-forget: the `metadata.refreshed` / `metadata.failed` events toast and reload the page. */
  async refreshMetadata(id: number): Promise<void> {
    try {
      await this.media.refreshMetadata(id);
      this.toast.success(this.translate.instant('media_detail.refresh_launched'));
    } catch (err: unknown) {
      this.toast.error(serverMessage(err, this.translate, 'media_detail.refresh_error'));
    }
  }

  /** Asks whether to delete the title; false when the user declined. */
  confirmDelete(m: Media): Promise<boolean> {
    const messageKey = m.folderName ? 'media_detail.confirm_delete' : 'media_detail.delete_no_folder';
    return this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant(messageKey, { title: m.title }),
      variant: 'danger',
    });
  }

  /** Deletes the title and leaves its page. */
  async removeMedia(m: Media): Promise<void> {
    await this.media.delete(m.id);
    this.toast.success(this.translate.instant('media_detail.delete_success'));
    void this.router.navigate(['/']);
  }

  /** Confirms, deletes and leaves the page; false when the user declined. */
  async deleteMedia(m: Media): Promise<boolean> {
    if (!(await this.confirmDelete(m))) return false;
    await this.removeMedia(m);
    return true;
  }
}
