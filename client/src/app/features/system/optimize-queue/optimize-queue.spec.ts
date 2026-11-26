import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { SseService } from '../../../core/services/sse.service';
import type { OptimizeJob } from '../../../core/models/optimize';
import { sseStub } from '../../../testing/sse.stub';
import { OptimizeQueueComponent } from './optimize-queue';

describe('OptimizeQueueComponent: errorDetails', () => {
  function component() {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService({
          lang: 'en',
          loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({ optimize: { queue: { error_class: { access: 'Access denied' } } } }) } },
        }),
        { provide: ConfirmationService, useValue: {} },
        { provide: SseService, useValue: sseStub({ connectionId: signal('c'), optimizeEvents: of() }) },
      ],
    });
    return TestBed.createComponent(OptimizeQueueComponent).componentInstance;
  }
  const job = (error: OptimizeJob['error']) => ({ error }) as OptimizeJob;

  it('joins the class label, message and stderr, one per line', () => {
    expect(component().errorDetails(job({ class: 'access', message: 'denied', stderr: 'tail' }))).toBe('Access denied\ndenied\ntail');
  });

  it('keeps an unknown class as is and skips empty parts', () => {
    expect(component().errorDetails(job({ class: 'odd', message: '', stderr: '' }))).toBe('odd');
  });

  it('is null without an error', () => {
    expect(component().errorDetails(job(null))).toBeNull();
  });
});
