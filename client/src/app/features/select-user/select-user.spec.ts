import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { AuthService } from '../../core/services/auth.service';
import { SelectUserComponent } from './select-user';

function open(passwordLogin: 'everyone' | 'admins') {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      {
        provide: AuthService,
        useValue: {
          listUsersPublic: async () => [{ id: 1, username: 'ada', avatar: null }],
          resumableSessions: signal([]),
          ssoProviders: signal([{ id: 3, name: 'Authentik' }]),
          passwordLogin: signal(passwordLogin),
          oidcBusy: signal(false),
          oidcInfo: async () => undefined,
          oidcAutoLaunch: () => false,
          oidcSignIn: async () => undefined,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(SelectUserComponent);
  const cmp = fixture.componentInstance;
  return { fixture, cmp, el: fixture.nativeElement as HTMLElement };
}

describe('SelectUserComponent sheet', () => {
  for (const [mode, first] of [
    ['admins', 'sso'],
    ['everyone', 'password'],
  ] as const) {
    it(`leads with ${first} under password_login=${mode}`, async () => {
      const { fixture, cmp, el } = open(mode);
      fixture.detectChanges();
      await fixture.whenStable();
      await cmp.selectUser({ id: 1, username: 'ada', avatar: null });
      fixture.detectChanges();
      const buttons = [...el.querySelectorAll('[data-tv-modal] button')].map(
        (b) => b.textContent?.trim() ?? '',
      );
      const sso = buttons.findIndex((t) => t.includes('Authentik') || t.includes('sso'));
      const admin = el.querySelector('[data-testid="admin-sign-in"]');
      expect(sso).toBeGreaterThanOrEqual(0);
      expect(!!admin).toBe(mode === 'admins');
      if (mode === 'admins') expect(sso).toBe(0);
      else expect(sso).toBeGreaterThan(1);
    });
  }
});
