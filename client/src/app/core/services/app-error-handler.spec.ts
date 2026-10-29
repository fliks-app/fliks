import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { describe, expect, it, vi } from 'vitest';
import { AppErrorHandler } from './app-error-handler';
import { ToastService } from './toast.service';

describe('AppErrorHandler', () => {
  it('toasts an uncaught error once per burst', () => {
    const toast = { error: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        AppErrorHandler,
        { provide: ToastService, useValue: toast },
        { provide: TranslateService, useValue: { instant: (k: string) => k } },
      ],
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = TestBed.inject(AppErrorHandler);
    h.handleError(new TypeError('crypto.randomUUID is not a function'));
    h.handleError(new Error('again'));
    expect(toast.error).toHaveBeenCalledOnce();
    expect(toast.error).toHaveBeenCalledWith('common.unexpected_error');
  });

  it('leaves an unhandled HTTP failure to the error interceptor', () => {
    const toast = { error: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        AppErrorHandler,
        { provide: ToastService, useValue: toast },
        { provide: TranslateService, useValue: { instant: (k: string) => k } },
      ],
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    TestBed.inject(AppErrorHandler).handleError(new HttpErrorResponse({ status: 0 }));
    expect(toast.error).not.toHaveBeenCalled();
  });
});
