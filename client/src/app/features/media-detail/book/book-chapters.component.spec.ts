import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { describe, expect, it } from 'vitest';
import {
  audioEditionFixture, bookChaptersFixture, bookDetailFixture,
} from '../../../core/services/api/books.fixtures';
import { BookChaptersComponent } from './book-chapters.component';
import { bookSpecProviders } from './book-test-setup';

describe('BookChaptersComponent', () => {
  function setup(editions = bookDetailFixture.editions) {
    TestBed.configureTestingModule({ providers: bookSpecProviders() });
    const fixture = TestBed.createComponent(BookChaptersComponent);
    fixture.componentRef.setInput('mediaId', 1);
    fixture.componentRef.setInput('editions', editions);
    fixture.detectChanges();
    return { fixture, http: TestBed.inject(HttpTestingController), el: fixture.nativeElement as HTMLElement };
  }

  it('reads the chapters of the first audio edition with a file', async () => {
    const { fixture, http, el } = setup();
    http.expectOne('/api/media/1/editions/101/chapters').flush(bookChaptersFixture);
    await fixture.whenStable();
    fixture.detectChanges();
    const rows = Array.from(el.querySelectorAll('[data-testid="chapter"]'));
    expect(rows.map((r) => r.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Chapter 1 0:00',
      'Chapter 2 30:00',
    ]);
    expect(el.querySelector('select')).toBeNull();
  });

  it('asks for nothing and renders nothing without an audio file', () => {
    const { http, el } = setup([bookDetailFixture.editions[0], { ...audioEditionFixture, hasFile: false }]);
    http.expectNone((r) => r.url.includes('/chapters'));
    expect(el.textContent?.trim()).toBe('');
  });

  it('switches edition from the picker', async () => {
    const second = { ...audioEditionFixture, id: 102, label: 'Second' };
    const { fixture, http, el } = setup([audioEditionFixture, second]);
    http.expectOne('/api/media/1/editions/101/chapters').flush(bookChaptersFixture);
    await fixture.whenStable();
    fixture.detectChanges();
    const select = el.querySelector('select')!;
    select.value = '102';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    http.expectOne('/api/media/1/editions/102/chapters').flush([]);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="chapter"]')).toBeNull();
  });
});
