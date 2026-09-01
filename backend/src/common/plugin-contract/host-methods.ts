/**
 * The 15 methods a `process` plugin calls on core, grouped A-E as the
 * plan groups them. Every payload/return shape is restated structurally
 * here rather than imported, even where it mirrors an entity — this
 * directory has no dependency on `backend/src` outside itself.
 */

export type MediaKind = 'movie' | 'series';

/**
 * Everything a plugin needs to decide whether, and how, to acquire one
 * piece of media. `want: null` means unprofiled: nothing can be scored without a profile.
 * `decision: 'skip'` carries the same constraints for a title that already satisfies its
 * profile — searchable and scorable by hand, never grabbed unattended.
 */
export interface AcquisitionTarget {
  mediaId: number;
  kind: MediaKind;
  title: string;
  originalTitle: string | null;
  alternativeTitles: string[];
  year: number | null;
  runtimeMinutes: number | null;
  imdbId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  libraryId: number;
  want: {
    decision: 'missing' | 'upgrade' | 'skip';
    allowedQualityIds: number[];
    allowedLanguageIds: number[];
    minRankExclusive: number;
    maxRankInclusive: number;
    minResolution: number;
    resolutionUpgradeOnly: boolean;
  } | null;
  expectedTitles: string[];
  searchTitle: string;
  season?: { id: number; number: number; episodeCount: number };
  episode?: {
    id: number;
    number: number;
    endNumber: number | null;
    airDate: string | null;
    /** The only handle on a special: season 0 is never published as `S00Exx`, so a plugin
     *  searching one has to query the episode title. Null when the provider has none. */
    title: string | null;
  };
}

/**
 * The verdict on one candidate release, already sorted by relevance.
 * `qualityName`/`languageName` ride alongside their ids because the id
 * registries are static in-core constants a plugin may not vendor.
 */
export interface ScoredRelease {
  id: string;
  qualityId: number;
  qualityName: string;
  rank: number;
  allowed: boolean;
  customFormatScore: number;
  blocklisted: boolean;
  languageId: number | null;
  languageName: string | null;
  languageAllowed: boolean;
  isFullSeason: boolean;
  /** Null when the media carries no runtime to judge against — distinct from 0, which claims the
   *  size is exactly the preferred one. */
  sizeDeviation: number | null;
  videoCodec: string | null;
  /** `params` is interpolated into the frontend's own `rejection.<code>` string —
   *  flattening it to a message here would strip the numbers out of the reason. */
  rejections: { code: string; params?: Record<string, number | string> }[];
}

/** Domain facts a plugin publishes; core decides the SSE audience for each. */
export type AcquisitionEvent =
  | {
      type: 'acquisition.grabbed';
      mediaId: number;
      seasonNumber?: number;
      episodeNumber?: number;
    }
  | {
      type: 'acquisition.imported';
      mediaId: number;
      seasonNumber?: number;
      episodeNumber?: number;
      /** Not derivable from `mediaId` — the download attempt's own facts. */
      quality: string;
      sourceTitle: string;
    }
  | {
      type: 'acquisition.failed';
      mediaId: number;
      title: string;
      reason: string;
    }
  | { type: 'acquisition.queue.changed' }
  | {
      type: 'acquisition.stalled.removed';
      mediaId: number | null;
      title: string;
    };

/**
 * The full core-side surface, keyed by dotted method name. A `process`
 * plugin's socket client implements calls against this shape; core's
 * `FliksHostImpl` is declared to satisfy it.
 */
export interface PluginHostApi {
  // Group A — read (6)

  /** Replaces 8 mediaRepo.findOne + 6 profiles.resolveAllowedForMedia* + 4 getSizeLimitsMap calls. */
  'media.acquisitionContext': (p: {
    mediaId: number;
    seasonId?: number;
    episodeId?: number;
  }) => Promise<AcquisitionTarget | null>;

  /** Replaces the scheduler's four candidate-enumeration call sites. Cursor-paged, limit <= 500. */
  'acquisition.candidates': (p: {
    kind?: MediaKind;
    mediaIds?: number[];
    availableOn: string;
    limit: number;
    cursor?: string;
  }) => Promise<{ items: AcquisitionTarget[]; cursor: string | null }>;

  /** Replaces the RSS full-library load — the endpoint that makes RssSync viable. */
  'releases.match': (p: {
    titles: { id: string; title: string; publishDate: string }[];
    minAgeMinutes?: number;
  }) => Promise<
    {
      id: string;
      mediaId: number | null;
      seasonNumber?: number;
      episodeNumber?: number;
      isFullSeason: boolean;
      decision: 'grab' | 'skip';
      skipReason?:
        | 'on-disk'
        | 'not-monitored'
        | 'unmatched'
        | 'too-fresh'
        | 'not-available'
        | 'unprofiled';
    }[]
  >;

  /** The hot path: rejection rules, custom formats, blocklist and quality/profile scoring, all in one call. */
  'releases.score': (p: {
    mediaId: number;
    seasonNumber?: number;
    episodeNumber?: number;
    releases: {
      id: string;
      title: string;
      size: number;
      seeders: number;
      leechers: number;
      publishDate: string;
      /** Source-declared markers, matched by name by a `release_flag` custom-format
       *  condition and by the ordering rule. Open set: a new marker needs no change here.
       *  `freeleech`/`downloadVolumeFactor` are the torrent spelling of the same thing and
       *  are folded into it, so a plugin can send either. */
      flags?: string[];
      freeleech?: boolean;
      downloadVolumeFactor?: number;
      sourceRef: string;
      minSeeders?: number;
      unknownLanguageIsoCode?: string;
      /** Only the plugin can know — it owns the blocklist table. */
      blocked: boolean;
    }[];
  }) => Promise<ScoredRelease[]>;

  /** Queue page labels. Keyed `media:<id>` / `season:<id>` / `episode:<id>`, so a
   *  mixed batch stays unambiguous. Bounded: <= 100 ids (QUEUE_PAGE_SIZE_MAX). */
  'media.resolve': (p: {
    mediaIds?: number[];
    seasonIds?: number[];
    episodeIds?: number[];
  }) => Promise<
    Record<
      string,
      {
        title: string;
        kind: MediaKind;
        libraryId: number;
        seasonNumber?: number;
        episodeNumber?: number;
        episodeTitle?: string;
      }
    >
  >;

  /** Orphan reconcile. The FK makes this a belt, not the braces. */
  'media.exists': (p: { mediaIds: number[] }) => Promise<number[]>;

  // Group B — write acquisition state (1)

  'requests.markInProgress': (p: {
    idempotencyKey: string;
    mediaId: number;
    seasonNumber?: number;
  }) => Promise<void>;

  // Group C — ingest (1)

  /**
   * The one method that writes to disk. Core, not the plugin, resolves the
   * destination and enforces the ingest-root allowlist and idempotency.
   */
  'library.ingest': (p: {
    idempotencyKey: string;
    mediaId: number;
    paths: string[];
    transfer: 'copy' | 'move';
    fallbackQuality?: string;
    sourceLabel: string;
  }) => Promise<{
    imported: { mediaFileId: number; relativePath: string; quality: string }[];
    /** Source paths whose destination was already taken, so nothing was written for them. A
     *  retried ingest lands here, and reading it as "nothing could be placed" reports a
     *  completed import as a failure. */
    alreadyPresent: string[];
    seasonNumber?: number;
    episodeNumber?: number;
  }>;

  // Group D — events and outbound (5)

  /** Batched. Core resolves the SSE audience via SseAudienceService.recipientsForMedia. */
  'events.publish': (p: AcquisitionEvent[]) => Promise<void>;

  /** Closed vocabulary, not a free string. Today: 'grab.started'. */
  'notifications.dispatch': (p: {
    event: 'grab.started';
    payload: Record<string, unknown>;
  }) => Promise<void>;

  /** The sidebar badge, pushed not polled. Stored per plugin: two plugins pushing one key add up
   *  rather than overwrite, and a stopped plugin stops counting. Core serves `queueActive`. */
  'counts.set': (p: { key: string; value: number }) => Promise<void>;

  /**
   * Plugin-namespaced SSE. Core force-prefixes the type to `plugin.<id>.<type>`.
   * `{ userId }` addresses one account — the `delegated` principal of the request being
   * served, when the answer belongs to whoever asked rather than to a media's audience.
   * Narrower than `'all'`, which any plugin holding this scope can already use.
   */
  'events.emitOwn': (p: {
    type: string;
    payload: unknown;
    audience: 'all' | { mediaId: number } | { userId: number };
  }) => Promise<void>;

  /**
   * Live acquisition progress, as the complete set for one media. Plugin pushes; core emits the
   * reserved `download.progress` SSE type, coalesced to one emission per media per second:
   * pushing faster is allowed, and the last value of a window is the one that goes out.
   *
   * `downloads` is a replacement, never a delta: whatever is absent from it is retired, and an
   * empty array retires the media outright. That is the whole point of the shape. A per-download
   * push cannot express absence, so every consumer had to infer a removal from a compensating
   * event or a timeout, and every new way to remove a download reopened the same gap.
   *
   * The caller must therefore only push a set it fully enumerated. A download client that could
   * not be reached is not evidence that its torrents are gone: skip the push for that tick rather
   * than assert a set that is missing them.
   */
  'progress.set': (p: {
    mediaId: number;
    downloads: {
      /** Stable identity for one download within the media, opaque to core. */
      ref: string;
      seasonNumber?: number;
      episodeNumber?: number;
      /** 0 to 1. */
      progress: number;
      bytesPerSecond?: number;
      etaSeconds?: number;
      state: 'queued' | 'active' | 'stalled' | 'paused' | 'importing';
    }[];
  }) => Promise<void>;

  // Group E — config (2)

  /** `plugin.<id>.*` keys only. */
  'config.get': (p: { keys?: string[] }) => Promise<Record<string, string>>;

  /** Prefix applied server-side. Never `PUT /settings/:key`. */
  'config.set': (p: { key: string; value: string | null }) => Promise<void>;
}
