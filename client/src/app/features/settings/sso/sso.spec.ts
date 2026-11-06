import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OidcApiService, OidcProviderRow } from '../../../core/services/api/oidc-api.service';
import { RolesApiService } from '../../../core/services/api/roles-api.service';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ToastService } from '../../../core/services/toast.service';
import { TvService } from '../../../core/services/tv.service';
import { SsoProviderEditorComponent } from './sso-provider-editor';
import { SsoSettingsComponent } from './sso';

const row = (id: number, over: Partial<OidcProviderRow> = {}): OidcProviderRow => ({
  id,
  name: `P${id}`,
  issuer: `https://idp${id}.test`,
  clientId: 'cid',
  clientSecretSet: true,
  caPem: null,
  scope: 'openid profile email',
  prompt: null,
  usernameClaim: 'preferred_username',
  groupsClaim: 'groups',
  allowedGroups: [],
  adminGroups: ['admins'],
  roleMappings: [{ group: 'kids', roleId: 2 }],
  autoRegister: false,
  matchByEmail: false,
  endSessionAtProvider: false,
  accountUrl: null,
  enabled: true,
  position: id - 1,
  linkedUsers: id * 2,
  ...over,
});
const roles = [
  { id: 1, name: 'User', permissions: [], isDefault: true, defaultLibraryIds: [] },
  { id: 2, name: 'Kids', permissions: [], isDefault: false, defaultLibraryIds: [] },
];

function providers(api: Record<string, unknown>) {
  return [
    provideZonelessChangeDetection(),
    provideTranslateService({
      lang: 'en',
      loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
    }),
    { provide: OidcApiService, useValue: api },
    { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
  ];
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});

describe('SsoProviderEditorComponent', () => {
  function setup(publicUrl = 'https://fliks.test/') {
    const api = {
      create: vi.fn(async () => row(9)),
      update: vi.fn(async () => row(1)),
      test: vi.fn(async () => ({ ok: true, issuer: 'https://idp', algs: ['ES256'], pkce: true, endSession: true, backchannel: false })),
    };
    TestBed.configureTestingModule({ providers: providers(api) });
    const fixture = TestBed.createComponent(SsoProviderEditorComponent);
    fixture.componentRef.setInput('roles', roles);
    fixture.componentRef.setInput('publicUrl', publicUrl);
    fixture.detectChanges();
    return { api, cmp: fixture.componentInstance, fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('creates a provider with every field, a blank secret meaning public client', async () => {
    const { api, cmp } = setup();
    cmp.open(null);
    cmp.name.set(' Authentik ');
    cmp.issuer.set('https://idp.test');
    cmp.clientId.set('cid');
    cmp.allowedGroups.set('family\nfriends\nkids');
    cmp.adminGroups.set('');
    cmp.addMapping();
    cmp.setMapping(0, { group: ' kids ', roleId: 2 });
    cmp.addMapping();
    await cmp.save();
    expect(api.create).toHaveBeenCalledWith({
      name: 'Authentik',
      issuer: 'https://idp.test',
      clientId: 'cid',
      clientSecret: '',
      caPem: null,
      scope: 'openid profile email',
      prompt: null,
      usernameClaim: 'preferred_username',
      groupsClaim: null,
      allowedGroups: ['family', 'friends', 'kids'],
      adminGroups: [],
      roleMappings: [{ group: 'kids', roleId: 2 }],
      autoRegister: false,
      matchByEmail: false,
      endSessionAtProvider: false,
      accountUrl: null,
      enabled: true,
    });
  });

  it('edits with the issuer locked and the secret kept on blank', async () => {
    const { api, cmp, el, fixture } = setup();
    cmp.open(row(1));
    fixture.detectChanges();
    await fixture.whenStable();
    expect((el.querySelector('[data-testid="sso-issuer"]') as HTMLInputElement).disabled).toBe(true);
    await cmp.save();
    const [id, body] = api.update.mock.calls[0] as unknown as [number, { clientSecret: string }];
    expect(id).toBe(1);
    expect(body.clientSecret).toBe('');
  });

  it('removes the stored secret with an explicit null', async () => {
    const { api, cmp, el, fixture } = setup();
    cmp.open(row(1));
    fixture.detectChanges();
    (el.querySelector('[data-testid="sso-remove-secret"]') as HTMLButtonElement).click();
    await cmp.save();
    const [, body] = api.update.mock.calls[0] as unknown as [number, { clientSecret: string | null }];
    expect(body.clientSecret).toBeNull();
  });

  it('builds the three URIs from the public URL once the provider has an id', () => {
    const { cmp } = setup('https://fliks.test/');
    cmp.open(null);
    expect(cmp.uris()).toBeNull();
    cmp.open(row(4));
    expect(cmp.uris()?.map((u) => u.value)).toEqual([
      'https://fliks.test/api/auth/oidc/4/callback',
      'https://fliks.test/api/auth/oidc/4/backchannel-logout',
      'https://fliks.test/login?autoLaunch=0',
    ]);
  });

  it('has no URIs without a public URL', () => {
    const { cmp } = setup('');
    cmp.open(row(4));
    expect(cmp.uris()).toBeNull();
  });

  it('runs the discovery test and keeps the result', async () => {
    const { api, cmp } = setup();
    cmp.open(null);
    cmp.issuer.set(' https://idp ');
    cmp.caPem.set('');
    await cmp.test();
    expect(api.test).toHaveBeenCalledWith('https://idp', null);
    expect(cmp.testResult()).toMatchObject({ ok: true, pkce: true });
  });

  it('reorders role mappings', () => {
    const { cmp } = setup();
    cmp.open(row(1, { roleMappings: [{ group: 'a', roleId: 1 }, { group: 'b', roleId: 2 }] }));
    cmp.moveMapping(1, 0);
    expect(cmp.roleMappings().map((m) => m.group)).toEqual(['b', 'a']);
  });
});

describe('SsoSettingsComponent', () => {
  function setup(all: Record<string, string | null> = {}) {
    const api = { list: vi.fn(async () => [row(2), row(1)]), update: vi.fn(async () => row(1)), remove: vi.fn(async () => undefined) };
    const settings = {
      getAll: vi.fn(async () => ({ public_url: 'https://fliks.test', ...all })),
      setBulk: vi.fn(async () => ({ ok: true })),
    };
    TestBed.configureTestingModule({
      providers: [
        ...providers(api),
        { provide: RolesApiService, useValue: { list: async () => roles } },
        { provide: SettingsApiService, useValue: settings },
        { provide: ConfirmationService, useValue: { confirm: async () => true } },
        { provide: TvService, useValue: { isTv: () => false } },
      ],
    });
    const fixture = TestBed.createComponent(SsoSettingsComponent);
    fixture.detectChanges();
    return { api, settings, cmp: fixture.componentInstance, fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('lists the providers in position order with their linked-user count', async () => {
    const { cmp, fixture, el } = setup();
    await vi.waitFor(() => expect(cmp.loading()).toBe(false));
    fixture.detectChanges();
    const rows = [...el.querySelectorAll('[data-testid="sso-provider"]')];
    expect(rows.map((r) => r.querySelector('.font-medium')?.textContent)).toEqual(['P1', 'P2']);
    expect(rows[0]!.querySelector('[data-testid="sso-linked"]')?.textContent).toContain('settings.sso.linked_users');
  });

  it('saves the order by updating the providers whose position moved', async () => {
    const { api, cmp } = setup();
    await vi.waitFor(() => expect(cmp.loading()).toBe(false));
    await cmp.reorder(0, 1);
    expect(api.update).toHaveBeenCalledTimes(2);
    expect(api.update).toHaveBeenCalledWith(1, expect.objectContaining({ position: 1, clientSecret: '' }));
    expect(api.update).toHaveBeenCalledWith(2, expect.objectContaining({ position: 0 }));
  });

  it('reloads the list when a reorder fails, and ignores a second drag meanwhile', async () => {
    const { api, cmp } = setup();
    await vi.waitFor(() => expect(cmp.loading()).toBe(false));
    api.update.mockRejectedValueOnce(new Error('boom'));
    const first = cmp.reorder(0, 1);
    expect(cmp.reordering()).toBe(true);
    await cmp.reorder(1, 0);
    await first;
    expect(cmp.reordering()).toBe(false);
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('saves the two global settings together', async () => {
    const { settings, cmp } = setup({ password_login: 'admins', oidc_auto_launch: '2' });
    await vi.waitFor(() => expect(cmp.loading()).toBe(false));
    expect(cmp.passwordLogin()).toBe('admins');
    expect(cmp.autoLaunch()).toBe('2');
    cmp.autoLaunch.set('');
    await cmp.savePolicy();
    expect(settings.setBulk).toHaveBeenCalledWith({ password_login: 'admins', oidc_auto_launch: '' });
  });

  it('toggles a provider without touching its secret', async () => {
    const { api, cmp } = setup();
    await vi.waitFor(() => expect(cmp.loading()).toBe(false));
    await cmp.toggle(cmp.providers()[0]!);
    expect(api.update).toHaveBeenCalledWith(1, expect.objectContaining({ enabled: false, clientSecret: '' }));
  });
});
