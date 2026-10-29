import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Media, MediaService } from '../api/media.service';
import { describeNowPlaying, mediaSessionText, NO_NOW_PLAYING, NowPlayingMetadataService } from './now-playing-metadata.service';

const series = {
  id: 3,
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

function setup(media: Media = series) {
  const getOne = vi.fn(async (_id: number) => media);
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: MediaService, useValue: { getOne } }],
  });
  return { svc: TestBed.inject(NowPlayingMetadataService), getOne };
}

describe('describeNowPlaying', () => {
  it('gives the title, the player-style episode label, the logo and the still over the fanart', () => {
    expect(describeNowPlaying(series, 10)).toEqual({
      title: 'Show',
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

describe('mediaSessionText', () => {
  it('puts the episode label first and the title under it', () => {
    expect(mediaSessionText(describeNowPlaying(series, 10))).toEqual({ title: 'S1:E2 - Pilot', artist: 'Show' });
    expect(mediaSessionText(describeNowPlaying(movie))).toEqual({ title: 'Film' });
  });
});

describe('NowPlayingMetadataService', () => {
  afterEach(() => TestBed.resetTestingModule());

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
