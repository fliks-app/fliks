import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { MobileFanartHeroComponent } from './mobile-fanart-hero';
import { ServerConfigService } from '../../core/services/server-config.service';

/** A single <img> whose src changes cuts to the new picture the moment it
 *  decodes, so a swap fades the outgoing one out over the incoming one. The
 *  fade rides the OUTGOING layer on purpose: on the incoming one an
 *  already-cached picture skips it, which is most swaps. */
describe('MobileFanartHeroComponent — cross-fade on swap', () => {
  afterEach(() => TestBed.resetTestingModule());

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

  const images = (fixture: { nativeElement: HTMLElement }) => [
    ...fixture.nativeElement.querySelectorAll('img'),
  ];
  const sources = (fixture: { nativeElement: HTMLElement }) =>
    images(fixture).map((i) => i.getAttribute('src'));

  it('fades the outgoing picture out over an incoming one shown at once', () => {
    const fixture = createFixture();
    expect(sources(fixture)).toEqual(['/a.jpg']);

    fixture.componentRef.setInput('fanartUrl', '/b.jpg');
    fixture.detectChanges();
    const [incoming, outgoing] = images(fixture);
    expect(sources(fixture)).toEqual(['/b.jpg', '/a.jpg']);
    // Nothing in jsdom ever loads: the incoming layer is opaque because the
    // swap asks for it, not because the picture happened to be cached.
    expect(incoming.style.opacity).toBe('1');
    expect(outgoing.classList).not.toContain('hero-swap-out');

    incoming.dispatchEvent(new Event('load'));
    fixture.detectChanges();
    expect(outgoing.classList).toContain('hero-swap-out');

    outgoing.dispatchEvent(new Event('animationend'));
    fixture.detectChanges();
    expect(sources(fixture)).toEqual(['/b.jpg']);
  });

  it('renders no image without a url', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('fanartUrl', null);
    fixture.detectChanges();

    expect(sources(fixture)).toEqual([]);
  });
});
