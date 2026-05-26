/**
 * Feature-based permissions.
 * Each permission grants access to a specific feature area.
 */
export const PERMISSIONS = [
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
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Default permission sets for seeded roles. */
export const DEFAULT_ROLES = {
  Admin: [...PERMISSIONS] as string[],
  // Minimal viewer role: browse the library and submit requests for
  // missing titles. Admin-side actions (create/edit/grab/delete,
  // manage subs/requests, settings access, user admin) are intentionally
  // off — an admin promotes per-user as needed.
  User: ['media.read', 'requests.create'],
  Readonly: ['media.read'],
};
