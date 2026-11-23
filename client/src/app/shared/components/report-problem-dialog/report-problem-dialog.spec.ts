import { provideZonelessChangeDetection } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { ProblemsService } from '../../../core/services/api/problems.service';
import { MediaService } from '../../../core/services/api/media.service';
import { ReportProblemService } from '../../../core/services/report-problem.service';
import { ToastService } from '../../../core/services/toast.service';
import { ReportProblemDialogComponent } from './report-problem-dialog';

async function settle(f: ComponentFixture<unknown>) {
  f.detectChanges();
  await f.whenStable();
  f.detectChanges();
}

describe('ReportProblemDialogComponent', () => {
  const create = vi.fn();
  const error = vi.fn();
  let fixture: ComponentFixture<ReportProblemDialogComponent>;
  let broker: ReportProblemService;
  const el = () => fixture.nativeElement as HTMLElement;
  const send = () => [...el().querySelectorAll('button')].find((b) => b.textContent?.includes('send'))!;

  beforeEach(async () => {
    create.mockReset();
    error.mockReset();
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
        { provide: ProblemsService, useValue: { create } },
        { provide: MediaService, useValue: { getOne: vi.fn() } },
        { provide: ToastService, useValue: { error } },
      ],
    });
    fixture = TestBed.createComponent(ReportProblemDialogComponent);
    broker = TestBed.inject(ReportProblemService);
    await settle(fixture);
    broker.open({ mediaId: 7, title: 'T', itemId: 42, mediaFileId: 9, locked: true, kind: 'playback' });
    await settle(fixture);
  });

  it('sends the locked scope and kind', async () => {
    create.mockResolvedValue({});
    send().click();
    await settle(fixture);
    expect(create).toHaveBeenCalledWith(7, { kind: 'playback', itemId: 42, mediaFileId: 9 }, true);
    expect(el().textContent).toContain('problems.report.sent');
  });

  it('keeps the dialog open and toasts on a 409', async () => {
    create.mockRejectedValue(new HttpErrorResponse({ status: 409, error: { message: 'problem_already_open' } }));
    send().click();
    await settle(fixture);
    expect(error).toHaveBeenCalled();
    expect(el().textContent).not.toContain('problems.report.sent');
  });
});
