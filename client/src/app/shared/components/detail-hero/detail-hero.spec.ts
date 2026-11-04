import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../../core/services/auth.service';
import { MediaLibraryDialogComponent } from '../media-library-dialog/media-library-dialog';
import { By } from '@angular/platform-browser';
import type { Media } from '../../../core/services/api/media.service';
import { CardActionsService } from '../../../core/services/card-actions.service';
import { DetailHeroComponent, MEDIA_SAVED_HOST } from './detail-hero';

describe('DetailHeroComponent', () => {
  it('pairs the cover with its card and offers like, playlist and more', () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
        { provide: AuthService, useValue: { user: () => null, hasPermission: () => false, sharingDisabled: () => false } },
      ],
    });
    const fixture = TestBed.createComponent(DetailHeroComponent);
    fixture.componentRef.setInput('title', 'Title');
    fixture.componentRef.setInput('mediaId', 9);
    fixture.componentRef.setInput('mediaType', 'book');
    fixture.componentRef.setInput('posterUrl', '/p.jpg');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('img')!.getAttribute('style')).toContain('media-poster-9');
    expect(el.querySelectorAll('button').length).toBeGreaterThanOrEqual(3);
  });

  function hero(mediaType: string, extra: object[] = [], hasPerm = true) {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
        { provide: AuthService, useValue: { user: () => null, hasPermission: () => hasPerm, sharingDisabled: () => false } },
        ...extra,
      ],
    });
    const fixture = TestBed.createComponent(DetailHeroComponent);
    fixture.componentRef.setInput('title', 'Title');
    fixture.componentRef.setInput('mediaId', 9);
    fixture.componentRef.setInput('mediaType', mediaType);
    return fixture;
  }

  it('hands a saved library back to the page that owns the title', () => {
    const onLibrarySaved = vi.fn();
    const fixture = hero('book', [{ provide: MEDIA_SAVED_HOST, useValue: { onLibrarySaved } }]);
    const media = { id: 9, type: 'book', title: 'T' } as Media;
    fixture.componentRef.setInput('media', media);
    fixture.detectChanges();
    const saved = { ...media, libraryId: 2 } as Media;
    fixture.debugElement.query(By.directive(MediaLibraryDialogComponent)).triggerEventHandler('updated', saved);
    expect(onLibrarySaved).toHaveBeenCalledWith(saved);
  });

  it('labels a book profiles row as formats and languages and offers refresh once identified', () => {
    const register = vi.fn();
    const fixture = hero('book', [{ provide: CardActionsService, useValue: { register, show: vi.fn() } }]);
    fixture.componentRef.setInput('media', { id: 9, type: 'book', title: 'T', providers: [{ provider: 'openlibrary' }] } as unknown as Media);
    fixture.componentRef.setInput('actions', { 'media.edit-profiles': () => undefined });
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button[aria-label="common.more"]')!.click();
    const rows = register.mock.calls[0][0].actions.flatMap((a: { children?: unknown[] }) => [a, ...(a.children ?? [])]);
    expect(rows.some((r: { labelKey?: string }) => r.labelKey === 'books_work.edit_profiles')).toBe(true);
    expect(rows.some((r: { labelKey?: string }) => r.labelKey === 'media_detail.refresh_metadata')).toBe(true);
  });

  it('does not offer a refresh for a title no provider knows', () => {
    const register = vi.fn();
    const fixture = hero('book', [{ provide: CardActionsService, useValue: { register, show: vi.fn() } }]);
    fixture.componentRef.setInput('media', { id: 9, type: 'book', title: 'T' } as Media);
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button[aria-label="common.more"]')!.click();
    const rows = register.mock.calls[0][0].actions.flatMap((a: { children?: unknown[] }) => [a, ...(a.children ?? [])]);
    expect(rows.some((r: { labelKey?: string }) => r.labelKey === 'media_detail.refresh_metadata')).toBe(false);
  });
});
