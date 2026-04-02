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
  User: [
    'media.read',
    'media.create',
    'media.edit',
    'media.grab',
    'requests.create',
    'subtitles.manage',
  ],
  Readonly: ['media.read'],
};
