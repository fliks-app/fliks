import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { describe, expect, it, vi } from 'vitest';
import { MediaService } from '../api/media.service';
import type { PartyItem } from '../api/party-api.service';
import { AudioPlayerService } from '../audio-player/audio-player.service';
import { ToastService } from '../toast.service';
import { AudioPartyHost } from './audio-party-host';

const album = {
  id: 4,
  type: 'album',
  title: 'Al',
  posterUrl: '/p.jpg',
  album: {
    targetEditionId: 1,
    editions: [{ id: 1, coverUrl: '/c.jpg', albumGain: -3, albumPeak: 0.9, hasFiles: true }],
    artists: [{ id: 1, name: 'Band', creditedName: null, joinPhrase: null }],
    tracks: [
      { itemId: 70, editionId: 1, hasFile: true, title: 'One', artists: [], durationSeconds: 100, gain: -1, peak: 0.5 },
      { itemId: 71, editionId: 1, hasFile: false, title: 'Gone', artists: [], durationSeconds: 10, gain: null, peak: null },
    ],
  },
};

function setup(media: unknown = album) {
  const audio = {
    track: signal<{ mediaId: number; itemId: number } | null>(null),
    musicMode: signal(true),
    playing: signal(false),
    buffering: signal(false),
    ended: signal(false),
    position: signal(0),
    partyReady: vi.fn(() => true),
    seekLocal: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn(),
    pause: vi.fn(),
    elementRate: vi.fn(() => 1),
    setElementRate: vi.fn(),
    duckLevel: vi.fn(() => 1),
    setDuck: vi.fn(),
    close: vi.fn(),
    setPartyRouter: vi.fn(() => () => undefined),
    openForParty: vi.fn().mockResolvedValue(undefined),
  };
  const toast = { error: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      { provide: AudioPlayerService, useValue: audio },
      { provide: MediaService, useValue: { getOne: vi.fn().mockResolvedValue(media) } },
      { provide: ToastService, useValue: toast },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
    ],
  });
  return { host: TestBed.inject(AudioPartyHost), audio, toast };
}

const item = (itemId: number) => ({ mediaId: 4, itemId, episodeId: null }) as PartyItem;

describe('AudioPartyHost output', () => {
  it('names the loaded track by album and item, and a placeholder when none plays', () => {
    const { host, audio } = setup();
    expect(host.output().item()).toEqual({ mediaId: -1, episodeId: undefined });
    audio.track.set({ mediaId: 4, itemId: 70 });
    expect(host.output().item()).toEqual({ mediaId: 4, episodeId: undefined, itemId: 70 });
  });

  it('maps play state, buffering and the natural end from the audio player', () => {
    const { host, audio } = setup();
    const out = host.output();
    expect(out.uiPaused()).toBe(true);
    audio.playing.set(true);
    audio.buffering.set(true);
    audio.ended.set(true);
    expect([out.uiPaused(), out.paused(), out.buffering(), out.ended(), out.seekLocked()]).toEqual([false, false, true, true, false]);
  });

  it('seeks, plays and pauses the element without going through the party', async () => {
    const { host, audio } = setup();
    const out = host.output();
    out.seek(12);
    out.play();
    await out.pause();
    expect(audio.seekLocal).toHaveBeenCalledWith(12);
    expect(audio.resume).toHaveBeenCalled();
    expect(audio.pause).toHaveBeenCalled();
  });

  it('corrects drift through the element rate and a half-second slack', () => {
    const { host, audio } = setup();
    const { sync } = host.output();
    expect(sync.slackS).toBe(0.5);
    sync.rate!.set(1.05);
    expect(audio.setElementRate).toHaveBeenCalledWith(1.05);
    expect(sync.rate!.get()).toBe(1);
  });

  it('ducks through the audio player level', () => {
    const { host, audio } = setup();
    host.engine().volume = 0.4;
    expect(audio.setDuck).toHaveBeenCalledWith(0.4);
    expect(host.engine().volume).toBe(1);
  });
});

describe('AudioPartyHost openItem', () => {
  it('builds the full request, gains included, and opens it', async () => {
    const { host, audio } = setup();
    expect(await host.openItem(item(70))).toBe(true);
    expect(audio.openForParty).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 70, mediaId: 4, title: 'One', albumTitle: 'Al', coverUrl: '/c.jpg', gain: -1, albumGain: -3, albumPeak: 0.9, artists: 'Band' }),
    );
  });

  it('opens a track once for concurrent callers', async () => {
    const { host, audio } = setup();
    await Promise.all([host.openItem(item(70)), host.openItem(item(70))]);
    expect(audio.openForParty).toHaveBeenCalledTimes(1);
  });

  it('says so and refuses a track without a file or an unknown one', async () => {
    const { host, audio, toast } = setup();
    expect(await host.openItem(item(71))).toBe(false);
    expect(await host.openItem(item(99))).toBe(false);
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(audio.openForParty).not.toHaveBeenCalled();
  });

  it('takes the track away with it when the party leaves', () => {
    const { host, audio } = setup();
    host.onBack();
    expect(audio.close).toHaveBeenCalled();
  });
});
