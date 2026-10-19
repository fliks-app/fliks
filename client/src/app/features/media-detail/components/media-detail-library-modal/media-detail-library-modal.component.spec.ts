import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { MediaDetailLibraryModalComponent } from './media-detail-library-modal.component';

async function render(libraryLocked: boolean) {
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
  fixture.componentRef.setInput('libraryLocked', libraryLocked);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('MediaDetailLibraryModalComponent — library lock', () => {
  it('disables the library select and explains why for a media with files', async () => {
    const el = await render(true);
    expect(el.querySelector<HTMLSelectElement>('select[name="library"]')?.disabled).toBe(true);
    expect(el.textContent).toContain('errors.media_has_files');
  });

  it('leaves the library select usable otherwise', async () => {
    const el = await render(false);
    expect(el.querySelector<HTMLSelectElement>('select[name="library"]')?.disabled).toBe(false);
    expect(el.textContent).not.toContain('errors.media_has_files');
  });
});
