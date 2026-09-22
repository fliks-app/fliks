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
function asRestrictedGroups(names: string[]): RestrictedGroup[] {
  return names.map((name) => ({ name, automatic: AUTO_GROUPS.has(name) }));
}

function createFixture(opts: {
  restricted?: string[];
  users?: LiveTvUserAccess[];
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
        return of(asRestrictedGroups(opts.restricted ?? []));
      if (url === '/api/livetv/admin/access/users') return of(opts.users ?? []);
      throw new Error(`unexpected GET ${url}`);
    });
  const put = opts.put ?? vi.fn((_url: string, body: { groups: string[] }) => of(body.groups));

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
});

describe('LiveTvAccessComponent - auto-restricted adult groups', () => {
  it('flags a group the server marked as matching the automatic pattern', async () => {
    const { component } = await ready({ restricted: ['News', 'XXX Uncut'] });

    expect(component.autoRestricted()).toEqual(new Set(['XXX Uncut']));
  });
});

describe('LiveTvAccessComponent - access overview', () => {
  it('shows granted groups from the overview response, with no per-row request', async () => {
    const { component, get } = await ready({
      restricted: ['News', 'XXX Uncut'],
      users: [{ id: 7, username: 'alice', groups: ['News'] }],
    });

    expect(get).toHaveBeenCalledWith('/api/livetv/admin/access/users');
    expect(component.users()).toEqual([{ id: 7, username: 'alice', groups: ['News'] }]);
    expect(get).not.toHaveBeenCalledWith('/api/livetv/admin/access/users/7');
  });

  it('never falls back to the generic users endpoint', async () => {
    const { get } = await ready({ restricted: ['News'], users: [] });

    expect(get).not.toHaveBeenCalledWith('/api/users');
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
});
