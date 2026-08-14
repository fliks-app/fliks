import { Injectable } from '@nestjs/common';

/**
 * In-memory push cache backing `counts.set` (contract D3): the plugin pushes,
 * core serves the cached number. An unset key reads as 0, matching "the
 * plugin has never connected". Not persisted — a restart is a legitimate
 * reset, the plugin re-pushes once it reconnects.
 *
 * Keyed by plugin then by key, so two plugins pushing the same key contribute
 * to it instead of overwriting each other, and neither can reach the other's slot.
 */
@Injectable()
export class PluginCountsCacheService {
  private readonly byPlugin = new Map<string, Map<string, number>>();

  set(pluginId: string, key: string, value: number): void {
    const owned = this.byPlugin.get(pluginId) ?? new Map<string, number>();
    owned.set(key, value);
    this.byPlugin.set(pluginId, owned);
  }

  /** Summed across the plugins that pushed it: with one publisher this is that publisher's number. */
  get(key: string): number {
    let total = 0;
    for (const owned of this.byPlugin.values()) total += owned.get(key) ?? 0;
    return total;
  }

  /** Tells "never pushed" apart from an explicit 0 — callers that must not
   *  show a badge for a publisher that never connected read this first. */
  has(key: string): boolean {
    for (const owned of this.byPlugin.values()) if (owned.has(key)) return true;
    return false;
  }

  /** A plugin that is no longer running must stop contributing to any badge it pushed. */
  forget(pluginId: string): void {
    this.byPlugin.delete(pluginId);
  }
}
