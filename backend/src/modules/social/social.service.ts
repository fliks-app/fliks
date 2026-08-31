import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { UserFollow } from './entities/user-follow.entity';
import { ContentRecommendation } from './entities/content-recommendation.entity';
import { User } from '../users/entities/user.entity';
import { PlaybackState } from '../streaming/entities/playback-state.entity';
import { Media } from '../media/entities/media.entity';
import { Season } from '../media/entities/season.entity';
import { Episode } from '../media/entities/episode.entity';
import { LikesService, LikedItem } from './likes.service';
import { RecommendContentDto } from './dto/recommend-content.dto';
import { PlaylistsService, PlaylistView } from '../playlists/playlists.service';
import {
  RecommendationItem,
  RecommendationService,
} from '../streaming/recommendation.service';
import {
  PlaybackService,
  WatchHistoryItem,
} from '../streaming/playback.service';
import { LibrariesService } from '../libraries/libraries.service';
import { EventsService } from '../scheduler/events.service';
import { UsersStatsService } from '../users/users-stats.service';
import { UserStatsDto } from '../users/dto/user-stats.dto';
import { FollowStatus, ProfileVisibility } from '../../common/enums';

/** A member as seen by another member, with the caller-relative follow state. */
export interface SocialUser {
  id: number;
  username: string;
  avatar: string | null;
  /** The caller follows this user (accepted). */
  isFollowing: boolean;
  /** The caller has a pending follow request to this user. */
  requested: boolean;
  /** This user follows the caller (accepted). */
  followsYou: boolean;
}

export interface PublicProfile extends SocialUser {
  isSelf: boolean;
  visibility: ProfileVisibility;
  followerCount: number;
  followingCount: number;
  /** Which content sections the caller may see (drives the UI). */
  shown: {
    playlists: boolean;
    tastes: boolean;
    recommendations: boolean;
    recentlyWatched: boolean;
    likes: boolean;
    stats: boolean;
  };
  playlists: PlaylistView[];
  topGenres: { genre: string; weight: number }[];
  recommendations: RecommendationItem[];
  recentlyWatched: WatchHistoryItem[];
  likes: LikedItem[];
}

/** The content half of a recommendation card (movie / season / episode). */
export interface RecommendationCard {
  id: number;
  message: string | null;
  createdAt: Date;
  mediaId: number;
  mediaType: string;
  title: string;
  posterUrl: string | null;
  fanartUrl: string | null;
  seasonId: number | null;
  episodeId: number | null;
  label: string | null;
  stillUrl: string | null;
}

/** A content recommendation received from another member. */
export interface ReceivedRecommendation extends RecommendationCard {
  sender: { id: number; username: string; avatar: string | null };
  liked: boolean;
}

/** A content recommendation the caller sent to another member. */
export interface SentRecommendation extends RecommendationCard {
  recipient: { id: number; username: string; avatar: string | null };
}

@Injectable()
export class SocialService {
  constructor(
    @InjectRepository(UserFollow)
    private readonly followRepo: Repository<UserFollow>,
    @InjectRepository(ContentRecommendation)
    private readonly recRepo: Repository<ContentRecommendation>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(PlaybackState)
    private readonly playbackRepo: Repository<PlaybackState>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    private readonly playlists: PlaylistsService,
    private readonly recommendations: RecommendationService,
    private readonly playback: PlaybackService,
    private readonly libraries: LibrariesService,
    private readonly events: EventsService,
    private readonly likes: LikesService,
    private readonly usersStats: UsersStatsService,
  ) {}

  // ── helpers ──

  /** Load an enabled user or 404 (never leak whether a hidden user exists). */
  private async requireUser(userId: number): Promise<User> {
    const user = await this.userRepo.findOne({ where: { id: userId, enabled: true } });
    if (!user) throw new NotFoundException(`User #${userId} not found`);
    return user;
  }

  private isAcceptedFollower(followerId: number, followingId: number): Promise<boolean> {
    return this.followRepo.exist({
      where: {
        follower: { id: followerId },
        following: { id: followingId },
        status: FollowStatus.ACCEPTED,
      },
    });
  }

  /** Both directions ACCEPTED. A public-profile follow is auto-accepted with no
   *  consent from the target, so a one-way edge must never count as mutual. */
  async areMutualFollowers(a: number, b: number): Promise<boolean> {
    const [aFollowsB, bFollowsA] = await Promise.all([
      this.isAcceptedFollower(a, b),
      this.isAcceptedFollower(b, a),
    ]);
    return aFollowsB && bFollowsA;
  }

  /** Decorate a set of users with the caller-relative follow flags (2 batch queries). */
  private async decorate(caller: User, users: User[]): Promise<SocialUser[]> {
    if (!users.length) return [];
    const ids = users.map((u) => u.id);
    const [outgoing, incoming] = await Promise.all([
      this.followRepo.find({
        where: { follower: { id: caller.id }, following: { id: In(ids) } },
      }),
      this.followRepo.find({
        where: {
          follower: { id: In(ids) },
          following: { id: caller.id },
          status: FollowStatus.ACCEPTED,
        },
      }),
    ]);
    const out = new Map(outgoing.map((f) => [f.followingId, f.status]));
    const followsMe = new Set(incoming.map((f) => f.followerId));
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      avatar: u.avatar ?? null,
      isFollowing: out.get(u.id) === FollowStatus.ACCEPTED,
      requested: out.get(u.id) === FollowStatus.PENDING,
      followsYou: followsMe.has(u.id),
    }));
  }

  // ── follow graph ──

  async follow(me: User, targetId: number): Promise<{ status: FollowStatus }> {
    if (me.id === targetId) {
      throw new BadRequestException('Cannot follow yourself');
    }
    if (me.shareDisabled) {
      throw new BadRequestException('Sharing features are disabled');
    }
    const target = await this.requireUser(targetId);
    // A member who opted out of sharing is undiscoverable — 404, not 403, so
    // their existence can't be probed.
    if (target.shareDisabled) throw new NotFoundException(`User #${targetId} not found`);
    const existing = await this.followRepo.findOne({
      where: { follower: { id: me.id }, following: { id: targetId } },
    });
    if (existing) return { status: existing.status };

    const status =
      target.profileVisibility === ProfileVisibility.PUBLIC
        ? FollowStatus.ACCEPTED
        : FollowStatus.PENDING;
    await this.followRepo.save(
      this.followRepo.create({
        follower: { id: me.id } as User,
        following: { id: targetId } as User,
        status,
      }),
    );
    this.events.emitToUser(targetId, {
      type:
        status === FollowStatus.ACCEPTED
          ? 'social.followed'
          : 'social.follow_request',
      userId: me.id,
      username: me.username,
      avatar: me.avatar ?? null,
    });
    return { status };
  }

  async unfollow(me: User, targetId: number): Promise<void> {
    await this.followRepo.delete({
      follower: { id: me.id },
      following: { id: targetId },
    });
  }

  /** Accept a pending request from `requesterId` to follow me. */
  async acceptRequest(me: User, requesterId: number): Promise<void> {
    const req = await this.followRepo.findOne({
      where: {
        follower: { id: requesterId },
        following: { id: me.id },
        status: FollowStatus.PENDING,
      },
    });
    if (!req) throw new NotFoundException('Follow request not found');
    req.status = FollowStatus.ACCEPTED;
    await this.followRepo.save(req);
    this.events.emitToUser(requesterId, {
      type: 'social.follow_accepted',
      userId: me.id,
      username: me.username,
      avatar: me.avatar ?? null,
    });
  }

  async rejectRequest(me: User, requesterId: number): Promise<void> {
    await this.followRepo.delete({
      follower: { id: requesterId },
      following: { id: me.id },
      status: FollowStatus.PENDING,
    });
  }

  /** Pending follow requests addressed to me. */
  async listRequests(me: User): Promise<SocialUser[]> {
    const rows = await this.followRepo.find({
      where: { following: { id: me.id }, status: FollowStatus.PENDING },
      relations: ['follower'],
    });
    return this.decorate(me, rows.map((r) => r.follower));
  }

  // ── discovery ──

  async search(me: User, query: string): Promise<SocialUser[]> {
    // Opted-out members don't use discovery at all.
    if (me.shareDisabled) return [];
    const q = query?.trim();
    // No query → a default roster of discoverable members (not just matches).
    const qb = this.userRepo
      .createQueryBuilder('u')
      .where('u.enabled = true')
      .andWhere('u.shareDisabled = false')
      .andWhere('u.id != :meId', { meId: me.id });
    if (q) qb.andWhere('u.username ILIKE :q', { q: `%${q}%` });
    const users = await qb.orderBy('u.username', 'ASC').take(30).getMany();
    return this.decorate(me, users);
  }

  /** Members the caller may add as playlist collaborators: public profiles, or
   *  members the caller already follows (accepted). An empty query returns the
   *  default suggestions (so the picker can propose on focus). */
  async searchConnectable(me: User, query: string): Promise<SocialUser[]> {
    if (me.shareDisabled) return [];
    const q = query?.trim();
    const followingIds = (
      await this.followRepo.find({
        where: { follower: { id: me.id }, status: FollowStatus.ACCEPTED },
      })
    ).map((f) => f.followingId);
    const qb = this.userRepo
      .createQueryBuilder('u')
      .where('u.enabled = true')
      .andWhere('u.shareDisabled = false')
      .andWhere('u.id != :meId', { meId: me.id })
      .andWhere('(u.profileVisibility = :pub OR u.id IN (:...ids))', {
        pub: ProfileVisibility.PUBLIC,
        ids: followingIds.length ? followingIds : [-1],
      });
    if (q) qb.andWhere('u.username ILIKE :q', { q: `%${q}%` });
    const users = await qb.orderBy('u.username', 'ASC').take(30).getMany();
    return this.decorate(me, users);
  }

  private async connectionsVisible(me: User, target: User): Promise<boolean> {
    return (
      me.id === target.id ||
      target.profileVisibility === ProfileVisibility.PUBLIC ||
      (await this.isAcceptedFollower(me.id, target.id))
    );
  }

  async listFollowers(me: User, targetId: number): Promise<SocialUser[]> {
    const target = await this.requireUser(targetId);
    if (!(await this.connectionsVisible(me, target))) return [];
    const rows = await this.followRepo.find({
      where: { following: { id: targetId }, status: FollowStatus.ACCEPTED },
      relations: ['follower'],
    });
    return this.decorate(me, rows.map((r) => r.follower));
  }

  async listFollowing(me: User, targetId: number): Promise<SocialUser[]> {
    const target = await this.requireUser(targetId);
    if (!(await this.connectionsVisible(me, target))) return [];
    const rows = await this.followRepo.find({
      where: { follower: { id: targetId }, status: FollowStatus.ACCEPTED },
      relations: ['following'],
    });
    return this.decorate(me, rows.map((r) => r.following));
  }

  // ── public profile aggregate ──

  async getProfile(me: User, targetId: number): Promise<PublicProfile> {
    const target = await this.requireUser(targetId);
    const isSelf = me.id === targetId;
    // An opted-out member is invisible to everyone but themselves, and an
    // opted-out viewer can't browse others' profiles. 404 either way (no probe).
    if (!isSelf && (target.shareDisabled || me.shareDisabled)) {
      throw new NotFoundException(`User #${targetId} not found`);
    }
    const [followerCount, followingCount, outgoing] = await Promise.all([
      this.followRepo.count({
        where: { following: { id: targetId }, status: FollowStatus.ACCEPTED },
      }),
      this.followRepo.count({
        where: { follower: { id: targetId }, status: FollowStatus.ACCEPTED },
      }),
      isSelf
        ? Promise.resolve(null)
        : this.followRepo.findOne({
            where: { follower: { id: me.id }, following: { id: targetId } },
          }),
      ]);
    const followsMe = isSelf
      ? false
      : await this.isAcceptedFollower(targetId, me.id);

    const header: SocialUser & {
      isSelf: boolean;
      visibility: ProfileVisibility;
      followerCount: number;
      followingCount: number;
    } = {
      id: target.id,
      username: target.username,
      avatar: target.avatar ?? null,
      isFollowing: outgoing?.status === FollowStatus.ACCEPTED,
      requested: outgoing?.status === FollowStatus.PENDING,
      followsYou: followsMe,
      isSelf,
      visibility: target.profileVisibility,
      followerCount,
      followingCount,
    };

    const canSeeContent =
      isSelf ||
      target.profileVisibility === ProfileVisibility.PUBLIC ||
      header.isFollowing;

    const empty = {
      playlists: false,
      tastes: false,
      recommendations: false,
      recentlyWatched: false,
      likes: false,
      stats: false,
    };
    if (!canSeeContent) {
      // A non-follower of a private profile sees only name + avatar + follow
      // state — no content and no counts.
      return {
        ...header,
        followerCount: 0,
        followingCount: 0,
        shown: empty,
        playlists: [],
        topGenres: [],
        recommendations: [],
        recentlyWatched: [],
        likes: [],
      };
    }

    const includeFollowers = isSelf || header.isFollowing;
    const viewerAccessible = await this.libraries.getAccessibleLibraryIds(me);
    const shown = {
      playlists: true,
      tastes: isSelf || target.shareTastes,
      recommendations: isSelf || target.shareRecommendations,
      recentlyWatched: isSelf || target.shareWatchHistory,
      likes: isSelf || target.shareLikes,
      stats: isSelf || target.shareStats,
    };
    const [playlists, topGenres, recommendations, history, likes] =
      await Promise.all([
        this.playlists.listVisibleForOwner(targetId, me, includeFollowers),
        shown.tastes ? this.recommendations.getTopGenres(targetId) : Promise.resolve([]),
        shown.recommendations
          ? this.recommendations.getRecommendations(targetId, viewerAccessible, 15)
          : Promise.resolve([]),
        shown.recentlyWatched
          ? this.playback.getHistory(targetId, 1, 12, viewerAccessible)
          : Promise.resolve({ data: [], total: 0 }),
        shown.likes
          ? this.likes.listLikes(targetId, viewerAccessible, { limit: 24 })
          : Promise.resolve([]),
      ]);
    return {
      ...header,
      shown,
      playlists,
      topGenres,
      // Strip `becauseTitle`: it is derived from the target's UNSCOPED watch
      // history and could name a title in a library the viewer can't access.
      // The candidate items themselves are already viewer-ACL-scoped.
      recommendations: recommendations.map((r) => ({ ...r, becauseTitle: '' })),
      recentlyWatched: history.data,
      likes,
    };
  }

  /** Activity statistics for a profile's Statistics tab. Visible to the owner
   *  always, and to others only when the user shares stats AND the caller may
   *  see the profile (public, or an accepted follower). 404 otherwise (no
   *  probe). Delegates the aggregation to the shared users-stats service. */
  async getUserStats(me: User, targetId: number): Promise<UserStatsDto> {
    const target = await this.requireUser(targetId);
    const isSelf = me.id === targetId;
    if (!isSelf && (target.shareDisabled || me.shareDisabled)) {
      throw new NotFoundException(`User #${targetId} not found`);
    }
    if (!isSelf) {
      const iFollow = await this.followRepo.findOne({
        where: {
          follower: { id: me.id },
          following: { id: targetId },
          status: FollowStatus.ACCEPTED,
        },
      });
      const canSee =
        target.profileVisibility === ProfileVisibility.PUBLIC || !!iFollow;
      if (!target.shareStats || !canSee) {
        throw new NotFoundException(`User #${targetId} not found`);
      }
    }
    return this.usersStats.getUserStats(targetId);
  }

  /** Media popular among the members the caller follows (accepted), scoped to
   *  the caller's library ACL (and the active library when given), excluding
   *  what the caller has already played. Shaped as RecommendationItem[] so the
   *  library Suggestions row can render it like the other recommendation rows. */
  async followingRecommendations(
    me: User,
    libraryId?: number,
    limit = 20,
  ): Promise<RecommendationItem[]> {
    const followingIds = (
      await this.followRepo.find({
        where: { follower: { id: me.id }, status: FollowStatus.ACCEPTED },
      })
    ).map((f) => f.followingId);
    if (!followingIds.length) return [];
    const accessible = await this.libraries.getAccessibleLibraryIds(me);
    if (!accessible.length) return [];
    const libs =
      libraryId && accessible.includes(libraryId) ? [libraryId] : accessible;

    const rows: { mediaId: number }[] = await this.playbackRepo.query(
      `
      SELECT ps."mediaId" AS "mediaId", COUNT(DISTINCT ps."userId")::int AS cnt
      FROM playback_states ps
      JOIN media m ON m.id = ps."mediaId"
      WHERE ps."userId" = ANY($1)
        AND ps.completed = true
        AND m."libraryId" = ANY($2)
        AND NOT EXISTS (
          SELECT 1 FROM playback_states mine
          WHERE mine."userId" = $3 AND mine."mediaId" = ps."mediaId"
        )
      GROUP BY ps."mediaId"
      ORDER BY cnt DESC, ps."mediaId" DESC
      LIMIT $4
      `,
      [followingIds, libs, me.id, limit],
    );
    if (!rows.length) return [];
    const media = await this.mediaRepo.find({
      where: { id: In(rows.map((r) => r.mediaId)) },
    });
    const byId = new Map(media.map((m) => [m.id, m]));
    return rows
      .map((r) => byId.get(r.mediaId))
      .filter((m): m is Media => !!m)
      .map((m) => ({
        media: {
          id: m.id,
          title: m.title,
          type: m.type,
          year: m.year,
          posterUrl: m.posterUrl,
          fanartUrl: m.fanartUrl,
          additionalFanartUrls: m.additionalFanartUrls ?? [],
          genres: m.genres ?? [],
          available: true,
        },
        becauseTitle: '',
        score: 0,
      }));
  }

  // ── content recommendations (member → member) ──

  /** A member may recommend content to public members or members they follow
   *  (accepted) — the same reach as the playlist-collaborator picker. */
  private async assertConnectable(me: User, target: User): Promise<void> {
    const ok =
      !target.shareDisabled &&
      (target.profileVisibility === ProfileVisibility.PUBLIC ||
        (await this.isAcceptedFollower(me.id, target.id)));
    // 404 (not 403) so a hidden recipient can't be probed for existence.
    if (!ok) throw new NotFoundException(`User #${target.id} not found`);
  }

  async recommend(me: User, dto: RecommendContentDto): Promise<void> {
    if (me.id === dto.recipientId) {
      throw new BadRequestException('Cannot recommend to yourself');
    }
    if (me.shareDisabled) {
      throw new BadRequestException('Sharing features are disabled');
    }
    const recipient = await this.requireUser(dto.recipientId);
    await this.assertConnectable(me, recipient);

    const media = await this.mediaRepo.findOne({ where: { id: dto.mediaId } });
    if (!media) throw new NotFoundException(`Media #${dto.mediaId} not found`);

    // Re-recommending the same content replaces the previous card, so the fresh
    // note resurfaces at the top of the feed instead of stacking or being suppressed.
    await this.recRepo.delete({
      sender: { id: me.id },
      recipient: { id: dto.recipientId },
      media: { id: dto.mediaId },
      season: dto.seasonId ? { id: dto.seasonId } : IsNull(),
      episode: dto.episodeId ? { id: dto.episodeId } : IsNull(),
    });
    await this.recRepo.save(
      this.recRepo.create({
        sender: { id: me.id } as User,
        recipient: { id: dto.recipientId } as User,
        media: { id: dto.mediaId } as Media,
        season: dto.seasonId ? ({ id: dto.seasonId } as Season) : null,
        episode: dto.episodeId ? ({ id: dto.episodeId } as Episode) : null,
        message: dto.message?.trim() || null,
        dismissedAt: null,
      }),
    );
    this.events.emitToUser(dto.recipientId, {
      type: 'social.content_recommended',
      userId: me.id,
      username: me.username,
      avatar: me.avatar ?? null,
      mediaTitle: media.title,
    });
  }

  /** Shape a recommendation's content half (media card + label), or null when
   *  the media is missing / outside the viewer's library access. */
  private contentCard(
    r: ContentRecommendation,
    accessible: number[],
  ): RecommendationCard | null {
    const m = r.media;
    if (!m || !accessible.includes(m.libraryId as number)) return null;
    const season = r.season ?? r.episode?.season ?? null;
    const label = r.episode
      ? `S${season?.seasonNumber ?? '?'}E${r.episode.episodeNumber}` +
        (r.episode.title ? ` · ${r.episode.title}` : '')
      : r.season
        ? `${m.title} · S${r.season.seasonNumber}`
        : null;
    return {
      id: r.id,
      message: r.message,
      createdAt: r.createdAt,
      mediaId: m.id,
      mediaType: m.type,
      title: m.title,
      posterUrl: m.posterUrl,
      fanartUrl: m.fanartUrl,
      seasonId: r.seasonId,
      episodeId: r.episodeId,
      label,
      stillUrl: r.episode?.stillUrl ?? null,
    };
  }

  /** Recommendations addressed to me, newest first, scoped to my library ACL.
   *  Dismissing one (from the home card) only hides it from the active feed —
   *  `includeDismissed` brings the full history back for the profile page. */
  async receivedRecommendations(
    me: User,
    includeDismissed = false,
  ): Promise<ReceivedRecommendation[]> {
    const accessible = await this.libraries.getAccessibleLibraryIds(me);
    if (!accessible.length) return [];
    const rows = await this.recRepo.find({
      where: {
        recipient: { id: me.id },
        ...(includeDismissed ? {} : { dismissedAt: IsNull() }),
      },
      relations: ['sender', 'media', 'season', 'episode', 'episode.season'],
      order: { createdAt: 'DESC' },
      take: 60,
    });
    const likedKeys = await this.likes.likedKeys(
      me.id,
      rows.map((r) => r.mediaId),
    );
    const items: ReceivedRecommendation[] = [];
    for (const r of rows) {
      const card = this.contentCard(r, accessible);
      if (!card) continue;
      items.push({
        ...card,
        sender: {
          id: r.sender.id,
          username: r.sender.username,
          avatar: r.sender.avatar ?? null,
        },
        liked: likedKeys.has(
          `${r.mediaId}:${r.seasonId ?? ''}:${r.episodeId ?? ''}`,
        ),
      });
    }
    return items;
  }

  /** Recommendations the caller has sent to other members, newest first,
   *  scoped to the caller's library ACL. */
  async sentRecommendations(me: User): Promise<SentRecommendation[]> {
    const accessible = await this.libraries.getAccessibleLibraryIds(me);
    if (!accessible.length) return [];
    const rows = await this.recRepo.find({
      where: { sender: { id: me.id } },
      relations: ['recipient', 'media', 'season', 'episode', 'episode.season'],
      order: { createdAt: 'DESC' },
      take: 60,
    });
    const items: SentRecommendation[] = [];
    for (const r of rows) {
      const card = this.contentCard(r, accessible);
      if (!card) continue;
      items.push({
        ...card,
        recipient: {
          id: r.recipient.id,
          username: r.recipient.username,
          avatar: r.recipient.avatar ?? null,
        },
      });
    }
    return items;
  }

  /** Dismiss a recommendation addressed to me (idempotent). */
  async dismissRecommendation(me: User, id: number): Promise<void> {
    await this.recRepo.update(
      { id, recipient: { id: me.id }, dismissedAt: IsNull() },
      { dismissedAt: new Date() },
    );
  }
}
