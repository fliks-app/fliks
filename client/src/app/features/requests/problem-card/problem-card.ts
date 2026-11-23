import { Component, computed, inject, input, output, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  PROBLEM_REOPEN_DAYS,
  ProblemDetail,
  ProblemRow,
  ProblemsService,
} from '../../../core/services/api/problems.service';
import { AuthService } from '../../../core/services/auth.service';
import { ToastService } from '../../../core/services/toast.service';
import { LocaleDatePipe } from '../../../core/pipes/locale-date.pipe';
import { formatBytes } from '../../../core/utils/format-bytes';
import { mediaDetailLink } from '../../../core/media-kinds';
import { TvRowDirective } from '../../../shared/directives/tv-row.directive';

export type ProblemResolveMode = 'resolve' | 'close';

/** Reopen 409 codes the card explains itself, keyed to their `problems.card.*` message. */
const REOPEN_ERRORS: Record<string, string> = {
  problem_already_open: 'problems.card.reopen_already_open',
  problem_cap: 'problems.card.reopen_cap',
  problem_reopen_window: 'problems.card.reopen_window',
};

interface Qoe {
  deviceLabel?: string | null;
  playMethod?: string | null;
  quality?: string | null;
  stallCount?: number | null;
  errorCount?: number | null;
  verdict?: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');

@Component({
  selector: 'app-problem-card',
  imports: [FormsModule, LocaleDatePipe, RouterLink, TranslatePipe, TvRowDirective],
  templateUrl: './problem-card.html',
})
export class ProblemCardComponent {
  private readonly api = inject(ProblemsService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly row = input.required<ProblemRow>();
  /** The list changed (reopened, withdrawn): refetch it. */
  readonly changed = output<void>();
  /** A manager asked to mark fixed or close; the list hosts the dialog. */
  readonly resolveRequested = output<ProblemResolveMode>();

  protected readonly expanded = signal(false);
  protected readonly detail = signal<ProblemDetail | null>(null);
  protected readonly draft = signal('');
  protected readonly reopening = signal(false);
  protected readonly reopenNote = signal('');
  protected readonly busy = signal(false);
  protected readonly size = formatBytes;

  protected readonly isManager = computed(() => this.auth.hasPermission('requests.manage'));
  protected readonly isActive = computed(() => this.row().status === 'open' || this.row().status === 'acknowledged');
  private readonly isReporter = computed(() => {
    const id = this.row().user?.id;
    return id != null && id === this.auth.user()?.id;
  });
  protected readonly canWithdraw = computed(() => this.isReporter() && this.isActive());
  protected readonly canReopen = computed(() => {
    const r = this.row();
    if (this.isManager()) return r.status === 'resolved' || r.status === 'closed';
    if (!this.isReporter() || r.status !== 'resolved' || !r.resolvedAt) return false;
    return Date.now() - new Date(r.resolvedAt).getTime() <= PROBLEM_REOPEN_DAYS * 86_400_000;
  });

  protected readonly scope = computed(() => {
    const r = this.row();
    if (r.seasonNumber != null && r.episodeNumber != null) return `S${pad(r.seasonNumber)}E${pad(r.episodeNumber)}`;
    if (r.seasonNumber != null) return this.translate.instant('problems.card.scope_season', { n: r.seasonNumber });
    return this.translate.instant('problems.card.scope_title');
  });

  protected readonly mediaLink = computed(() => {
    const r = this.row();
    return r.itemId != null && r.media.type === 'series'
      ? ['/series', String(r.media.id), 'episode', String(r.itemId)]
      : mediaDetailLink(r.media.type as Parameters<typeof mediaDetailLink>[0], r.media.id);
  });
  protected readonly qoe = computed(() => this.detail()?.playback as Qoe | null | undefined);

  protected async toggleThread() {
    const open = !this.expanded();
    this.expanded.set(open);
    if (open) await this.loadDetail();
  }

  private async loadDetail() {
    try {
      this.detail.set(await this.api.get(this.row().id));
    } catch {
      /* the global toast reports it */
    }
  }

  protected async send() {
    const message = this.draft().trim();
    if (!message || this.busy()) return;
    await this.act(async () => {
      await this.api.comment(this.row().id, message);
      this.draft.set('');
      await this.loadDetail();
    });
  }

  protected async removeComment(id: number) {
    await this.act(async () => {
      await this.api.removeComment(id);
      await this.loadDetail();
    });
  }

  protected canDeleteComment(userId: number | null) {
    return this.isManager() || (userId != null && userId === this.auth.user()?.id);
  }

  protected async withdraw() {
    await this.act(async () => {
      await this.api.remove(this.row().id);
      this.changed.emit();
    });
  }

  protected async reopen() {
    const note = this.reopenNote().trim();
    if (!note && !this.isManager()) return;
    this.busy.set(true);
    try {
      await this.api.reopen(this.row().id, note, true);
      this.reopening.set(false);
      this.reopenNote.set('');
      this.changed.emit();
    } catch (err) {
      const code = err instanceof HttpErrorResponse && err.status === 409 ? err.error?.code : null;
      this.toast.error(this.translate.instant(REOPEN_ERRORS[code] ?? 'problems.card.reopen_failed'));
    } finally {
      this.busy.set(false);
    }
  }

  private async act(fn: () => Promise<void>) {
    this.busy.set(true);
    try {
      await fn();
    } catch {
      /* the global toast reports it */
    } finally {
      this.busy.set(false);
    }
  }
}
