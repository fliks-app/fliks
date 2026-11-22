import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Type, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { SKIP_ERROR_TOAST } from '../../core/interceptors/error.interceptor';
import { AcquisitionSettingsComponent } from './acquisition/acquisition-settings';
import { EmailSettingsComponent } from './email/email';
import { GeneralSettingsComponent } from './general/general';
import { LyricsSettingsComponent } from './lyrics/lyrics-settings';
import { NamingSettingsComponent } from './naming/naming';
import { StreamingSettingsComponent } from './streaming/streaming';
import { SubtitlesSettingsComponent } from './subtitles/subtitles-settings';

const pages: [string, Type<unknown>][] = [
  ['email', EmailSettingsComponent],
  ['naming', NamingSettingsComponent],
  ['acquisition', AcquisitionSettingsComponent],
  ['subtitles', SubtitlesSettingsComponent],
  ['lyrics', LyricsSettingsComponent],
  ['general', GeneralSettingsComponent],
  ['streaming', StreamingSettingsComponent],
];

describe.each(pages)('the %s settings page on a failed load', (_name, page) => {
  async function open() {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(page);
    await fixture.whenStable();
    const settings = () => http.match((r) => r.url === '/api/settings');
    const failFirst = async () => {
      settings().forEach((r) => r.flush('', { status: 502, statusText: 'Bad Gateway' }));
      await new Promise((r) => setTimeout(r));
      await fixture.whenStable();
    };
    return { fixture, el: fixture.nativeElement as HTMLElement, settings, failFirst };
  }

  it('shows the failed card and no form to save', async () => {
    const { el, failFirst } = await open();
    await failFirst();
    expect(el.querySelector('app-load-failed [role=alert]')).not.toBeNull();
    expect(el.querySelectorAll('button')).toHaveLength(1);
  });

  it('asks without the error toast, since the page renders its own failure', async () => {
    const { settings, failFirst } = await open();
    const [req] = settings();
    expect(req.request.context.get(SKIP_ERROR_TOAST)).toBe(true);
    req.flush('', { status: 502, statusText: 'Bad Gateway' });
    await failFirst();
  });

  it('loads again from Retry', async () => {
    const { el, settings, failFirst } = await open();
    await failFirst();
    (el.querySelector('app-load-failed button') as HTMLButtonElement).click();
    expect(settings()).toHaveLength(1);
  });
});
