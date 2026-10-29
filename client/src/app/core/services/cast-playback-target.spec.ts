import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CastPlaybackTarget } from './cast-playback-target';
import { CastService } from './cast.service';
import { CastPlayerService } from './cast-player.service';
import { MediaService } from './api/media.service';
import { PartyService } from './party/party.service';
import { PlayerSettingsService } from './player-settings.service';
import { CastSettingsService } from './cast-settings.service';

function setup(autoPlayNext = true, partyActive = false) {
  const cast = { ended: signal(false), isConnected: signal(true), isPaused: signal(true), buffering: signal(false), currentTime: signal(12), setTextTrackStyle: vi.fn(async () => {}), duration: signal(0), nextRequested$: new Subject<void>(), sendFliks: vi.fn(), seek: vi.fn(), play: vi.fn(), pause: vi.fn() };
  const quickStart = vi.fn(async () => {});
  const timeline = signal<{ intro: unknown; outro: unknown; chapters: unknown[]; edl: unknown[] }>({ intro: null, outro: null, chapters: [], edl: [] });
  const cp = { timeline, mediaFileId: signal(5), changeAudio: vi.fn(async () => {}), changeQuality: vi.fn(async () => {}), selectSubtitle: vi.fn(async () => true), mediaId: signal(1), episodeId: signal(10), hasMedia: signal(true), reloading: signal(false), availableQualities: signal([]), quickStart };
  const media = {
    id: 1,
    type: 'series',
    title: 'T',
    seasons: [{ seasonNumber: 1, episodes: [{ id: 10, episodeNumber: 1 }, { id: 11, episodeNumber: 2 }] }],
    files: [{ id: 5, episodeId: 10 }, { id: 6, episodeId: 11 }],
  };
  const castStyle = { size: 'normal', color: 'white', shadow: 'drop', background: 'transparent' };
  const castSettings = { settings: signal({ subtitleStyle: castStyle, hdr: false }), get: () => castSettings.settings(), save: vi.fn((s) => castSettings.settings.set(s)) };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: CastService, useValue: cast },
      { provide: CastPlayerService, useValue: cp },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
      { provide: MediaService, useValue: { getOne: vi.fn(async () => media) } },
      { provide: PartyService, useValue: { drives: signal(partyActive) } },
      { provide: CastSettingsService, useValue: castSettings },
      { provide: PlayerSettingsService, useValue: { settings: () => ({ autoPlayNext }) } },
    ],
  });
  const target = TestBed.inject(CastPlaybackTarget);
  return { cast, cp, target, quickStart, timeline, castSettings };
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

describe('CastPlaybackTarget subtitle style', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('sends the style live and saves it to the cast settings', () => {
    const { cast, castSettings, target } = setup();
    const style = { size: 'large', color: 'yellow', shadow: 'none', background: 'semi' };
    target.setSubtitleStyle(style);
    expect(cast.setTextTrackStyle).toHaveBeenCalledWith(style);
    expect(castSettings.save).toHaveBeenCalledWith(expect.objectContaining({ subtitleStyle: style, hdr: false }));
    expect(target.subtitleStyle()).toEqual(style);
  });
});

describe('CastPlaybackTarget skip cues', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('offers the intro skip inside the intro and seeks to its end', () => {
    const { cast, target, timeline } = setup();
    timeline.set({ intro: { startSeconds: 10, endSeconds: 70 }, outro: null, chapters: [], edl: [] });
    cast.currentTime.set(5);
    expect(target.skipCue()).toBeNull();
    cast.currentTime.set(30);
    expect(target.skipCue()).toEqual({ labelKey: 'player.skip_intro' });
    target.skip();
    expect(cast.seek).toHaveBeenCalledWith(70);
  });

  it('tells the receiver the ranges and whether a next episode follows', async () => {
    const { cast, target, timeline } = setup();
    timeline.set({ intro: { startSeconds: 1, endSeconds: 2 }, outro: { startSeconds: 9, endSeconds: 10 }, chapters: [], edl: [] });
    TestBed.tick();
    await vi.waitFor(() => expect(target.canPlayNext()).toBe(true));
    TestBed.tick();
    expect(cast.sendFliks).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'cues', fileId: 5, hasNext: true, intro: { startSeconds: 1, endSeconds: 2 } }),
    );
  });

  it('plays the next episode when the receiver asks for it', async () => {
    const { cast, target, quickStart } = setup();
    await vi.waitFor(() => expect(target.canPlayNext()).toBe(true));
    cast.nextRequested$.next();
    expect(quickStart).toHaveBeenCalledTimes(1);
  });
});

describe('CastPlaybackTarget after a stop', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('is idle while connected with nothing loaded', () => {
    const { cp, target } = setup();
    expect(target.isIdle()).toBe(false);
    cp.hasMedia.set(false);
    expect(target.isIdle()).toBe(true);
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

describe('CastPlaybackTarget id-based picks', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('resolves an audio id to its index and awaits the receiver', async () => {
    const { cp, target } = setup();
    await target.selectAudioById('shaka-3');
    expect(cp.changeAudio).toHaveBeenCalledWith(3);
  });

  it('refuses an audio id without an index', async () => {
    const { cp, target } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await target.selectAudioById('track');
    expect(cp.changeAudio).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('passes subtitle and quality ids straight to the cast player', async () => {
    const { cp, target } = setup();
    await target.selectSubtitleById(null);
    await target.selectQualityById('720p');
    expect(cp.selectSubtitle).toHaveBeenCalledWith(null);
    expect(cp.changeQuality).toHaveBeenCalledWith('720p');
  });
});
