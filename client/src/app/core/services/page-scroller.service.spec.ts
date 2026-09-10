import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PageScrollerService } from './page-scroller.service';

describe('PageScrollerService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  const service = () => TestBed.inject(PageScrollerService);

  it('reads the document offset', () => {
    expect(service().offset()).toBe(window.scrollY);
  });

  it('writes the document offset without animating', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    service().scrollTo(240);
    expect(scrollTo).toHaveBeenCalledWith({ top: 240, left: 0, behavior: 'instant' });
  });

  it('emits on a document scroll', async () => {
    const next = firstValueFrom(service().changes());
    window.dispatchEvent(new Event('scroll'));
    await expect(next).resolves.toBeUndefined();
  });
});
