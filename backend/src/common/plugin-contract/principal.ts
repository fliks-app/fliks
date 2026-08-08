/**
 * Auth model for the plugin socket. There is no JWT and no `User` row on
 * this side of the boundary — only these two principals.
 */

/**
 * Who the plugin is acting as for one `http` callback. `delegated` is a
 * proxied authenticated request, re-checked by core against that exact
 * user on every callback; `system` is a background job, limited to the
 * scopes consented at install.
 */
export type Principal = { kind: 'delegated'; userId: number } | { kind: 'system' };

/**
 * The eight scopes a `process` manifest can request, one per method
 * group, consented once at install.
 */
export type PluginScope =
  | 'media:read'
  | 'acquisition:candidates'
  | 'releases:score'
  | 'blocklist:write'
  | 'requests:progress'
  | 'ingest:write'
  | 'events:emit'
  | 'config:rw';
