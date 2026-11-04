import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { MediaDetailLibraryModalComponent } from './media-detail-library-modal.component';

async function render(folders: { id: number; name: string }[], libraryChanged: boolean) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
    ],
  });
  const fixture = TestBed.createComponent(MediaDetailLibraryModalComponent);
  fixture.componentRef.setInput('folders', folders);
  fixture.componentRef.setInput('libraryChanged', libraryChanged);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const two = [
  { id: 1, name: 'a' },
  { id: 2, name: 'b' },
];

describe('MediaDetailLibraryModalComponent folder choice', () => {
  it('always lets the library change, with files or not', async () => {
    const el = await render(two, false);
    expect(el.querySelector<HTMLSelectElement>('select[name="library"]')?.disabled).toBe(false);
  });

  it('offers the current folder first while the library is unchanged', async () => {
    const el = await render(two, false);
    const options = el.querySelectorAll('select[name="folder"] option');
    expect(options.length).toBe(3);
    expect(options[0].textContent).toContain('media_detail.folder_current');
  });

  it('lists only the folders once the library changed', async () => {
    const el = await render(two, true);
    expect(el.querySelectorAll('select[name="folder"] option').length).toBe(2);
  });

  it('hides the choice for a library with a single folder', async () => {
    const el = await render([two[0]], true);
    expect(el.querySelector('select[name="folder"]')).toBeNull();
  });
});
