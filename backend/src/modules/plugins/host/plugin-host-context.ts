import { AsyncLocalStorage } from 'async_hooks';

const storage = new AsyncLocalStorage<string>();

/**
 * The plugin id a host call is bound to, carried through Node's async
 * context rather than through any RPC payload. Only `PluginHostBindingService`
 * calls `runAs` — a plugin has no field to write it and no way to read another
 * call's value, since each async chain gets its own isolated store.
 */
export const PluginHostContext = {
  runAs<T>(pluginId: string, fn: () => T): T {
    return storage.run(pluginId, fn);
  },

  /** `null` outside any bound call — the in-process bundle's permanent case. */
  current(): string | null {
    return storage.getStore() ?? null;
  },
};
