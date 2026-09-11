/**
 * Vocabulary for plugin-declared CASL subjects. Self-contained — no imports from `modules/auth`
 * or `modules/plugins` — so both can depend on it without creating an import cycle between them.
 */

/** Every plugin-declared subject lives under this prefix; a core subject never does. */
export const PLUGIN_SUBJECT_PREFIX = 'plugin:';

/** A raw permission name as written in a manifest's `permissions[]`, before namespacing.
 *  Lowercase only and no `.`/`:` — either would let a name masquerade as a different plugin's
 *  subject or a multi-segment path once it is namespaced. */
export const PLUGIN_PERMISSION_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/** The CASL subject / grantable permission string a declared name resolves to. Core builds
 *  this itself from the plugin's own immutable id — a plugin never writes the prefix itself. */
export function pluginPermissionSubject(pluginId: string, name: string): string {
  return `${PLUGIN_SUBJECT_PREFIX}${pluginId}:${name}`;
}

/** Shape only — whether this exact subject is currently declared by that plugin is the
 *  plugin registry's job, not this function's. */
export function isPluginPermissionSubject(value: string): boolean {
  return value.startsWith(PLUGIN_SUBJECT_PREFIX) && value.length > PLUGIN_SUBJECT_PREFIX.length;
}

/** Splits a grant: a bare subject allows every action, `read:plugin:<id>:<name>` only that one.
 *  The action comes back as written; judging it against a vocabulary is the caller's job. */
export function parsePluginPermissionGrant(value: string): { action?: string; subject: string } | null {
  if (isPluginPermissionSubject(value)) return { subject: value };
  const sep = value.indexOf(':');
  if (sep === -1) return null;
  const subject = value.slice(sep + 1);
  return isPluginPermissionSubject(subject) ? { action: value.slice(0, sep), subject } : null;
}
