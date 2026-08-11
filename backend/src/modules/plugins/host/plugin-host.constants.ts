/**
 * DI token for the plugin id `FliksHostImpl` is scoped to — it derives the
 * `plugin.<id>.` settings prefix and the `library.ingest` root allowlist.
 * One host instance serves one plugin; a second concurrent `process`
 * plugin needs its own instance, wired once the RPC dispatcher binds a
 * socket connection to a specific registration (Phase 10.3).
 */
export const PLUGIN_HOST_PLUGIN_ID = 'PLUGIN_HOST_PLUGIN_ID';

/** The one plugin this host serves today. */
export const DEFAULT_HOST_PLUGIN_ID = 'fliks.download';
