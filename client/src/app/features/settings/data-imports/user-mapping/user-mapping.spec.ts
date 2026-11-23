import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { ImportUserMappingComponent, NEW_ACCOUNT, type UnmappedUser } from './user-mapping';
import { UsersApiService } from '../../../../core/services/api/users-api.service';
import { ToastService } from '../../../../core/services/toast.service';

const USERS: UnmappedUser[] = [
  { provider: 'seerr', externalId: '7', username: 'ana' },
  { provider: 'emby:2', externalId: 'abc', username: 'bob' },
];

function setup(overrides: Record<string, unknown> = {}) {
  const api = {
    list: vi.fn(() => Promise.resolve([{ id: 5, username: 'ana' }, { id: 6, username: 'bob' }])),
    create: vi.fn(() => Promise.resolve({ id: 9 })),
    mapImported: vi.fn(() => Promise.resolve({ ok: true })),
    ...overrides,
  };
  const toast = { success: vi.fn(), error: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: UsersApiService, useValue: api },
      { provide: ToastService, useValue: toast },
    ],
  });
  const fixture = TestBed.createComponent(ImportUserMappingComponent);
  fixture.componentRef.setInput('users', USERS);
  fixture.componentRef.setInput('shown', true);
  fixture.detectChanges();
  const cmp = fixture.componentInstance as unknown as {
    setChoice(u: UnmappedUser, v: string): void;
    setNewName(u: UnmappedUser, v: string): void;
    canMap(u: UnmappedUser): boolean;
    map(u: UnmappedUser): Promise<void>;
  };
  const mapped = vi.fn();
  fixture.componentInstance.mapped.subscribe(mapped);
  return { fixture, cmp, api, toast, mapped };
}

describe('ImportUserMappingComponent', () => {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  });

  it('loads the accounts when shown and renders one row per unmapped user', async () => {
    const { fixture, api } = setup();
    await vi.waitFor(() => expect(api.list).toHaveBeenCalled());
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('li').length).toBe(2);
    expect(fixture.nativeElement.textContent).toContain('ana');
    expect(fixture.nativeElement.textContent).toContain('bob');
  });

  it('maps a user to the chosen account', async () => {
    const { cmp, api, mapped, toast } = setup();
    expect(cmp.canMap(USERS[0])).toBe(false);
    cmp.setChoice(USERS[0], '5');
    expect(cmp.canMap(USERS[0])).toBe(true);
    await cmp.map(USERS[0]);
    expect(api.mapImported).toHaveBeenCalledWith({ provider: 'seerr', externalId: '7', userId: 5 });
    expect(mapped).toHaveBeenCalledWith(USERS[0]);
    expect(toast.success).toHaveBeenCalled();
  });

  it('creates an account first when asked, and needs a name for it', async () => {
    const { cmp, api } = setup();
    cmp.setChoice(USERS[1], NEW_ACCOUNT);
    expect(cmp.canMap(USERS[1])).toBe(false);
    cmp.setNewName(USERS[1], ' bob2 ');
    expect(cmp.canMap(USERS[1])).toBe(true);
    await cmp.map(USERS[1]);
    expect(api.create).toHaveBeenCalledWith({ username: 'bob2' });
    expect(api.mapImported).toHaveBeenCalledWith({ provider: 'emby:2', externalId: 'abc', userId: 9 });
  });

  it('keeps the row and toasts when the server refuses', async () => {
    const { cmp, mapped, toast } = setup({ mapImported: vi.fn(() => Promise.reject(new Error('no'))) });
    cmp.setChoice(USERS[0], '5');
    await cmp.map(USERS[0]);
    expect(mapped).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });
});
