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
import { SchedulerService } from '../scheduler/scheduler.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
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
 *  - `onReleaseGrabbed`    — auto-grab pipeline pushed a release to
 *                            the download client. Flip APPROVED →
 *                            PROCESSING.
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
    @Inject(forwardRef(() => SchedulerService))
    private readonly scheduler: SchedulerService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Whether an import driven by a request approval should kick off a
   * targeted search immediately, or wait for the next scheduled
   * SearchMissing tick. Default is "yes" — users expect the download
   * to start right after the green check.
   *
   * Admin-toggleable from the General settings page; defaults to `true`
   * (an unset key reads as enabled) to preserve behaviour on existing installs.
   */
  private async autoGrabOnApproval(): Promise<boolean> {
    return (await this.settings.get('requests_auto_grab_on_approval')) !== 'false';
  }

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

    // If the import actually satisfied at least one request, kick off
    // an immediate SearchMissing for that media so the user doesn't
    // wait up to 6 h for the next scheduled tick. Fire-and-forget;
    // failures (missing indexer, etc.) are logged inside the scheduler.
    if (touched.length && (await this.autoGrabOnApproval())) {
      void this.scheduler.searchMissingForMedia([media.id]);
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
   * Auto-grab pipeline sent a release to the download client. Flip
   * matching `APPROVED` requests to `PROCESSING`. Per-season requests
   * honour the season scope: only flip when the grabbed season is in
   * the `seasons` array. Movies / whole-series flip on any grab.
   */
  async onReleaseGrabbed(
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
      // Push a 0% progress event to the requesters so the bar + PROCESSING
      // state appear immediately, without waiting for the next poll tick.
      const userIds = [
        ...new Set(
          touched
            .map((r) => r.userId)
            .filter((id): id is number => id != null),
        ),
      ];
      if (userIds.length) {
        this.events.emitToUsers(userIds, {
          type: 'download.progress',
          mediaId,
          mediaType: touched[0].mediaType as 'movie' | 'series',
          seasonNumber,
          progress: 0,
          dlspeed: 0,
          eta: 0,
          state: 'downloading',
        });
      }
    }
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
