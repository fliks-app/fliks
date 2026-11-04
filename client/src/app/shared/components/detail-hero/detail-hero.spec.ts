import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { AuthService } from '../../../core/services/auth.service';
import { DetailHeroComponent } from './detail-hero';

describe('DetailHeroComponent', () => {
  it('pairs the cover with its card and offers like, playlist and more', () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
        { provide: AuthService, useValue: { hasPermission: () => false, sharingDisabled: () => false } },
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
});
