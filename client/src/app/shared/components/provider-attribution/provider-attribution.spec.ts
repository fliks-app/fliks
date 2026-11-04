import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { ProviderAttributionComponent } from './provider-attribution';
import type { MediaProvider } from '../../../core/services/api/media.service';

function render(providers: MediaProvider[] | undefined) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
    ],
  });
  const fixture = TestBed.createComponent(ProviderAttributionComponent);
  fixture.componentRef.setInput('providers', providers);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('ProviderAttributionComponent', () => {
  it('shows nothing for a title with no source to credit', () => {
    expect(render([]).querySelector('[data-testid="attribution"]')).toBeNull();
    expect(render(undefined).querySelector('[data-testid="attribution"]')).toBeNull();
  });

  it('links each plugin that has a homepage and skips the one that has none', () => {
    const el = render([
      { provider: 'org.cv:volume', name: 'Comic Source', url: 'https://cv.test' },
      { provider: 'org.gone:id', name: 'Gone', url: null },
    ]);
    const links = Array.from(el.querySelectorAll('[data-testid="attribution-link"]'));
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://cv.test');
  });

  it('notes unofficial sources once', () => {
    const el = render([
      { provider: 'audible', name: 'Audible', url: null, unofficial: true },
      { provider: 'audnexus', name: 'Audnexus', url: null, unofficial: true },
    ]);
    expect(el.querySelectorAll('[data-testid="unofficial"]')).toHaveLength(1);
  });
});
