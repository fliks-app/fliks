/**
 * DI token for the plugin id `FliksHostImpl` is scoped to — it derives the
 * `plugin.<id>.` settings prefix and the `library.ingest` root allowlist.
 * One host instance serves one plugin; a second concurrent `process`
 * plugin needs its own instance, wired once the RPC dispatcher binds a
 * socket connection to a specific registration (Phase 10.3).
 *
 * Core names no plugin, so it supplies `null`: an identity-scoped method
 * refuses rather than guessing. Whoever binds a host to a registration
 * supplies the id from that registration.
 */
export const PLUGIN_HOST_PLUGIN_ID = 'PLUGIN_HOST_PLUGIN_ID';
