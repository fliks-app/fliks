import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileFanartHeroComponent } from './mobile-fanart-hero';
import { ServerConfigService } from '../../core/services/server-config.service';

/** A single <img> whose src changes cuts to the new picture the moment it
 *  decodes, so the swap holds the outgoing one under the fade. */
describe('MobileFanartHeroComponent — cross-fade on swap', () => {
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  function createFixture() {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ServerConfigService,
          useValue: { resolveUrl: (u: string) => u } as unknown as ServerConfigService,
        },
      ],
    });
    const fixture = TestBed.createComponent(MobileFanartHeroComponent);
    fixture.componentRef.setInput('fanartUrl', '/a.jpg');
    fixture.detectChanges();
    return fixture;
  }

  const sources = (fixture: { nativeElement: HTMLElement }) =>
    [...fixture.nativeElement.querySelectorAll('img')].map((i) => i.getAttribute('src'));

  it('holds the outgoing picture until the incoming one has loaded', () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    expect(sources(fixture)).toEqual(['/a.jpg']);

    fixture.componentRef.setInput('fanartUrl', '/b.jpg');
    fixture.detectChanges();
    expect(sources(fixture)).toEqual(['/a.jpg', '/b.jpg']);

    const incoming = fixture.nativeElement.querySelector('img[src="/b.jpg"]')!;
    incoming.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(300);
    fixture.detectChanges();

    expect(sources(fixture)).toEqual(['/b.jpg']);
  });

  it('renders the placeholder and no image without a url', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('fanartUrl', null);
    fixture.detectChanges();

    expect(sources(fixture)).toEqual([]);
  });
});
