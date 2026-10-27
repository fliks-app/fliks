/** Core permissions each broader one includes, from the server ACL (`Permissions::from`): A includes B only when A's grants cover B's. */
export const PERMISSION_INCLUDES: Readonly<Record<string, readonly string[]>> = {
  'parties.manage': ['parties.create', 'parties.read_public'],
};

/** Core permissions grouped by domain, in display order. */
export const PERMISSION_GROUPS: readonly { id: string; permissions: readonly string[] }[] = [
  { id: 'media', permissions: ['media.read', 'media.create', 'media.edit', 'media.delete', 'media.grab'] },
  { id: 'livetv', permissions: ['livetv.read'] },
  { id: 'requests', permissions: ['requests.create', 'requests.manage'] },
  { id: 'subtitles', permissions: ['subtitles.manage'] },
  { id: 'parties', permissions: ['parties.create', 'parties.manage', 'parties.read_public'] },
  { id: 'admin', permissions: ['settings.access', 'users.manage', 'roles.manage'] },
];

/** True when `held` grants `perm` itself or through a broader permission that includes it. */
export function holdsPermission(held: readonly string[], perm: string): boolean {
  return held.includes(perm) || held.some((h) => PERMISSION_INCLUDES[h]?.includes(perm));
}

/** The held permissions that include `perm`. */
export function includedBy(held: Iterable<string>, perm: string): string[] {
  return [...held].filter((h) => PERMISSION_INCLUDES[h]?.includes(perm));
}
