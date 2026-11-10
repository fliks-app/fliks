import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import { ConfirmationService } from './confirmation.service';
import { DeviceService } from './device.service';
import { ClockService } from './party/clock.service';
import { SessionSyncService, type AccountSession, type SessionPlayer } from './session-sync.service';
import { SseService, type SessionEvent } from './sse.service';

function session(over: Partial<AccountSession> = {}): AccountSession {
  return {
    epoch: 1,
    item: { id: 5, mediaId: 3, episodeId: 7, mediaFileId: 9, kind: 'movie', family: 'video', title: 'A film', subtitle: null, posterUrl: null },
    owner: { targetId: 'pc#1', deviceName: 'Desk', formFactor: 'desktop' },
    state: 'playing',
    positionSeconds: 100,
    positionAt: new Date().toISOString(),
    playing: true,
    durationSeconds: 3600,
    queue: null,
    ...over,
  };
}

function setup(opts: { enabled?: boolean; tv?: boolean; confirm?: boolean } = {}) {
  const sse = {
    sessionEvents: new Subject<SessionEvent>(),
    connectionId: signal<string | null>('conn-1'),
    targetId: signal<string | null>('phone#1'),
  };
  const confirm = vi.fn().mockResolvedValue(opts.confirm ?? false);
  const user = signal<{ sessionSync: boolean }>({ sessionSync: opts.enabled ?? true });
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: SseService, useValue: sse },
      { provide: AuthService, useValue: { user } },
      { provide: DeviceService, useValue: { isTv: () => !!opts.tv } },
      { provide: ClockService, useValue: { serverNow: () => Date.now() } },
      { provide: ConfirmationService, useValue: { confirm } },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
    ],
  });
  const service = TestBed.inject(SessionSyncService);
  const http = TestBed.inject(HttpTestingController);
  const flush = async (body: AccountSession | null) => {
    TestBed.tick();
    http.expectOne('/api/session').flush(body);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { service, sse, http, confirm, flush, user };
}

describe('SessionSyncService role', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('reads the session on connect and sees another device as the owner', async () => {
    const { service, flush } = setup();
    await flush(session());
    expect(service.session()?.item.title).toBe('A film');
    expect(service.role()).toBe('observer');
  });

  it('is the owner when the session names this target', async () => {
    const { service, flush } = setup();
    await flush(session({ owner: { targetId: 'phone#1', deviceName: 'Phone', formFactor: 'phone' } }));
    expect(service.role()).toBe('owner');
    expect(service.observedOwnerTargetId()).toBeNull();
  });

  it('owns a parked session of an earlier page load of this device, and a live one only by its exact target', async () => {
    const { service, flush, sse } = setup();
    await flush(session({ state: 'parked', playing: false, owner: { targetId: 'phone#old', deviceName: null, formFactor: 'phone' } }));
    expect(service.ownedHere()).toBe(true);
    expect(service.parkedHere()).toBe(true);
    expect(service.ownerName(service.session()!)).toBe('session.another_device');
    sse.targetId.set('tablet#1');
    expect(service.ownedHere()).toBe(false);
  });

  it('owns a live session held by its device native face, which the bare web target continues', async () => {
    const { service, flush, sse } = setup();
    sse.targetId.set('phone');
    await flush(session({ owner: { targetId: 'phone#native', deviceName: 'Phone', formFactor: 'phone' } }));
    expect(service.role()).toBe('owner');
    expect(service.ownedHere()).toBe(true);
    sse.targetId.set('tablet');
    expect(service.role()).toBe('observer');
    expect(service.ownedHere()).toBe(false);
  });

  it('keeps another tab of this device an observer of a live session', async () => {
    const { service, flush } = setup();
    await flush(session({ owner: { targetId: 'phone#other', deviceName: null, formFactor: 'phone' } }));
    expect(service.ownedHere()).toBe(false);
    expect(service.role()).toBe('observer');
  });

  it('moves the position of a session played elsewhere every second', async () => {
    vi.useFakeTimers();
    try {
      const { service, flush } = setup();
      await flush(session({ positionSeconds: 100, positionAt: new Date().toISOString() }));
      const s = service.session()!;
      const read = computed(() => Math.floor(service.positionNow(s)));
      const before = read();
      TestBed.tick();
      vi.advanceTimersByTime(3000);
      TestBed.tick();
      expect(read()).toBeGreaterThanOrEqual(before + 3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('has no role without a session', async () => {
    const { service, flush } = setup();
    await flush(null);
    expect(service.role()).toBe('none');
  });

  it('asks nothing while the setting is off', () => {
    const { service, http } = setup({ enabled: false });
    TestBed.tick();
    http.expectNone('/api/session');
    expect(service.session()).toBeNull();
  });

  it('refetches on session.changed', async () => {
    const { sse, http, flush } = setup();
    await flush(session());
    sse.sessionEvents.next({ type: 'session.changed', epoch: 2, itemId: 5, state: 'paused', ownerTargetId: 'pc#1' });
    http.expectOne('/api/session').flush(session({ state: 'paused', playing: false }));
  });
});

describe('SessionSyncService observation', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('names the owner to observe without selecting anything', async () => {
    const { service, flush } = setup();
    await flush(session());
    expect(service.observedOwnerTargetId()).toBe('pc#1');
  });

  it('observes nothing once the owner is parked', async () => {
    const { service, flush } = setup();
    await flush(session({ state: 'parked', playing: false }));
    expect(service.parked()).toBe(true);
    expect(service.role()).toBe('observer');
    expect(service.observedOwnerTargetId()).toBeNull();
  });

  it('observes nothing on a TV, which only ever owns', async () => {
    const { service, flush } = setup({ tv: true });
    await flush(session());
    expect(service.observedOwnerTargetId()).toBeNull();
  });
});

describe('SessionSyncService one surface', () => {
  afterEach(() => TestBed.resetTestingModule());

  const held = (itemId: number, active = false) => {
    const yielded = vi.fn().mockResolvedValue(null);
    const p: SessionPlayer = { sessionId: () => 'sid-old', active: () => active, itemId: () => itemId, yield: yielded };
    return { p, yielded };
  };

  it('closes a paused local copy of the item another device plays, without a modal', async () => {
    const { service, flush, confirm } = setup({ confirm: true });
    const { p, yielded } = held(5);
    service.registerPlayer(p);
    await flush(session());
    TestBed.tick();
    expect(yielded).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('keeps a paused local player of another item, which is not the observed session', async () => {
    const { service, flush } = setup();
    const { p, yielded } = held(6);
    service.registerPlayer(p);
    await flush(session());
    TestBed.tick();
    expect(yielded).not.toHaveBeenCalled();
  });

  it('keeps the paused copy of the item while this device is taking the session over', async () => {
    const { service, flush } = setup();
    const { p, yielded } = held(5);
    service.registerPlayer(p);
    let done!: () => void;
    service.registerResumer('video', () => new Promise<void>((r) => (done = r)));
    await flush(session());
    const taking = service.playHere();
    TestBed.tick();
    expect(yielded).not.toHaveBeenCalled();
    done();
    await taking;
  });

  it('keeps a playing local player, one with no account item, and every player of a parked session', async () => {
    const { service, flush } = setup();
    const playing = held(5, true);
    const parked = held(6);
    const noItem = { sessionId: () => 'sid-live', active: () => false, itemId: () => null, yield: vi.fn().mockResolvedValue(null) };
    service.registerPlayer(playing.p);
    service.registerPlayer(noItem);
    await flush(session());
    TestBed.tick();
    expect(playing.yielded).not.toHaveBeenCalled();
    expect(noItem.yield).not.toHaveBeenCalled();
    service.registerPlayer(parked.p);
    service.refresh();
    TestBed.inject(HttpTestingController).expectOne('/api/session').flush(session({ state: 'parked', playing: false }));
    await Promise.resolve();
    await Promise.resolve();
    TestBed.tick();
    expect(parked.yielded).not.toHaveBeenCalled();
  });

  it('keeps the paused player of the session this device owns', async () => {
    const { service, flush } = setup();
    const { p, yielded } = held(5);
    service.registerPlayer(p);
    await flush(session({ state: 'paused', playing: false, owner: { targetId: 'phone#1', deviceName: null, formFactor: 'phone' } }));
    TestBed.tick();
    expect(yielded).not.toHaveBeenCalled();
  });

  it('has every player beat once the stream connects again', async () => {
    const { service, flush, sse } = setup();
    const report = vi.fn();
    service.registerPlayer({ sessionId: () => 'sid-1', active: () => true, yield: async () => null, report });
    await flush(null);
    report.mockClear();
    sse.connectionId.set(null);
    TestBed.tick();
    sse.connectionId.set('conn-2');
    TestBed.tick();
    expect(report).toHaveBeenCalledOnce();
  });
});

describe('SessionSyncService takeover', () => {
  afterEach(() => TestBed.resetTestingModule());

  const player = (sid: string | undefined, resume = vi.fn()) => {
    const yielded = vi.fn().mockResolvedValue({ title: 'A film', positionSeconds: 754, resume });
    const p: SessionPlayer = { sessionId: () => sid, active: () => true, yield: yielded };
    return { p, yielded, resume };
  };

  it('stops the player holding the superseded session and offers to resume', async () => {
    const { service, sse, confirm } = setup({ confirm: true });
    const { p, yielded, resume } = player('sid-1');
    service.registerPlayer(p);
    sse.sessionEvents.next({ type: 'session.superseded', sessionId: 'sid-1', byDeviceName: 'Pixel', epoch: 2 });
    await vi.waitFor(() => expect(resume).toHaveBeenCalled());
    expect(yielded).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0].title).toBe('session.superseded_title');
    expect(confirm.mock.calls[0][0].message).toBe('A film. session.superseded_message');
  });

  it('does not reject when "resume here" fails to start', async () => {
    const { service } = setup({ confirm: true });
    const { p, resume } = player('sid-1');
    resume.mockRejectedValue(new Error('chunk failed'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    service.registerPlayer(p);
    await expect(service.handleSuperseded('sid-1', 'Pixel')).resolves.toBeUndefined();
    expect(resume).toHaveBeenCalled();
  });

  it('flags the session started by "resume here" as a hand-over', async () => {
    const { service, sse } = setup({ confirm: true });
    const { p } = player('sid-1');
    service.registerPlayer(p);
    sse.sessionEvents.next({ type: 'session.superseded', sessionId: 'sid-1', byDeviceName: 'Pixel', epoch: 2 });
    await vi.waitFor(() => expect(service.handoffFor('sid-2')).toBe(true));
  });

  it('leaves the player closed when the modal is dismissed', async () => {
    const { service, sse, confirm } = setup({ confirm: false });
    const { p, resume } = player('sid-1');
    service.registerPlayer(p);
    sse.sessionEvents.next({ type: 'session.superseded', sessionId: 'sid-1', byDeviceName: 'Pixel', epoch: 2 });
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(resume).not.toHaveBeenCalled();
  });

  it('handles one supersede once, whichever of the event or the beat flag comes second', async () => {
    const { service } = setup();
    const { p, yielded } = player('sid-1');
    service.registerPlayer(p);
    await service.handleSuperseded('sid-1', 'Pixel');
    await service.handleSuperseded('sid-1');
    expect(yielded).toHaveBeenCalledOnce();
  });

  it('stops a silent hand-over without a modal, still saving the position', async () => {
    const { service, sse, confirm } = setup({ confirm: true });
    const { p, yielded, resume } = player('sid-1');
    service.registerPlayer(p);
    sse.sessionEvents.next({ type: 'session.superseded', sessionId: 'sid-1', byDeviceName: 'Pixel', epoch: 2, silent: true });
    await vi.waitFor(() => expect(yielded).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(confirm).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    await service.handleSuperseded('sid-1');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('shows no modal when the silent event lands while the beat flag is yielding', async () => {
    const { service, confirm } = setup({ confirm: true });
    const { p } = player('sid-1');
    service.registerPlayer(p);
    const beat = service.handleSuperseded('sid-1');
    await service.handleSuperseded('sid-1', 'Pixel', true);
    await beat;
    expect(confirm).not.toHaveBeenCalled();
  });

  it('ignores a session no local player holds', async () => {
    const { service, confirm } = setup();
    const { p, yielded } = player('sid-1');
    service.registerPlayer(p);
    await service.handleSuperseded('other');
    expect(yielded).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('stops listening for a player that unregistered', async () => {
    const { service } = setup();
    const { p, yielded } = player('sid-1');
    service.registerPlayer(p)();
    await service.handleSuperseded('sid-1', 'Pixel');
    expect(yielded).not.toHaveBeenCalled();
  });
});

describe('SessionSyncService play here', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('flags the first beats of the session started by play here as a hand-over, once', async () => {
    const { service, flush } = setup();
    await flush(session());
    service.registerResumer('video', vi.fn().mockResolvedValue(undefined));
    expect(service.handoffFor('new')).toBeUndefined();
    await service.playHere();
    expect(service.handoffFor('new')).toBe(true);
    expect(service.handoffFor('new')).toBe(true);
    expect(service.handoffFor('other')).toBeUndefined();
  });

  it('never flags the session of a player already running when play here is armed', async () => {
    const { service, flush } = setup();
    await flush(session());
    service.registerResumer('video', vi.fn().mockResolvedValue(undefined));
    service.registerPlayer({ sessionId: () => 'busy', active: () => true, yield: async () => null });
    await service.playHere();
    expect(service.handoffFor('busy')).toBeUndefined();
    expect(service.handoffFor('new')).toBe(true);
  });

  it('lets a hand-over lapse after its TTL', async () => {
    vi.useFakeTimers();
    try {
      const { service, flush } = setup();
      await flush(session());
      service.registerResumer('video', vi.fn().mockResolvedValue(undefined));
      await service.playHere();
      vi.advanceTimersByTime(61_000);
      expect(service.handoffFor('late')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts the item with its own pair at the extrapolated position through the adapter of its family', async () => {
    const { service, flush } = setup();
    await flush(session());
    const resumer = vi.fn().mockResolvedValue(undefined);
    service.registerResumer('video', resumer);
    expect(service.canPlayHere()).toBe(true);
    await service.playHere();
    expect(resumer.mock.calls[0][0].item).toMatchObject({ mediaId: 3, episodeId: 7, mediaFileId: 9 });
    expect(resumer.mock.calls[0][1]).toBeGreaterThanOrEqual(100);
  });

  it('ignores a report of another file than the session item', async () => {
    const { service, flush } = setup();
    await flush(session({ positionSeconds: 100, playing: false }));
    service.setLiveSource(() => ({ mediaFileId: 4, durationSeconds: 90 }), () => 812.5);
    TestBed.tick();
    expect(service.liveReport()).toBeNull();
    expect(service.positionNow(service.session()!)).toBe(100);
    expect(service.durationNow(service.session()!)).toBe(3600);
  });

  it('holds the claim of a resume until this device owns the session', async () => {
    const { service, flush } = setup();
    await flush(session());
    service.registerPlayer({ sessionId: () => 'sid-new', active: () => true, yield: vi.fn().mockResolvedValue(null) });
    service.registerResumer('video', vi.fn().mockResolvedValue(undefined));
    expect(service.claimPending()).toBe(false);
    await service.playHere();
    expect(service.claimPending()).toBe(true);
    service.refresh();
    TestBed.inject(HttpTestingController).expectOne('/api/session').flush(session({ owner: { targetId: 'phone#1', deviceName: 'Phone', formFactor: 'phone' } }));
    await Promise.resolve();
    await Promise.resolve();
    TestBed.tick();
    expect(service.claimPending()).toBe(false);
  });

  it('keeps the claim while the resumed player is still being navigated to', async () => {
    const { service, flush } = setup();
    await flush(session());
    let done!: () => void;
    service.registerResumer('video', () => new Promise<void>((r) => (done = r)));
    const taking = service.playHere();
    TestBed.tick();
    expect(service.claimPending()).toBe(true);
    service.registerPlayer({ sessionId: () => 'sid-new', active: () => true, yield: vi.fn().mockResolvedValue(null) });
    done();
    await taking;
    TestBed.tick();
    expect(service.claimPending()).toBe(true);
    expect(service.handoffFor('sid-new')).toBe(true);
  });

  it('releases the claim of a resume that started no player', async () => {
    const { service, flush } = setup();
    await flush(session());
    service.registerResumer('video', vi.fn().mockResolvedValue(undefined));
    await service.playHere();
    TestBed.tick();
    expect(service.claimPending()).toBe(false);
    expect(service.handoffFor('sid-x')).toBeUndefined();
  });

  it('releases the claim when the resumer fails', async () => {
    const { service, flush } = setup();
    await flush(session());
    service.registerResumer('video', vi.fn().mockRejectedValue(new Error('no')));
    await expect(service.playHere()).rejects.toThrow();
    TestBed.tick();
    expect(service.claimPending()).toBe(false);
  });

  it('does not count a registered idle player as holding one', () => {
    const { service } = setup();
    service.registerPlayer({ sessionId: () => undefined, active: () => false, itemId: () => null, yield: vi.fn().mockResolvedValue(null) });
    expect(service.holdsPlayer()).toBe(false);
    service.registerPlayer({ sessionId: () => undefined, active: () => false, itemId: () => 4, yield: vi.fn().mockResolvedValue(null) });
    expect(service.holdsPlayer()).toBe(true);
  });

  it('dates the owner report from the row, for the owner only', async () => {
    const { service, flush } = setup();
    await flush(session({ positionAt: new Date(Date.now() - 4000).toISOString() }));
    expect(Date.now() - service.ownerReportAt('pc#1')).toBeGreaterThanOrEqual(3900);
    expect(service.ownerReportAt('tv#1')).toBe(0);
  });

  it('prefers the owner live position while it is observed', async () => {
    const { service, flush } = setup();
    await flush(session());
    const resumer = vi.fn().mockResolvedValue(undefined);
    service.registerResumer('video', resumer);
    service.setLiveSource(() => ({ mediaFileId: 9, durationSeconds: 3600 }), () => 812.5);
    TestBed.tick();
    await service.playHere();
    expect(resumer.mock.calls[0][1]).toBe(812.5);
  });

  it('resumes a parked session from a cold start at the stored position', async () => {
    const { service, flush } = setup();
    await flush(session({ state: 'parked', playing: false, positionSeconds: 640 }));
    const resumer = vi.fn().mockResolvedValue(undefined);
    service.registerResumer('video', resumer);
    expect(service.canPlayHere()).toBe(true);
    await service.playHere();
    expect(resumer.mock.calls[0][1]).toBe(640);
  });

  const book = { id: 11, mediaId: 4, episodeId: null, mediaFileId: 2, kind: 'book' as const, family: 'text' as const, title: 'A book', subtitle: null, posterUrl: null };

  it('opens a parked book in the reader', async () => {
    const { service, flush } = setup();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    await flush(session({ item: book, state: 'parked', playing: false, positionSeconds: 0.4, durationSeconds: 1 }));
    expect(service.isReading(service.session()!)).toBe(true);
    expect(service.canTransfer()).toBe(false);
    await service.playHere();
    expect(navigate).toHaveBeenCalledWith(['/read', 4, 11]);
  });

  it('keeps an audiobook out of the reader', async () => {
    const { service, flush } = setup();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const audio = vi.fn().mockResolvedValue(undefined);
    service.registerResumer('audio', audio);
    await flush(session({ item: { ...book, family: 'audio' }, state: 'parked', playing: false }));
    expect(service.isReading(service.session()!)).toBe(false);
    await service.playHere();
    expect(audio).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('starts an album from its stored queue', async () => {
    const { service, flush } = setup();
    const queue = { itemIds: [5, 6], index: 0, shuffle: false, repeat: 'off' as const };
    await flush(session({ item: { id: 5, mediaId: 2, episodeId: null, mediaFileId: null, kind: 'album', family: 'audio', title: 'An album', subtitle: 'A track', posterUrl: null }, queue, state: 'parked', playing: false }));
    const resumer = vi.fn().mockResolvedValue(undefined);
    service.registerResumer('audio', resumer);
    expect(service.canPlayHere()).toBe(true);
    await service.playHere();
    expect(resumer.mock.calls[0][0].queue).toEqual(queue);
    expect(resumer.mock.calls[0][1]).toBe(100);
  });

  it('transfers to another device through the server without touching the local state', async () => {
    const { service, flush, http } = setup();
    await flush(session({ owner: { targetId: 'phone#1', deviceName: 'Phone', formFactor: 'phone' } }));
    const done = service.transferTo('tv#1');
    const req = http.expectOne('/api/session/transfer');
    expect(req.request.body).toEqual({ toTargetId: 'tv#1' });
    req.flush({ cmdId: 'c1' });
    await done;
    expect(service.role()).toBe('owner');
  });

  it('does nothing for the owner', async () => {
    const { service, flush } = setup();
    await flush(session({ owner: { targetId: 'phone#1', deviceName: 'Phone', formFactor: 'phone' } }));
    const resumer = vi.fn();
    service.registerResumer('video', resumer);
    await service.playHere();
    expect(resumer).not.toHaveBeenCalled();
  });
});

describe('SessionSyncService setting and local playback', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('drops a session that comes back after the setting was turned off', async () => {
    const { service, http, flush, user } = setup();
    await flush(session());
    user.set({ sessionSync: false });
    TestBed.tick();
    expect(service.session()).toBeNull();
    service.refresh();
    http.expectOne('/api/session').flush(session());
    await Promise.resolve();
    await Promise.resolve();
    expect(service.session()).toBeNull();
  });

  it('stops observing the owner while this device plays something itself', async () => {
    const { service, flush } = setup();
    await flush(session());
    expect(service.observedOwnerTargetId()).toBe('pc#1');
    const busy = signal(true);
    service.registerPlayer({ sessionId: () => undefined, active: busy, yield: vi.fn() });
    expect(service.observedOwnerTargetId()).toBeNull();
    busy.set(false);
    expect(service.observedOwnerTargetId()).toBe('pc#1');
  });
});
