import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { RemoteService } from './remote.service';
import { RemoteCommandDto } from './dto/remote-command.dto';
import { EventsService } from '../scheduler/events.service';
import { LiveSessionRegistry } from '../streaming/live-session.service';
import { CaslAbilityFactory } from '../auth/casl/casl-ability.factory';
import { SocialService } from '../social/social.service';
import { User } from '../users/entities/user.entity';
import { UserFollow } from '../social/entities/user-follow.entity';
import { FollowStatus } from '../../common/enums';

interface Edge {
  followerId: number;
  followingId: number;
  status: FollowStatus;
}

/** In-memory stand-in for the `UserFollow` repo: enough for the `where`
 *  shapes `RemoteService.mutualFollowerIds` actually sends. */
function followRepoStub(edges: Edge[]): Repository<UserFollow> {
  return {
    find: jest.fn(async ({ where }: { where: { follower?: { id: number }; following?: { id: number }; status: FollowStatus } }) => {
      if (where.follower) {
        return edges
          .filter((e) => e.followerId === where.follower!.id && e.status === where.status)
          .map((e) => ({ followingId: e.followingId }));
      }
      return edges
        .filter((e) => e.followingId === where.following!.id && e.status === where.status)
        .map((e) => ({ followerId: e.followerId }));
    }),
  } as unknown as Repository<UserFollow>;
}

function userRepoStub(users: User[]): Repository<User> {
  return {
    findOne: jest.fn(async ({ where }: { where: { id: number } }) =>
      users.find((u) => u.id === where.id) ?? null,
    ),
    // `where.id` is whatever `In(ids)` produces: a `FindOperator` exposing `.value`.
    find: jest.fn(
      async ({
        where,
      }: {
        where: { id?: { value: number[] }; shareDisabled?: boolean; allowRemoteControlOfOthers?: boolean };
      }) => {
        const ids = where.id?.value ?? [];
        return users.filter(
          (u) =>
            ids.includes(u.id) &&
            (where.shareDisabled === undefined || u.shareDisabled === where.shareDisabled) &&
            (where.allowRemoteControlOfOthers === undefined ||
              u.allowRemoteControlOfOthers === where.allowRemoteControlOfOthers),
        );
      },
    ),
  } as unknown as Repository<User>;
}

/** Real bidirectional-ACCEPTED check against the same edge list: the exact
 *  contract `RemoteService.canControl` relies on from `SocialService`. */
function socialStub(edges: Edge[]): SocialService {
  const mutual = (a: number, b: number) =>
    edges.some((e) => e.followerId === a && e.followingId === b && e.status === FollowStatus.ACCEPTED) &&
    edges.some((e) => e.followerId === b && e.followingId === a && e.status === FollowStatus.ACCEPTED);
  return {
    areMutualFollowers: jest.fn(async (a: number, b: number) => mutual(a, b)),
  } as unknown as SocialService;
}

function fakeUser(overrides: Partial<User>): User {
  return {
    username: `user${overrides.id}`,
    permissions: [],
    isAdmin: false,
    enabled: true,
    shareDisabled: false,
    allowRemoteControlOfOthers: false,
    allowRemoteControlOfMyDevices: false,
    ...overrides,
  } as unknown as User;
}

function makeService(edges: Edge[] = [], users: User[] = []) {
  const events = new EventsService();
  const liveSessions = { list: () => [] } as unknown as LiveSessionRegistry;
  const service = new RemoteService(
    userRepoStub(users),
    followRepoStub(edges),
    events,
    liveSessions,
    new CaslAbilityFactory(),
    socialStub(edges),
  );
  return { service, events };
}

let openConnections: { close: () => void }[] = [];

afterEach(() => {
  openConnections.forEach((c) => c.close());
  openConnections = [];
});

/** Registers a live SSE connection for `userId` and collects every
 *  `remote.*` frame it receives: the ping's empty-data frame is dropped the
 *  same way a real `EventSource` drops a named event with no payload. */
function connect(events: EventsService, userId: number, targetId: string) {
  const frames: { type: string; [key: string]: unknown }[] = [];
  let connectionId = '';
  const sub = events
    .getStream(userId, { targetId, formFactor: 'phone', tvPlatform: null,
      deviceName: null, userAgent: 'ua' })
    .subscribe((msg) => {
      const raw = msg as unknown as { data: string; type?: string };
      if (raw.type === 'ping' || !raw.data) return;
      const parsed = JSON.parse(raw.data);
      if (parsed.type === 'sse.connected') connectionId = parsed.connectionId;
      else frames.push(parsed);
    });
  const handle = { get connectionId() { return connectionId; }, frames, close: () => sub.unsubscribe() };
  openConnections.push(handle);
  return handle;
}

const pauseCmd = { action: 'pause' } as RemoteCommandDto;

describe('RemoteService.sendCommand', () => {
  it('404s on another user\'s target instead of delivering', async () => {
    const { service, events } = makeService();
    const alice = fakeUser({ id: 1 });
    const bobTv = connect(events, 2, 'bob-tv');

    await expect(service.sendCommand(alice, 'bob-tv', pauseCmd)).rejects.toThrow(NotFoundException);
    expect(bobTv.frames).toHaveLength(0);

    bobTv.close();
  });

  it('delivers to exactly the named connection, not the caller\'s other devices', async () => {
    const { service, events } = makeService();
    const alice = fakeUser({ id: 1 });
    const aliceTv = connect(events, 1, 'alice-tv');
    const aliceLaptop = connect(events, 1, 'alice-laptop');

    await service.sendCommand(alice, 'alice-tv', pauseCmd);

    // Both connections belong to alice, so `aliceLaptop`'s own connect already
    // fanned a `remote.targets_changed` to `aliceTv`: filter to the command itself.
    expect(aliceTv.frames.filter((f) => f.type === 'remote.command')).toHaveLength(1);
    expect(aliceLaptop.frames.filter((f) => f.type === 'remote.command')).toHaveLength(0);
  });

  it('rejects a command aimed at the caller\'s own issuing target with 400', async () => {
    const { service, events } = makeService();
    const alice = fakeUser({ id: 1 });
    const alicePhone = connect(events, 1, 'alice-phone');

    await expect(
      service.sendCommand(alice, 'alice-phone', { action: 'pause', byTargetId: 'alice-phone' } as RemoteCommandDto),
    ).rejects.toThrow(BadRequestException);

    alicePhone.close();
  });

  it('treats a dead connection as offline rather than reporting success', async () => {
    const { service, events } = makeService();
    const alice = fakeUser({ id: 1 });
    const aliceTv = connect(events, 1, 'alice-tv');
    jest.spyOn(events, 'emitToConnection').mockReturnValue(false);

    await expect(service.sendCommand(alice, 'alice-tv', pauseCmd)).rejects.toThrow(NotFoundException);

    aliceTv.close();
  });

  it('denies a disabled target user even though its connection is live', async () => {
    const edges: Edge[] = [
      { followerId: 1, followingId: 2, status: FollowStatus.ACCEPTED },
      { followerId: 2, followingId: 1, status: FollowStatus.ACCEPTED },
    ];
    const bob = fakeUser({ id: 2, allowRemoteControlOfMyDevices: true, enabled: false });
    const { service, events } = makeService(edges, [bob]);
    const alice = fakeUser({ id: 1, allowRemoteControlOfOthers: true });
    const bobTv = connect(events, 2, 'bob-tv');

    await expect(service.sendCommand(alice, 'bob-tv', pauseCmd)).rejects.toThrow(ForbiddenException);

    bobTv.close();
  });
});

describe('RemoteService.canControl: household predicate', () => {
  function bobTarget(overrides: Partial<User> = {}): User {
    return fakeUser({ id: 2, allowRemoteControlOfMyDevices: true, ...overrides });
  }

  it('denies a one-way follow', async () => {
    const edges: Edge[] = [{ followerId: 1, followingId: 2, status: FollowStatus.ACCEPTED }];
    const { service } = makeService(edges, [bobTarget()]);
    const alice = fakeUser({ id: 1, allowRemoteControlOfOthers: true });

    const result = await service.canControl(alice, 2);

    expect(result.allowed).toBe(false);
  });

  it('allows a mutual accepted follow with both consent flags set', async () => {
    const edges: Edge[] = [
      { followerId: 1, followingId: 2, status: FollowStatus.ACCEPTED },
      { followerId: 2, followingId: 1, status: FollowStatus.ACCEPTED },
    ];
    const { service } = makeService(edges, [bobTarget()]);
    const alice = fakeUser({ id: 1, allowRemoteControlOfOthers: true });

    const result = await service.canControl(alice, 2);

    expect(result.allowed).toBe(true);
  });
});

/**
 * `PlaybackController` publishes `remote.state`/`remote.targets_changed` with a
 * plain `events.emitToUser(ownerId, ...)`, same as any other user-scoped event.
 * `RemoteService` registers a fan-out hook on construction (see its constructor)
 * so a mutual, consenting follower gets the frame too, without the streaming
 * module ever depending on the remote module.
 */
describe('RemoteService: household fan-out for remote.state / remote.targets_changed', () => {
  const flushHook = () => new Promise((resolve) => setImmediate(resolve));

  it('delivers to the owner and an authorized mutual follower, but not an unrelated user', async () => {
    const edges: Edge[] = [
      { followerId: 1, followingId: 2, status: FollowStatus.ACCEPTED },
      { followerId: 2, followingId: 1, status: FollowStatus.ACCEPTED },
    ];
    const alice = fakeUser({ id: 1, allowRemoteControlOfMyDevices: true });
    const bob = fakeUser({ id: 2, allowRemoteControlOfOthers: true });
    const carol = fakeUser({ id: 3 });
    const { events } = makeService(edges, [alice, bob, carol]);

    const aliceTv = connect(events, 1, 'alice-tv');
    const bobPhone = connect(events, 2, 'bob-phone');
    const carolPhone = connect(events, 3, 'carol-phone');

    events.emitToUser(1, {
      type: 'remote.state',
      targetId: 'alice-tv',
      sessionId: 'sid-1',
      mediaId: 1,
      mediaFileId: 1,
      mediaTitle: 'Title',
      episodeLabel: null,
      posterUrl: null,
      positionSeconds: 10,
      durationSeconds: 100,
      state: 'playing',
      volume: null,
      muted: null,
      supportsVolume: false,
      subtitleId: null,
      quality: null,
      audioTrackIndex: null,
      subtitleTrackIndex: null,
      lastCmdId: null,
    });
    await flushHook();

    expect(aliceTv.frames.some((f) => f.type === 'remote.state')).toBe(true);
    expect(bobPhone.frames.some((f) => f.type === 'remote.state')).toBe(true);
    expect(carolPhone.frames.some((f) => f.type === 'remote.state')).toBe(false);
  });

  it('withholds the fan-out when the owner has not opted in to remote control', async () => {
    const edges: Edge[] = [
      { followerId: 1, followingId: 2, status: FollowStatus.ACCEPTED },
      { followerId: 2, followingId: 1, status: FollowStatus.ACCEPTED },
    ];
    // Owner never set `allowRemoteControlOfMyDevices`: the opt-out `canControl` enforces.
    const alice = fakeUser({ id: 1 });
    const bob = fakeUser({ id: 2, allowRemoteControlOfOthers: true });
    const { events } = makeService(edges, [alice, bob]);

    const bobPhone = connect(events, 2, 'bob-phone');
    events.emitToUser(1, { type: 'remote.targets_changed' });
    await flushHook();

    expect(bobPhone.frames.some((f) => f.type === 'remote.targets_changed')).toBe(false);
  });
});
