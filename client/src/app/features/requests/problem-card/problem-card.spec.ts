import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ProblemRow, ProblemsService } from '../../../core/services/api/problems.service';
import { AuthService } from '../../../core/services/auth.service';
import { ToastService } from '../../../core/services/toast.service';
import { ProblemCardComponent } from './problem-card';

const DAY = 86_400_000;
const row = (over: Partial<ProblemRow> = {}): ProblemRow => ({
  id: 7, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', status: 'open', kind: 'video',
  itemId: null, seasonNumber: null, episodeNumber: null, fileSize: null, autoResolved: false, resolvedAt: null,
  media: { id: 1, type: 'movie', title: 'T', posterUrl: null }, file: null, user: { id: 5, username: 'ana' },
  resolvedBy: null, commentCount: 0, lastReply: null, source: 'user', ...over,
});

function setup(r: ProblemRow, manager: boolean, api: Record<string, unknown> = {}) {
  TestBed.resetTestingModule();
  const toast = { error: vi.fn(), success: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: ProblemsService, useValue: api },
      { provide: ToastService, useValue: toast },
      { provide: AuthService, useValue: { user: signal({ id: 5 }), hasPermission: () => manager } },
    ],
  });
  const fixture = TestBed.createComponent(ProblemCardComponent);
  fixture.componentRef.setInput('row', r);
  fixture.detectChanges();
  const labels = () =>
    [...(fixture.nativeElement as HTMLElement).querySelectorAll('button, a.btn')].map((b) => b.textContent?.trim());
  return { fixture, labels, toast, cmp: fixture.componentInstance as unknown as { reopenNote: { set(v: string): void }; reopen(): Promise<void> } };
}

describe('ProblemCardComponent', () => {
  it('gives a manager Mark fixed and Close on an active report, a reporter Withdraw', () => {
    expect(setup(row(), true).labels()).toEqual(expect.arrayContaining(['problems.card.mark_fixed', 'problems.card.close']));
    const own = setup(row(), false).labels();
    expect(own).toContain('problems.card.withdraw');
    expect(own).not.toContain('problems.card.mark_fixed');
  });

  it('offers a reporter Reopen on a fixed report only inside the window', () => {
    const recent = row({ status: 'resolved', resolvedAt: new Date(Date.now() - 2 * DAY).toISOString() });
    expect(setup(recent, false).labels()).toContain('problems.card.reopen');
    const old = row({ status: 'resolved', resolvedAt: new Date(Date.now() - 15 * DAY).toISOString() });
    const labels = setup(old, false).labels();
    expect(labels).not.toContain('problems.card.reopen');
    expect(labels).not.toContain('problems.card.withdraw');
  });

  it('toasts a reopen 409 itself and keeps the note', async () => {
    const reopen = vi.fn().mockRejectedValue(new HttpErrorResponse({ status: 409, error: { code: 'problem_cap' } }));
    const recent = row({ status: 'resolved', resolvedAt: new Date().toISOString() });
    const { cmp, toast } = setup(recent, false, { reopen });
    cmp.reopenNote.set('still broken');
    await cmp.reopen();
    expect(reopen).toHaveBeenCalledWith(7, 'still broken', true);
    expect(toast.error).toHaveBeenCalledWith('problems.card.reopen_cap');
  });
});
