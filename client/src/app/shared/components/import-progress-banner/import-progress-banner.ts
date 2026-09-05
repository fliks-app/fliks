import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { SseService, TaskProgress, formatProgressSubject } from '../../../core/services/sse.service';
import { ProgressBarComponent } from '../progress-bar/progress-bar.component';

type ImportPhase = 'enrich' | 'import' | 'scan';

const PHASE_LABEL_KEY: Record<ImportPhase, string> = {
  enrich: 'import_progress.enriching',
  import: 'import_progress.importing',
  scan: 'import_progress.scanning',
};

/** Outermost loop first: several of these keys are live at once during a library
 *  import (enrichment of the first files runs while later folders are still being
 *  imported), and only one bar shows. OrphanImport wins because it counts the
 *  batch the user is waiting on; it retires and falls through to the enrich tail. */
const PHASES: { command: string; phase: ImportPhase }[] = [
  { command: 'OrphanImport', phase: 'import' },
  { command: 'PostImportEnrich', phase: 'enrich' },
  { command: 'OrphanScan', phase: 'scan' },
];

/** Background library-import indicator: silent otherwise, so it costs nothing on
 *  every other page. Never focusable/interactive, so it can't enter the TV
 *  spatial-nav grid. */
@Component({
  selector: 'app-import-progress-banner',
  imports: [TranslateModule, ProgressBarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './import-progress-banner.html',
  host: { role: 'status', 'aria-live': 'polite' },
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
