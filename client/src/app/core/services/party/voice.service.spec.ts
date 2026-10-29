import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PartyApiService } from '../api/party-api.service';
import { AuthService } from '../auth.service';
import { DeviceService } from '../device.service';
import { SseService } from '../sse.service';
import { ToastService } from '../toast.service';
import { PartyService } from './party.service';
import { VoiceService } from './voice.service';

class FakePc {
  static all: FakePc[] = [];
  ontrack: ((e: unknown) => void) | null = null;
  oniceconnectionstatechange = null;
  iceGatheringState = 'complete';
  localDescription = { toJSON: () => ({ type: 'answer', sdp: 'x' }) };
  setRemoteDescription = vi.fn().mockResolvedValue(undefined);
  setLocalDescription = vi.fn().mockResolvedValue(undefined);
  createAnswer = vi.fn().mockResolvedValue({});
  addTransceiver = vi.fn();
  close = vi.fn();
  constructor() {
    FakePc.all.push(this);
  }
}

function setup() {
  FakePc.all = [];
  vi.stubGlobal('RTCPeerConnection', FakePc);
  vi.stubGlobal('MediaStream', class {});
  const rejoined = new Subject<void>();
  const members = signal<unknown[]>([]);
  const api = { voice: vi.fn().mockResolvedValue(undefined), signal: vi.fn().mockResolvedValue(undefined), iceServers: vi.fn().mockResolvedValue({ iceServers: [] }) };
  TestBed.configureTestingModule({
    providers: [
      VoiceService,
      { provide: PartyApiService, useValue: api },
      { provide: PartyService, useValue: { party: signal({ id: 7 }), members, rejoined, onActionError: vi.fn() } },
      { provide: SseService, useValue: { partyEvents: new Subject(), targetId: signal('dev'), connected: signal(true) } },
      { provide: AuthService, useValue: { user: signal({ id: 1 }) } },
      { provide: ToastService, useValue: { error: vi.fn() } },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
      { provide: DeviceService, useValue: { isTv: () => false } },
    ],
  });
  return { voice: TestBed.inject(VoiceService), api, rejoined, members, sse: TestBed.inject(SseService) as unknown as { partyEvents: Subject<unknown> } };
}

describe('VoiceService rejoin', () => {
  it('tells the server it is still in voice, with its mute state', async () => {
    const { voice, api, rejoined } = setup();
    voice.joined.set(true);
    rejoined.next();
    await Promise.resolve();
    expect(api.voice).toHaveBeenCalledWith(7, 'dev', true, true);
  });

  it('stays quiet when this device was not in voice', async () => {
    const { api, rejoined, voice } = setup();
    expect(voice.joined()).toBe(false);
    rejoined.next();
    await Promise.resolve();
    expect(api.voice).not.toHaveBeenCalled();
  });
});

describe('VoiceService join', () => {
  it('accepts signals while the server is still flagging the join', async () => {
    const { voice, api } = setup();
    let flagged!: () => void;
    api.voice.mockReturnValue(new Promise<void>((r) => (flagged = r)));
    const joining = voice.join();
    await vi.waitFor(() => expect(api.voice).toHaveBeenCalled());
    expect(voice.joined()).toBe(true);
    flagged();
    await joining;
  });

  it('is not joined when the server refuses', async () => {
    const { voice, api } = setup();
    api.voice.mockRejectedValue(new Error('full'));
    await voice.join();
    expect(voice.joined()).toBe(false);
  });
});

describe('VoiceService negotiation', () => {
  const signal = (sse: { partyEvents: Subject<unknown> }, from: string, kind: string, data: object, userId = 2) =>
    sse.partyEvents.next({ type: 'party.signal', partyId: 7, from: { userId, deviceId: from }, kind, data });

  it('echoes the offer sid in its answer', async () => {
    const { voice, api, sse } = setup();
    voice.joined.set(true);
    signal(sse, 'peer', 'offer', { type: 'offer', sdp: 'o', sid: 'abc' });
    await vi.waitFor(() => expect(api.signal).toHaveBeenCalledWith(7, 'dev', 'peer', 2, 'answer', expect.objectContaining({ sid: 'abc' })));
  });

  it('drops an answer that belongs to a replaced offer', async () => {
    const { voice, api, sse } = setup();
    voice.joined.set(true);
    signal(sse, 'peer', 'offer', { type: 'offer', sdp: 'o', sid: 'abc' });
    await vi.waitFor(() => expect(api.signal).toHaveBeenCalled());
    const pc = FakePc.all[0];
    pc.setRemoteDescription.mockClear();
    signal(sse, 'peer', 'answer', { type: 'answer', sdp: 'a', sid: 'stale' });
    await Promise.resolve();
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
  });

  it('keeps one peer per user when two members share a deviceId', async () => {
    const { voice, api, sse, members } = setup();
    members.set([2, 3].map((userId) => ({ userId, deviceId: 'same', status: 'ready', voice: { muted: true } })));
    voice.joined.set(true);
    signal(sse, 'same', 'offer', { type: 'offer', sdp: 'o', sid: 'a' }, 2);
    signal(sse, 'same', 'offer', { type: 'offer', sdp: 'o', sid: 'b' }, 3);
    await vi.waitFor(() => expect(api.signal).toHaveBeenCalledTimes(2));
    const peers = FakePc.all.filter((pc) => pc.setRemoteDescription.mock.calls.length);
    expect(peers).toHaveLength(2);
    expect(peers[0].close).not.toHaveBeenCalled();
    expect(api.signal).toHaveBeenCalledWith(7, 'dev', 'same', 3, 'answer', expect.anything());
  });
});
