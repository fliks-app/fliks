import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { RequestStatusBadgeComponent } from './request-status-badge.component';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { DownloadProgressService } from '../../../core/services/download-progress.service';
import { TvService } from '../../../core/services/tv.service';
import { FliksRequestRow } from '../../../core/services/api/requests.service';

function setup(row: Partial<FliksRequestRow>) {
  const confirm = { alert: vi.fn().mockResolvedValue(undefined) };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: {
          provide: TranslateLoader,
          useValue: {
            getTranslation: () =>
              of({
                requests: {
                  status: { failed: 'Failed' },
                  failed_reason_title: 'Why',
                  failed_reason: { 'provider-removed': 'Provider removed' },
                },
              }),
          },
        },
      }),
      { provide: ConfirmationService, useValue: confirm },
      { provide: DownloadProgressService, useValue: { progress: signal(new Map()) } },
      { provide: TvService, useValue: { isTv: () => false } },
    ],
  });
  const fixture = TestBed.createComponent(RequestStatusBadgeComponent);
  fixture.componentRef.setInput('request', { kind: 'add', status: 'failed', declinedReason: null, media: null, ...row });
  fixture.detectChanges();
  return { fixture, confirm };
}

describe('RequestStatusBadgeComponent', () => {
  it('opens the translated reason of a failed request instead of the download detail', () => {
    const { fixture, confirm } = setup({ declinedReason: 'provider-removed' });
    const emitted = vi.fn();
    fixture.componentInstance.badgeClick.subscribe(emitted);

    (fixture.nativeElement as HTMLElement).querySelector('button')!.click();

    expect(confirm.alert).toHaveBeenCalledWith({ title: 'Why', message: 'Provider removed' });
    expect(emitted).not.toHaveBeenCalled();
  });

  it('shows an unknown reason as stored', () => {
    const { fixture } = setup({ declinedReason: 'something-else' });
    expect(fixture.componentInstance.failureReason()).toBe('something-else');
  });

  it('is a plain badge when a failed request has no reason', () => {
    const { fixture } = setup({});
    expect((fixture.nativeElement as HTMLElement).querySelector('button')).toBeNull();
  });
});
