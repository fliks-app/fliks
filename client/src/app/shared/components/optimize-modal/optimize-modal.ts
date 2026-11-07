import { Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MediaService } from '../../../core/services/api/media.service';
import { OptimizeService } from '../../../core/services/api/optimize.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import {
  OptimizeModalService,
  type OptimizeModalConfig,
} from '../../../core/services/optimize-modal.service';
import { ToastService } from '../../../core/services/toast.service';
import { LEVELS, type OptimizeLevel } from '../../../core/models/optimize';
import { formatBytes } from '../../../core/utils/format-bytes';
import { ModalHeaderComponent } from '../modal-header';

/** Files compared one by one; beyond this the dialog queues without a per-file preview. */
const PREVIEW_MAX = 40;

interface Summary {
  files: number;
  conform: number;
  excluded: number;
  perLevel: Record<OptimizeLevel, { count: number; bytes: number }>;
  removed: number;
  lossless: number;
}

/** "Optimize…" and "Force re-encode" on a title, an episode, a season or a collection. */
@Component({
  selector: 'app-optimize-modal',
  imports: [RouterLink, TranslatePipe, ModalHeaderComponent],
  templateUrl: './optimize-modal.html',
})
export class OptimizeModalComponent {
  private readonly service = inject(OptimizeModalService);
  private readonly media = inject(MediaService);
  private readonly api = inject(OptimizeService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  readonly levels = LEVELS;
  readonly formatBytes = formatBytes;
  readonly config = signal<OptimizeModalConfig | null>(null);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly fileIds = signal<number[]>([]);
  readonly summary = signal<Summary | null>(null);
  /** More files than {@link PREVIEW_MAX}: the counts are not compared. */
  readonly truncated = signal(false);
  readonly noProfile = signal(false);
  private seq = 0;

  constructor() {
    effect(() => {
      const req = this.service.request();
      const d = this.dialog();
      if (!req || !d) return;
      this.service.clear();
      void this.open(req.config);
    });
  }

  private async open(config: OptimizeModalConfig) {
    const seq = ++this.seq;
    this.config.set(config);
    this.summary.set(null);
    this.noProfile.set(false);
    this.truncated.set(false);
    this.fileIds.set([]);
    this.loading.set(true);
    this.dialog()?.nativeElement.showModal();
    try {
      const items = await Promise.all(config.mediaIds.map((id) => this.media.getOne(id)));
      if (seq !== this.seq) return;
      const episodes = config.episodeIds;
      const files = items.flatMap((m) =>
        (m.files ?? [])
          .filter((f) => !episodes || (f.episodeId != null && episodes.includes(f.episodeId)))
          .map((f) => ({ id: f.id, size: f.size, libraryId: m.libraryId ?? null })),
      );
      this.fileIds.set(files.map((f) => f.id));
      const libraryId = files.find((f) => f.libraryId != null)?.libraryId;
      if (files.length > PREVIEW_MAX || libraryId == null) {
        this.truncated.set(files.length > PREVIEW_MAX);
        return;
      }
      const outcomes = await Promise.all(
        files.map((f) =>
          this.api.previewFile(libraryId, f.id).then(
            (o) => ({ f, o }),
            () => null,
          ),
        ),
      );
      if (seq !== this.seq) return;
      // Every comparison refused: the library has no profile.
      if (outcomes.every((r) => r === null)) {
        this.noProfile.set(true);
        return;
      }
      const s: Summary = {
        files: files.length,
        conform: 0,
        excluded: 0,
        perLevel: {
          metadata: { count: 0, bytes: 0 },
          remux: { count: 0, bytes: 0 },
          reencode: { count: 0, bytes: 0 },
        },
        removed: 0,
        lossless: 0,
      };
      for (const r of outcomes) {
        if (!r) {
          s.excluded++;
        } else if (r.o.status === 'diff') {
          const l = s.perLevel[r.o.level];
          l.count++;
          l.bytes += r.f.size;
          s.removed += r.o.changes.filter((c) => c.type === 'drop').length;
          s.lossless += r.o.warnings.filter((w) => w.type === 'losslessReplaced').length;
        } else if (r.o.status === 'conform') {
          s.conform++;
        } else {
          s.excluded++;
        }
      }
      this.summary.set(s);
    } catch {
      // The global interceptor toasts the reason; the actions stay disabled without files.
    } finally {
      if (seq === this.seq) this.loading.set(false);
    }
  }

  close() {
    this.dialog()?.nativeElement.close();
  }

  async run(force: boolean) {
    if (force) {
      const ok = await this.confirmation.confirm({
        title: this.translate.instant('optimize.action.force'),
        message: this.translate.instant('optimize.action.force_warning'),
        variant: 'danger',
      });
      if (!ok) return;
    }
    this.busy.set(true);
    try {
      const out: { outcome: string }[] = [];
      const ids = this.fileIds();
      for (let i = 0; i < ids.length; i += 500)
        out.push(...(await this.api.enqueue(ids.slice(i, i + 500), force)));
      const queued = out.filter((q) => q.outcome === 'queued').length;
      this.toast.success(
        this.translate.instant('optimize.action.queued', { count: queued, total: out.length }),
      );
      this.close();
    } catch {
      // The global interceptor toasts the reason.
    } finally {
      this.busy.set(false);
    }
  }
}
