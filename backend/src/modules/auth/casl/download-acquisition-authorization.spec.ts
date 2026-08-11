import { CaslAbilityFactory } from './casl-ability.factory';
import { Action } from './actions.enum';
import { Media } from '../../media/entities/media.entity';
import type { User } from '../../users/entities/user.entity';

/**
 * Adversarial table proving the Indexer/DownloadClient removal changed no
 * effective permission. Each `before` column is hardcoded from the
 * pre-removal grants (not re-derived from the code below):
 *
 *   - Indexer (all actions) and DownloadClient (Create/Update/Delete/Manage)
 *     were reachable only via `can(Action.Manage, Indexer | DownloadClient)`,
 *     itself gated by `settings.access` alone.
 *   - DownloadClient's Read action (findAll/queue/findOne, and the sidebar
 *     queue badge) was additionally reachable via the unconditional
 *     `can(Action.Read, DownloadClient)` granted under
 *     `media.create || requests.create`.
 *
 * `after` is computed against the real `CaslAbilityFactory` using the exact
 * predicates the bundle's controllers (and `CountsService`) now check:
 *   - admin CRUD (Indexer, and DownloadClient's non-Read actions):
 *     `ability.can(Action.Manage, 'Settings')`
 *   - DownloadClient's Read-shared routes + the queue badge:
 *     `ability.can(Action.Manage, 'Settings') || ability.can(Action.Track, Media)`
 */
describe('Indexer/DownloadClient authorization removal — adversarial permission table', () => {
  const factory = new CaslAbilityFactory();

  function fakeUser(permissions: string[], isAdmin = false): User {
    return {
      id: 1,
      isAdmin,
      permissions: isAdmin ? ['manage:all'] : permissions,
    } as unknown as User;
  }

  function adminCrudAfter(permissions: string[], isAdmin = false): boolean {
    const ability = factory.createForUser(fakeUser(permissions, isAdmin));
    return ability.can(Action.Manage, 'Settings');
  }

  function downloadClientReadAfter(
    permissions: string[],
    isAdmin = false,
  ): boolean {
    const ability = factory.createForUser(fakeUser(permissions, isAdmin));
    return (
      ability.can(Action.Manage, 'Settings') || ability.can(Action.Track, Media)
    );
  }

  it.each([
    ['super-admin (manage:all)', [], true, true, true],
    [
      'DEFAULT_ROLES.Admin permission set (non-super-admin)',
      [
        'media.read',
        'media.create',
        'media.edit',
        'media.delete',
        'media.grab',
        'requests.create',
        'requests.manage',
        'subtitles.manage',
        'settings.access',
        'users.manage',
      ],
      false,
      true,
      true,
    ],
    [
      'DEFAULT_ROLES.User',
      ['media.read', 'requests.create'],
      false,
      false,
      true,
    ],
    [
      'DEFAULT_ROLES.Readonly (read-only role)',
      ['media.read'],
      false,
      false,
      false,
    ],
    ['settings.access only', ['settings.access'], false, true, true],
    ['media.create only', ['media.create'], false, false, true],
    ['requests.create only', ['requests.create'], false, false, true],
    [
      'settings.access + media.create',
      ['settings.access', 'media.create'],
      false,
      true,
      true,
    ],
    [
      'users.manage only (unrelated permission)',
      ['users.manage'],
      false,
      false,
      false,
    ],
    [
      'subtitles.manage only (unrelated permission)',
      ['subtitles.manage'],
      false,
      false,
      false,
    ],
    [
      'requests.manage only (unrelated permission)',
      ['requests.manage'],
      false,
      false,
      false,
    ],
    ['no permissions at all', [], false, false, false],
  ] as [string, string[], boolean, boolean, boolean][])(
    '%s — admin CRUD before=%s, queue-read before=%s',
    (
      _label,
      permissions,
      isAdmin,
      expectedAdminCrud,
      expectedDownloadClientRead,
    ) => {
      expect(adminCrudAfter(permissions, isAdmin)).toBe(expectedAdminCrud);
      expect(downloadClientReadAfter(permissions, isAdmin)).toBe(
        expectedDownloadClientRead,
      );
    },
  );
});
