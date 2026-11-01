import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { LibraryFolderSelectComponent, defaultFolderId } from './library-folder-select';

function render(folders: { id: number; name: string; freeSpace?: number | null }[]) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
    ],
  });
  const fixture = TestBed.createComponent(LibraryFolderSelectComponent);
  fixture.componentRef.setInput('folders', folders);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('library folder select', () => {
  it('is absent with a single folder', () => {
    expect(render([{ id: 1, name: '/a' }]).querySelector('select')).toBeNull();
  });

  it('lists every folder and marks the first as the default', () => {
    const options = [...render([{ id: 1, name: '/a', freeSpace: 2048 }, { id: 2, name: '/b' }]).querySelectorAll('option')];
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toContain('settings.libraries.folder_default');
    expect(options[1].textContent).not.toContain('settings.libraries.folder_default');
  });

  it('defaults to the first folder only when there is a choice', () => {
    expect(defaultFolderId(undefined)).toBeNull();
    expect(defaultFolderId([{ id: 4, name: 'a' }])).toBeNull();
    expect(defaultFolderId([{ id: 4, name: 'a' }, { id: 5, name: 'b' }])).toBe(4);
  });
});
