import { describe, expect, it } from 'vitest';
import { PERMISSION_GROUPS, PERMISSION_INCLUDES, holdsPermission, includedBy } from './permissions';

describe('permissions', () => {
  it('manage includes create and read_public', () => {
    expect(holdsPermission(['parties.manage'], 'parties.create')).toBe(true);
    expect(holdsPermission(['parties.manage'], 'parties.read_public')).toBe(true);
    expect(holdsPermission(['parties.create'], 'parties.manage')).toBe(false);
    expect(holdsPermission(['requests.manage'], 'requests.create')).toBe(false);
  });

  it('names who includes a permission', () => {
    expect(includedBy(new Set(['parties.manage', 'media.read']), 'parties.create')).toEqual(['parties.manage']);
    expect(includedBy(['parties.create'], 'parties.create')).toEqual([]);
  });

  it('only lists included permissions that belong to a group', () => {
    const listed = PERMISSION_GROUPS.flatMap((g) => g.permissions);
    for (const [perm, inc] of Object.entries(PERMISSION_INCLUDES)) {
      expect(listed).toContain(perm);
      inc.forEach((i) => expect(listed).toContain(i));
    }
  });
});
