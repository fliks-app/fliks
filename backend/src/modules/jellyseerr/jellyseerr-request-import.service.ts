import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Media } from '../media/entities/media.entity';
import { FliksRequest } from '../requests/entities/request.entity';
import { LibraryUserAccess } from '../libraries/entities/library-user-access.entity';
import { Library } from '../libraries/entities/library.entity';
import { Role } from '../roles/entities/role.entity';
import { MediaType, RequestStatus, MediaServerType } from '../../common/enums';
import { SettingsService } from '../settings/settings.service';
import {
  JellyseerrService,
  JellyseerrUser,
  JellyseerrMediaRequest,
  JELLYSEERR_REQUEST_STATUS,
  JELLYSEERR_MEDIA_STATUS,
} from './jellyseerr.service';

export interface JellyseerrImportStats {
  users: number;
  usersCreated: number;
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
}

const SETTINGS_URL_KEY = 'jellyseerr_url';
const SETTINGS_API_KEY = 'jellyseerr_api_key';

function parseDate(raw?: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Import Jellyseerr (or Overseerr) requests into Fliks's `FliksRequest` table.
 *
 * Matching strategy:
 *   - Users: by username chain `jellyfinUsername || plexUsername || username
 *     || displayName`. Missing users are auto-created with `passwordHash=null`
 *     (non-loggable) + the default role + its default library set — same
 *     pattern as the Emby watch-history import.
 *   - Media: by `request.media.tmdbId` → `Media(type, tmdbId)`. If Fliks
 *     hasn't imported the media yet, the request row is still created with
 *     `mediaId=null` so the admin can act on it later.
 *
 * Status mapping:
 *   - Jellyseerr request.status: 1=PENDING, 2=APPROVED, 3=DECLINED, 4=FAILED
 *     → Fliks RequestStatus.PENDING/APPROVED/DECLINED/FAILED.
 *   - Availability override: when `media.status === 5 (AVAILABLE)` we set
 *     `AVAILABLE`, when `=== 3 (PROCESSING)` we set `PROCESSING`. Availability
 *     wins because it's the "final" state of a request.
 *
 * Idempotent: re-running the import upserts on `(userId, tmdbId, mediaType)`.
 */
@Injectable()
export class JellyseerrRequestImportService {
  private readonly log = new Logger(JellyseerrRequestImportService.name);

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Media) private readonly mediaRepo: Repository<Media>,
    @InjectRepository(FliksRequest)
    private readonly requestRepo: Repository<FliksRequest>,
    @InjectRepository(LibraryUserAccess)
    private readonly libraryAccessRepo: Repository<LibraryUserAccess>,
    @InjectRepository(Role) private readonly roleRepo: Repository<Role>,
    private readonly jellyseerr: JellyseerrService,
    private readonly settings: SettingsService,
  ) {}

  async importFromJellyseerr(): Promise<JellyseerrImportStats> {
    const url = await this.settings.get(SETTINGS_URL_KEY);
    const apiKey = await this.settings.get(SETTINGS_API_KEY);
    if (!url || !apiKey) {
      throw new BadRequestException(
        'Configure Jellyseerr URL and API key first',
      );
    }

    const stats: JellyseerrImportStats = {
      users: 0,
      usersCreated: 0,
      imported: 0,
      updated: 0,
      skipped: 0,
      errors: [],
    };

    // Cache TMDB → Fliks Media per (type, tmdbId) to avoid re-querying for
    // requests that target the same title across multiple users.
    const mediaByKey = new Map<string, Media | null>();
    // Cache (type:tmdbId) → title fetched from Jellyseerr's TMDB proxy. Same
    // title can appear in many users' requests, no point hammering the API.
    const titleByKey = new Map<string, string | null>();
    // Cache username → Fliks user across the whole pass.
    const userCache = new Map<string, User>();
    const seenUsernames = new Set<string>();

    const pageSize = 50;
    let skip = 0;
    while (true) {
      const { results, total } = await this.jellyseerr.listRequests(
        url,
        apiKey,
        skip,
        pageSize,
      );
      if (!results.length) break;

      for (const req of results) {
        try {
          const handled = await this.applyRequest(
            req,
            mediaByKey,
            titleByKey,
            userCache,
            seenUsernames,
            stats,
            url,
            apiKey,
          );
          if (handled === 'created') stats.imported++;
          else if (handled === 'updated') stats.updated++;
          else stats.skipped++;
        } catch (err) {
          stats.errors.push(
            `request #${req.id}: ${(err as Error).message}`,
          );
          this.log.warn(
            `Jellyseerr import: request #${req.id} skipped — ${(err as Error).message}`,
          );
        }
      }

      skip += results.length;
      if (skip >= total) break;
    }

    stats.users = seenUsernames.size;
    this.log.log(
      `Jellyseerr import: ${stats.users} user(s) (${stats.usersCreated} created), ${stats.imported} imported, ${stats.updated} updated, ${stats.skipped} skipped, ${stats.errors.length} error(s)`,
    );
    return stats;
  }

  private async applyRequest(
    req: JellyseerrMediaRequest,
    mediaByKey: Map<string, Media | null>,
    titleByKey: Map<string, string | null>,
    userCache: Map<string, User>,
    seenUsernames: Set<string>,
    stats: JellyseerrImportStats,
    jellyseerrUrl: string,
    jellyseerrApiKey: string,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const username = this.resolveUsername(req.requestedBy);
    if (!username) return 'skipped';
    seenUsernames.add(username);

    const user = await this.resolveUser(username, userCache, stats);
    const mediaType =
      req.type === 'tv' ? MediaType.SERIES : MediaType.MOVIE;
    const tmdbId = req.media?.tmdbId;
    if (!tmdbId || tmdbId <= 0) return 'skipped';

    const key = `${mediaType}:${tmdbId}`;
    let media = mediaByKey.get(key);
    if (media === undefined) {
      media = await this.mediaRepo.findOne({
        where: { type: mediaType, tmdbId },
      });
      mediaByKey.set(key, media);
    }

    const status = this.mapStatus(req.status, req.media?.status);

    // Title resolution chain:
    //   1. Fliks's own Media.title (most authoritative — local cache)
    //   2. Jellyseerr's request payload (rarely populated — only when the
    //      build exposes title/name on the embedded media object)
    //   3. Jellyseerr's TMDB proxy `/api/v1/{movie|tv}/{tmdbId}` — covers
    //      orphans (no Fliks Media yet). Cached by (type, tmdbId) so
    //      multi-user requests for the same title only hit Jellyseerr once.
    let title = media?.title ?? req.media?.title ?? req.media?.name ?? '';
    if (!title) {
      let cached = titleByKey.get(key);
      if (cached === undefined) {
        cached = await this.jellyseerr.fetchTitle(
          jellyseerrUrl,
          jellyseerrApiKey,
          req.type,
          tmdbId,
        );
        titleByKey.set(key, cached);
      }
      if (cached) title = cached;
    }

    const seasons =
      mediaType === MediaType.SERIES && req.seasons?.length
        ? req.seasons.map((s) => s.seasonNumber)
        : null;

    // Preserve Jellyseerr's authoritative timestamps so the imported request
    // looks identical in age/listing order to its source — falling back to
    // "now" only when Jellyseerr returned an unparseable value.
    const createdAt = parseDate(req.createdAt) ?? new Date();
    const updatedAt = parseDate(req.updatedAt) ?? createdAt;

    const existing = await this.requestRepo.findOne({
      where: {
        user: { id: user.id },
        tmdbId,
        mediaType,
      },
    });

    if (existing) {
      existing.status = status;
      existing.seasons = seasons;
      if (media) existing.media = media;
      if (title && !existing.title) existing.title = title;
      await this.requestRepo.save(existing);
      // Restore Jellyseerr's timestamps after `save` (TypeORM auto-stamps
      // updatedAt during save; `update` writes only what we pass it).
      await this.requestRepo.update(existing.id, { createdAt, updatedAt });
      return 'updated';
    }

    const row = this.requestRepo.create({
      user,
      mediaType,
      tmdbId,
      title,
      status,
      seasons,
      media: media ?? null,
      // Profiles / library are left null — the admin picks them at approval
      // time (Fliks already applies sensible defaults at grab time).
      qualityProfile: null,
      languageProfile: null,
      rootFolder: null,
      library: null,
      approvedBy: null,
      declinedReason: null,
    });
    const saved = await this.requestRepo.save(row);
    // Same trick as above for inserts: TypeORM's @CreateDateColumn stamps
    // NOW() on insert, so we overwrite both timestamps after the fact.
    await this.requestRepo.update(saved.id, { createdAt, updatedAt });
    return 'created';
  }

  /** First non-empty value of `jellyfinUsername || plexUsername || username || displayName`. */
  private resolveUsername(u?: JellyseerrUser): string | null {
    if (!u) return null;
    const candidate =
      u.jellyfinUsername || u.plexUsername || u.username || u.displayName;
    const trimmed = candidate?.trim();
    return trimmed ? trimmed : null;
  }

  private async resolveUser(
    username: string,
    cache: Map<string, User>,
    stats: JellyseerrImportStats,
  ): Promise<User> {
    const cached = cache.get(username);
    if (cached) return cached;

    let user = await this.userRepo.findOne({ where: { username } });
    if (!user) {
      // Need the relation here so we can seed library access from the role's
      // template — `RolesService.getDefaultRole()` returns it without
      // relations, so query directly.
      const defaultRole = await this.roleRepo.findOne({
        where: { isDefault: true },
        relations: ['defaultLibraries'],
      });
      user = await this.userRepo.save({
        username,
        passwordHash: null,
        userRole: defaultRole ?? null,
        mediaServerType: MediaServerType.LOCAL,
      } as unknown as User);
      stats.usersCreated++;

      // Mirror UsersService.create: seed library access from the default
      // role's defaultLibraries so the new user can actually see media.
      const defaultLibIds =
        defaultRole?.defaultLibraries?.map((l) => l.id) ?? [];
      if (defaultLibIds.length) {
        await this.libraryAccessRepo.save(
          defaultLibIds.map((libraryId) =>
            this.libraryAccessRepo.create({
              user: { id: user!.id } as User,
              library: { id: libraryId } as Library,
            }),
          ),
        );
      }

      this.log.log(
        `Jellyseerr import: created Fliks user "${username}" (role=${defaultRole?.name ?? 'none'})`,
      );
    }
    cache.set(username, user);
    return user;
  }

  private mapStatus(
    requestStatus: JellyseerrMediaRequest['status'],
    mediaStatus?: JellyseerrMediaRequest['media']['status'],
  ): RequestStatus {
    // Availability overrides request status: an item already on disk is
    // AVAILABLE regardless of how it was requested. PROCESSING means the
    // grab is in flight (Sonarr/Radarr picked it up).
    if (mediaStatus === JELLYSEERR_MEDIA_STATUS.AVAILABLE) {
      return RequestStatus.AVAILABLE;
    }
    if (
      mediaStatus === JELLYSEERR_MEDIA_STATUS.PROCESSING ||
      mediaStatus === JELLYSEERR_MEDIA_STATUS.PARTIALLY_AVAILABLE
    ) {
      return RequestStatus.PROCESSING;
    }
    switch (requestStatus) {
      case JELLYSEERR_REQUEST_STATUS.APPROVED:
        return RequestStatus.APPROVED;
      case JELLYSEERR_REQUEST_STATUS.DECLINED:
        return RequestStatus.DECLINED;
      case JELLYSEERR_REQUEST_STATUS.FAILED:
        return RequestStatus.FAILED;
      case JELLYSEERR_REQUEST_STATUS.PENDING:
      default:
        return RequestStatus.PENDING;
    }
  }
}
