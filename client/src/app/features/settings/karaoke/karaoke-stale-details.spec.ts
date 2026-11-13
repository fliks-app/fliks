import { provideZonelessChangeDetection } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { KaraokeStaleTrack } from '../../../core/services/api/karaoke.models';
import { KaraokeStaleDetailsComponent } from './karaoke-stale-details';

const track = (itemId: number): KaraokeStaleTrack => ({
  itemId,
  title: `T${itemId}`,
  album: null,
  artist: null,
  language: 'fr',
  model: 'a',
  aligner: 'b',
  result: null,
});

describe('KaraokeStaleDetailsComponent', () => {
  let seen: (e: { isIntersecting: boolean }[]) => void;
  const offsets: number[] = [];

  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = () => undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: typeof seen) {
          seen = cb;
        }
        observe = () => undefined;
        disconnect = () => undefined;
      },
    );
    offsets.length = 0;
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTranslateService({
          lang: 'en',
          loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
        }),
        {
          provide: HttpClient,
          useValue: {
            get: (_url: string, o: { params: { offset: number } }) => {
              const { offset } = o.params;
              offsets.push(offset);
              const items = Array.from({ length: Math.min(50, 120 - offset) }, (_, i) => track(offset + i));
              return of({ total: 120, minMatch: 0.17, items });
            },
          },
        },
      ],
    });
  });

  it('loads the next page each time the list end scrolls into view, then stops', async () => {
    const fixture = TestBed.createComponent(KaraokeStaleDetailsComponent);
    fixture.componentRef.setInput('models', []);
    fixture.detectChanges();
    await fixture.whenStable();
    const c = fixture.componentInstance;
    for (let i = 0; i < 4; i++) {
      seen([{ isIntersecting: true }]);
      await fixture.whenStable();
    }
    expect(offsets).toEqual([0, 50, 100]);
    expect(c['items']().length).toBe(120);
    expect(c['hasMore']).toBe(false);
  });
});
