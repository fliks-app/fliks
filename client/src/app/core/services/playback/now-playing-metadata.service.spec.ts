import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Media, MediaService } from '../api/media.service';
import { MusicApiService } from '../api/music-api.service';
import type { MusicTrackRequest } from '../audio-player/music-queue';
import { describeNowPlaying, mediaSessionText, NO_NOW_PLAYING, NowPlayingMetadataService } from './now-playing-metadata.service';

const series = {
  id: 3,
  type: 'series',
  title: 'Show',
  logoUrl: '/logo.png',
  posterUrl: '/poster.jpg',
  fanartUrl: '/fanart.jpg',
  seasons: [
    {
      seasonNumber: 1,
      episodes: [
        { id: 10, episodeNumber: 2, title: 'Pilot', stillUrl: '/still.jpg' },
        { id: 11, episodeNumber: 3, title: null, stillUrl: null },
      ],
    },
  ],
} as unknown as Media;

const movie = { id: 4, title: 'Film', logoUrl: null, posterUrl: '/p.jpg', fanartUrl: null } as unknown as Media;

const album = { id: 5, type: 'album', title: 'Album A', logoUrl: null, posterUrl: '/cover.jpg', fanartUrl: null } as unknown as Media;
const track = { itemId: 7, mediaId: 5, title: 'Track A', artists: 'Artist A' } as MusicTrackRequest;

function setup(media: Media = series, trackRequests = vi.fn(async (_ids: readonly number[]) => [track])) {
  const getOne = vi.fn(async (_id: number) => media);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: MediaService, useValue: { getOne } },
      { provide: MusicApiService, useValue: { trackRequests } },
    ],
  });
  return { svc: TestBed.inject(NowPlayingMetadataService), getOne, trackRequests };
}

describe('describeNowPlaying', () => {
  it('gives the title, the player-style episode label, the logo and the still over the fanart', () => {
    expect(describeNowPlaying(series, 10)).toEqual({
      title: 'Show',
      artist: '',
      album: '',
      kind: 'series',
      episodeLabel: 'S1:E2 - Pilot',
      logoUrl: '/logo.png',
      posterUrl: '/poster.jpg',
      fanartUrl: '/fanart.jpg',
      stillUrl: '/still.jpg',
      backdropUrl: '/still.jpg',
    });
  });

  it('falls back to the fanart without a still, and has no label without a title', () => {
    const m = describeNowPlaying(series, 11);
    expect([m.episodeLabel, m.backdropUrl]).toEqual(['S1:E3', '/fanart.jpg']);
  });

  it('has no label for a movie and nulls the artwork it lacks', () => {
    expect(describeNowPlaying(movie)).toMatchObject({ episodeLabel: '', logoUrl: null, backdropUrl: null, posterUrl: '/p.jpg' });
  });
});

describe('describeNowPlaying for a track', () => {
  it('names the track and its artists, and keeps the album as album and artwork', () => {
    expect(describeNowPlaying(album, undefined, track)).toMatchObject({
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      posterUrl: '/cover.jpg',
    });
  });
});

describe('mediaSessionText', () => {
  it('puts the episode label first and the title under it', () => {
    expect(mediaSessionText(describeNowPlaying(series, 10))).toEqual({ title: 'S1:E2 - Pilot', artist: 'Show' });
    expect(mediaSessionText(describeNowPlaying(movie))).toEqual({ title: 'Film' });
  });

  it('puts a track first and its artists under it', () => {
    expect(mediaSessionText(describeNowPlaying(album, undefined, track))).toEqual({ title: 'Track A', artist: 'Artist A' });
  });
});

describe('NowPlayingMetadataService', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('resolves a track of an album once per item and misses in peek until it is cached', async () => {
    const { svc, trackRequests } = setup(album);
    svc.prime(album);
    expect(svc.peek({ mediaId: 5, itemId: 7 })).toBeNull();
    const [a] = await Promise.all([svc.load({ mediaId: 5, itemId: 7 }), svc.load({ mediaId: 5, itemId: 7 })]);
    await svc.load({ mediaId: 5, itemId: 7 });
    expect(trackRequests).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ title: 'Track A', artist: 'Artist A', album: 'Album A' });
    expect(svc.peek({ mediaId: 5, itemId: 7 })?.title).toBe('Track A');
  });

  it('falls back to the album metadata when the track cannot be read', async () => {
    const { svc } = setup(album, vi.fn(async () => { throw new Error('boom'); }));
    expect(await svc.load({ mediaId: 5, itemId: 7 })).toMatchObject({ title: 'Album A', artist: '', album: '' });
  });

  it('caches a failed lookup: one fetch across loads, and peek then describes the album', async () => {
    const { svc, trackRequests } = setup(album, vi.fn(async () => { throw new Error('boom'); }));
    await svc.load({ mediaId: 5, itemId: 7 });
    await svc.load({ mediaId: 5, itemId: 7 });
    expect(svc.peek({ mediaId: 5, itemId: 7 })).toMatchObject({ title: 'Album A', kind: 'album' });
    expect(trackRequests).toHaveBeenCalledTimes(1);
  });

  it('keeps a track a caller primed, with no fetch', async () => {
    const { svc, trackRequests } = setup(album);
    svc.prime(album);
    svc.primeTracks([track]);
    expect(svc.peek({ mediaId: 5, itemId: 7 })?.title).toBe('Track A');
    expect((await svc.load({ mediaId: 5, itemId: 7 })).title).toBe('Track A');
    expect(trackRequests).not.toHaveBeenCalled();
  });

  it('keeps the previous value on a track change inside one album, and drops a stale result', async () => {
    const other = { ...track, itemId: 8, title: 'Track B' };
    let release!: (rows: MusicTrackRequest[]) => void;
    const trackRequests = vi.fn(async (ids: readonly number[]) =>
      ids[0] === 7 ? [track] : new Promise<MusicTrackRequest[]>((r) => (release = r)),
    );
    const { svc } = setup(album, trackRequests);
    const id = signal<{ mediaId: number; itemId: number }>({ mediaId: 5, itemId: 7 });
    const meta = TestBed.runInInjectionContext(() => svc.track(id));
    TestBed.tick();
    await vi.waitFor(() => expect(meta()?.title).toBe('Track A'));
    id.set({ mediaId: 5, itemId: 8 });
    TestBed.tick();
    expect(meta()?.title).toBe('Track A');
    id.set({ mediaId: 5, itemId: 7 });
    TestBed.tick();
    await vi.waitFor(() => expect(meta()?.title).toBe('Track A'));
    release([other]);
    await new Promise((r) => setTimeout(r));
    expect(meta()?.title).toBe('Track A');
  });

  it('does not look a track up for a media that is not an album', async () => {
    const { svc, trackRequests } = setup(series);
    await svc.load({ mediaId: 3, itemId: 7 });
    expect(trackRequests).not.toHaveBeenCalled();
  });

  it('fetches a media once for every item and caller that asks', async () => {
    const { svc, getOne } = setup();
    const [a, b] = await Promise.all([svc.load({ mediaId: 3, episodeId: 10 }), svc.load({ mediaId: 3, episodeId: 11 })]);
    await svc.load({ mediaId: 3 });
    expect(getOne).toHaveBeenCalledTimes(1);
    expect([a.episodeLabel, b.episodeLabel]).toEqual(['S1:E2 - Pilot', 'S1:E3']);
  });

  it('does not fetch a media the caller already loaded', async () => {
    const { svc, getOne } = setup();
    const m = await svc.load({ mediaId: 3, episodeId: 10 }, series);
    expect(m.logoUrl).toBe('/logo.png');
    expect(getOne).not.toHaveBeenCalled();
  });

  it('reads the media again when the cached one lacks the episode', async () => {
    const { svc, getOne } = setup();
    svc.prime({ ...series, seasons: [] });
    const m = await svc.load({ mediaId: 3, episodeId: 10 });
    expect(getOne).toHaveBeenCalledTimes(1);
    expect(m.episodeLabel).toBe('S1:E2 - Pilot');
  });

  it('describes a download from its own label, without the network', () => {
    const { svc, getOne } = setup();
    const m = svc.describeDownload({ episodeLabel: 'S01E02 Pilot', media: { title: 'Show', logoUrl: '/l.png' } } as never);
    expect(m).toMatchObject({ title: 'Show', episodeLabel: 'S1:E2 - Pilot', logoUrl: '/l.png' });
    expect(getOne).not.toHaveBeenCalled();
  });

  it('tracks an identity: nothing until loaded, then the metadata, then nothing once it clears', async () => {
    const { svc } = setup();
    const id = signal<{ mediaId: number; episodeId?: number } | null>(null);
    const meta = TestBed.runInInjectionContext(() => svc.track(id));
    TestBed.tick();
    expect(meta()).toBeNull();
    id.set({ mediaId: 3, episodeId: 10 });
    TestBed.tick();
    await vi.waitFor(() => expect(meta()?.episodeLabel).toBe('S1:E2 - Pilot'));
    id.set(null);
    TestBed.tick();
    expect(meta()).toBeNull();
    expect(NO_NOW_PLAYING.title).toBe('');
  });
});
