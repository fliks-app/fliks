import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PartyApiService, type PartyDto, type PartyItem, type PartyMember } from '../api/party-api.service';
import { MediaService } from '../api/media.service';
import { AuthService } from '../auth.service';
import { ConfirmationService } from '../confirmation.service';
import { DeviceService } from '../device.service';
import { PlaybackQueueService } from '../playback-queue.service';
import { ServerConfigService } from '../server-config.service';
import { SseService, type PartyEvent } from '../sse.service';
import { ToastService } from '../toast.service';
import { ClockService } from './clock.service';
import { PartyService } from './party.service';
import { VoiceService } from './voice.service';
import { ReactionsService } from './reactions.service';

const item = (mediaId: number, episodeId: number | null = null): PartyItem => ({
  mediaId, mediaFileId: 10, episodeId, title: 't', posterUrl: null, fanartUrl: null, additionalFanartUrls: [], stillUrl: null, seriesTitle: null, seasonNumber: null, episodeNumber: null, episodeTitle: null, hidden: false,
});

function dto(rev: number, over: Partial<PartyDto> = {}): PartyDto {
  return {
    id: 7, name: 'p', status: 'live', scheduledAt: null, host: { userId: 1, username: 'a' },
    item: item(1, 100), playlist: null, memberCount: 1, policy: 'everyone', reactionsEnabled: true, chatEnabled: true,
    linkSharing: false, public: false, cover: null, inviteToken: null, guests: [], proposals: [],
    live: { rev, playback: { state: 'paused', anchor: { position: 0, serverTimeMs: 0 } }, members: [], messages: [{ id: rev, userId: null, username: null, text: '', system: null, sentAtMs: 0 }] },
    ...over,
  };
}

function setup(connected = false, confirmed = true) {
  const events = new Subject<PartyEvent>();
  const api = {
    join: vi.fn(), get: vi.fn(), create: vi.fn(), queue: vi.fn().mockResolvedValue([item(1, 100), item(1, 101)]),
    leave: vi.fn().mockResolvedValue(undefined), status: vi.fn().mockResolvedValue(undefined), kick: vi.fn().mockResolvedValue(undefined), start: vi.fn(), voice: vi.fn().mockResolvedValue(undefined), end: vi.fn().mockResolvedValue(undefined),
  };
  const confirm = vi.fn().mockResolvedValue(confirmed);
  const sse = { partyEvents: events, connected: signal(connected), targetId: signal('dev') };
  const router = { navigate: vi.fn().mockResolvedValue(true) };
  TestBed.configureTestingModule({
    providers: [
      PartyService,
      { provide: PartyApiService, useValue: api },
      { provide: SseService, useValue: sse },
      { provide: AuthService, useValue: { user: signal({ id: 1 }) } },
      { provide: ServerConfigService, useValue: { resolveUrl: (p: string) => p } },
      { provide: ReactionsService, useValue: { load: vi.fn() } },
      { provide: ClockService, useValue: { start: vi.fn(), stop: vi.fn(), rttMs: signal(0) } },
      { provide: Router, useValue: router },
      { provide: ConfirmationService, useValue: { confirm } },
      { provide: ToastService, useValue: { info: vi.fn(), error: vi.fn(), success: vi.fn() } },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
      { provide: MediaService, useValue: { getOne: vi.fn() } },
      { provide: DeviceService, useValue: { isTv: () => false, isPhone: () => false } },
    ],
  });
  return { svc: TestBed.inject(PartyService), api, confirm, sse, events, router, queue: TestBed.inject(PlaybackQueueService) };
}

const http = (status: number, message: string) => new HttpErrorResponse({ status, error: { message } });

async function reconnect(sse: { connected: ReturnType<typeof signal<boolean>> }) {
  TestBed.tick();
  sse.connected.set(true);
  TestBed.tick();
  await Promise.resolve();
  await Promise.resolve();
}

describe('PartyService rejoin', () => {
  it('applies a snapshot whose revision restarted after a server restart', async () => {
    const { svc, api, sse } = setup();
    svc.applySnapshot(dto(50));
    api.join.mockResolvedValue(dto(3));
    await reconnect(sse);
    expect(svc.live()?.rev).toBe(3);
    expect(svc.messages().map((m) => m.id)).toEqual([3]);
  });

  it.each([
    [404, 'party.error_not_found', 'host_ended'],
    [409, 'party.error_ended', 'host_ended'],
    [409, 'party.error_not_live', 'expired'],
    [403, 'party.error_kicked', 'kicked'],
    [403, 'party.error_no_access', 'kicked'],
  ])('closes on a %s %s refusal', async (status, message, reason) => {
    const { svc, api, sse } = setup();
    const closed = vi.fn();
    svc.closed.subscribe(closed);
    svc.applySnapshot(dto(1));
    api.join.mockRejectedValue(http(status, message));
    await reconnect(sse);
    expect(closed).toHaveBeenCalledWith(reason);
    expect(svc.party()).toBeNull();
  });

  it('keeps the party on a transient failure', async () => {
    const { svc, api, sse } = setup();
    svc.applySnapshot(dto(1));
    api.join.mockRejectedValue(new HttpErrorResponse({ status: 503 }));
    await reconnect(sse);
    expect(svc.party()).not.toBeNull();
  });
});

describe('PartyService queue', () => {
  const state = (rev: number, i: PartyItem): PartyEvent =>
    ({ type: 'party.state', partyId: 7, rev, state: 'paused', item: i, anchor: { position: 0, serverTimeMs: 0 }, whenMs: null, by: null, action: null }) as PartyEvent;

  it('reloads when the party moves to an item the queue lacks, not for one it holds', async () => {
    const { svc, api, events } = setup(true);
    api.join.mockResolvedValue(dto(1));
    await svc.resume(7);
    expect(api.queue).toHaveBeenCalledTimes(1);
    events.next(state(2, item(1, 101)));
    expect(api.queue).toHaveBeenCalledTimes(1);
    events.next(state(3, item(2)));
    expect(api.queue).toHaveBeenCalledTimes(2);
  });
});

describe('PartyService queue cursor', () => {
  it('sits before the first row when the playing item is not in the programme', async () => {
    const { svc, api, queue } = setup(true);
    api.join.mockResolvedValue(dto(1, { item: item(9) }));
    await svc.resume(7);
    expect(queue.index()).toBe(-1);
    expect(queue.current()).toBeNull();
    expect(queue.peekNext()?.mediaId).toBe(1);
    expect(queue.peekNext()?.episodeId).toBe(100);
  });

  it('follows the playing item when the programme holds it', async () => {
    const { svc, api, queue } = setup(true);
    api.join.mockResolvedValue(dto(1, { item: item(1, 101) }));
    await svc.resume(7);
    expect(queue.index()).toBe(1);
  });
});

describe('PartyService stale snapshots', () => {
  const proposal = { id: 4, item: item(2), proposedBy: 1, upvoterIds: [1], downvoterIds: [] };
  const lobby = (rev: number, over: Partial<PartyDto> = {}) =>
    dto(rev, { status: 'scheduled', item: item(1), live: { ...dto(rev).live!, playback: null }, ...over });

  it('drops a snapshot older than the programme head an event applied, touching nothing', () => {
    const { svc, events } = setup();
    svc.applySnapshot(lobby(1));
    events.next({ type: 'party.programme', partyId: 7, rev: 5, item: item(3) });
    svc.applySnapshot(lobby(2, { item: item(1), proposals: [proposal] }));
    expect(svc.party()?.item?.mediaId).toBe(3);
    expect(svc.proposals()).toEqual([]);
  });

  it('keeps the proposals of an event that arrived while the refetch was in flight', async () => {
    const { svc, api, events } = setup();
    svc.applySnapshot(lobby(1));
    let answer!: (d: PartyDto) => void;
    api.get.mockReturnValue(new Promise<PartyDto>((r) => (answer = r)));
    const refetch = svc.refetch();
    events.next({ type: 'party.proposals', partyId: 7, proposals: [proposal] });
    answer(lobby(1, { proposals: [] }));
    await refetch;
    expect(svc.proposals()).toEqual([proposal]);
  });

  it('takes the proposals of a refetch no event overtook', async () => {
    const { svc, api } = setup();
    svc.applySnapshot(lobby(1));
    api.get.mockResolvedValue(lobby(1, { proposals: [proposal] }));
    await svc.refetch();
    expect(svc.proposals()).toEqual([proposal]);
  });
});

describe('PartyService created parties', () => {
  it('announces a scheduled party so the home rail reloads', async () => {
    const { svc, api } = setup();
    api.create.mockResolvedValue(dto(1, { status: 'scheduled', inviteToken: 't', live: null }));
    const created = vi.fn();
    svc.created.subscribe(created);
    await svc.create({ name: 'p', scheduledAt: '2099-01-01T00:00:00Z' });
    expect(created).toHaveBeenCalledOnce();
  });
});

describe('PartyService refetch', () => {
  it('coalesces the start fan-out and opens the player once', async () => {
    const { svc, api, router } = setup();
    svc.applySnapshot(dto(1, { status: 'scheduled' }));
    await svc.setReady(true);
    api.get.mockImplementation(() => Promise.resolve(dto(2)));
    await Promise.all([svc.refetch(), svc.refetch(), svc.refetch()]);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(api.queue).toHaveBeenCalledTimes(1);
  });

  it('leaves a member who was not ready on the page, out of the room', async () => {
    const { svc, api, router } = setup();
    const skipped = vi.fn();
    svc.startSkipped.subscribe(skipped);
    svc.applySnapshot(dto(1, { status: 'scheduled' }));
    api.get.mockResolvedValue(dto(2));
    await svc.refetch();
    expect(router.navigate).not.toHaveBeenCalled();
    expect(skipped).toHaveBeenCalledWith(expect.objectContaining({ status: 'live' }));
    expect(api.leave).toHaveBeenCalledWith(7, 'dev');
  });
});

describe('PartyService rejoin into a started party', () => {
  it('opens the player when the party went live while the stream was down', async () => {
    const { svc, api, sse, router } = setup();
    svc.applySnapshot(dto(1, { status: 'scheduled', item: null, live: { ...dto(1).live!, playback: null } }));
    await svc.setReady(true);
    api.join.mockResolvedValue(dto(4));
    await reconnect(sse);
    await vi.waitFor(() => expect(router.navigate).toHaveBeenCalledOnce());
  });
});

describe('PartyService room before the start', () => {
  const lobby = (over: Partial<PartyDto> = {}) =>
    dto(1, { status: 'scheduled', item: null, live: { ...dto(1).live!, playback: null }, ...over });

  it('is a lobby with no playback and no item', () => {
    const { svc } = setup();
    svc.applySnapshot(lobby());
    expect(svc.lobby()).toBe(true);
    expect(svc.live()).toBeNull();
    expect(svc.item()).toBeNull();
  });

  it('takes the programme head from party.programme, once', () => {
    const { svc, events } = setup();
    svc.applySnapshot(lobby());
    events.next({ type: 'party.programme', partyId: 7, rev: 2, item: item(3) });
    expect(svc.item()?.mediaId).toBe(3);
    events.next({ type: 'party.programme', partyId: 7, rev: 2, item: item(4) });
    expect(svc.item()?.mediaId).toBe(3);
  });

  it('keeps the playing item when the programme is edited after the start', () => {
    const { svc, events } = setup();
    svc.applySnapshot(dto(2, { item: item(3) }));
    events.next({ type: 'party.programme', partyId: 7, rev: 5, item: null });
    expect(svc.item()?.mediaId).toBe(3);
  });

  it('builds the playback once the party has started', () => {
    const { svc } = setup();
    svc.applySnapshot(lobby());
    svc.applySnapshot(dto(2, { item: item(3) }));
    expect(svc.live()?.item.mediaId).toBe(3);
    expect(svc.live()?.state).toBe('paused');
  });
});

const withMe = (role: 'host' | 'member') =>
  dto(1, { live: { ...dto(1).live!, members: [{ userId: 1, deviceId: 'dev', role } as PartyMember] } });

describe('PartyService leaveOrEnd', () => {
  it('asks the host, then ends the party instead of leaving', async () => {
    const { svc, api, confirm } = setup();
    svc.applySnapshot(withMe('host'));
    expect(await svc.leaveOrEnd()).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(api.end).toHaveBeenCalledWith(7);
    expect(api.leave).not.toHaveBeenCalled();
  });

  it('closes the ended party without waiting for its event', async () => {
    const { svc } = setup();
    svc.applySnapshot(withMe('host'));
    const closed = vi.fn();
    svc.closed.subscribe(closed);
    await svc.end();
    expect(closed).toHaveBeenCalledWith('host_ended');
    expect(svc.party()).toBeNull();
  });

  it('does nothing when the host declines', async () => {
    const { svc, api } = setup(false, false);
    svc.applySnapshot(withMe('host'));
    expect(await svc.leaveOrEnd()).toBe(false);
    expect(api.end).not.toHaveBeenCalled();
    expect(api.leave).not.toHaveBeenCalled();
  });

  it('lets a member leave without a dialog', async () => {
    const { svc, api, confirm } = setup();
    svc.applySnapshot(withMe('member'));
    expect(await svc.leaveOrEnd()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(api.leave).toHaveBeenCalledOnce();
    expect(api.end).not.toHaveBeenCalled();
  });
});

describe('PartyService lobby', () => {
  const lobby = () => dto(1, { status: 'scheduled' });
  const message = (id: number): PartyEvent =>
    ({ type: 'party.message', partyId: 7, rev: id, message: { id, userId: 2, username: 'b', text: 'hi', system: null, sentAtMs: 0 } }) as PartyEvent;

  it('keeps a lobby message out of unread and bubbles, and keeps it after start', async () => {
    const { svc, api, events } = setup();
    svc.applySnapshot(lobby());
    events.next(message(50));
    expect(svc.unread()).toBe(0);
    expect(svc.bubbles()).toEqual([]);
    api.start.mockResolvedValue(dto(2, { live: { ...dto(2).live!, messages: [...svc.messages()] } }));
    await svc.start();
    expect(svc.messages().some((m) => m.id === 50)).toBe(true);
    events.next(message(51));
    expect(svc.unread()).toBe(1);
  });

  it('keeps voice joined across start', async () => {
    vi.stubGlobal('RTCPeerConnection', class { close() {} });
    const { svc, api } = setup();
    const voice = TestBed.inject(VoiceService);
    svc.applySnapshot(lobby());
    voice.joined.set(true);
    api.start.mockResolvedValue(dto(2));
    await svc.start();
    TestBed.tick();
    expect(voice.joined()).toBe(true);
  });
});

describe('PartyService proposals', () => {
  const proposal = { id: 4, item: item(2), proposedBy: 1, upvoterIds: [1], downvoterIds: [] };

  it('takes the snapshot and then the events', () => {
    const { svc, events } = setup();
    svc.applySnapshot(dto(1, { proposals: [proposal] }));
    expect(svc.proposals()).toEqual([proposal]);
    events.next({ type: 'party.proposals', partyId: 7, proposals: [{ ...proposal, upvoterIds: [1, 2] }] });
    expect(svc.proposals()[0].upvoterIds).toEqual([1, 2]);
  });

  it('ignores the proposals of another party', () => {
    const { svc, events } = setup();
    svc.applySnapshot(dto(1));
    events.next({ type: 'party.proposals', partyId: 8, proposals: [proposal] });
    expect(svc.proposals()).toEqual([]);
  });
});

describe('PartyService kick', () => {
  it('removes the person only once the host confirms', async () => {
    const { svc, api } = setup(false, false);
    await svc.kick({ userId: 3, username: 'c' }, 7);
    expect(api.kick).not.toHaveBeenCalled();
    TestBed.resetTestingModule();
    const ok = setup(false, true);
    await ok.svc.kick({ userId: 3, username: 'c' }, 7);
    expect(ok.api.kick).toHaveBeenCalledWith(7, 3);
  });
});

describe('PartyService closed', () => {
  it('names who ended the party in the toast', () => {
    const { svc, events } = setup();
    svc.applySnapshot(dto(1));
    const toast = TestBed.inject(ToastService) as unknown as { info: ReturnType<typeof vi.fn> };
    events.next({ type: 'party.closed', partyId: 7, reason: 'host_ended', by: 'admin' });
    expect(toast.info).toHaveBeenCalledWith('party.closed_host_ended_by');
  });
});

describe('PartyService action errors', () => {
  it('rejoins once when a restarted server lost the room', async () => {
    const { svc, api } = setup(false);
    svc.applySnapshot(dto(1));
    api.join.mockResolvedValue(dto(1));
    const toast = TestBed.inject(ToastService) as unknown as { error: ReturnType<typeof vi.fn> };
    svc.onActionError(http(403, 'party.error_not_member'));
    svc.onActionError(http(409, 'party.error_not_live'));
    await new Promise((r) => setTimeout(r));
    expect(api.join).toHaveBeenCalledTimes(1);
    expect(svc.reconnecting()).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('holds the reconnecting state from a dropped stream until the rejoin lands', async () => {
    const { svc, api, sse } = setup(false);
    svc.applySnapshot(dto(1));
    api.join.mockResolvedValue(dto(1));
    await reconnect(sse);
    expect(svc.reconnecting()).toBeNull();
    sse.connected.set(false);
    TestBed.tick();
    expect(svc.reconnecting()).toBe('server');
    let release!: (d: PartyDto) => void;
    api.join.mockReturnValue(new Promise<PartyDto>((r) => (release = r)));
    sse.connected.set(true);
    TestBed.tick();
    expect(svc.reconnecting()).toBe('room');
    release(dto(1));
    await new Promise((r) => setTimeout(r));
    expect(svc.reconnecting()).toBeNull();
  });

  it('names an unreachable server instead of a generic failure', () => {
    const { svc } = setup();
    svc.applySnapshot(dto(1));
    const toast = TestBed.inject(ToastService) as unknown as { error: ReturnType<typeof vi.fn> };
    svc.onActionError(new HttpErrorResponse({ status: 502 }));
    expect(toast.error).toHaveBeenCalledWith('errors.network');
  });

  it('reports a failed kick instead of swallowing it', async () => {
    const { svc, api } = setup();
    api.kick.mockRejectedValue(new HttpErrorResponse({ status: 0 }));
    const toast = TestBed.inject(ToastService) as unknown as { error: ReturnType<typeof vi.fn> };
    await svc.kick({ userId: 3, username: 'c' }, 7);
    expect(toast.error).toHaveBeenCalledWith('errors.network');
  });
});
