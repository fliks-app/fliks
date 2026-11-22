import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { BehaviorSubject, of } from 'rxjs';
import { vi } from 'vitest';
import { By } from '@angular/platform-browser';
import { SseService } from '../../core/services/sse.service';
import { DataTableComponent } from '../../shared/components/data-table/data-table';
import { AcquisitionQueueComponent } from './acquisition-queue';

function setup(view: 'queue' | 'history', query: Record<string, string> = {}) {
  const navigateByUrl = vi.fn();
  const navigate = vi.fn();
  const params = new BehaviorSubject(convertToParamMap(query));
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: ActivatedRoute, useValue: { snapshot: { data: { view }, queryParamMap: params.value }, queryParamMap: params } },
      { provide: Router, useValue: { navigateByUrl, navigate } },
    ],
  });
  const fixture = TestBed.createComponent(AcquisitionQueueComponent);
  fixture.detectChanges();
  return { fixture, http: TestBed.inject(HttpTestingController), navigateByUrl, navigate, params };
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

  it('narrows the history to one title from the query string, with a chip that removes the filter', async () => {
    const { fixture, http, navigate, params } = setup('history', { mediaId: '42' });
    http.expectOne((r) => r.url === '/api/acquisition/history' && r.params.get('mediaId') === '42').flush({ data: [], total: 0, page: 1, pageSize: 25 });
    const chip = fixture.nativeElement.querySelector('[data-testid="media-filter"] button') as HTMLButtonElement;
    chip.click();
    expect(navigate).toHaveBeenCalledWith([], expect.objectContaining({ queryParams: { mediaId: null } }));

    params.next(convertToParamMap({}));
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne((r) => r.url === '/api/acquisition/history' && !r.params.has('mediaId')).flush({ data: [], total: 0, page: 1, pageSize: 25 });
    expect(fixture.nativeElement.querySelector('[data-testid="media-filter"]')).toBeNull();
  });

  it('ignores a mediaId that is not an id', () => {
    const { http } = setup('history', { mediaId: 'x' });
    http.expectOne((r) => r.url === '/api/acquisition/history' && !r.params.has('mediaId')).flush({ data: [], total: 0, page: 1, pageSize: 25 });
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

  it('patches the rows a provider report names and reloads on a report without rows', async () => {
    const { fixture, http } = setup('queue');
    const row = (id: number, progress: number) => ({ id, title: `t${id}`, state: 'active', progress });
    http
      .expectOne((r) => r.url === '/api/acquisition/queue')
      .flush({ data: [row(1, 10), row(2, 20)], total: 2, page: 1, pageSize: 25 });
    await fixture.whenStable();
    const table = fixture.debugElement.query(By.directive(DataTableComponent)).componentInstance as DataTableComponent;
    const sse = TestBed.inject(SseService);
    sse.queueEvents.next({ type: 'acquisition.queue', payload: { rows: [row(2, 55)] } });
    expect(table.rows().map((r) => r['progress'])).toEqual([10, 55]);
    http.verify();
    sse.queueEvents.next({ type: 'acquisition.queue', payload: { rows: null } });
    http.expectOne((r) => r.url === '/api/acquisition/queue').flush({ data: [], total: 0, page: 1, pageSize: 25 });
  });
});
