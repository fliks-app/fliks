import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { DataImportsSettingsComponent } from './data-imports';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { LibrariesApiService } from '../../../core/services/api/libraries-api.service';
import { MediaServersApiService } from '../../../core/services/api/media-servers-api.service';

const LIBS = [
  { id: 1, name: 'Films', mediaTypes: ['movie'] },
  { id: 2, name: 'Series', mediaTypes: ['series'] },
];

async function createComponent(settings: Record<string, string> = {}) {
  const post = vi.fn((url: string) =>
    of(url.endsWith('/preview') ? { remoteRootFolders: [], localLibraries: [] } : { ok: true, message: 'ok', imported: 1, errors: [] }),
  );
  const setBulk = vi.fn(() => Promise.resolve());
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: HttpClient, useValue: { get: () => of([]), post } },
      { provide: SettingsApiService, useValue: { getAll: () => Promise.resolve(settings), setBulk } },
      { provide: LibrariesApiService, useValue: { list: () => Promise.resolve(LIBS) } },
      { provide: MediaServersApiService, useValue: { list: () => Promise.resolve([]) } },
    ],
  });
  const fixture = TestBed.createComponent(DataImportsSettingsComponent);
  fixture.detectChanges();
  await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
  fixture.detectChanges();
  return { fixture, cmp: fixture.componentInstance, post, setBulk };
}

describe('DataImportsSettingsComponent — Radarr and Sonarr forms', () => {
  it('renders one card per provider, each offering its own libraries', async () => {
    const { fixture } = await createComponent();
    const titles = [...fixture.nativeElement.querySelectorAll('.card-title')].map((e) => (e as HTMLElement).textContent?.trim());
    expect(titles).toContain('import.radarr_title');
    expect(titles).toContain('import.sonarr_title');
    expect(fixture.nativeElement.textContent).toContain('Films');
    expect(fixture.nativeElement.textContent).toContain('Series');
  });

  it('keeps the two providers independent and posts each to its own route', async () => {
    const { cmp, post, setBulk } = await createComponent({
      radarr_url: 'http://radarr:7878/',
      radarr_api_key: 'rk',
      sonarr_url: 'http://sonarr:8989',
      sonarr_api_key: 'sk',
    });
    expect(cmp.arr.radarr.url()).toBe('http://radarr:7878/');
    expect(cmp.arr.sonarr.url()).toBe('http://sonarr:8989');

    await cmp.testArr('sonarr');
    expect(post).toHaveBeenCalledWith('/api/imports/sonarr/test', { url: 'http://sonarr:8989', apiKey: 'sk' });
    expect(cmp.arr.radarr.testResult()).toBeNull();

    await cmp.saveArrCredentials('radarr');
    expect(setBulk).toHaveBeenCalledWith({ radarr_url: 'http://radarr:7878', radarr_api_key: 'rk' });
  });

  it('gates the import on credentials and a target library', async () => {
    const { cmp } = await createComponent({ radarr_url: 'http://r', radarr_api_key: 'k' });
    expect(cmp.arrCanSubmit('radarr')).toBe(true);
    expect(cmp.arrCanImport('radarr')).toBe(false);
    cmp.arr.radarr.library.set(1);
    expect(cmp.arrCanImport('radarr')).toBe(true);
    expect(cmp.arrCanSubmit('sonarr')).toBe(false);
  });

  it('imports straight away when the *arr has no root folder to map', async () => {
    const { cmp, post } = await createComponent({ sonarr_url: 'http://s', sonarr_api_key: 'k' });
    cmp.arr.sonarr.library.set(2);
    await cmp.openWizard('sonarr');
    expect(post).toHaveBeenCalledWith('/api/imports/sonarr/preview', expect.anything());
    expect(post).toHaveBeenCalledWith(
      '/api/imports/sonarr',
      expect.objectContaining({ mode: 'skip', pathMappings: [], targetLibraryId: 2 }),
    );
    expect(cmp.arr.sonarr.result()?.imported).toBe(1);
  });
});
