import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopNotifyPrefs } from '../../../core/plugins/desktop-player.bridge';
import { PushService } from '../../../core/services/push.service';
import { GeneralSettingsPageComponent } from './general-settings';

async function render(prefs: DesktopNotifyPrefs) {
  const setDesktopPref = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: PushService, useValue: { desktopPrefs: signal(prefs), setDesktopPref } },
    ],
  });
  const fixture = TestBed.createComponent(GeneralSettingsPageComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return { text: el.textContent ?? '', switches: el.querySelectorAll<HTMLInputElement>('input[type=checkbox]'), setDesktopPref };
}

describe('GeneralSettingsPageComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('offers quit on close only where the shell reports it', async () => {
    const { text } = await render({ notifications: true, background: false, startAtLogin: false });
    expect(text).not.toContain('app_settings.general.quit_on_close');
  });

  it('saves the macOS quit on close switch', async () => {
    const { text, switches, setDesktopPref } = await render({ notifications: true, background: false, startAtLogin: false, quitOnClose: false });
    expect(text).toContain('app_settings.general.quit_on_close');
    switches[1].click();
    expect(setDesktopPref).toHaveBeenCalledWith({ quitOnClose: true });
  });
});
