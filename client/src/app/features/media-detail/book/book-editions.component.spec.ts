import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { audioEditionFixture, bookDetailFixture } from '../../../core/services/api/books.fixtures';
import { BookEditionsComponent } from './book-editions.component';
import { bookSpecProviders } from './book-test-setup';

describe('BookEditionsComponent', () => {
  function render(editions = bookDetailFixture.editions) {
    TestBed.configureTestingModule({ providers: bookSpecProviders() });
    const fixture = TestBed.createComponent(BookEditionsComponent);
    fixture.componentRef.setInput('editions', editions);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('lists one row per edition with its length', () => {
    const rows = Array.from(render().querySelectorAll('[data-testid="edition-row"]'));
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('epub');
    expect(rows[0].textContent).toContain('books_work.pages');
    expect(rows[1].textContent).toContain('10:00:00');
    expect(rows[1].textContent).toContain('Narrator One');
  });

  it('marks an edition without a file', () => {
    const rows = render([{ ...audioEditionFixture, hasFile: false }]).querySelectorAll('[data-testid="edition-row"]');
    expect(rows[0].textContent).toContain('books_work.file_no');
  });
});
