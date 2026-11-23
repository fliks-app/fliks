import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { PROBLEM_KINDS, ProblemsService, type ProblemKind } from '../../../core/services/api/problems.service';
import { MediaService, type Media } from '../../../core/services/api/media.service';
import { ReportProblemService, type ReportProblemTarget } from '../../../core/services/report-problem.service';
import { ToastService } from '../../../core/services/toast.service';
import { formatBytes } from '../../../core/utils/format-bytes';
import { TvSelectDirective } from '../../directives/tv-select.directive';
import { ModalComponent } from '../modal';
import { ModalFooterComponent } from '../modal-footer';
import { ModalHeaderComponent } from '../modal-header';

const NOTE_MAX = 2000;
/** "Report a problem" on a title, a season, an episode or one file; opened through {@link ReportProblemService}. */
@Component({
  selector: 'app-report-problem-dialog',
  imports: [FormsModule, RouterLink, TranslatePipe, TvSelectDirective, ModalComponent, ModalHeaderComponent, ModalFooterComponent],
  templateUrl: './report-problem-dialog.html',
})
export class ReportProblemDialogComponent {
  private readonly service = inject(ReportProblemService);
  private readonly problems = inject(ProblemsService);
  private readonly mediaApi = inject(MediaService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly dialog = viewChild<string, ElementRef<HTMLDialogElement>>('dialog', { read: ElementRef });

  protected readonly kinds = PROBLEM_KINDS;
  protected readonly noteMax = NOTE_MAX;
  protected readonly formatBytes = formatBytes;

  protected readonly target = signal<ReportProblemTarget | null>(null);
  private readonly media = signal<Media | null>(null);
  protected readonly kind = signal<ProblemKind | null>(null);
  protected readonly season = signal<number | null>(null);
  protected readonly episodeId = signal<number | null>(null);
  protected readonly fileId = signal<number | null>(null);
  protected readonly note = signal('');
  protected readonly busy = signal(false);
  protected readonly sent = signal(false);
  private seq = 0;

  protected readonly seasons = computed(() => this.media()?.seasons ?? []);
  protected readonly episodes = computed(() => this.seasons().find((s) => s.seasonNumber === this.season())?.episodes ?? []);

  /** Files of the chosen scope: an episode's own, else the title's when it has no seasons. */
  protected readonly files = computed(() => {
    const m = this.media();
    if (!m?.files) return [];
    const item = this.episodeId();
    if (item != null) return m.files.filter((f) => f.episodeId === item);
    return m.seasons?.length ? [] : m.files;
  });
  protected readonly showFile = computed(() => !this.target()?.locked && this.files().length > 1);
  protected readonly scopeLabel = computed(() => {
    const t = this.target();
    const ep = this.episodes().find((e) => e.id === this.episodeId());
    if (ep) return `S${String(this.season()).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}`;
    if (this.season() != null) return this.translate.instant('problems.report.season', { n: this.season() });
    return t?.scopeLabel ?? '';
  });

  constructor() {
    effect(() => {
      const req = this.service.request();
      const d = this.dialog();
      if (!req || !d) return;
      this.service.clear();
      void this.open(req.target);
    });
  }

  private async open(t: ReportProblemTarget) {
    const seq = ++this.seq;
    this.target.set(t);
    this.media.set(null);
    this.kind.set(t.kind ?? null);
    this.season.set(t.seasonNumber ?? null);
    this.episodeId.set(t.itemId ?? null);
    this.fileId.set(t.mediaFileId ?? null);
    this.note.set('');
    this.sent.set(false);
    this.busy.set(false);
    this.dialog()?.nativeElement.showModal();
    if (t.locked) return;
    try {
      const m = await this.mediaApi.getOne(t.mediaId);
      if (seq !== this.seq) return;
      this.media.set(m);
      if (t.itemId != null && t.seasonNumber == null) {
        const s = m.seasons?.find((x) => x.episodes.some((e) => e.id === t.itemId));
        if (s) this.season.set(s.seasonNumber);
      }
    } catch {
      // The global interceptor toasts it; the report still goes through at the preset scope.
    }
  }

  protected pickSeason(n: number | null) {
    this.season.set(n);
    this.episodeId.set(null);
    this.fileId.set(null);
  }

  protected pickEpisode(id: number | null) {
    this.episodeId.set(id);
    this.fileId.set(null);
  }

  protected close() {
    this.dialog()?.nativeElement.close();
  }

  protected async send() {
    const t = this.target();
    const kind = this.kind();
    if (!t || !kind || this.busy()) return;
    const item = this.episodeId();
    const season = this.season();
    const note = this.note().trim();
    this.busy.set(true);
    try {
      await this.problems.create(
        t.mediaId,
        {
          kind,
          ...(item != null ? { itemId: item } : season != null ? { seasonNumber: season } : {}),
          ...(this.fileId() != null ? { mediaFileId: this.fileId()! } : {}),
          ...(note ? { note } : {}),
        },
        true,
      );
      this.sent.set(true);
    } catch (err) {
      const message = err instanceof HttpErrorResponse && err.status === 409 ? (err.error as { message?: string } | null)?.message : null;
      if (message === 'problem_already_open' || message === 'problem_cap') {
        this.toast.error(this.translate.instant(`problems.report.error_${message}`));
      } else {
        this.toast.error(this.translate.instant('problems.report.error'));
      }
    } finally {
      this.busy.set(false);
    }
  }
}
