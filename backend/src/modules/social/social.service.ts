import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { UserFollow } from './entities/user-follow.entity';
import { User } from '../users/entities/user.entity';
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
  shown: { playlists: boolean; tastes: boolean; recommendations: boolean; recentlyWatched: boolean };
  playlists: PlaylistView[];
  topGenres: { genre: string; weight: number }[];
  recommendations: RecommendationItem[];
  recentlyWatched: WatchHistoryItem[];
}

@Injectable()
export class SocialService {
  constructor(
    @InjectRepository(UserFollow)
    private readonly followRepo: Repository<UserFollow>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly playlists: PlaylistsService,
    private readonly recommendations: RecommendationService,
    private readonly playback: PlaybackService,
    private readonly libraries: LibrariesService,
    private readonly events: EventsService,
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
    const target = await this.requireUser(targetId);
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
    const q = query?.trim();
    if (!q) return [];
    const users = await this.userRepo
      .createQueryBuilder('u')
      .where('u.enabled = true')
      .andWhere('u.id != :meId', { meId: me.id })
      .andWhere('u.username ILIKE :q', { q: `%${q}%` })
      .orderBy('u.username', 'ASC')
      .take(30)
      .getMany();
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

    const empty = { playlists: false, tastes: false, recommendations: false, recentlyWatched: false };
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
      };
    }

    const includeFollowers = isSelf || header.isFollowing;
    const viewerAccessible = await this.libraries.getAccessibleLibraryIds(me);
    const shown = {
      playlists: true,
      tastes: isSelf || target.shareTastes,
      recommendations: isSelf || target.shareRecommendations,
      recentlyWatched: isSelf || target.shareWatchHistory,
    };
    const [playlists, topGenres, recommendations, history] = await Promise.all([
      this.playlists.listVisibleForOwner(targetId, me, includeFollowers),
      shown.tastes ? this.recommendations.getTopGenres(targetId) : Promise.resolve([]),
      shown.recommendations
        ? this.recommendations.getRecommendations(targetId, viewerAccessible, 15)
        : Promise.resolve([]),
      shown.recentlyWatched
        ? this.playback.getHistory(targetId, 1, 12, viewerAccessible)
        : Promise.resolve({ data: [], total: 0 }),
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
    };
  }
}
