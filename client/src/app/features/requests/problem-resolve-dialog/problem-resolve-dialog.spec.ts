import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ProblemsService } from '../../../core/services/api/problems.service';
import { ProblemResolveDialogComponent } from './problem-resolve-dialog';

HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};

function setup(api: Record<string, unknown>) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: ProblemsService, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(ProblemResolveDialogComponent);
  fixture.componentRef.setInput('problemId', 3);
  fixture.componentRef.setInput('mode', 'close');
  fixture.detectChanges();
  const cmp = fixture.componentInstance;
  const dialog = (fixture.nativeElement as HTMLElement).querySelector('dialog') as HTMLDialogElement;
  const done = vi.fn();
  cmp.done.subscribe(done);
  cmp.showModal();
  return { cmp, dialog, done, fixture };
}

describe('ProblemResolveDialogComponent', () => {
  it('stays open and silent when the call fails, then closes on success', async () => {
    const close = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce({});
    const { cmp, dialog, done, fixture } = setup({ close });
    fixture.nativeElement.querySelector('textarea').value = 'why';
    fixture.nativeElement.querySelector('textarea').dispatchEvent(new Event('input'));
    await fixture.whenStable();
    await cmp.submit();
    expect(dialog.open).toBe(true);
    expect(done).not.toHaveBeenCalled();
    await cmp.submit();
    expect(close).toHaveBeenCalledWith(3, 'why');
    expect(dialog.open).toBe(false);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('refuses to close without a reason', async () => {
    const close = vi.fn();
    const { cmp } = setup({ close });
    await cmp.submit();
    expect(close).not.toHaveBeenCalled();
  });
});
