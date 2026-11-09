import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
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
    item: { id: 5, mediaFileId: 9, kind: 'movie', title: 'A film', subtitle: null, posterUrl: null },
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
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: SseService, useValue: sse },
      { provide: AuthService, useValue: { user: signal({ sessionSync: opts.enabled ?? true }) } },
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
  return { service, sse, http, confirm, flush };
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

  it('masks only a parked session', async () => {
    const { service, http, flush } = setup();
    await flush(session());
    await service.dismiss();
    http.expectNone('/api/session');

    service.refresh();
    http.expectOne('/api/session').flush(session({ state: 'parked', playing: false }));
    await Promise.resolve();
    const done = service.dismiss();
    http.expectOne({ method: 'DELETE', url: '/api/session' }).flush(null);
    await done;
    expect(service.session()).toBeNull();
  });
});

describe('SessionSyncService takeover', () => {
  afterEach(() => TestBed.resetTestingModule());

  const player = (sid: string | undefined, resume = vi.fn()) => {
    const yielded = vi.fn().mockResolvedValue({ title: 'A film', positionSeconds: 754, resume });
    const p: SessionPlayer = { sessionId: () => sid, yield: yielded };
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

  it('cannot start an item whose media it has not seen', async () => {
    const { service, flush } = setup();
    await flush(session());
    expect(service.canPlayHere()).toBe(false);
  });

  it('starts the observed item at the owner position through the adapter of its family', async () => {
    const { service, flush } = setup();
    await flush(session());
    const resumer = vi.fn().mockResolvedValue(undefined);
    service.registerResumer('video', resumer);
    service.setLiveSource(() => ({ mediaFileId: 9, mediaId: 3, episodeId: 7 }), () => 812.5);
    TestBed.tick();
    expect(service.canPlayHere()).toBe(true);
    await service.playHere();
    expect(resumer.mock.calls[0][1]).toEqual({ mediaFileId: 9, mediaId: 3, episodeId: 7, positionSeconds: 812.5 });
  });

  it('falls back on the stored anchor once the owner is parked', async () => {
    const { service, flush } = setup();
    await flush(session());
    const resumer = vi.fn().mockResolvedValue(undefined);
    service.registerResumer('video', resumer);
    const report = signal<{ mediaFileId: number; mediaId: number; episodeId: null } | null>({ mediaFileId: 9, mediaId: 3, episodeId: null });
    service.setLiveSource(report, () => 812);
    TestBed.tick();
    report.set(null);
    service.refresh();
    TestBed.inject(HttpTestingController).expectOne('/api/session').flush(session({ state: 'parked', playing: false, positionSeconds: 640 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(service.canPlayHere()).toBe(true);
    await service.playHere();
    expect(resumer.mock.calls[0][1].positionSeconds).toBe(640);
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
