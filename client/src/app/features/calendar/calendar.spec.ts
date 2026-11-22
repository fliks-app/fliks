import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { CalendarComponent } from './calendar';

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function setup(query: Record<string, string> = {}) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: { get: (k: string) => query[k] ?? null } } },
      },
    ],
  });
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const fixture = TestBed.createComponent(CalendarComponent);
  fixture.detectChanges();
  return { fixture, navigate, http: TestBed.inject(HttpTestingController) };
}

const calls = (http: HttpTestingController) =>
  http.match((r) => r.url === '/api/media/calendar');

describe('CalendarComponent', () => {
  beforeEach(() => localStorage.clear());

  it('reads view and month from the address and keeps the scope in storage', async () => {
    const { fixture, http } = setup({ view: 'month', month: '2026-03' });
    const cmp = fixture.componentInstance;
    expect(cmp.view()).toBe('month');
    expect(ymd(cmp.currentDate())).toBe('2026-03-01');
    calls(http)[0].flush([]);
    cmp.setScope('mine');
    expect(localStorage.getItem('calendar_scope')).toBe('mine');
    const reqs = calls(http);
    expect(reqs.at(-1)!.request.params.get('requestedByMe')).toBe('true');
    expect(reqs.at(-1)!.request.params.get('monitoredOnly')).toBeNull();
  });

  it('puts month and view in the URL with replaceUrl on navigation', () => {
    const { fixture, navigate } = setup({ view: 'month', month: '2026-03' });
    fixture.componentInstance.nextMonth();
    expect(navigate).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ queryParams: { view: 'month', month: '2026-04' }, replaceUrl: true }),
    );
  });

  it('derives the state of an entry from hasFile and the date', () => {
    const { fixture } = setup({ view: 'month' });
    const cmp = fixture.componentInstance;
    const base = { id: 1, mediaId: 1, title: 't', type: 'movie', event: 'digital', posterUrl: null, fanartUrl: null, status: '', year: 2026 };
    const past = ymd(new Date(2000, 0, 1));
    const future = ymd(new Date(2999, 0, 1));
    expect(cmp.entryState({ ...base, date: past, hasFile: true } as never)).toBe('ok');
    expect(cmp.entryState({ ...base, date: past } as never)).toBe('miss');
    expect(cmp.entryState({ ...base, date: future } as never)).toBe('up');
  });

  it('groups the agenda by day from today, loads the next weeks on demand', async () => {
    const { fixture, http } = setup({ view: 'agenda' });
    const today = ymd(new Date());
    const entry = { id: 1, mediaId: 1, title: 'Show', type: 'movie', event: 'cinema', date: today, posterUrl: null, fanartUrl: null, status: '', year: 2026 };
    const first = calls(http)[0];
    expect(first.request.params.get('start')).toBe(today);
    first.flush([entry, { ...entry, id: 2, title: 'Other' }]);
    await fixture.whenStable();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelectorAll('[data-testid=calendar-day]').length).toBe(1);
    expect(el.querySelectorAll('[data-testid=calendar-agenda-row]').length).toBe(2);
    const startEnd = (r: { request: { params: { get(k: string): string | null } } }) => r.request.params.get('end');
    const firstEnd = startEnd(first);
    fixture.componentInstance.loadMore();
    expect(startEnd(calls(http).at(-1)!)! > firstEnd!).toBe(true);
  });
});
