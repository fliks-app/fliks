import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsersApiService } from '../../../core/services/api/users-api.service';
import { AuthService } from '../../../core/services/auth.service';
import { PushService, type SystemBlock } from '../../../core/services/push.service';
import { ToastService } from '../../../core/services/toast.service';
import { TvService } from '../../../core/services/tv.service';
import { NotificationSettingsPageComponent } from './notification-settings';

async function render(o: { block: SystemBlock | null; canOpen: boolean; desktop?: boolean; enabled?: boolean }) {
  const openSystemSettings = vi.fn();
  const push = {
    mode: o.desktop ? 'desktop' : 'native',
    canEnableDevice: () => !o.desktop,
    mobileBlockedByAdmin: () => false,
    desktopPrefs: signal(o.desktop ? { notifications: true, background: false, startAtLogin: false } : null),
    deviceEnabled: () => o.enabled ?? true,
    permission: () => (o.block ? 'denied' : 'granted'),
    systemBlock: () => o.block,
    canOpenSystemSettings: () => o.canOpen,
    busy: () => false,
    plugins: () => [],
    loadConfig: async () => null,
    openSystemSettings,
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: PushService, useValue: push },
      { provide: AuthService, useValue: { user: () => ({ id: 1, pushMuted: [] }) } },
      { provide: UsersApiService, useValue: {} },
      { provide: ToastService, useValue: {} },
      { provide: TvService, useValue: { isTv: () => false } },
    ],
  });
  const fixture = TestBed.createComponent(NotificationSettingsPageComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const status = el.querySelector('[role=status]');
  const deviceSwitch = el.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  return { status, deviceSwitch, button: status?.querySelector('button') ?? null, openSystemSettings };
}

describe('NotificationSettingsPageComponent system status', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows nothing while the system shows notifications', async () => {
    const { status, deviceSwitch } = await render({ block: null, canOpen: false });
    expect(status).toBeNull();
    expect(deviceSwitch.checked).toBe(true);
  });

  it('turns the switch off and opens the settings when the system refused', async () => {
    const { status, deviceSwitch, button, openSystemSettings } = await render({ block: 'denied_app', canOpen: true });
    expect(status!.textContent).toContain('app_settings.notifications.denied_app');
    expect(deviceSwitch.checked).toBe(false);
    button!.click();
    expect(openSystemSettings).toHaveBeenCalledOnce();
  });

  it('says a phone is not yet allowed, the switch being the way to ask', async () => {
    const { status, button } = await render({ block: 'not_allowed', canOpen: false });
    expect(status!.textContent).toContain('app_settings.notifications.not_allowed');
    expect(button).toBeNull();
  });

  it('renders the desktop block the same way, its switch off and locked', async () => {
    const { status, deviceSwitch, button } = await render({ block: 'denied_app', canOpen: true, desktop: true });
    expect(status!.textContent).toContain('app_settings.notifications.denied_app');
    expect(button).not.toBeNull();
    expect(deviceSwitch.checked).toBe(false);
    expect(deviceSwitch.disabled).toBe(true);
  });

  it('has no settings button where the system has no notification service', async () => {
    const { status, button } = await render({ block: 'unavailable', canOpen: false, desktop: true });
    expect(status!.textContent).toContain('app_settings.notifications.unavailable');
    expect(button).toBeNull();
  });
});
