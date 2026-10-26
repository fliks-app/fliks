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
import { ReactionsService } from './reactions.service';

const item = (mediaId: number, episodeId: number | null = null): PartyItem => ({
  mediaId, mediaFileId: 10, episodeId, title: 't', posterUrl: null, fanartUrl: null, additionalFanartUrls: [],
});

function dto(rev: number, over: Partial<PartyDto> = {}): PartyDto {
  return {
    id: 7, name: 'p', status: 'live', scheduledAt: null, lobbyOpensAt: null, host: { userId: 1, username: 'a' },
    item: item(1, 100), playlist: null, memberCount: 1, policy: 'everyone', reactionsEnabled: true, chatEnabled: true,
    linkSharing: false, inviteToken: null, guests: [],
    live: { rev, playback: { state: 'paused', anchor: { position: 0, serverTimeMs: 0 } }, members: [], messages: [{ id: rev, userId: null, username: null, text: '', system: null, sentAtMs: 0 }] },
    ...over,
  };
}

function setup(connected = false, confirmed = true) {
  const events = new Subject<PartyEvent>();
  const api = {
    join: vi.fn(), get: vi.fn(), queue: vi.fn().mockResolvedValue([item(1, 100), item(1, 101)]),
    leave: vi.fn().mockResolvedValue(undefined), end: vi.fn().mockResolvedValue(undefined),
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

describe('PartyService refetch', () => {
  it('coalesces the start fan-out and opens the player once', async () => {
    const { svc, api, router } = setup();
    svc.applySnapshot(dto(1, { status: 'scheduled' }));
    api.get.mockImplementation(() => Promise.resolve(dto(2)));
    await Promise.all([svc.refetch(), svc.refetch(), svc.refetch()]);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(api.queue).toHaveBeenCalledTimes(1);
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

  it('takes the film the host chose from party.selection, once', () => {
    const { svc, events } = setup();
    svc.applySnapshot(lobby());
    events.next({ type: 'party.selection', partyId: 7, rev: 2, item: item(3) });
    expect(svc.item()?.mediaId).toBe(3);
    events.next({ type: 'party.selection', partyId: 7, rev: 2, item: null });
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
