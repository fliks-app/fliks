import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { LibraryFoldersComponent } from './library-folders';
import { LibraryDetailState } from '../library-detail.state';
import {
  LibrariesApiService,
  Library,
  LibraryFolder,
} from '../../../../../core/services/api/libraries-api.service';
import { ConfirmationService } from '../../../../../core/services/confirmation.service';
import { FolderPickerService } from '../../../../../core/services/folder-picker.service';
import { ToastService } from '../../../../../core/services/toast.service';

const folder = (id: number, path: string, mediaCount = 0): LibraryFolder => ({
  id,
  path,
  position: id - 1,
  disk: null,
  mediaCount,
});

function setup(removeError?: unknown) {
  const lib = { id: 7, folders: [folder(1, '/a', 3), folder(2, '/b'), folder(3, '/c')] } as Library;
  const calls: string[] = [];
  const toasts: string[] = [];
  const api = {
    get: () => Promise.resolve(lib),
    updateFolder: (_l: number, id: number, body: unknown) => {
      calls.push(`update ${id} ${JSON.stringify(body)}`);
      return Promise.resolve({});
    },
    removeFolder: (_l: number, id: number, removeMedia: boolean) => {
      calls.push(`remove ${id} ${removeMedia}`);
      return !removeMedia && removeError ? Promise.reject(removeError) : Promise.resolve();
    },
  };

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: LibrariesApiService, useValue: api },
      { provide: FolderPickerService, useValue: {} },
      { provide: ConfirmationService, useValue: { confirm: () => Promise.resolve(true) } },
      { provide: ToastService, useValue: { error: (m: string) => toasts.push(m) } },
      LibraryDetailState,
    ],
  });
  const state = TestBed.inject(LibraryDetailState);
  state.libraryId.set(7);
  state.library.set(lib);
  const fixture = TestBed.createComponent(LibraryFoldersComponent);
  return { cmp: fixture.componentInstance, state, calls, toasts };
}

describe('LibraryFoldersComponent', () => {
  it('moves a folder to its new index and updates the list at once', async () => {
    const { cmp, state, calls } = setup();
    await cmp.reorder(2, 0);
    expect(calls).toEqual(['update 3 {"position":0}']);
    expect(state.library()?.folders.map((f) => f.id)).toEqual([1, 2, 3]);
  });

  it('ignores a move outside the list', async () => {
    const { cmp, calls } = setup();
    await cmp.reorder(0, -1);
    await cmp.reorder(2, 3);
    expect(calls).toEqual([]);
  });

  it('offers the in-use choices instead of a toast when media are linked', async () => {
    // jsdom has no modal dialog support.
    HTMLDialogElement.prototype.showModal = () => undefined;
    HTMLDialogElement.prototype.close = () => undefined;
    const { cmp, calls, toasts } = setup({ error: { code: 'folder_in_use' } });

    await cmp.remove(folder(1, '/a', 3));
    expect(calls).toEqual(['remove 1 false']);
    expect(cmp.blocked()?.id).toBe(1);
    expect(toasts).toEqual([]);

    await cmp.removeWithMedia();
    expect(calls).toEqual(['remove 1 false', 'remove 1 true']);
  });

  it('toasts any other removal failure', async () => {
    const { cmp, toasts } = setup({ error: { message: 'errors.folder_reserved' } });
    await cmp.remove(folder(2, '/b'));
    expect(cmp.blocked()).toBeNull();
    expect(toasts).toEqual(['errors.folder_reserved']);
  });
});
