import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { LibraryDetailState } from './library-detail.state';
import {
  CreateLibraryBody,
  LibrariesApiService,
  Library,
} from '../../../../core/services/api/libraries-api.service';
import { ToastService } from '../../../../core/services/toast.service';

function setup() {
  const created: CreateLibraryBody[] = [];
  const api = {
    create: (body: CreateLibraryBody) => {
      created.push(body);
      return Promise.resolve({
        id: 7,
        name: body.name,
        icon: body.icon ?? null,
        color: body.color ?? null,
        mediaTypes: body.mediaTypes ?? [],
        preferredProvider: body.preferredProvider ?? null,
        metadataLanguage: body.metadataLanguage ?? null,
        metadataRegion: body.metadataRegion ?? null,
        defaultQualityProfileId: body.defaultQualityProfileId ?? null,
        defaultLanguageProfileId: body.defaultLanguageProfileId ?? null,
        isDefaultForMovies: !!body.isDefaultForMovies,
        isDefaultForSeries: !!body.isDefaultForSeries,
        path: body.path ?? null,
        userIds: body.userIds ?? [],
      } as unknown as Library);
    },
  };

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: LibrariesApiService, useValue: api as unknown as LibrariesApiService },
      { provide: ToastService, useValue: { success: () => undefined } },
      LibraryDetailState,
    ],
  });
  return { state: TestBed.inject(LibraryDetailState), created };
}

describe('LibraryDetailState.validate', () => {
  it('rejects a blank name', () => {
    const { state } = setup();
    state.formName.set('   ');
    expect(state.validate()).toBe(false);
    expect(state.saveError()).toBe('settings.libraries.name_required');
  });

  it('rejects a library with no media type', () => {
    const { state } = setup();
    state.formName.set('Films');
    state.formMovies.set(false);
    state.formSeries.set(false);
    expect(state.validate()).toBe(false);
    expect(state.saveError()).toBe('settings.libraries.media_type_required');
  });
});

describe('LibraryDetailState.create', () => {
  it('does not call the API when the form is invalid', async () => {
    const { state, created } = setup();
    expect(await state.create()).toBeNull();
    expect(created).toEqual([]);
  });

  it('sends the metadata locale and the selected users, then adopts the new library', async () => {
    const { state, created } = setup();
    state.formName.set('  Films  ');
    state.formSeries.set(false);
    state.formMetadataLanguage.set('fr');
    state.formMetadataRegion.set('FR');
    state.formPath.set('/medias/movies');
    state.toggleUser(3);
    state.toggleUser(5);

    expect(await state.create()).toBe(7);
    expect(created).toEqual([
      expect.objectContaining({
        name: 'Films',
        mediaTypes: ['movie'],
        metadataLanguage: 'fr',
        metadataRegion: 'FR',
        path: '/medias/movies',
        userIds: [3, 5],
      }),
    ]);
    expect(state.libraryId()).toBe(7);
    expect(state.formName()).toBe('Films');
  });
});
