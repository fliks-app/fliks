import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { LiveTvAccessComponent } from './live-tv-access';
import {
  LiveTvUserAccess,
  RestrictedGroup,
} from '../../../../core/services/api/livetv-api.service';
import { ToastService } from '../../../../core/services/toast.service';

beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  }
});

const GROUPS = [
  { name: 'News', count: 12 },
  { name: 'XXX Uncut', count: 3 },
];

/** Mirrors which of the fixed test group names the server would flag automatic. */
const AUTO_GROUPS = new Set(['XXX Uncut']);
function asRestrictedGroups(
  names: string[],
  cleanupAt: Record<string, string> = {},
): RestrictedGroup[] {
  return names.map((name) => ({
    name,
    automatic: AUTO_GROUPS.has(name),
    vanishedSince: cleanupAt[name] ?? null,
    cleanupAt: cleanupAt[name] ?? null,
  }));
}

function createFixture(opts: {
  restricted?: string[];
  vanishing?: Record<string, string>;
  exempt?: string[];
  users?: Array<Omit<LiveTvUserAccess, 'hasFullAccess'> & { hasFullAccess?: boolean }>;
  get?: ReturnType<typeof vi.fn>;
  put?: ReturnType<typeof vi.fn>;
}): {
  fixture: ComponentFixture<LiveTvAccessComponent>;
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
} {
  const get =
    opts.get ??
    vi.fn((url: string) => {
      if (url === '/api/livetv/admin/channels') return of({ items: [], total: 0, groups: GROUPS });
      if (url === '/api/livetv/admin/access/restricted-groups')
        return of({
          groups: asRestrictedGroups(opts.restricted ?? [], opts.vanishing ?? {}),
          exempt: opts.exempt ?? [],
        });
      if (url === '/api/livetv/admin/access/users')
        return of((opts.users ?? []).map((u) => ({ hasFullAccess: false, ...u })));
      throw new Error(`unexpected GET ${url}`);
    });
  const put =
    opts.put ??
    vi.fn((url: string, body: { groups: string[] }) =>
      url.includes('/users/') ? of({ groups: body.groups, ignored: [] }) : of(body.groups),
    );

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      {
        provide: HttpClient,
        useValue: { get, put } as unknown as HttpClient,
      },
    ],
  });
  const fixture = TestBed.createComponent(LiveTvAccessComponent);
  fixture.detectChanges();
  return { fixture, get, put };
}

async function ready(opts: Parameters<typeof createFixture>[0] = {}) {
  const { fixture, get, put } = createFixture(opts);
  await fixture.whenStable();
  return { component: fixture.componentInstance, get, put, fixture };
}

describe('LiveTvAccessComponent - restricted groups', () => {
  it('loads the restricted-groups list from the API', async () => {
    const { component, get } = await ready({ restricted: ['News'] });

    expect(get).toHaveBeenCalledWith('/api/livetv/admin/access/restricted-groups');
    expect(component.restricted()).toEqual(new Set(['News']));
  });

  it('saves the full updated set when a group is toggled', async () => {
    const { component, put } = await ready({ restricted: ['News'] });

    await component.toggleRestricted('XXX Uncut');

    expect(put).toHaveBeenCalledWith('/api/livetv/admin/access/restricted-groups', {
      groups: ['News', 'XXX Uncut'],
    });
    expect(component.restricted()).toEqual(new Set(['News', 'XXX Uncut']));
  });

  it('removes a group from the set instead of adding it a second time', async () => {
    const { component, put } = await ready({ restricted: ['News', 'XXX Uncut'] });

    await component.toggleRestricted('News');

    expect(put).toHaveBeenCalledWith('/api/livetv/admin/access/restricted-groups', {
      groups: ['XXX Uncut'],
    });
  });

  it('drops the unrestricted group from the users table without an extra request', async () => {
    const { component, get } = await ready({
      restricted: ['News', 'XXX Uncut'],
      users: [
        { id: 7, username: 'alice', groups: ['News'] },
        { id: 8, username: 'bob', groups: ['News', 'XXX Uncut'] },
      ],
    });
    get.mockClear();

    await component.toggleRestricted('News');

    expect(component.users()).toEqual([
      { id: 7, username: 'alice', groups: [], hasFullAccess: false },
      { id: 8, username: 'bob', groups: ['XXX Uncut'], hasFullAccess: false },
    ]);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('LiveTvAccessComponent - concurrent toggles', () => {
  it('does not let a second toggle overwrite the first with a stale snapshot', async () => {
    const { component, put } = await ready({ restricted: ['News', 'Sport'] });

    const first = component.toggleRestricted('Sport');
    const second = component.toggleRestricted('Adult');
    await Promise.all([first, second]);

    const lastBody = put.mock.calls[put.mock.calls.length - 1][1] as { groups: string[] };
    expect([...lastBody.groups].sort()).toEqual(['Adult', 'News']);
    expect([...component.restricted()].sort()).toEqual(['Adult', 'News']);
  });

  it('shows every in-flight group as busy, not only the most recent one', async () => {
    const { component } = await ready({ restricted: ['News', 'Sport'] });

    const first = component.toggleRestricted('Sport');
    const second = component.toggleRestricted('Adult');
    expect(component.togglingGroups()).toEqual(new Set(['Sport', 'Adult']));

    await Promise.all([first, second]);
    expect(component.togglingGroups()).toEqual(new Set());
  });
});

describe('LiveTvAccessComponent - vanishing groups', () => {
  it('surfaces a restricted group missing from the live lineup with its cleanup date', async () => {
    const { component } = await ready({
      restricted: ['News'],
      vanishing: { News: '2030-01-08T00:00:00.000Z' },
    });

    expect(component.displayGroups().find((g) => g.name === 'News')?.cleanupAt).toBe(
      '2030-01-08T00:00:00.000Z',
    );
  });

  it('leaves a restricted group alone while it is still seen', async () => {
    const { component } = await ready({ restricted: ['News'] });

    expect(component.displayGroups().find((g) => g.name === 'News')?.cleanupAt).toBeNull();
  });
});

describe('LiveTvAccessComponent - auto-restricted adult groups', () => {
  it('flags a group the server marked as matching the automatic pattern', async () => {
    const { component } = await ready({ restricted: ['News', 'XXX Uncut'] });

    expect(component.autoRestricted()).toEqual(new Set(['XXX Uncut']));
  });
});

describe('LiveTvAccessComponent - exempt groups', () => {
  it('flags a group the server reports as exempt, distinct from a restricted one', async () => {
    const { component } = await ready({ restricted: ['News'], exempt: ['Vanished Adult'] });

    expect(component.exempt()).toEqual(new Set(['Vanished Adult']));
    expect(component.restricted().has('Vanished Adult')).toBe(false);
    // Not in any channel facet either — still surfaced via the exempt set alone.
    expect(component.displayGroups().map((g) => g.name)).toContain('Vanished Adult');
  });

  it('leaves the exempt set empty when the server reports none', async () => {
    const { component } = await ready({ restricted: ['News'] });

    expect(component.exempt()).toEqual(new Set());
  });
});

describe('LiveTvAccessComponent - access overview', () => {
  it('shows granted groups from the overview response, with no per-row request', async () => {
    const { component, get } = await ready({
      restricted: ['News', 'XXX Uncut'],
      users: [{ id: 7, username: 'alice', groups: ['News'] }],
    });

    expect(get).toHaveBeenCalledWith('/api/livetv/admin/access/users');
    expect(component.users()).toEqual([
      { id: 7, username: 'alice', groups: ['News'], hasFullAccess: false },
    ]);
    expect(get).not.toHaveBeenCalledWith('/api/livetv/admin/access/users/7');
  });

  it('never falls back to the generic users endpoint', async () => {
    const { get } = await ready({ restricted: ['News'], users: [] });

    expect(get).not.toHaveBeenCalledWith('/api/users');
  });

  it('carries the server-computed full-access flag through untouched', async () => {
    const { component } = await ready({
      restricted: ['News'],
      users: [
        { id: 7, username: 'alice', groups: [], hasFullAccess: true },
        { id: 8, username: 'bob', groups: [], hasFullAccess: false },
      ],
    });

    expect(component.users()).toEqual([
      { id: 7, username: 'alice', groups: [], hasFullAccess: true },
      { id: 8, username: 'bob', groups: [], hasFullAccess: false },
    ]);
  });
});

describe('LiveTvAccessComponent - per-user grants', () => {
  it('grants a user access to a restricted group', async () => {
    const { component, put } = await ready({
      restricted: ['News', 'XXX Uncut'],
      users: [{ id: 7, username: 'alice', groups: [] }],
    });

    component.openGrants(component.users()[0]);
    expect(component.grantedGroups()).toEqual(new Set());

    component.toggleGrant('News');
    await component.saveGrants();

    expect(put).toHaveBeenCalledWith('/api/livetv/admin/access/users/7', { groups: ['News'] });
    expect(component.users()[0].groups).toEqual(['News']);
  });

  it('revokes a previously granted group', async () => {
    const { component, put } = await ready({
      restricted: ['News', 'XXX Uncut'],
      users: [{ id: 7, username: 'alice', groups: ['News', 'XXX Uncut'] }],
    });

    component.openGrants(component.users()[0]);
    expect(component.grantedGroups()).toEqual(new Set(['News', 'XXX Uncut']));

    component.toggleGrant('XXX Uncut');
    await component.saveGrants();

    expect(put).toHaveBeenCalledWith('/api/livetv/admin/access/users/7', { groups: ['News'] });
  });

  it('warns instead of granting a group the server says is no longer restricted', async () => {
    const put = vi.fn((url: string) =>
      url.includes('/users/')
        ? of({ groups: ['News'], ignored: ['Sport'] })
        : of(['News', 'XXX Uncut']),
    );
    const { component } = await ready({
      restricted: ['News', 'XXX Uncut'],
      users: [{ id: 7, username: 'alice', groups: [] }],
      put,
    });
    const toast = TestBed.inject(ToastService);

    component.openGrants(component.users()[0]);
    component.toggleGrant('News');
    component.toggleGrant('Sport');
    await component.saveGrants();

    expect(component.users()[0].groups).toEqual(['News']);
    expect(toast.toasts().at(-1)).toMatchObject({ type: 'warning' });
  });
});
