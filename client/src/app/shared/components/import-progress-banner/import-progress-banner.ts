import { Component, computed, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { SseService, TaskProgress, formatProgressSubject } from '../../../core/services/sse.service';
import { ProgressBarComponent } from '../progress-bar/progress-bar.component';

type ImportPhase = 'enrich' | 'import' | 'scan';

const PHASE_LABEL_KEY: Record<ImportPhase, string> = {
  enrich: 'import_progress.enriching',
  import: 'import_progress.importing',
  scan: 'import_progress.scanning',
};

/** Outermost loop first, since several keys are live during an import and only one bar shows; OrphanImport wins as it counts the batch the user waits on. */
const PHASES: { command: string; phase: ImportPhase }[] = [
  { command: 'OrphanImport', phase: 'import' },
  { command: 'PostImportEnrich', phase: 'enrich' },
  { command: 'OrphanScan', phase: 'scan' },
];

/** Background library-import indicator: silent otherwise and never focusable, so it can't enter the TV spatial-nav grid. */
@Component({
  selector: 'app-import-progress-banner',
  imports: [TranslatePipe, ProgressBarComponent],
  templateUrl: './import-progress-banner.html',
  // Idle, the host is still a flex item and eats one `gap` from the page it
  // sits in. Collapsed rather than emptied.
  host: { role: 'status', 'aria-live': 'polite', '[class.hidden]': '!active()' },
})
export class ImportProgressBannerComponent {
  private readonly sse = inject(SseService);

  readonly active = computed<{ progress: TaskProgress; labelKey: string } | null>(() => {
    const map = this.sse.activeProgress();
    for (const { command, phase } of PHASES) {
      const progress = map.get(command);
      if (progress) return { progress, labelKey: PHASE_LABEL_KEY[phase] };
    }
    return null;
  });

  readonly percent = computed(() => {
    const p = this.active()?.progress;
    if (!p || !p.total) return 0;
    return Math.min(100, Math.round((p.current / p.total) * 100));
  });

  /** Series/movie + episode when the subject names one; the plain `message`
   *  (a folder path, for instance) when it doesn't. */
  readonly subjectLabel = computed(() => {
    const p = this.active()?.progress;
    return p ? formatProgressSubject(p) : '';
  });
}
