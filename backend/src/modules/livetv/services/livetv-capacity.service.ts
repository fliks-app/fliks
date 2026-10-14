import { ConflictException, Injectable } from '@nestjs/common';

/**
 * What a provider counts against its connection limit beyond the open sessions:
 * a closed upstream keeps holding one for a few seconds on the provider's side,
 * which the session registry cannot see.
 */
@Injectable()
export class LiveTvCapacityService {
  /** sourceId -> ms timestamps of upstreams closed recently but still busy. */
  private readonly recentReleases = new Map<number, number[]>();

  recordRelease(sourceId: number): void {
    this.recentReleases.set(sourceId, [
      ...(this.recentReleases.get(sourceId) ?? []),
      Date.now(),
    ]);
  }

  /**
   * `liveHolds` is the caller's own count of open upstreams. Passed in rather
   * than tracked here so the tally stays derived from the holds themselves: a
   * counter of its own would leak a slot for good on any unbalanced release.
   */
  inUse(sourceId: number, graceSeconds: number, liveHolds: number): number {
    const cutoff = Date.now() - graceSeconds * 1000;
    const stillHeld = (this.recentReleases.get(sourceId) ?? []).filter(
      (t) => t > cutoff,
    );
    if (stillHeld.length) this.recentReleases.set(sourceId, stillHeld);
    else this.recentReleases.delete(sourceId);
    return liveHolds + stillHeld.length;
  }

  assertBelowLimit(
    source: { id: number; name: string; maxStreams: number | null },
    graceSeconds: number,
    liveHolds: number,
  ): void {
    if (!source.maxStreams) return;
    if (this.inUse(source.id, graceSeconds, liveHolds) < source.maxStreams)
      return;
    throw new ConflictException({
      code: 'livetv_source_at_capacity',
      sourceName: source.name,
      limit: source.maxStreams,
    });
  }
}
