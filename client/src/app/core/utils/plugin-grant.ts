/** Everything a plugin grant can be written as: the bare subject, or one action of it. */
export interface PluginGrant {
  action: string;
  subject: string;
}

/**
 * `plugin:<id>:<name>` (every action) or `<action>:plugin:<id>:<name>` (that one). A bare subject
 * reads as `manage`, which is what core grants for it.
 */
export function parsePluginGrant(value: string): PluginGrant | null {
  const match = /^(?:([a-z]+):)?(plugin:[^:]+:.+)$/.exec(value);
  return match ? { action: match[1] ?? 'manage', subject: match[2] } : null;
}

/** Mirrors CASL: `manage` covers every action, any other action covers only itself. */
export function grantSatisfies(held: string, wanted: PluginGrant): boolean {
  const grant = parsePluginGrant(held);
  if (!grant || grant.subject !== wanted.subject) return false;
  return grant.action === 'manage' || grant.action === wanted.action;
}
