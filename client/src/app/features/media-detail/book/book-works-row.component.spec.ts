import { Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaCardComponent } from '../../../shared/components/media-card/media-card';
import { BookWorksRowComponent, type WorkItem } from './book-works-row.component';
import { bookSpecProviders } from './book-test-setup';

@Component({ selector: 'app-media-card', template: '' })
class CardStub {
  readonly title = input('');
  readonly subtitle = input<string | undefined>();
  readonly link = input<string[] | null>(null);
  readonly highlighted = input(false);
  readonly progressPercent = input(0);
  readonly imageUrl = input<string | null>(null);
  readonly aspect = input('');
  readonly posterMorph = input(true);
}

const ITEMS: WorkItem[] = [
  { id: 1, title: 'Book One', posterUrl: null, label: '1', progressPercent: 100 },
  { id: 3, title: 'Book Three', posterUrl: null, label: null, progressPercent: 0 },
];

describe('BookWorksRowComponent', () => {
  afterEach(() => vi.unstubAllGlobals());

  function render() {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    TestBed.configureTestingModule({ providers: bookSpecProviders() });
    TestBed.overrideComponent(BookWorksRowComponent, {
      remove: { imports: [MediaCardComponent] },
      add: { imports: [CardStub] },
    });
    const fixture = TestBed.createComponent(BookWorksRowComponent);
    fixture.componentRef.setInput('heading', 'Series One');
    fixture.componentRef.setInput('items', ITEMS);
    fixture.componentRef.setInput('currentId', 1);
    fixture.detectChanges();
    return fixture;
  }

  it('renders a titled card per work, linked to its book page, the current one highlighted', () => {
    const fixture = render();
    const cards = fixture.debugElement.queryAll((d) => d.name === 'app-media-card');
    expect(fixture.nativeElement.querySelector('h2').textContent).toContain('Series One');
    expect(cards.map((c) => c.componentInstance.title())).toEqual(['Book One', 'Book Three']);
    expect(cards.map((c) => c.componentInstance.subtitle())).toEqual(['#1', '']);
    expect(cards.map((c) => c.componentInstance.link())).toEqual([['/books', '1'], ['/books', '3']]);
    expect(cards.map((c) => c.componentInstance.highlighted())).toEqual([true, false]);
  });
});
