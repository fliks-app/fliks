import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import type { Annotation } from './annotations-api.service';
import { ReaderSettingsService } from './reader-settings.service';
import { ReaderSidebarComponent } from './reader-sidebar';

const note: Annotation = {
  id: 5,
  itemId: 1,
  kind: 'highlight',
  colour: 'yellow',
  note: 'first',
  locator: { href: 'a.xhtml' },
  excerpt: 'a line',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

async function open(savedFilter: Annotation['colour'] = null) {
  TestBed.configureTestingModule({
    providers: [
      ReaderSettingsService,
      provideZonelessChangeDetection(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
    ],
  });
  TestBed.inject(ReaderSettingsService).panel.set({ tab: 'notes', notesFilter: savedFilter });
  const fixture = TestBed.createComponent(ReaderSidebarComponent);
  fixture.componentRef.setInput('tab', 'notes');
  fixture.componentRef.setInput('toc', []);
  fixture.componentRef.setInput('currentRow', 0);
  fixture.componentRef.setInput('progression', 0);
  fixture.componentRef.setInput('annotations', [note]);
  fixture.componentRef.setInput('tocRows', []);
  fixture.componentRef.setInput('hits', []);
  fixture.componentRef.setInput('searching', false);
  fixture.componentRef.setInput('searched', false);
  await fixture.whenStable();
  return fixture;
}

describe('ReaderSidebarComponent', () => {
  it('saves a note still being typed when the owner flushes before closing', async () => {
    const fixture = await open();
    const saved: unknown[] = [];
    fixture.componentInstance.saveNote.subscribe((c) => saved.push(c));
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('[aria-label="reader.edit_note"]')!.click();
    await fixture.whenStable();
    el.querySelector('textarea')!.value = ' typed ';
    fixture.componentInstance.flushNote();
    expect(saved).toEqual([{ annotation: note, note: 'typed' }]);
  });

  it('has nothing to flush when no note is open', async () => {
    const fixture = await open();
    const saved: unknown[] = [];
    fixture.componentInstance.saveNote.subscribe((c) => saved.push(c));
    fixture.componentInstance.flushNote();
    expect(saved).toEqual([]);
  });

  it('shows every note when the saved colour has none in this book, and keeps that colour saved', async () => {
    const fixture = await open('green');
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('a line');
    expect(TestBed.inject(ReaderSettingsService).panel().notesFilter).toBe('green');
  });
});
