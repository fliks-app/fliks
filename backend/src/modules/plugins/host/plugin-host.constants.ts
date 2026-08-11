/**
 * DI token for `FliksHostImpl`'s constructor-frozen plugin id — the fallback
 * an identity-scoped method uses when no call is bound through
 * `PluginHostContext` (see `plugin-host-context.ts`). Core names no plugin,
 * so it supplies `null` here: the in-process client's calls are never bound,
 * so they always resolve through this token and always see `null`.
 *
 * A real `process` plugin's calls are bound per-call by
 * `PluginHostBindingService.bind(pluginId)`, which sources the id from the
 * connection's own registration, never from this token.
 */
export const PLUGIN_HOST_PLUGIN_ID = 'PLUGIN_HOST_PLUGIN_ID';
