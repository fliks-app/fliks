import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { ImportProgressBannerComponent } from './import-progress-banner';
import { SseService, TaskProgress } from '../../../core/services/sse.service';

const progress = (command: string, current: number, total: number): TaskProgress => ({
  type: 'task.progress',
  command,
  current,
  total,
  message: 'A Folder',
});

const setup = (...rows: TaskProgress[]) => {
  const activeProgress = signal(new Map(rows.map((r) => [r.command, r])));
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: SseService, useValue: { activeProgress } },
    ],
  });
  return TestBed.createComponent(ImportProgressBannerComponent).componentInstance;
};

describe('ImportProgressBannerComponent', () => {
  it('is silent with no import in flight', () => {
    expect(setup().active()).toBeNull();
  });

  it('shows the batch counter while enrichment of earlier files runs alongside it', () => {
    const c = setup(progress('PostImportEnrich', 3, 400), progress('OrphanImport', 42, 300));
    expect(c.active()?.labelKey).toBe('import_progress.importing');
    expect(c.percent()).toBe(14);
  });

  it('falls through to the enrich tail once the batch retires', () => {
    expect(setup(progress('PostImportEnrich', 3, 4)).active()?.labelKey).toBe(
      'import_progress.enriching',
    );
  });
});
