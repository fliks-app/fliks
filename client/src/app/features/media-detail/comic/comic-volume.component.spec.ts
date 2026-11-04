import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { AuthService } from '../../../core/services/auth.service';
import { TvService } from '../../../core/services/tv.service';
import type { ComicIssue } from '../../../core/services/api/comics.models';
import type { Media } from '../../../core/services/api/media.service';
import { bookSpecProviders } from '../book/book-test-setup';
import { ComicVolumeComponent } from './comic-volume.component';

const issue = (n: number, over: Partial<ComicIssue> = {}): ComicIssue =>
  ({ itemId: n, mediaFileId: n, format: 'cbz', number: String(n), sort: n, kind: 'issue', annual: false, title: null, finished: false, progression: null, ...over }) as ComicIssue;

function setup(media: Partial<Media>, isTv = false) {
  TestBed.configureTestingModule({
    providers: bookSpecProviders(
      { provide: AuthService, useValue: { hasPermission: () => true } },
      { provide: TvService, useValue: { isTv: () => isTv } },
    ),
  });
  const fixture = TestBed.createComponent(ComicVolumeComponent);
  fixture.componentRef.setInput('media', { id: 7, type: 'comic', title: 'Volume One', posterUrl: '/p.jpg', ...media });
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('ComicVolumeComponent', () => {
  it('renders the title from a card handoff before the issues arrive', () => {
    const el = setup({});
    expect(el.querySelector('h1')!.textContent).toBe('Volume One');
    expect(el.querySelector('[data-testid="read-button"]')).toBeNull();
    expect(el.querySelector('[data-testid="issue"]')).toBeNull();
  });

  it('shows the read button and the read ratio as progress, on a TV too, without the edit button', () => {
    const el = setup(
      { comic: { publisher: null, startYear: null, volume: null, issues: [issue(1, { finished: true }), issue(2)] } } as unknown as Partial<Media>,
      true,
    );
    expect(el.querySelector('[data-testid="read-button"]')!.getAttribute('href')).toBe('/read/7/2');
    expect(el.querySelector<HTMLElement>('app-hero-progress .bg-primary')!.style.width).toBe('50%');
    expect(el.querySelector('[data-testid="edit-volume"]')).toBeNull();
  });
});
