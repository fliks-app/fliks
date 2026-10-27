import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CastPlaybackTarget } from './cast-playback-target';
import { CastService } from './cast.service';
import { CastPlayerService } from './cast-player.service';
import { MediaService } from './api/media.service';
import { PartyService } from './party/party.service';
import { PlayerSettingsService } from './player-settings.service';

function setup(autoPlayNext = true, partyActive = false) {
  const cast = { ended: signal(false), isConnected: signal(true), isPaused: signal(true), buffering: signal(false), currentTime: signal(12), duration: signal(0), seek: vi.fn(), play: vi.fn(), pause: vi.fn() };
  const quickStart = vi.fn(async () => {});
  const cp = { mediaId: signal(1), episodeId: signal(10), hasMedia: signal(true), availableQualities: signal([]), quickStart };
  const media = {
    id: 1,
    type: 'series',
    title: 'T',
    seasons: [{ seasonNumber: 1, episodes: [{ id: 10, episodeNumber: 1 }, { id: 11, episodeNumber: 2 }] }],
    files: [{ id: 5, episodeId: 10 }, { id: 6, episodeId: 11 }],
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: CastService, useValue: cast },
      { provide: CastPlayerService, useValue: cp },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
      { provide: MediaService, useValue: { getOne: vi.fn(async () => media) } },
      { provide: PartyService, useValue: { active: signal(partyActive) } },
      { provide: PlayerSettingsService, useValue: { settings: () => ({ autoPlayNext }) } },
    ],
  });
  const target = TestBed.inject(CastPlaybackTarget);
  return { cast, target, quickStart };
}

describe('CastPlaybackTarget auto-next', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('plays the next item when the receiver reports the end', async () => {
    const { cast, target, quickStart } = setup();
    TestBed.tick();
    await vi.waitFor(() => expect(target.canPlayNext()).toBe(true));
    cast.ended.set(true);
    TestBed.tick();
    expect(quickStart).toHaveBeenCalledTimes(1);
  });

  it('stays put when auto-play is off, in a party, or on the last item', async () => {
    const off = setup(false);
    TestBed.tick();
    await vi.waitFor(() => expect(off.target.canPlayNext()).toBe(true));
    off.cast.ended.set(true);
    TestBed.tick();
    expect(off.quickStart).not.toHaveBeenCalled();
    TestBed.resetTestingModule();

    const party = setup(true, true);
    TestBed.tick();
    await vi.waitFor(() => expect(party.target.canPlayNext()).toBe(true));
    party.cast.ended.set(true);
    TestBed.tick();
    expect(party.quickStart).not.toHaveBeenCalled();
  });
});

describe('CastPlaybackTarget as a party output', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('is ready only once the receiver reports a duration', () => {
    const { cast, target } = setup();
    expect(target.ready()).toBe(false);
    cast.duration.set(3600);
    expect(target.ready()).toBe(true);
  });

  it('reads the receiver state and the cast item', () => {
    const { cast, target } = setup();
    cast.isPaused.set(false);
    cast.buffering.set(true);
    expect(target.paused()).toBe(false);
    expect(target.uiPaused()).toBe(false);
    expect(target.buffering()).toBe(true);
    expect(target.position()).toBe(12);
    expect(target.item()).toEqual({ mediaId: 1, episodeId: 10 });
    cast.ended.set(true);
    expect(target.ended()).toBe(true);
  });

  it('drives the receiver and nudges by seeking only', async () => {
    const { cast, target } = setup();
    target.seek(40);
    target.play();
    await target.pause();
    expect(cast.seek).toHaveBeenCalledWith(40);
    expect(cast.play).toHaveBeenCalled();
    expect(cast.pause).toHaveBeenCalled();
    expect(target.sync.rate).toBeUndefined();
  });
});
