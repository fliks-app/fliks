import {
  Component,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideSend } from '@lucide/angular';
import {
  SocialApiService,
  SocialUser,
} from '../../../core/services/api/social-api.service';
import { RecommendTarget } from '../../../core/services/recommend.service';
import { ModalHeaderComponent } from '../modal-header';
import { ToastService } from '../../../core/services/toast.service';

/**
 * Dialog to recommend a piece of content (movie / season / episode) to another
 * member. Mounted once at the layout level and opened from anywhere (the
 * media-detail header, season menu) through {@link RecommendService}. The
 * recipient list is restricted to connectable members (public profiles or
 * members the caller follows), reusing `/social/connectable`.
 */
@Component({
  selector: 'app-recommend-modal',
  imports: [FormsModule, TranslatePipe, LucideSend, ModalHeaderComponent],
  templateUrl: './recommend-modal.component.html',
})
export class RecommendModalComponent {
  private readonly social = inject(SocialApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  private readonly dialogEl =
    viewChild<ElementRef<HTMLDialogElement>>('dialog');

  readonly target = signal<RecommendTarget | null>(null);
  readonly message = signal('');
  readonly query = signal('');
  readonly results = signal<SocialUser[]>([]);
  readonly busyId = signal<number | null>(null);

  async open(target: RecommendTarget): Promise<void> {
    this.target.set(target);
    this.message.set('');
    this.query.set('');
    this.results.set([]);
    this.dialogEl()?.nativeElement.showModal();
    // Propose connectable members right away, before the user types.
    void this.onQuery('');
  }

  close() {
    this.dialogEl()?.nativeElement.close();
  }

  /** Search connectable members; an empty query returns default suggestions
   *  so results appear as soon as the dialog opens. */
  async onQuery(q: string): Promise<void> {
    this.query.set(q);
    const query = q.trim();
    try {
      const found = await this.social.searchConnectable(query);
      if (this.query().trim() !== query) return; // stale response
      this.results.set(found);
    } catch {
      this.results.set([]);
    }
  }

  async sendTo(user: SocialUser): Promise<void> {
    const target = this.target();
    if (!target || this.busyId() !== null) return;
    this.busyId.set(user.id);
    try {
      await this.social.recommend({
        recipientId: user.id,
        mediaId: target.mediaId,
        seasonId: target.seasonId,
        episodeId: target.episodeId,
        message: this.message().trim() || undefined,
      });
      this.toast.success(
        this.translate.instant('recommend.sent_toast', { username: user.username }),
      );
      this.close();
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    } finally {
      this.busyId.set(null);
    }
  }
}
