import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type {
  AcquisitionEvent,
  AcquisitionTarget,
  MediaKind,
  PluginHostApi,
} from '../../../common/plugin-contract';
import {
  MediaStatus,
  MediaType,
  MinimumAvailability,
} from '../../../common/enums';
import { Media } from '../../media/entities/media.entity';
import { Season } from '../../media/entities/season.entity';
import { Episode } from '../../media/entities/episode.entity';
import { MediaFile } from '../../media/entities/media-file.entity';
import { RequestLifecycleService } from '../../requests/request-lifecycle.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { SettingsService } from '../../settings/settings.service';
import { EventsService } from '../../scheduler/events.service';
import { SseAudienceService } from '../../scheduler/sse-audience.service';
import { PluginRegistration } from '../entities/plugin-registration.entity';
import { PluginCountsCacheService } from './plugin-counts-cache.service';
import { DownloadProgressCacheService } from '../../scheduler/download-progress-cache.service';
import { PLUGIN_HOST_PLUGIN_ID } from './plugin-host.constants';
import { PluginHostContext } from './plugin-host-context';
import { DownloadProgressState } from '../../../common/constants/download-progress-state';

/** The rate `progress.set` promises: at most one SSE emission per media per second. */
const PROGRESS_MIN_INTERVAL_MS = 1_000;

type ProgressSet = Parameters<PluginHostApi['progress.set']>[0];

interface ProgressGate {
  lastEmitMs: number;
  pending: ProgressSet | null;
  timer: NodeJS.Timeout | null;
}

/** `media.resolve`'s own bound, per the contract's doc comment. */
const QUEUE_PAGE_SIZE_MAX = 100;

/** `library.ingest` and the acquisition reads moved with their services; S8 ports the host. */
function unavailable(method: string): Promise<never> {
  return Promise.reject(new Error(`${method}: unavailable until S8`));
}

type MediaResolveEntry = Awaited<
  ReturnType<PluginHostApi['media.resolve']>
>[string];

/**
 * Core's implementation of the 15 plugin-facing host methods. Every value it
 * returns is a plain, JSON-safe object built field-by-field from entities —
 * never the entity itself — because the same shape crosses a socket once the
 * transport changes (Phase 10.4).
 */
@Injectable()
export class FliksHostImpl implements PluginHostApi {
  constructor(
    @Inject(PLUGIN_HOST_PLUGIN_ID) private readonly pluginId: string | null,
    @InjectRepository(Media) private readonly mediaRepo: Repository<Media>,
    @InjectRepository(Season) private readonly seasonRepo: Repository<Season>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    @InjectRepository(PluginRegistration)
    private readonly pluginRegistrationRepo: Repository<PluginRegistration>,
    private readonly requestLifecycle: RequestLifecycleService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly events: EventsService,
    private readonly sseAudience: SseAudienceService,
    private readonly countsCache: PluginCountsCacheService,
    private readonly progressCache: DownloadProgressCacheService,
  ) {}

  private readonly logger = new Logger(FliksHostImpl.name);

  private readonly progressGates = new Map<string, ProgressGate>();

  /** `PluginHostContext` (set only by `PluginHostBindingService`, never by a plugin's
   *  payload) wins when bound; the constructor value is the in-process default. */
  private currentPluginId(): string | null {
    return PluginHostContext.current() ?? this.pluginId;
  }

  // ---------------------------------------------------------------------------
  // Group A — read
  // ---------------------------------------------------------------------------

  'media.acquisitionContext': PluginHostApi['media.acquisitionContext'] = (p) =>
    this.acquisitionContext(p);
  'acquisition.candidates': PluginHostApi['acquisition.candidates'] = (p) =>
    this.candidates(p);
  'releases.match': PluginHostApi['releases.match'] = (p) =>
    this.releasesMatch(p);
  'releases.score': PluginHostApi['releases.score'] = (p) =>
    this.releasesScore(p);
  'media.resolve': PluginHostApi['media.resolve'] = (p) => this.mediaResolve(p);
  'media.exists': PluginHostApi['media.exists'] = (p) => this.mediaExists(p);

  // ---------------------------------------------------------------------------
  // Group B — write acquisition state
  // ---------------------------------------------------------------------------

  'requests.markInProgress': PluginHostApi['requests.markInProgress'] = (p) =>
    this.requestsMarkInProgress(p);

  // ---------------------------------------------------------------------------
  // Group C — ingest
  // ---------------------------------------------------------------------------

  'library.ingest': PluginHostApi['library.ingest'] = (p) =>
    this.libraryIngest(p);

  // ---------------------------------------------------------------------------
  // Group D — events and outbound
  // ---------------------------------------------------------------------------

  'events.publish': PluginHostApi['events.publish'] = (p) =>
    this.eventsPublish(p);
  'notifications.dispatch': PluginHostApi['notifications.dispatch'] = (p) =>
    this.notificationsDispatch(p);
  'counts.set': PluginHostApi['counts.set'] = (p) => this.countsSet(p);
  'events.emitOwn': PluginHostApi['events.emitOwn'] = (p) =>
    this.eventsEmitOwn(p);
  'progress.set': PluginHostApi['progress.set'] = (p) => this.progressSet(p);

  // ---------------------------------------------------------------------------
  // Group E — config
  // ---------------------------------------------------------------------------

  'config.get': PluginHostApi['config.get'] = (p) => this.configGet(p);
  'config.set': PluginHostApi['config.set'] = (p) => this.configSet(p);

  // ===========================================================================
  // Acquisition reads (A1-A4): known gap until S8, the grab pipeline, the profile scoring and the release
  // parser live in fliks-server now (docs/bridge.md).
  // ===========================================================================

  private acquisitionContext(_p: unknown): Promise<never> {
    return unavailable('media.acquisitionContext');
  }

  private candidates(_p: unknown): Promise<never> {
    return unavailable('acquisition.candidates');
  }

  private releasesMatch(_p: unknown): Promise<never> {
    return unavailable('releases.match');
  }

  private releasesScore(_p: unknown): Promise<never> {
    return unavailable('releases.score');
  }

  // ===========================================================================
  // A5 — media.resolve
  // ===========================================================================

  private async mediaResolve(p: {
    mediaIds?: number[];
    seasonIds?: number[];
    episodeIds?: number[];
  }): Promise<Record<string, MediaResolveEntry>> {
    const mediaIds = p.mediaIds ?? [];
    const seasonIds = p.seasonIds ?? [];
    const episodeIds = p.episodeIds ?? [];
    const total = mediaIds.length + seasonIds.length + episodeIds.length;
    if (total > QUEUE_PAGE_SIZE_MAX) {
      throw new Error(
        `media.resolve: ${total} ids exceeds the ${QUEUE_PAGE_SIZE_MAX} limit`,
      );
    }

    const out: Record<string, MediaResolveEntry> = {};

    if (mediaIds.length) {
      const rows = await this.mediaRepo.find({ where: { id: In(mediaIds) } });
      for (const m of rows) out[`media:${m.id}`] = this.mediaLabel(m);
    }
    if (seasonIds.length) {
      const rows = await this.seasonRepo.find({
        where: { id: In(seasonIds) },
        relations: ['media'],
      });
      for (const s of rows) {
        const label = this.mediaLabel(s.media);
        out[`season:${s.id}`] = { ...label, seasonNumber: s.seasonNumber };
      }
    }
    if (episodeIds.length) {
      const rows = await this.episodeRepo.find({
        where: { id: In(episodeIds) },
        relations: ['season', 'season.media'],
      });
      for (const e of rows) {
        const label = this.mediaLabel(e.season.media);
        out[`episode:${e.id}`] = {
          ...label,
          seasonNumber: e.season.seasonNumber,
          episodeNumber: e.episodeNumber,
          episodeTitle: e.title ?? undefined,
        };
      }
    }
    return out;
  }

  private mediaLabel(media: Media): MediaResolveEntry {
    return {
      title: media.title,
      kind: media.type === MediaType.MOVIE ? 'movie' : 'series',
      libraryId: media.libraryId ?? 0,
    };
  }

  // ===========================================================================
  // A6 — media.exists
  // ===========================================================================

  private async mediaExists(p: { mediaIds: number[] }): Promise<number[]> {
    if (!p.mediaIds.length) return [];
    const rows = await this.mediaRepo.find({
      where: { id: In(p.mediaIds) },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  // ===========================================================================
  // B1 — requests.markInProgress
  // ===========================================================================

  private async requestsMarkInProgress(p: {
    idempotencyKey: string;
    mediaId: number;
    seasonNumber?: number;
  }): Promise<void> {
    await this.requestLifecycle.markInProgress(p.mediaId, p.seasonNumber);
  }

  // ===========================================================================
  // C1 — library.ingest (known gap until S8: the ingest service lives in fliks-server)
  // ===========================================================================

  private libraryIngest(_p: unknown): Promise<never> {
    return unavailable('library.ingest');
  }

  // ===========================================================================
  // D1 — events.publish
  // ===========================================================================

  private async eventsPublish(events: AcquisitionEvent[]): Promise<void> {
    for (const event of events) await this.publishOne(event);
  }

  private async publishOne(event: AcquisitionEvent): Promise<void> {
    switch (event.type) {
      case 'acquisition.grabbed':
        // No `queue.updated` here: every direct grab call site emits only the
        // domain event, and the sidebar badge doesn't move on a grab.
        this.events.emitDomain({
          type: 'acquisition.grabbed',
          mediaId: event.mediaId,
          seasonNumber: event.seasonNumber,
          // Carried through so a single-episode grab is announced as that
          // episode's leaf: without it every grab reads as a season pack, and
          // a pack shows on every episode page of the season.
          episodeNumber: event.episodeNumber,
        });
        // Put the download badge up on the grab rather than on the client's next poll tick,
        // which can be a minute out. Added to the media's last known set rather than replacing
        // it: a push states the whole set, so announcing this grab alone would retire whatever
        // else the media already had in flight. The first real snapshot supersedes it.
        //
        // This reads the replay cache for correctness, not just for replay. It is safe because
        // the cache and a viewer's own store cannot disagree about what exists: a client resets
        // its store on `sse.connected`, so a core restart empties both, and both expire on the
        // same horizon. A cold cache therefore means the viewer holds nothing either, and
        // stating a set of one erases nothing from their screen.
        await this.pushProgress({
          mediaId: event.mediaId,
          downloads: [
            ...((await this.progressCache.current(event.mediaId))?.downloads ?? []).map((d) => ({
              ref: d.ref,
              seasonNumber: d.seasonNumber,
              episodeNumber: d.episodeNumber,
              progress: d.progress,
              bytesPerSecond: d.dlspeed,
              etaSeconds: d.eta,
              state: d.state,
            })),
            {
              // No download exists yet, so there is no identity to carry: the scope is the only
              // thing that names this placeholder, and the first real snapshot drops it.
              ref: `pending:${event.seasonNumber ?? ''}:${event.episodeNumber ?? ''}`,
              seasonNumber: event.seasonNumber,
              episodeNumber: event.episodeNumber,
              progress: 0,
              state: 'queued' as const,
            },
          ],
        });
        return;
      case 'acquisition.imported': {
        const media = await this.mediaRepo.findOne({
          where: { id: event.mediaId },
        });
        void this.notifications.dispatch('download.complete', {
          title: media?.title ?? '',
          quality: event.quality,
          sourceTitle: event.sourceTitle,
        });
        // Same audience as `download.progress`: this event retires the badge
        // that event put up, and repaints the page the file just landed on.
        const recipients = await this.sseAudience.viewersForMedia(
          event.mediaId,
        );
        this.events.emitToUsers(recipients, {
          type: 'import.complete',
          mediaId: event.mediaId,
          title: media?.title ?? '',
          seasonNumber: event.seasonNumber,
          episodeNumber: event.episodeNumber,
        });
        this.events.emit({ type: 'queue.updated' });
        return;
      }
      case 'acquisition.failed': {
        // `event.title` is the caller's release title, never re-derived from
        // `media.title` — every real call site means the release, not the media.
        const recipients = await this.sseAudience.recipientsForMedia(
          event.mediaId,
        );
        this.events.emitToUsers(recipients, {
          type: 'import.failed',
          mediaId: event.mediaId,
          title: event.title,
          error: event.reason,
        });
        this.events.emit({ type: 'queue.updated' });
        return;
      }
      case 'acquisition.queue.changed':
        this.events.emit({ type: 'queue.updated' });
        return;
      case 'acquisition.stalled.removed': {
        const recipients = await this.sseAudience.recipientsForMedia(
          event.mediaId,
        );
        this.events.emitToUsers(recipients, {
          type: 'stalled.removed',
          title: event.title,
        });
        this.events.emit({ type: 'queue.updated' });
        return;
      }
    }
  }

  // ===========================================================================
  // D2 — notifications.dispatch
  // ===========================================================================

  private async notificationsDispatch(p: {
    event: 'grab.started';
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.notifications.dispatchStrict(p.event, p.payload);
  }

  // ===========================================================================
  // D3 — counts.set
  // ===========================================================================

  private countsSet(p: { key: string; value: number }): Promise<void> {
    const pluginId = this.currentPluginId();
    if (pluginId) this.countsCache.set(pluginId, p.key, p.value);
    return Promise.resolve();
  }

  // ===========================================================================
  // D4 — events.emitOwn
  // ===========================================================================

  private async eventsEmitOwn(p: {
    type: string;
    payload: unknown;
    audience: 'all' | { mediaId: number } | { userId: number };
  }): Promise<void> {
    const type = `plugin.${this.currentPluginId()}.${p.type}`;
    if (p.audience === 'all') {
      this.events.emitRaw(type, p.payload, null);
      return;
    }
    if ('userId' in p.audience) {
      this.events.emitRaw(type, p.payload, [p.audience.userId]);
      return;
    }
    const recipients = await this.sseAudience.recipientsForMedia(
      p.audience.mediaId,
    );
    this.events.emitRaw(type, p.payload, recipients);
  }

  // ===========================================================================
  // D5 — progress.set
  // ===========================================================================

  private async progressSet(p: ProgressSet): Promise<void> {
    // One gate per media, because a media's set is now what a push carries: coalescing per
    // download would let a window drop the very push that shrank the set.
    const key = String(p.mediaId);
    const gate = this.progressGates.get(key);
    const now = Date.now();
    if (gate && now - gate.lastEmitMs < PROGRESS_MIN_INTERVAL_MS) {
      // Newest wins, and nothing is lost by it: each push already carries the media's whole set.
      gate.pending = p;
      if (!gate.timer) {
        gate.timer = setTimeout(
          () => this.flushProgress(key),
          PROGRESS_MIN_INTERVAL_MS - (now - gate.lastEmitMs),
        );
        gate.timer.unref();
      }
      return;
    }
    // A due-but-unfired flush would otherwise delete the gate installed here,
    // resetting the rate limit for the next push.
    if (gate?.timer) clearTimeout(gate.timer);
    this.progressGates.set(key, { lastEmitMs: now, pending: null, timer: null });
    await this.pushProgress(p);
  }

  private flushProgress(key: string): void {
    const gate = this.progressGates.get(key);
    if (!gate) return;
    gate.timer = null;
    const pending = gate.pending;
    gate.pending = null;
    if (!pending) {
      // Idle for a whole window: drop the gate so the map cannot grow with
      // every media ever seen.
      this.progressGates.delete(key);
      return;
    }
    gate.lastEmitMs = Date.now();
    void this.pushProgress(pending);
  }

  private async pushProgress(p: ProgressSet): Promise<void> {
    const media = await this.mediaRepo.findOne({ where: { id: p.mediaId } });
    // Progress is passive page state, not a notification: everyone who can open
    // the media's page sees it, not just whoever requested the title.
    const recipients = await this.sseAudience.viewersForMedia(p.mediaId);
    if (!recipients.length) return;
    this.events.emitToUsers(recipients, {
      type: 'download.progress',
      mediaId: p.mediaId,
      mediaType: media?.type === MediaType.MOVIE ? 'movie' : 'series',
      downloads: p.downloads.map((d) => ({
        ref: d.ref,
        seasonNumber: d.seasonNumber,
        episodeNumber: d.episodeNumber,
        progress: d.progress,
        dlspeed: d.bytesPerSecond ?? 0,
        eta: d.etaSeconds ?? 0,
        state: d.state,
      })),
    });
  }

  // ===========================================================================
  // E1 — config.get
  // ===========================================================================

  private async configGet(p: {
    keys?: string[];
  }): Promise<Record<string, string>> {
    const prefix = `plugin.${this.currentPluginId()}.`;
    const out: Record<string, string> = {};
    if (p.keys?.length) {
      for (const key of p.keys) {
        const value = await this.settings.get(prefix + key);
        if (value != null) out[key] = value;
      }
      return out;
    }
    const all = await this.settings.getAll();
    for (const [key, value] of Object.entries(all)) {
      if (value != null && key.startsWith(prefix))
        out[key.slice(prefix.length)] = value;
    }
    return out;
  }

  // ===========================================================================
  // E2 — config.set
  // ===========================================================================

  private async configSet(p: {
    key: string;
    value: string | null;
  }): Promise<void> {
    const pluginId = this.currentPluginId();
    // Tagged with the writer so the config note is not echoed back to the plugin that made it.
    await this.settings.set(`plugin.${pluginId}.${p.key}`, p.value, pluginId ?? undefined);
  }

}
