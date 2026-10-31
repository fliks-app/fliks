import { computed, signal } from '@angular/core';
import type { TranslateService } from '@ngx-translate/core';
import type { Media, MediaService } from '../../core/services/api/media.service';
import type { MarkersApiService } from '../../core/services/api/markers-api.service';
import type { ToastService } from '../../core/services/toast.service';
import { serverMessage } from '../../core/utils/server-message';
import { KIND_REGISTRY } from '../../core/media-kinds';

export interface AnalyzeHost {
  media(): Media | null;
  dialog(): HTMLDialogElement | undefined;
  firstOption(): HTMLInputElement | undefined;
}

export interface AnalyzeDeps {
  media: MediaService;
  markers: MarkersApiService;
  toast: ToastService;
  translate: TranslateService;
}

export type AnalyzeOptKey = 'rescan' | 'sprites' | 'crop' | 'subtitleCache' | 'markers';

const NO_OPTIONS: Record<AnalyzeOptKey, boolean> = {
  rescan: false,
  sprites: false,
  crop: false,
  subtitleCache: false,
  markers: false,
};

/** The "analyze" dialog: which background jobs to launch on the open title. */
export class AnalyzeController {
  readonly running = signal(false);
  readonly opts = signal<Record<AnalyzeOptKey, boolean>>({ ...NO_OPTIONS });
  readonly hasSelection = computed(() => Object.values(this.opts()).some(Boolean));
  /** Intro/outro detection is episode-based, so the analyze option only
   *  applies to series. */
  readonly showMarkers = computed(() => {
    const m = this.host.media();
    return !!m && KIND_REGISTRY[m.type].hasSeasons;
  });

  constructor(
    private readonly host: AnalyzeHost,
    private readonly deps: AnalyzeDeps,
  ) {}

  open() {
    this.opts.set({ ...NO_OPTIONS });
    const dlg = this.host.dialog();
    if (!dlg) return;
    dlg.showModal();
    // Focus the first checkbox; showModal()'s autofocus would land on the cancel button.
    queueMicrotask(() => this.host.firstOption()?.focus());
  }

  close() {
    this.host.dialog()?.close();
  }

  setOpt(key: AnalyzeOptKey, value: boolean) {
    this.opts.update((o) => ({ ...o, [key]: value }));
  }

  async run() {
    const m = this.host.media();
    if (!m) return;
    const opts = this.opts();
    this.running.set(true);
    try {
      // Rescan is the superset: hit /rescan alone so the SSE event stream still fires.
      if (opts.rescan) {
        // Rescan already re-runs intro/outro detection on completion.
        await this.deps.media.rescanFiles(m.id);
      } else {
        if (opts.sprites || opts.crop || opts.subtitleCache) {
          await this.deps.media.analyzeMedia(m.id, {
            sprites: opts.sprites,
            crop: opts.crop,
            subtitleCache: opts.subtitleCache,
          });
        }
        if (opts.markers) {
          await this.deps.markers.detectSeries(m.id);
        }
      }
      this.deps.toast.success(this.deps.translate.instant('media_detail.analyze_launched'));
      this.close();
    } catch (err) {
      this.deps.toast.error(serverMessage(err, this.deps.translate, 'media_detail.analyze_launch_error'));
    } finally {
      this.running.set(false);
    }
  }
}
