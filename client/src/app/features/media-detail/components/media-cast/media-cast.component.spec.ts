import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaCastEntry } from '../../../../core/services/api/media.service';
import { bookSpecProviders } from '../../book/book-test-setup';
import { MediaCastComponent, libraryCast, providerCast } from './media-cast.component';

const CAST: MediaCastEntry[] = [
  { id: 1, character: 'Lead', order: 0, person: { id: 11, name: 'Ann Actor', avatarUrl: null } },
  { id: 2, character: '', order: 1, person: { id: 12, name: 'Bob Actor', avatarUrl: null } },
];

function render(cast: MediaCastEntry[]) {
  TestBed.configureTestingModule({ providers: bookSpecProviders() });
  const fixture = TestBed.createComponent(MediaCastComponent);
  fixture.componentRef.setInput('cast', libraryCast(cast));
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('MediaCastComponent', () => {
  beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} }));
  afterEach(() => vi.unstubAllGlobals());

  it('links each member to their person page, under a divider and a folding heading', () => {
    const el = render(CAST);
    expect(el.querySelector('.divider')).not.toBeNull();
    expect(el.querySelector('button')?.textContent).toContain('media_detail.cast');
    expect(Array.from(el.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(['/persons/11', '/persons/12']);
  });

  it('hides its host, divider included, with no cast', () => {
    const el = render([]);
    expect(el.classList.contains('hidden')).toBe(true);
    expect(el.querySelector('.divider')).toBeNull();
  });

  it('draws a previewed title cast as plain cards, with no link to follow', () => {
    TestBed.configureTestingModule({ providers: bookSpecProviders() });
    const fixture = TestBed.createComponent(MediaCastComponent);
    fixture.componentRef.setInput('cast', providerCast([{ externalId: 5, name: 'Cy Actor', character: 'Hero', avatarUrl: null }]));
    fixture.detectChanges();
    const preview = fixture.nativeElement as HTMLElement;
    expect(preview.querySelector('a')).toBeNull();
    expect(preview.textContent).toContain('Cy Actor');
    expect(preview.textContent).toContain('Hero');
  });
});
