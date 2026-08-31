import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { RemoteService } from './remote.service';
import { RemoteCommandDto } from './dto/remote-command.dto';
import { EventsService, type SseEvent } from '../scheduler/events.service';
import { LiveSessionRegistry } from '../streaming/live-session.service';
import { CaslAbilityFactory } from '../auth/casl/casl-ability.factory';
import { RemoteGrantService } from './remote-grant.service';
import { User } from '../users/entities/user.entity';

/** One standing per-device permission, as the service sees it. */
interface Grant {
  deviceId: string;
  ownerUserId: number;
  granteeUserId: number;
}

/** In-memory stand-in for `RemoteGrantService`, covering exactly the reads
 *  `RemoteService` performs. */
function grantStub(grants: Grant[]): RemoteGrantService {
  return {
    grantedDevices: jest.fn(async (granteeUserId: number) =>
      grants
        .filter((g) => g.granteeUserId === granteeUserId)
        .map((g) => ({ deviceId: g.deviceId, ownerUserId: g.ownerUserId })),
    ),
    isGranted: jest.fn(
      async (granteeUserId: number, deviceId: string) =>
        grants.some(
          (g) => g.granteeUserId === granteeUserId && g.deviceId === deviceId,
        ),
    ),
    granteesForDevice: jest.fn(async (deviceId: string) =>
      grants.filter((g) => g.deviceId === deviceId).map((g) => g.granteeUserId),
    ),
    granteesForOwner: jest.fn(async (ownerUserId: number) =>
      grants.filter((g) => g.ownerUserId === ownerUserId).map((g) => g.granteeUserId),
    ),
  } as unknown as RemoteGrantService;
}

function userRepoStub(users: User[]): Repository<User> {
  return {
    findOne: jest.fn(async ({ where }: { where: { id: number } }) =>
      users.find((u) => u.id === where.id) ?? null,
    ),
    // `where.id` is whatever `In(ids)` produces: a `FindOperator` exposing `.value`.
    find: jest.fn(
      async ({ where }: { where: { id?: { value: number[] }; enabled?: boolean } }) => {
        // No `id` clause means "every user matching the rest", which is how the
        // admin lookup asks; filtering on an absent list returned nobody.
        const ids = where.id?.value;
        return users.filter(
          (u) =>
            (ids === undefined || ids.includes(u.id)) &&
            (where.enabled === undefined || u.enabled === where.enabled),
        );
      },
    ),
  } as unknown as Repository<User>;
}

function fakeUser(overrides: Partial<User>): User {
  return {
    username: `user${overrides.id}`,
    permissions: [],
    isAdmin: false,
    enabled: true,
    shareDisabled: false,
    ...overrides,
  } as unknown as User;
}

function makeService(grants: Grant[] = [], users: User[] = []) {
  const events = new EventsService();
  const liveSessions = { list: () => [] } as unknown as LiveSessionRegistry;
  const service = new RemoteService(
    userRepoStub(users),
    events,
    liveSessions,
    new CaslAbilityFactory(),
    grantStub(grants),
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

  it('lists another account\'s devices for an admin, with no follow or opt-in', async () => {
    const admin = fakeUser({ id: 1, isAdmin: true, permissions: ['manage:all'] });
    const bob = fakeUser({ id: 2 });
    const { service, events } = makeService([], [admin, bob]);

    const adminPhone = connect(events, 1, 'admin-phone');
    const bobTv = connect(events, 2, 'bob-tv');

    // No mutual follow, neither flag set: the command path already authorizes an
    // admin here, so the listing has to agree.
    const rows = await service.listTargets(admin, 'admin-phone');

    const bobRow = rows.find((r) => r.targetId === 'bob-tv');
    expect(bobRow?.ownerUsername).toBe('user2');
    // Its own issuing target stays out of its own list.
    expect(rows.some((r) => r.targetId === 'admin-phone')).toBe(false);

    adminPhone.close();
    bobTv.close();
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

  it('forwards every declared command field to the target', async () => {
    const { service, events } = makeService();
    const alice = fakeUser({ id: 1 });
    const aliceTv = connect(events, 1, 'alice-tv');

    await service.sendCommand(alice, 'alice-tv', {
      action: 'quality',
      qualityId: '720p',
    } as RemoteCommandDto);

    const cmd = aliceTv.frames.find((f) => f.type === 'remote.command');
    // A hand-written field copy here dropped each field added to the protocol
    // later, so the target saw the action with nothing to act on.
    expect(cmd).toMatchObject({ action: 'quality', qualityId: '720p' });

    aliceTv.close();
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
    const grants: Grant[] = [
      { deviceId: 'bob-tv', ownerUserId: 2, granteeUserId: 1 },
    ];
    const bob = fakeUser({ id: 2, enabled: false });
    const { service, events } = makeService(grants, [bob]);
    const alice = fakeUser({ id: 1 });
    const bobTv = connect(events, 2, 'bob-tv');

    await expect(service.sendCommand(alice, 'bob-tv', pauseCmd)).rejects.toThrow(ForbiddenException);

    bobTv.close();
  });
});

describe('RemoteService.canControl: per-device grant', () => {
  it('denies a device that granted nothing', async () => {
    const { service } = makeService([], [fakeUser({ id: 2 })]);
    const alice = fakeUser({ id: 1 });

    const result = await service.canControl(alice, 2, 'bob-tv');

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('device_not_granted');
  });

  it('allows the device that granted this account, and only that device', async () => {
    const grants: Grant[] = [
      { deviceId: 'bob-tv', ownerUserId: 2, granteeUserId: 1 },
    ];
    const { service } = makeService(grants, [fakeUser({ id: 2 })]);
    const alice = fakeUser({ id: 1 });

    expect((await service.canControl(alice, 2, 'bob-tv')).allowed).toBe(true);
    // A grant covers one device, never everything its owner signs into.
    expect((await service.canControl(alice, 2, 'bob-laptop')).allowed).toBe(false);
  });
});

/**
 * `PlaybackController` publishes `remote.state`/`remote.targets_changed` with a
 * plain `events.emitToUser(ownerId, ...)`, same as any other user-scoped event.
 * `RemoteService` registers a fan-out hook on construction (see its constructor)
 * so a mutual, consenting follower gets the frame too, without the streaming
 * module ever depending on the remote module.
 */
/** A minimal valid `remote.state` frame: this suite asserts routing, not
 *  payload contents, so the fields live in one place. */
function stateFrame(targetId: string): SseEvent {
  return {
    type: 'remote.state',
    targetId,
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
    qualities: null,
    autoplayBlocked: false,
    audioTrackIndex: null,
    subtitleTrackIndex: null,
    lastCmdId: null,
  };
}

describe('RemoteService: fan-out for remote.state / remote.targets_changed', () => {
  /** The fan-out awaits its audience lookups, so let more than one turn run. */
  const flushHook = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };

  it('delivers to the owner and the granted account, but not an unrelated user', async () => {
    const grants: Grant[] = [
      { deviceId: 'alice-tv', ownerUserId: 1, granteeUserId: 2 },
    ];
    const alice = fakeUser({ id: 1 });
    const bob = fakeUser({ id: 2 });
    const carol = fakeUser({ id: 3 });
    const { events } = makeService(grants, [alice, bob, carol]);

    const aliceTv = connect(events, 1, 'alice-tv');
    const bobPhone = connect(events, 2, 'bob-phone');
    const carolPhone = connect(events, 3, 'carol-phone');

    events.emitToUser(1, stateFrame('alice-tv'));
    await flushHook();

    expect(aliceTv.frames.some((f) => f.type === 'remote.state')).toBe(true);
    expect(bobPhone.frames.some((f) => f.type === 'remote.state')).toBe(true);
    expect(carolPhone.frames.some((f) => f.type === 'remote.state')).toBe(false);

    aliceTv.close();
    bobPhone.close();
    carolPhone.close();
  });

  it('keeps a state frame within the device it names', async () => {
    // Bob may control the television, so what the bedroom screen plays is none
    // of his business even though the same account owns both.
    const grants: Grant[] = [
      { deviceId: 'alice-tv', ownerUserId: 1, granteeUserId: 2 },
    ];
    const { events } = makeService(grants, [fakeUser({ id: 1 }), fakeUser({ id: 2 })]);

    const bobPhone = connect(events, 2, 'bob-phone');
    events.emitToUser(1, stateFrame('alice-bedroom'));
    await flushHook();

    expect(bobPhone.frames.some((f) => f.type === 'remote.state')).toBe(false);

    bobPhone.close();
  });

  it('reaches an admin without any grant', async () => {
    const admin = fakeUser({ id: 3, isAdmin: true, permissions: ['manage:all'] });
    const { events } = makeService([], [fakeUser({ id: 1 }), admin]);

    const adminPhone = connect(events, 3, 'admin-phone');
    events.emitToUser(1, stateFrame('alice-tv'));
    await flushHook();

    // It commands every target and lists them all, so a card it opens has to
    // receive their state or it never leaves the loading pane.
    expect(adminPhone.frames.some((f) => f.type === 'remote.state')).toBe(true);

    adminPhone.close();
  });

  it('tells a granted account that the device stopped', async () => {
    const grants: Grant[] = [
      { deviceId: 'alice-tv', ownerUserId: 1, granteeUserId: 2 },
    ];
    const { events } = makeService(grants, [fakeUser({ id: 1 }), fakeUser({ id: 2 })]);

    const bobPhone = connect(events, 2, 'bob-phone');
    events.emitToUser(1, { type: 'remote.stopped', targetId: 'alice-tv' });
    await flushHook();

    // Without this a second remote kept showing playback that had ended.
    expect(bobPhone.frames.some((f) => f.type === 'remote.stopped')).toBe(true);

    bobPhone.close();
  });

  it('withholds the fan-out when nothing was granted', async () => {
    const { events } = makeService([], [fakeUser({ id: 1 }), fakeUser({ id: 2 })]);

    const bobPhone = connect(events, 2, 'bob-phone');
    events.emitToUser(1, { type: 'remote.targets_changed' });
    await flushHook();

    expect(bobPhone.frames.some((f) => f.type === 'remote.targets_changed')).toBe(false);

    bobPhone.close();
  });
});
