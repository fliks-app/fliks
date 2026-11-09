import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { AcquisitionQueueComponent } from './acquisition-queue';

function setup(view: 'queue' | 'history') {
  const navigateByUrl = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: ActivatedRoute, useValue: { snapshot: { data: { view } } } },
      { provide: Router, useValue: { navigateByUrl } },
    ],
  });
  const fixture = TestBed.createComponent(AcquisitionQueueComponent);
  fixture.detectChanges();
  return { fixture, http: TestBed.inject(HttpTestingController), navigateByUrl };
}

describe('AcquisitionQueueComponent', () => {
  it('lists the open rows of the core queue, paged', () => {
    const { http } = setup('queue');
    const req = http.expectOne((r) => r.url === '/api/acquisition/queue');
    expect(req.request.params.get('page')).toBe('1');
    expect(req.request.params.get('pageSize')).toBe('25');
    req.flush({ data: [], total: 0, page: 1, pageSize: 25 });
    http.verify();
  });

  it('lists the history on the history route', () => {
    const { http } = setup('history');
    http
      .expectOne((r) => r.url === '/api/acquisition/history')
      .flush({ data: [], total: 0, page: 1, pageSize: 25 });
    http.verify();
  });

  it('opens the media page of a row, and nothing without a media type', () => {
    const { fixture, http, navigateByUrl } = setup('queue');
    http.expectOne((r) => r.url === '/api/acquisition/queue').flush({ data: [], total: 0, page: 1, pageSize: 25 });
    const resolve = (
      fixture.componentInstance as unknown as {
        resolveAction: (id: string, row: Record<string, unknown>) => (() => void) | undefined;
      }
    ).resolveAction;
    expect(resolve('table.open-media', { id: 1, mediaId: 7 })).toBeUndefined();
    resolve('table.open-media', { id: 1, mediaId: 7, mediaType: 'movie' })!();
    expect(navigateByUrl).toHaveBeenCalledWith(expect.stringContaining('7'));
  });
});
