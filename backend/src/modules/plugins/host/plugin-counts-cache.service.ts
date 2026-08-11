import { Injectable } from '@nestjs/common';

/**
 * In-memory push cache backing `counts.set` (contract D3): the plugin pushes,
 * core serves the cached number. An unset key reads as 0, matching "the
 * plugin has never connected". Not persisted — a restart is a legitimate
 * reset, the plugin re-pushes once it reconnects.
 */
@Injectable()
export class PluginCountsCacheService {
  private readonly counts = new Map<string, number>();

  set(key: string, value: number): void {
    this.counts.set(key, value);
  }

  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** Tells "never pushed" apart from an explicit 0 — callers that must not
   *  show a badge for a publisher that never connected read this first. */
  has(key: string): boolean {
    return this.counts.has(key);
  }
}
