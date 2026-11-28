import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KaraokeApiService } from '../api/karaoke-api.service';
import type { KaraokeItemState } from '../api/karaoke.models';
import type { LyricsCue, StructuredLyrics } from '../api/lyrics.models';
import { AudioPlayerService } from '../audio-player/audio-player.service';
import { RemoteAudioOutput } from '../audio-player/remote-audio-output';
import { AuthService } from '../auth.service';
import { PartyService } from '../party/party.service';
import { DeviceService } from '../device.service';
import { SseService } from '../sse.service';
import { KaraokeRelayService } from './karaoke-relay.service';
import { KaraokeService } from './karaoke.service';
import { MicCapture } from './mic-capture';

const cue = (start: number, end: number, pitch: number): LyricsCue => ({ start, end, value: 'x', byteStart: 0, byteEnd: 1, pitch });
const doc = {
  id: 1, kind: 'main', lang: 'en', synced: true, offset: 0, displayArtist: '', displayTitle: '', source: 's', reviewed: false, preferred: true, line: [],
  agents: [{ id: 'v1', role: 'main' }],
  cueLine: [{ index: 0, agentId: 'v1', start: 0, end: 1000, value: 'x', cue: [cue(0, 1000, 60)] }],
} as StructuredLyrics;
const take = (midi: number | null) => Array.from({ length: 50 }, (_, i) => ({ t: i * 20, midi }));
const stem = { size: 1, durationMs: 1, contentType: 'audio/ogg' };
const state = (s: Partial<KaraokeItemState> = {}): KaraokeItemState => ({ state: 'none', fileId: 9, stems: {}, lyrics: false, melody: false, cdg: false, ...s });
const ready = state({ state: 'ready', stems: { instrumental: stem, vocals: stem } });

function setup(isTv = true, opts: { status?: object; item?: KaraokeItemState } = {}) {
  const received = new Subject<{ userId: number; frames: { t: number; midi: number | null }[] }>();
  const events = new Subject<{ type: string }>();
  const track = signal<{ itemId: number } | null>({ itemId: 1 });
  const pitch = signal(0);
  const remoteView = signal(false);
  const can = signal(true);
  const remote = {
    expanded: remoteView, musicMode: signal(true), track: signal({ itemId: 1 }), position: signal(90), playing: signal(true), rate: signal(1), pitch: signal(5),
    supports: () => can(), setStemMode: vi.fn(), neighbour: () => null,
  };
  const local = {
    track, musicMode: signal(true), position: signal(0), playing: signal(false), rate: signal(1), pitch, stemsAvailable: signal(false),
    setStemMode: vi.fn(), refreshStems: vi.fn(), neighbour: vi.fn((): { itemId: number } | null => null),
  };
  const api = {
    status: vi.fn(async () => ({ enabled: true, ready: true, pitchShift: true, ...opts.status })),
    itemState: vi.fn(async () => opts.item ?? state()),
    prepare: vi.fn(async (_id: number, _b: object, _q?: boolean) => opts.item ?? state({ state: 'queued' })),
    remove: vi.fn(async () => undefined),
  };
  TestBed.configureTestingModule({
    providers: [
      KaraokeService,
      { provide: AudioPlayerService, useValue: local },
      { provide: RemoteAudioOutput, useValue: remote },
      { provide: KaraokeApiService, useValue: api },
      { provide: SseService, useValue: { karaokeEvents: events } },
      { provide: KaraokeRelayService, useValue: { received, open: vi.fn(), close: vi.fn(), send: vi.fn() } },
      { provide: DeviceService, useValue: { isTv: () => isTv } },
      { provide: PartyService, useValue: { party: signal(null), members: signal([{ userId: 5, username: 'Ana' }]) } },
      { provide: AuthService, useValue: { user: signal({ id: 1, username: 'me' }), hasPermission: () => true } },
      { provide: TranslateService, useValue: { instant: (k: string, p: { n: number }) => `${k}${p?.n ?? ''}` } },
    ],
  });
  return { karaoke: TestBed.inject(KaraokeService), received, track, pitch, remoteView, remote, local, api, events, can };
}

/** Lets the status and the item state land. */
async function settle(k: KaraokeService) {
  TestBed.tick();
  await vi.waitFor(() => expect(k.status()).not.toBeNull());
  TestBed.tick();
  await vi.waitFor(() => expect(k.itemState()).not.toBeNull());
}

describe('KaraokeService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('follows the displayed output for the media time and the key', () => {
    const { karaoke, received, remoteView } = setup();
    remoteView.set(true);
    TestBed.tick();
    expect(Math.round(karaoke.mediaMs() / 1000)).toBe(90);
    received.next({ userId: 5, frames: take(65) });
    remoteView.set(false);
    expect(karaoke.results(doc)[0].score).toBe(10000);
  });

  describe('media clock', () => {
    function clock() {
      const t = { now: 1000 };
      vi.spyOn(performance, 'now').mockImplementation(() => t.now);
      const s = setup();
      s.remoteView.set(true);
      TestBed.tick();
      const report = (wall: number, seconds: number) => {
        t.now = wall;
        s.remote.position.set(seconds);
        TestBed.tick();
      };
      return { ...s, t, report };
    }

    it('keeps free-running through 200 ms position steps at irregular wall times', () => {
      const { karaoke, t, report } = clock();
      report(1000, 90);
      let last = karaoke.mediaMs();
      [[1178, 90.2], [1380, 90.4], [1560, 90.6], [1774, 90.8]].forEach(([wall, pos]) => {
        report(wall, pos);
        t.now = wall;
        const now = karaoke.mediaMs();
        expect(now).toBeGreaterThanOrEqual(last);
        expect(now - last).toBeLessThan(250);
        last = now;
      });
      // Slewed toward the reported 90.8 s, never snapped to it.
      expect(karaoke.mediaMs()).toBeGreaterThan(90774);
      expect(karaoke.mediaMs()).toBeLessThan(90790);
    });

    it('re-anchors on a seek', () => {
      const { karaoke, t, report } = clock();
      report(1000, 90);
      report(1500, 30);
      t.now = 1600;
      expect(karaoke.mediaMs()).toBeCloseTo(30100, 0);
    });

    it('re-anchors on pause and resume', () => {
      const { karaoke, remote, t, report } = clock();
      report(1000, 90);
      remote.playing.set(false);
      report(1100, 90.1);
      t.now = 2000;
      expect(karaoke.mediaMs()).toBeCloseTo(90100, 0);
    });
  });

  it('scores a frame against the key it was sung in, not the key now', () => {
    const { karaoke, received, pitch } = setup();
    pitch.set(2);
    received.next({ userId: 5, frames: take(62) });
    pitch.set(0);
    expect(karaoke.results(doc)[0].score).toBe(10000);
  });

  it('scores the frames a peer sends over the channel, under that member', () => {
    const { karaoke, received } = setup();
    received.next({ userId: 5, frames: take(60) });
    const [row] = karaoke.results(doc);
    expect([row.userId, row.name, row.score]).toEqual([5, 'Ana', 10000]);
  });

  it('ignores an empty batch', () => {
    const { karaoke, received } = setup();
    received.next({ userId: 5, frames: [] });
    expect(karaoke.results(doc)).toEqual([]);
  });

  it('shows a scoreboard once per track, best first, and keeps the take when it is dismissed', () => {
    const { karaoke, received } = setup();
    received.next({ userId: 5, frames: take(60) });
    received.next({ userId: 6, frames: take(null) });
    karaoke.finish(doc, 'Song');
    karaoke.finish(doc, 'Other');
    expect(karaoke.board()?.title).toBe('Song');
    expect(karaoke.board()?.rows.map((r) => r.userId)).toEqual([5, 6]);
    karaoke.dismissBoard();
    karaoke.finish(doc, 'Song');
    expect(karaoke.board()).toBeNull();
    expect(karaoke.results(doc)).toHaveLength(2);
  });

  it('removes this device latency from its frames as they are captured, and calibrates on top of it', async () => {
    vi.stubGlobal('AudioWorkletNode', class {});
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => undefined } });
    let frame!: (f: { t: number; midi: number | null }) => void;
    vi.spyOn(MicCapture.prototype, 'start').mockImplementation(async (cb) => void (frame = cb));
    vi.spyOn(MicCapture.prototype, 'stop').mockImplementation(() => undefined);
    const { karaoke } = setup(false);
    karaoke.setLatency(100);
    await karaoke.startSinging();
    frame({ t: 1000, midi: 60 });
    expect(karaoke.store.frames(1).map((f) => f.t)).toEqual([900]);
    karaoke.nudgeLatency(-2);
    expect(karaoke.latencyMs()).toBe(80);
    karaoke.stopSinging();
    vi.unstubAllGlobals();
  });

  describe('track state', () => {
    it('prepares an unprepared track from the Sing button', async () => {
      const { karaoke, api } = setup();
      await settle(karaoke);
      expect(karaoke.singKind()).toBe('prepare');
      karaoke.sing();
      expect(api.prepare).toHaveBeenCalledWith(1, {});
    });

    it('enters with a quiet preparation that marks the stems sung, and leaves back to the original mix', async () => {
      const { karaoke, api, local } = setup(true, { item: ready });
      await settle(karaoke);
      expect(karaoke.singKind()).toBe('enter');
      karaoke.sing();
      TestBed.tick();
      expect(api.prepare).toHaveBeenCalledWith(1, {}, true);
      expect(karaoke.singKind()).toBe('exit');
      karaoke.sing();
      TestBed.tick();
      expect(karaoke.stage()).toBe(false);
      expect(local.setStemMode).toHaveBeenCalledWith('original');
    });

    it('enters as soon as both stems exist while the lyrics steps still run', async () => {
      const { karaoke } = setup(true, { item: state({ state: 'running', stage: 'align', progress: 10, stems: ready.stems }) });
      await settle(karaoke);
      expect(karaoke.singKind()).toBe('enter');
    });

    it('ends the stage and its stem mode when the music closes', async () => {
      const { karaoke, local, track } = setup(true, { item: ready });
      await settle(karaoke);
      karaoke.enter();
      TestBed.tick();
      track.set(null);
      TestBed.tick();
      TestBed.tick();
      expect(karaoke.stage()).toBe(false);
      expect(local.setStemMode).toHaveBeenCalledWith('original');
    });

    it('drives the displayed device in remote view, and hides Sing where it cannot apply stems', async () => {
      const { karaoke, remote, local, remoteView, can } = setup(true, { item: ready });
      remoteView.set(true);
      await settle(karaoke);
      karaoke.sing();
      TestBed.tick();
      karaoke.sing();
      TestBed.tick();
      expect(remote.setStemMode).toHaveBeenCalledWith('original');
      expect(local.setStemMode).not.toHaveBeenCalled();
      can.set(false);
      expect(karaoke.singKind()).toBeNull();
    });

    it('draws the MP3+G graphics without a separation model', async () => {
      const { karaoke } = setup(true, { status: { ready: false }, item: state({ cdg: true }) });
      await settle(karaoke);
      expect(karaoke.cdgFile()).toBe(9);
      expect(karaoke.singKind()).toBeNull();
      expect(karaoke.needsModel()).toBe(true);
    });

    it('follows the job: progress in place, a new stage reloads, stems flash ready and the local player looks them up', async () => {
      const { karaoke, api, events, local } = setup(true, { item: state({ state: 'running', stage: 'separate', progress: 0 }) });
      await settle(karaoke);
      api.itemState.mockClear();
      events.next({ type: 'karaoke.job_changed', itemId: 1, state: 'running', stage: 'separate', progress: 40 } as never);
      events.next({ type: 'karaoke.job_changed', itemId: 1, state: 'running', stage: 'separate', progress: 60 } as never);
      expect(karaoke.itemState()?.progress).toBe(60);
      expect(api.itemState).toHaveBeenCalledTimes(1);
      api.itemState.mockResolvedValue(state({ state: 'running', stage: 'align', stems: ready.stems }));
      events.next({ type: 'karaoke.job_changed', itemId: 1, state: 'running', stage: 'align', progress: 0 } as never);
      await vi.waitFor(() => expect(karaoke.readyFlash()).toBe(true));
      expect(local.refreshStems).toHaveBeenCalled();
    });
  });

  it('calibrates from the local take, and refuses one with too few notes', () => {
    const { karaoke } = setup();
    expect(karaoke.calibrate(doc)).toBe(false);
  });

  it('releases a mic whose start was still pending when singing stopped', async () => {
    vi.stubGlobal('AudioWorkletNode', class {});
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => undefined } });
    let open!: () => void;
    const started = vi.spyOn(MicCapture.prototype, 'start').mockImplementation(() => new Promise<void>((r) => (open = r)));
    const stopped = vi.spyOn(MicCapture.prototype, 'stop').mockImplementation(() => undefined);
    const { karaoke } = setup(false);
    const first = karaoke.startSinging();
    void karaoke.startSinging();
    expect(started).toHaveBeenCalledTimes(1);
    expect(karaoke.starting()).toBe(true);
    karaoke.stopSinging();
    stopped.mockClear();
    open();
    await first;
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(karaoke.singing()).toBe(false);
    expect(karaoke.starting()).toBe(false);
    vi.unstubAllGlobals();
  });
});
