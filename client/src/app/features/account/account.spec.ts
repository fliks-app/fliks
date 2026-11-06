import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, TranslateService, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AuthSession, SessionsApiService } from '../../core/services/api/sessions-api.service';
import { OidcApiService } from '../../core/services/api/oidc-api.service';
import { UsersApiService, passwordErrorMessage } from '../../core/services/api/users-api.service';
import { AuthService } from '../../core/services/auth.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ToastService } from '../../core/services/toast.service';
import { AccountComponent } from './account';

const session = (id: number, current = false): AuthSession => ({
  id,
  method: 'password',
  userAgent: `agent ${id}`,
  createdAt: '2026-11-02T10:00:00.000Z',
  lastSeenAt: '2026-11-03T10:00:00.000Z',
  current,
});

function setup(confirmed = true) {
  const users = { update: vi.fn(async () => ({})) };
  const sessions = {
    list: vi.fn(async () => [session(1, true), session(2)]),
    revoke: vi.fn(async () => undefined),
  };
  const toast = { success: vi.fn(), error: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: UsersApiService, useValue: users },
      { provide: SessionsApiService, useValue: sessions },
      {
        provide: AuthService,
        useValue: {
          user: () => ({ id: 7, isAdmin: false }),
          oidcInfo: vi.fn(async () => undefined),
          ssoProviders: () => [],
          ssoOtherOrigin: () => false,
          passwordLogin: () => 'everyone',
        },
      },
      { provide: OidcApiService, useValue: { identities: vi.fn(async () => ({ hasPassword: true, identities: [] })) } },
      { provide: ConfirmationService, useValue: { confirm: async () => confirmed } },
      { provide: ToastService, useValue: toast },
    ],
  });
  const fixture = TestBed.createComponent(AccountComponent);
  fixture.detectChanges();
  return { users, sessions, toast, cmp: fixture.componentInstance };
}

describe('AccountComponent', () => {
  it('sends the current password with the new one and reloads the sessions', async () => {
    const { users, sessions, cmp } = setup();
    await vi.waitFor(() => expect(cmp.sessions().length).toBe(2));
    cmp.formCurrentPassword.set('old-pass');
    cmp.formPassword.set('new-password');
    cmp.formPasswordConfirm.set('new-password');
    await cmp.save();
    expect(users.update).toHaveBeenCalledWith(
      7,
      { password: 'new-password', currentPassword: 'old-pass' },
      { skipErrorToast: true },
    );
    expect(cmp.formCurrentPassword()).toBe('');
    await vi.waitFor(() => expect(sessions.list).toHaveBeenCalledTimes(2));
  });

  it('shows a wrong current password translated and keeps the form', async () => {
    const { users, toast, cmp } = setup();
    users.update.mockRejectedValueOnce(
      new HttpErrorResponse({ status: 400, error: { message: 'Current password is incorrect' } }),
    );
    cmp.formPassword.set('new-password');
    cmp.formPasswordConfirm.set('new-password');
    await cmp.save();
    expect(toast.error).toHaveBeenCalledWith('account.current_password_wrong');
    expect(cmp.formPassword()).toBe('new-password');
  });

  it('signs a device out after a confirmation and drops it from the list', async () => {
    const { sessions, cmp } = setup();
    await vi.waitFor(() => expect(cmp.sessions().length).toBe(2));
    await cmp.revoke(cmp.sessions()[1]);
    expect(sessions.revoke).toHaveBeenCalledWith(2);
    expect(cmp.sessions().map((s) => s.id)).toEqual([1]);
  });

  it('leaves the device alone when the confirmation is declined', async () => {
    const { sessions, cmp } = setup(false);
    await vi.waitFor(() => expect(cmp.sessions().length).toBe(2));
    await cmp.revoke(cmp.sessions()[1]);
    expect(sessions.revoke).not.toHaveBeenCalled();
    expect(cmp.sessions().length).toBe(2);
  });
});

describe('passwordErrorMessage', () => {
  it('falls back to the server message for any other failure', () => {
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({
          lang: 'en',
          loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
        }),
      ],
    });
    const translate = TestBed.inject(TranslateService);
    const err = new HttpErrorResponse({ status: 400, error: { message: 'password too short' } });
    expect(passwordErrorMessage(err, translate)).toBe('password too short');
  });
});
