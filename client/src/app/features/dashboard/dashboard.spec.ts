import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { CountsApiService } from '../../core/services/api/counts-api.service';
import { LibrariesApiService } from '../../core/services/api/libraries-api.service';
import { SubtitlesApiService } from '../../core/services/api/subtitles-api.service';
import { DashboardComponent } from './dashboard';

describe('DashboardComponent', () => {
  it('shows one tile per library with its count, linking to the library', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService({
          lang: 'en',
          loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
        }),
        { provide: SubtitlesApiService, useValue: { getStats: () => Promise.resolve(null) } },
        { provide: CountsApiService, useValue: { get: () => Promise.resolve({ mediaByLibrary: { 1: 12 } }) } },
        {
          provide: LibrariesApiService,
          useValue: { listMine: () => Promise.resolve([{ id: 1, name: 'Films & Co' }, { id: 2, name: 'Music' }]) },
        },
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();
    http.expectOne('/api/system/stats').flush({ pendingRequests: 0, diskSpace: [] });
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const tiles = [...el.querySelectorAll('a[href^="/libraries/"]')];
    expect(tiles.map((t) => t.getAttribute('href'))).toEqual(['/libraries/Films%20&%20Co', '/libraries/Music']);
    expect(tiles.map((t) => t.querySelector('.text-3xl')?.textContent?.trim())).toEqual(['12', '0']);
  });
});
