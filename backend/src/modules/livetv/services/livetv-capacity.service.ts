import { ConflictException, Injectable } from '@nestjs/common';

/**
 * What a provider counts against its connection limit, beyond the sessions
 * themselves: a probe holds a real connection, and a closed upstream keeps
 * holding one for a few seconds on the provider's side. Both are invisible to
 * the session registry, which is why they live here.
 */
@Injectable()
export class LiveTvCapacityService {
  /** sourceId -> in-flight ffprobe calls. */
  private readonly probesInFlight = new Map<number, number>();
  /** sourceId -> ms timestamps of upstreams closed recently but still busy. */
  private readonly recentReleases = new Map<number, number[]>();

  beginProbe(sourceId: number): void {
    this.probesInFlight.set(sourceId, (this.probesInFlight.get(sourceId) ?? 0) + 1);
  }

  endProbe(sourceId: number): void {
    const remaining = (this.probesInFlight.get(sourceId) ?? 1) - 1;
    if (remaining > 0) this.probesInFlight.set(sourceId, remaining);
    else this.probesInFlight.delete(sourceId);
    this.recordRelease(sourceId);
  }

  recordRelease(sourceId: number): void {
    this.recentReleases.set(sourceId, [...(this.recentReleases.get(sourceId) ?? []), Date.now()]);
  }

  /**
   * `liveHolds` is the caller's own count of open upstreams. Passed in rather
   * than tracked here so the tally stays derived from the session map: a
   * counter of its own would leak a slot for good on any unbalanced release.
   */
  inUse(sourceId: number, graceSeconds: number, liveHolds: number): number {
    const cutoff = Date.now() - graceSeconds * 1000;
    const stillHeld = (this.recentReleases.get(sourceId) ?? []).filter((t) => t > cutoff);
    if (stillHeld.length) this.recentReleases.set(sourceId, stillHeld);
    else this.recentReleases.delete(sourceId);
    return (this.probesInFlight.get(sourceId) ?? 0) + liveHolds + stillHeld.length;
  }

  assertBelowLimit(
    source: { id: number; name: string; maxStreams: number | null },
    graceSeconds: number,
    liveHolds: number,
  ): void {
    if (!source.maxStreams) return;
    if (this.inUse(source.id, graceSeconds, liveHolds) < source.maxStreams) return;
    throw new ConflictException({
      code: 'livetv_source_at_capacity',
      sourceName: source.name,
      limit: source.maxStreams,
    });
  }
}
