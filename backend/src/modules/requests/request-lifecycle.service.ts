import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Subscription } from 'rxjs';
import { FliksRequest } from './entities/request.entity';
import { MediaType, RequestStatus, RequestKind } from '../../common/enums';
import { Media } from '../media/entities/media.entity';
import { MediaService } from '../media/media.service';
import { onDiskEpisodeNumbers } from '../media/episode-coverage.util';
import { ProfilesService } from '../profiles/profiles.service';
import { EventsService } from '../scheduler/events.service';
import { SseAudienceService } from '../scheduler/sse-audience.service';
import { NotificationsService } from '../notifications/notifications.service';
import { User } from '../users/entities/user.entity';
import {
  IN_FLIGHT_REQUEST_STATUSES,
  seasonScopeOf,
} from './request-status.constants';

/**
 * Cross-module orchestration for the request lifecycle. This is where
 * "something happened on the media side" turns into "promote / decline
 * / trim the linked request rows". Keeping it in one file makes the
 * full state machine readable in a single sweep — and stops bloating
 * `MediaService` with request-shaped methods.
 *
 * Triggers (one method each, named after the event that fires them):
 *
 *  - `onMediaImported`     — admin clicked Add or an approval imported
 *                            the row. Link & auto-approve compatible
 *                            open requests.
 *  - `markInProgress`      — driven by the `acquisition.grabbed` domain
 *                            event (auto-grab / manual grab pushed a
 *                            release to the download client). Flip
 *                            APPROVED → PROCESSING.
 *  - `onImportComplete`    — files landed on disk (via `EventsService`
 *                            subscription). Promote PROCESSING /
 *                            APPROVED → AVAILABLE for covered scopes.
 *  - `onMediaMonitorChange`— admin toggled `media.monitored`. Decline
 *                            active requests when monitoring is OFF.
 *  - `onSeasonMonitorChange` — same at season granularity (decline
 *                            scope-only requests, trim multi-season).
 *  - `onMediaRemoved`      — admin deleted the media row. Decline
 *                            active requests with a clear reason.
 */
@Injectable()
export class RequestLifecycleService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly log = new Logger(RequestLifecycleService.name);
  private readonly subscriptions = new Subscription();

  constructor(
    @InjectRepository(FliksRequest)
    private readonly requestRepo: Repository<FliksRequest>,
    @Inject(forwardRef(() => MediaService))
    private readonly mediaService: MediaService,
    private readonly profiles: ProfilesService,
    private readonly events: EventsService,
    private readonly notifications: NotificationsService,
    private readonly sseAudience: SseAudienceService,
  ) {}

  onModuleInit(): void {
    // Files landing on disk is the canonical "request might be
    // available now" trigger. Subscribing here keeps the recompute
    // tied to actual download completions regardless of the path
    // (auto-grab, manual grab, disk import all route through
    // `import.complete`).
    this.subscriptions.add(
      this.events.subscribe((event) => {
        if (event.type !== 'import.complete') return;
        this.onImportComplete(event.mediaId).catch((err) => {
          this.log.warn(
            `onImportComplete failed for media#${event.mediaId}: ${(err as Error).message}`,
          );
        });
      }),
    );

    // Auto-grab pipeline / manual grab pushed a release to the download
    // client — flip matching APPROVED requests to PROCESSING.
    this.subscriptions.add(
      this.events.onDomain((event) => {
        if (event.type !== 'acquisition.grabbed') return;
        this.announceGrab(
          event.mediaId,
          event.seasonNumber,
          event.episodeNumber,
        ).catch((err) => {
          this.log.warn(
            `announceGrab failed for media#${event.mediaId}: ${(err as Error).message}`,
          );
        });
        this.markInProgress(event.mediaId, event.seasonNumber).catch((err) => {
          this.log.warn(
            `markInProgress failed for media#${event.mediaId}: ${(err as Error).message}`,
          );
        });
      }),
    );
  }

  onModuleDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  // ---------------------------------------------------------------------------
  // Import / approval-side
  // ---------------------------------------------------------------------------

  /**
   * Called after a Media row is persisted from an import (admin manual
   * /add, request approval, profile-match auto-approve). Walks open
   * requests on the same tmdbId and decides per row:
   *
   * - Envelope covers the request → link, flip `PENDING` to `APPROVED`
   *   with `approvedBy = importer`, apply monitoring on the request's
   *   season scope.
   * - Envelope does NOT cover the request → leave untouched. Silent
   *   profile substitution would surprise the requester (VO ≠ FR).
   */
  async onMediaImported(
    media: Media,
    addedByUserId: number | null,
  ): Promise<void> {
    if (!media.tmdbId) return;
    const open = await this.requestRepo.find({
      where: {
        tmdbId: media.tmdbId,
        mediaType: media.type,
        status: In([...IN_FLIGHT_REQUEST_STATUSES]),
      },
    });
    if (open.length === 0) return;

    const mediaEnvelope = {
      qualityProfileId: media.qualityProfile?.id ?? null,
      languageProfileId: media.languageProfile?.id ?? null,
    };

    const touched: FliksRequest[] = [];
    for (const r of open) {
      const covers = await this.profiles.envelopeCovers(mediaEnvelope, {
        qualityProfileId: r.qualityProfileId,
        languageProfileId: r.languageProfileId,
      });
      if (!covers) continue;
      r.media = media;
      if (r.status === RequestStatus.PENDING) {
        r.status = RequestStatus.APPROVED;
        if (addedByUserId) {
          r.approvedBy = { id: addedByUserId } as User;
        }
      }
      touched.push(r);
      // Idempotently monitor the request's scope — admins' previously
      // unmonitored seasons get re-monitored when a request lands on them.
      await this.mediaService.applyMonitoredForRequestScope(
        media,
        r.seasons ?? null,
      );
    }
    if (touched.length) await this.requestRepo.save(touched);

    // An import satisfying a request is worth announcing: whoever owns acquisition can act
    // on it immediately instead of waiting for its own next tick.
    if (touched.length) {
      this.events.emitDomain({
        type: 'media.acquisition.requested',
        mediaIds: [media.id],
        reason: 'media-imported',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Grab / completion side
  // ---------------------------------------------------------------------------

  /**
   * Driven by the `acquisition.grabbed` domain event. Flip matching
   * `APPROVED` requests to `PROCESSING`. Per-season requests honour the
   * season scope: only flip when the grabbed season is in the `seasons`
   * array. Movies / whole-series flip on any grab.
   */
  async markInProgress(
    mediaId: number,
    seasonNumber?: number,
  ): Promise<void> {
    const candidates = await this.requestRepo.find({
      where: {
        media: { id: mediaId },
        status: RequestStatus.APPROVED,
      },
    });
    if (candidates.length === 0) return;
    const touched: FliksRequest[] = [];
    for (const r of candidates) {
      if (
        seasonNumber !== undefined &&
        r.seasons?.length &&
        !r.seasons.includes(seasonNumber)
      ) {
        continue;
      }
      r.status = RequestStatus.PROCESSING;
      touched.push(r);
    }
    if (touched.length) {
      await this.requestRepo.save(touched);
      for (const r of touched) {
        void this.notifications.dispatch('request.processing', {
          title: r.title,
          mediaType: r.mediaType,
        });
      }
    }
  }

  /**
   * Push a 0% progress event on every grab, so the download badge appears when
   * the user presses the button instead of on the acquisition plugin's next
   * poll tick — which can be a minute out. Deliberately outside
   * {@link markInProgress}: a direct grab matches no APPROVED request, and
   * this used to return before ever reaching the emit. Same audience as the
   * plugin's own ticks — everyone who can open the media's page.
   */
  private async announceGrab(
    mediaId: number,
    seasonNumber?: number,
    episodeNumber?: number,
  ): Promise<void> {
    const userIds = await this.sseAudience.viewersForMedia(mediaId);
    if (!userIds.length) return;
    this.events.emitToUsers(userIds, {
      type: 'download.progress',
      mediaId,
      // The discriminator the rest of the pipeline already uses: a leaf carries
      // a season number iff it belongs to a series.
      mediaType: seasonNumber == null ? 'movie' : 'series',
      seasonNumber,
      // Keyed to the episode when the grab named one, so episode 7's page stays
      // clear while only episode 8 downloads. Absent means a season pack, which
      // legitimately shows on every episode of that season.
      episodeNumber,
      progress: 0,
      dlspeed: 0,
      eta: 0,
      state: 'active',
    });
  }

  /**
   * Files landed for `mediaId` — walk active requests and promote the
   * ones whose scope is now fully on disk to `AVAILABLE`. Coverage
   * rules (see `isRequestScopeCovered`):
   *  - Movies: ≥ 1 file.
   *  - Series whole: every monitored season's monitored episodes have files.
   *  - Series per-season: every monitored episode of listed seasons has a file.
   */
  async onImportComplete(mediaId: number): Promise<void> {
    const active = await this.requestRepo.find({
      where: {
        media: { id: mediaId },
        status: In([RequestStatus.APPROVED, RequestStatus.PROCESSING]),
      },
    });
    if (active.length === 0) return;

    const ctx = await this.mediaService.findOneWithSeasonsAndFiles(mediaId);
    if (!ctx) return;

    const touched: FliksRequest[] = [];
    for (const r of active) {
      if (!this.isRequestScopeCovered(r, ctx)) continue;
      r.status = RequestStatus.AVAILABLE;
      touched.push(r);
    }
    if (touched.length) {
      await this.requestRepo.save(touched);
      for (const r of touched) {
        void this.notifications.dispatch('request.available', {
          title: r.title,
          mediaType: r.mediaType,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Admin-driven cleanup (unmonitor / remove)
  // ---------------------------------------------------------------------------

  /** Admin disabled `media.monitored`. Active requests can no longer
   *  be fulfilled — decline them with a machine-readable reason. */
  onMediaMonitorChange(media: Media, wasMonitored: boolean): Promise<void> {
    if (!wasMonitored || media.monitored !== false) return Promise.resolve();
    return this.declineActiveLinkedRequests(media, 'Media was unmonitored');
  }

  /** Admin disabled monitoring on a single season. Per-season requests
   *  targeting only this season are declined; multi-season requests
   *  have the season trimmed from their scope; whole-series requests
   *  are left alone (partial unmonitoring is admin discretion). */
  async onSeasonMonitorChange(
    media: Media,
    seasonNumber: number,
    wasMonitored: boolean,
    isMonitored: boolean,
  ): Promise<void> {
    if (!wasMonitored || isMonitored !== false) return;
    const candidates = await this.requestRepo.find({
      where: {
        media: { id: media.id },
        status: In([...IN_FLIGHT_REQUEST_STATUSES]),
      },
    });
    const touched: FliksRequest[] = [];
    for (const r of candidates) {
      const scope = seasonScopeOf(r);
      if (!scope || !scope.has(seasonNumber)) continue;
      const remaining = [...r.seasons!].filter((n) => n !== seasonNumber);
      if (remaining.length === 0) {
        r.status = RequestStatus.DECLINED;
        r.declinedReason = `Season ${seasonNumber} was unmonitored`;
        r.media = null;
      } else {
        r.seasons = remaining;
      }
      touched.push(r);
    }
    if (touched.length) await this.requestRepo.save(touched);
  }

  /** Admin (or an approved delete request) removed the media row. Active
   *  delete requests get what they asked for — resolve them to APPROVED —
   *  while active add requests for the now-gone title are declined. */
  async onMediaRemoved(media: Media): Promise<void> {
    await this.resolveActiveDeleteRequests(media);
    await this.declineActiveLinkedRequests(media, 'Media removed from library');
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Decline every active linked ADD request and unwire the media FK.
   *  `AVAILABLE` requests are left intact — the user already had the
   *  content, the cleanup is library hygiene, not a rejection. Delete
   *  requests are handled by {@link resolveActiveDeleteRequests}. */
  private async declineActiveLinkedRequests(
    media: Media,
    reason: string,
  ): Promise<void> {
    const linked = await this.requestRepo.find({
      where: {
        media: { id: media.id },
        kind: RequestKind.ADD,
        status: In([...IN_FLIGHT_REQUEST_STATUSES]),
      },
    });
    if (linked.length === 0) return;
    for (const r of linked) {
      r.status = RequestStatus.DECLINED;
      r.declinedReason = reason;
      r.media = null;
    }
    await this.requestRepo.save(linked);
  }

  /** The media a delete request targeted is gone — resolve every active
   *  linked delete request (the one being approved and any concurrent
   *  duplicate) to APPROVED, its terminal done-state, and unwire the FK. */
  private async resolveActiveDeleteRequests(media: Media): Promise<void> {
    const linked = await this.requestRepo.find({
      where: {
        media: { id: media.id },
        kind: RequestKind.DELETE,
        status: In([...IN_FLIGHT_REQUEST_STATUSES]),
      },
    });
    if (linked.length === 0) return;
    for (const r of linked) {
      r.status = RequestStatus.APPROVED;
      r.declinedReason = null;
      r.media = null;
    }
    await this.requestRepo.save(linked);
  }

  /** True when every file the request scope requires is on disk. */
  private isRequestScopeCovered(request: FliksRequest, media: Media): boolean {
    if (media.type === MediaType.MOVIE) {
      return (media.files?.length ?? 0) > 0;
    }
    const scope = seasonScopeOf(request);
    let anyChecked = false;
    for (const s of media.seasons ?? []) {
      if (scope && !scope.has(s.seasonNumber)) continue;
      if (!s.monitored) continue;
      const monitoredEps = (s.episodes ?? []).filter((e) => e.monitored);
      if (monitoredEps.length === 0) continue;
      anyChecked = true;
      // Coverage, not own-file: a shadowed episode of a multi-episode file is
      // satisfied even though it has no file of its own.
      const onDiskNums = onDiskEpisodeNumbers(s.episodes ?? []);
      if (!monitoredEps.every((e) => onDiskNums.has(e.episodeNumber)))
        return false;
    }
    // Nothing left to wait for (scope past the library, all unmonitored)
    // — treat as delivered rather than stranding the request forever.
    return anyChecked;
  }
}
