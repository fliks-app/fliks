import type { PluginHostApi } from './host-methods';

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
 * The seven scopes a `process` manifest can request, one per method
 * group, consented once at install.
 */
export type PluginScope =
  | 'media:read'
  | 'acquisition:candidates'
  | 'releases:score'
  | 'requests:progress'
  | 'ingest:write'
  | 'events:emit'
  | 'config:rw';

/**
 * The scopes each `PluginHostApi` method requires — every one of them — derived from what
 * `FliksHostImpl` reads or writes rather than from the method's own name.
 */
export const HOST_METHOD_SCOPES: Readonly<Record<keyof PluginHostApi, readonly PluginScope[]>> = {
  'media.acquisitionContext': ['media:read'],
  // Both enumerate the monitored library and answer with media identity, which is `media:read`'s
  // to grant: an acquisition scope alone would be a title oracle for the whole library.
  'acquisition.candidates': ['acquisition:candidates', 'media:read'],
  'releases.match': ['acquisition:candidates', 'media:read'],
  'releases.score': ['releases:score'],
  'media.resolve': ['media:read'],
  'media.exists': ['media:read'],
  'requests.markInProgress': ['requests:progress'],
  'library.ingest': ['ingest:write'],
  'events.publish': ['events:emit'],
  'notifications.dispatch': ['events:emit'],
  'counts.set': ['events:emit'],
  'events.emitOwn': ['events:emit'],
  'progress.set': ['events:emit'],
  'config.get': ['config:rw'],
  'config.set': ['config:rw'],
};
