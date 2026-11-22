import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { Subject, filter, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcquisitionApiService, type AcquisitionHistoryRow } from '../../../../core/services/api/acquisition-api.service';
import { AuthService } from '../../../../core/services/auth.service';
import { SseService, type SseEvent } from '../../../../core/services/sse.service';
import { TvService } from '../../../../core/services/tv.service';
import { MediaDownloadsComponent } from './media-downloads.component';

const row = (id: number): AcquisitionHistoryRow => ({
  id, mediaId: 7, sourceTitle: `Release.${id}`, state: 'failed', statusMessage: 'No peers', date: '2026-11-20T10:00:00Z',
});

async function setup(opts: { grab?: boolean; tv?: boolean; rows?: AcquisitionHistoryRow[] } = {}) {
  const history = vi.fn(async () => opts.rows ?? [row(1)]);
  const events = new Subject<SseEvent>();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: AcquisitionApiService, useValue: { history } },
      { provide: AuthService, useValue: { hasPermission: (p: string) => p === 'media.grab' && (opts.grab ?? true) } },
      { provide: TvService, useValue: { isTv: signal(opts.tv ?? false) } },
      { provide: SseService, useValue: { on: (...t: string[]) => events.pipe(filter((e) => t.includes(e.type))) } },
    ],
  });
  const fixture = TestBed.createComponent(MediaDownloadsComponent);
  fixture.componentRef.setInput('mediaId', 7);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, history, events, el: fixture.nativeElement as HTMLElement };
}

describe('MediaDownloadsComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('lists the last five grabs of the title, with a link to the filtered history', async () => {
    const { history, el } = await setup();
    expect(history).toHaveBeenCalledWith(7, 5);
    expect(el.querySelectorAll('[data-testid="downloads-rows"] li')).toHaveLength(1);
    expect(el.querySelector('a[href="/acquisition/history?mediaId=7"]')).not.toBeNull();
  });

  it('asks nothing of a viewer who cannot open the history', async () => {
    const { history, el } = await setup({ grab: false });
    expect(history).not.toHaveBeenCalled();
    expect(el.classList.contains('hidden')).toBe(true);
  });

  it('asks nothing on TV', async () => {
    const { history } = await setup({ tv: true });
    expect(history).not.toHaveBeenCalled();
  });

  it('is hidden while the title has no grab, and reads again when the queue changes', async () => {
    const { fixture, history, events, el } = await setup({ rows: [] });
    expect(el.classList.contains('hidden')).toBe(true);
    history.mockResolvedValueOnce([row(2)]);
    events.next({ type: 'queue.updated' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(history).toHaveBeenCalledTimes(2);
    expect(el.classList.contains('hidden')).toBe(false);
  });
});
