import { Injectable, computed, signal } from '@angular/core';
import { MediaType } from '../enums/media-type.enum';
import { DownloadProgressState, ProgressPhase } from '../enums/download-progress-state.enum';
import { foldLeaves } from '../../shared/utils/download-format';

/** Identifies one download within a season. `ref:<r>` is the reporter's own identity for it, so
 *  two releases grabbed for the *same* episode stay two leaves instead of overwriting each other.
 *  `pending:<scope>` keys the placeholder a grab puts up before any download exists. */
export type LeafKey = `ref:${string}` | `pending:${string}`;

/** One in-flight download contributing to a media's download progress. */
export interface DownloadLeaf {
  percent: number; // 0–100
  state: ProgressPhase;
  /** The episode this download is for, when it names one. Held on the leaf
   *  rather than in its key, which identifies the download itself. */
  episodeNumber?: number;
  /** This download's own speed and ETA. Held per leaf because concurrent
   *  episodes each have their own, and a media-level pair could only ever
   *  report whichever of them ticked last. */
  dlspeed?: number;
  eta?: number;
}

export interface SeasonProgress {
  leaves: Map<LeafKey, DownloadLeaf>;
}

/** Live download progress for one media, keyed by `mediaId`. For a series the
 *  `seasons` sub-map holds per-(season, leaf) progress (a leaf is a season pack
 *  or an individual episode download); `state`/`percent` are the folded
 *  media-level rollup. A movie has no `seasons` — its downloads fold straight
 *  onto the entry. */
export interface MediaDownloadProgress {
  mediaId: number;
  mediaType: MediaType;
  percent: number | null; // active-weighted mean; null when nothing is active
  state: ProgressPhase; // dominant state across all leaves
  dlspeed: number;
  eta: number;
  seasons?: Map<number, SeasonProgress>;
  /** When the snapshot behind this entry arrived, for the staleness sweep. */
  updatedAt?: number;
}

/** One download inside a `download.progress` snapshot. */
export interface DownloadProgressItem {
  ref: string;
  seasonNumber?: number;
  episodeNumber?: number;
  progress: number; // 0–1
  dlspeed: number;
  eta: number;
  state: DownloadProgressState;
}

/**
 * Payload of a `download.progress` SSE event: every download in flight for one media.
 *
 * A replacement, never a delta. Whatever is absent has been retired, and an empty `downloads`
 * retires the media. That is what makes a phantom leaf impossible rather than merely unlikely:
 * there is no removal to miss, because absence is the removal.
 */
export interface DownloadProgressEvent {
  mediaId: number;
  mediaType: MediaType;
  downloads: DownloadProgressItem[];
}

/** A grab the user just started, before any download exists to report it. */
interface GrabbingScope {
  mediaType: MediaType;
  seasonNumber?: number;
  episodeNumber?: number;
}

/**
 * How long a media may go unreported before the sweep drops it. The publisher ticks about once a
 * minute; three missed ticks is gone, not slow. Same horizon the backend's replay cache uses.
 *
 * This is a backstop for a publisher that died or was reconfigured, not the removal mechanism:
 * a download that stops is absent from the very next snapshot.
 */
const STALE_AFTER_MS = 3 * 60_000;
const SWEEP_INTERVAL_MS = 30_000;

function pendingKey(scope: GrabbingScope): LeafKey {
  return `pending:${scope.seasonNumber ?? ''}:${scope.episodeNumber ?? ''}`;
}

function sameScope(a: GrabbingScope, b: { seasonNumber?: number; episodeNumber?: number }): boolean {
  return a.seasonNumber === b.seasonNumber && a.episodeNumber === b.episodeNumber;
}

/** Fold every season leaf into the media-level state, percent, speed and ETA.
 *  Callers only reach here with at least one leaf, so `f.state` is never the
 *  empty sentinel. Speed sums across concurrent downloads and the ETA is the
 *  longest of them — the media is done when its slowest leaf is. */
function rollupSeasons(seasons: Map<number, SeasonProgress>): {
  state: ProgressPhase;
  percent: number | null;
  dlspeed: number;
  eta: number;
} {
  const leaves: DownloadLeaf[] = [];
  for (const sp of seasons.values()) {
    for (const l of sp.leaves.values()) leaves.push(l);
  }
  const f = foldLeaves(leaves);
  return {
    state: f.state || 'active',
    percent: f.percent,
    dlspeed: leaves.reduce((a, l) => a + (l.dlspeed ?? 0), 0),
    eta: leaves.reduce((a, l) => Math.max(a, l.eta ?? 0), 0),
  };
}

function toLeaf(d: DownloadProgressItem): DownloadLeaf {
  return {
    percent: Math.round(d.progress * 100),
    state: d.state,
    episodeNumber: d.episodeNumber,
    dlspeed: d.dlspeed,
    eta: d.eta,
  };
}

/** Build a media entry from one snapshot. A series groups by season; a movie folds flat. */
function toEntry(e: DownloadProgressEvent, at: number): MediaDownloadProgress | null {
  if (!e.downloads.length) return null;

  if (e.mediaType !== 'series') {
    const f = foldLeaves(e.downloads.map(toLeaf));
    return {
      mediaId: e.mediaId,
      mediaType: e.mediaType,
      percent: f.percent,
      state: f.state || 'active',
      dlspeed: e.downloads.reduce((a, d) => a + d.dlspeed, 0),
      eta: e.downloads.reduce((a, d) => Math.max(a, d.eta), 0),
      updatedAt: at,
    };
  }

  const seasons = new Map<number, SeasonProgress>();
  for (const d of e.downloads) {
    // A series download the reporter could not attribute to a season cannot be placed under
    // one. Dropping it is right: merging it onto whichever leaf happens to be alone would
    // attribute another download's percent to it.
    if (d.seasonNumber == null) continue;
    const leaves = seasons.get(d.seasonNumber)?.leaves ?? new Map<LeafKey, DownloadLeaf>();
    leaves.set(`ref:${d.ref}`, toLeaf(d));
    seasons.set(d.seasonNumber, { leaves });
  }
  if (!seasons.size) return null;
  return {
    mediaId: e.mediaId,
    mediaType: e.mediaType,
    seasons,
    updatedAt: at,
    ...rollupSeasons(seasons),
  };
}

/**
 * App-wide store of in-flight download progress, fed by `download.progress` SSE events (via
 * {@link SseService}). One shared signal — the requests views and media-detail read it by
 * `mediaId`. The status itself (label/colour/aggregation) is derived on read via the pure
 * helpers in `download-format`, so this store stays a plain data holder.
 *
 * Two sources, deliberately kept apart: `reported` is what the server said, replaced wholesale
 * per media by each snapshot, and `grabbing` is local optimism for a grab the user just clicked.
 * Merging them at read time is what lets a snapshot replace without erasing a placeholder it
 * knows nothing about.
 */
@Injectable({ providedIn: 'root' })
export class DownloadProgressService {
  /** Server truth. Never merged into, only replaced per media. */
  private readonly reported = signal<Map<number, MediaDownloadProgress>>(new Map());

  /** Grabs started here that no snapshot has reported yet. */
  private readonly grabbing = signal<Map<number, GrabbingScope[]>>(new Map());

  readonly progress = computed(() => this.merged());

  private sweepHandle: ReturnType<typeof setInterval> | null = null;

  private merged(): Map<number, MediaDownloadProgress> {
    const reported = this.reported();
    const grabbing = this.grabbing();
    if (!grabbing.size) return reported;

    const out = new Map(reported);
    for (const [mediaId, scopes] of grabbing) {
      if (!scopes.length) continue;
      const cur = out.get(mediaId);
      const mediaType = cur?.mediaType ?? scopes[0]!.mediaType;

      if (mediaType !== 'series') {
        // Nothing to place a movie placeholder under, and a reported movie already says more.
        if (!cur) {
          out.set(mediaId, {
            mediaId,
            mediaType,
            percent: null,
            state: 'searching',
            dlspeed: 0,
            eta: 0,
          });
        }
        continue;
      }

      const seasons = new Map(cur?.seasons ?? []);
      for (const scope of scopes) {
        const seasonNumber = scope.seasonNumber ?? 0;
        const leaves = new Map(seasons.get(seasonNumber)?.leaves ?? []);
        leaves.set(pendingKey(scope), {
          percent: 0,
          state: 'searching',
          episodeNumber: scope.episodeNumber,
          dlspeed: 0,
          eta: 0,
        });
        seasons.set(seasonNumber, { leaves });
      }
      out.set(mediaId, {
        mediaId,
        mediaType,
        seasons,
        updatedAt: cur?.updatedAt,
        ...rollupSeasons(seasons),
      });
    }
    return out;
  }

  /**
   * Drop a media whose snapshot has stopped arriving. The store is fed by events alone, so a
   * publisher that died would otherwise leave its last snapshot on screen for the life of the
   * app. Removal within a media needs no sweep: the next snapshot states the whole set.
   */
  private sweepStale(): void {
    const cutoff = Date.now() - STALE_AFTER_MS;
    const prev = this.reported();
    const next = new Map([...prev].filter(([, entry]) => (entry.updatedAt ?? 0) >= cutoff));
    if (next.size !== prev.size) this.reported.set(next);
    if (!next.size) this.stopSweep();
  }

  /** Runs only while something is in flight — an idle app keeps no timer. */
  private startSweep(): void {
    if (this.sweepHandle != null || typeof setInterval === 'undefined') return;
    this.sweepHandle = setInterval(() => this.sweepStale(), SWEEP_INTERVAL_MS);
  }

  private stopSweep(): void {
    if (this.sweepHandle == null) return;
    clearInterval(this.sweepHandle);
    this.sweepHandle = null;
  }

  /** Drop everything, for the SSE connect snapshot: the replay that follows re-states whatever
   *  is still in flight, and anything that ended while the stream was down never will. */
  reset(): void {
    if (this.reported().size) this.reported.set(new Map());
    if (this.grabbing().size) this.grabbing.set(new Map());
    this.stopSweep();
  }

  /** Apply one media's snapshot, replacing whatever was held for it. */
  applyProgress(e: DownloadProgressEvent): void {
    const entry = toEntry(e, Date.now());
    if (entry) this.startSweep();

    this.reported.update((prev) => {
      if (!entry) {
        if (!prev.has(e.mediaId)) return prev;
        const next = new Map(prev);
        next.delete(e.mediaId);
        return next;
      }
      return new Map(prev).set(e.mediaId, entry);
    });

    // A scope the snapshot now reports has a real download: the placeholder has been superseded.
    this.dropGrabbing(e.mediaId, (scope) => e.downloads.some((d) => sameScope(scope, d)));
  }

  private dropGrabbing(mediaId: number, matches: (scope: GrabbingScope) => boolean): void {
    this.grabbing.update((prev) => {
      const scopes = prev.get(mediaId);
      if (!scopes?.length) return prev;
      const kept = scopes.filter((s) => !matches(s));
      if (kept.length === scopes.length) return prev;
      const next = new Map(prev);
      if (kept.length) next.set(mediaId, kept);
      else next.delete(mediaId);
      return next;
    });
  }

  /**
   * Mark a grab as under way for a scope, before any download exists: the header says
   * "searching" from the click instead of from the download client's first tick, seconds later.
   * Returns the release to call when the request settles — either way, since a failed search
   * must not leave the badge up.
   */
  markGrabbing(e: {
    mediaId: number;
    mediaType: MediaType;
    seasonNumber?: number;
    episodeNumber?: number;
  }): () => void {
    const scope: GrabbingScope = {
      mediaType: e.mediaType,
      seasonNumber: e.seasonNumber,
      episodeNumber: e.episodeNumber,
    };
    // A download already reporting for this scope says strictly more than "searching".
    if (this.reportsScope(e.mediaId, scope)) return () => undefined;

    this.grabbing.update((prev) => {
      const scopes = prev.get(e.mediaId) ?? [];
      if (scopes.some((s) => sameScope(s, scope))) return prev;
      return new Map(prev).set(e.mediaId, [...scopes, scope]);
    });

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.dropGrabbing(e.mediaId, (s) => sameScope(s, scope));
    };
  }

  /** Whether the server already reports a download covering this scope. */
  private reportsScope(mediaId: number, scope: GrabbingScope): boolean {
    const cur = this.reported().get(mediaId);
    if (!cur) return false;
    if (!cur.seasons || scope.seasonNumber == null) return true;
    for (const leaf of cur.seasons.get(scope.seasonNumber)?.leaves.values() ?? []) {
      if (leaf.episodeNumber === scope.episodeNumber) return true;
    }
    return false;
  }

  /** Retire progress for a finished import, ahead of the publisher's next snapshot. With an
   *  `episodeNumber` on a series drop only that episode's leaf (sibling episodes keep
   *  advancing); with only a `seasonNumber` drop the whole season (pack / multi-episode
   *  import); otherwise drop the whole media entry. */
  clearMedia(mediaId: number, seasonNumber?: number, episodeNumber?: number): void {
    this.dropGrabbing(
      mediaId,
      (s) => seasonNumber == null || (s.seasonNumber === seasonNumber && (episodeNumber == null || s.episodeNumber === episodeNumber)),
    );
    this.reported.update((prev) => {
      const cur = prev.get(mediaId);
      if (!cur) return prev;
      const next = new Map(prev);

      if (seasonNumber == null || !cur.seasons) {
        next.delete(mediaId);
        return next;
      }
      const seasons = new Map(cur.seasons);
      const sp = seasons.get(seasonNumber);
      if (sp) {
        if (episodeNumber != null) {
          // Narrower than the scope filter used for rendering: a leaf naming no episode is a
          // pack, which one episode's import does not finish.
          const leaves = new Map([...sp.leaves].filter(([, l]) => l.episodeNumber !== episodeNumber));
          if (leaves.size === 0) seasons.delete(seasonNumber);
          else seasons.set(seasonNumber, { leaves });
        } else {
          seasons.delete(seasonNumber);
        }
      }
      if (seasons.size === 0) next.delete(mediaId);
      else next.set(mediaId, { ...cur, seasons, ...rollupSeasons(seasons) });
      return next;
    });
  }
}
