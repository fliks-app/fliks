import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { AudioPlayerService } from './audio-player/audio-player.service';
import { BooksApiService } from './api/books-api.service';
import { MediaService } from './api/media.service';
import { StreamingApiService } from './api/streaming-api.service';
import { MediaStartService } from './media-start.service';
import { MusicDownloadsService } from './music-downloads.service';
import { PlayableMediaService } from './playable-media.service';
import { PlaybackQueueService } from './playback-queue.service';

const edition = (o: Record<string, unknown>) => ({
  id: 1, itemId: 10, family: 'text', format: 'epub', hasFile: true, fileIds: [1], coverUrl: null, narrators: [], ...o,
});
const book = (editions: unknown[], progress: unknown = null, series: unknown[] = []) => ({
  id: 7, type: 'book', title: 'T', posterUrl: null, book: { editions, progress, series, authors: [{ name: 'A' }] },
});
const issue = (o: Record<string, unknown>) => ({ itemId: 1, mediaFileId: 1, kind: 'issue', finished: false, progression: null, ...o });

function setup(full?: unknown, tracks: unknown[] = [], resume: unknown = null, watched: number[] = []) {
  const router = { navigate: vi.fn().mockResolvedValue(true) };
  const playable = { play: vi.fn().mockResolvedValue(undefined), resume: vi.fn().mockResolvedValue(undefined), playFromPlaylist: vi.fn().mockResolvedValue(true) };
  const audio = { play: vi.fn().mockResolvedValue(undefined), playTracks: vi.fn().mockResolvedValue(undefined) };
  const music = { albumTracks: vi.fn().mockResolvedValue(tracks) };
  const queue = { start: vi.fn(), clear: vi.fn() };
  const media = { getOne: vi.fn().mockResolvedValue(full) };
  const books = { collection: vi.fn().mockResolvedValue({ entries: [{ media: { id: 6, title: 'a' } }, { media: { id: 7, title: 'b' } }] }) };
  TestBed.configureTestingModule({
    providers: [
      { provide: Router, useValue: router },
      { provide: PlayableMediaService, useValue: playable },
      { provide: AudioPlayerService, useValue: audio },
      { provide: PlaybackQueueService, useValue: queue },
      { provide: MediaService, useValue: media },
      { provide: StreamingApiService, useValue: { getMediaResumeInfo: vi.fn().mockResolvedValue(resume), getWatchedEpisodeIds: vi.fn().mockResolvedValue(watched) } },
      { provide: BooksApiService, useValue: books },
      { provide: MusicDownloadsService, useValue: music },
    ],
  });
  return { svc: TestBed.inject(MediaStartService), router, playable, audio, queue, media };
}

describe('MediaStartService', () => {
  it('plays a video kind through the video player', async () => {
    const h = setup();
    await h.svc.start({ id: 3, type: 'movie', files: [{ id: 9 }] } as any);
    expect(h.playable.play).toHaveBeenCalledWith(expect.objectContaining({ fileId: 9, mediaId: 3 }), false);
  });

  it('starts a series at the episode to resume, else the next unwatched one', async () => {
    const series = { id: 7, type: 'series', files: [{ id: 100, episodeId: 10 }, { id: 110, episodeId: 11 }], seasons: [{ id: 1, seasonNumber: 1, episodes: [{ id: 10, episodeNumber: 1, hasFile: true }, { id: 11, episodeNumber: 2, hasFile: true }] }] };
    const next = setup(series, [], null, [10]);
    await next.svc.start({ id: 7, type: 'series' } as any);
    expect(next.playable.play).toHaveBeenCalledWith(expect.objectContaining({ fileId: 110, episodeId: 11, mediaId: 7 }), false);
    TestBed.resetTestingModule();
    const resume = setup(series, [], { episodeId: 10, mediaFileId: 100 }, [10]);
    await resume.svc.start({ id: 7, type: 'series' } as any);
    expect(resume.playable.play).toHaveBeenCalledWith(expect.objectContaining({ fileId: 100, episodeId: 10 }), false);
  });

  it('opens the detail page of a series with nothing on disk', async () => {
    const h = setup({ id: 7, type: 'series', files: [], seasons: [] });
    await h.svc.start({ id: 7, type: 'series' } as any);
    expect(h.router.navigate).toHaveBeenCalledWith(['/series', '7']);
    expect(h.playable.play).not.toHaveBeenCalled();
  });

  it('opens the detail page of a video with no file', async () => {
    const h = setup({ id: 3, type: 'movie', files: [] });
    await h.svc.start({ id: 3, type: 'movie' } as any);
    expect(h.router.navigate).toHaveBeenCalledWith(['/movies', '3']);
  });

  it('plays an album from its first track', async () => {
    const h = setup(undefined, [{ itemId: 1 }, { itemId: 2 }]);
    await h.svc.start({ id: 4, type: 'album' } as any);
    expect(h.audio.playTracks).toHaveBeenCalledWith([{ itemId: 1 }, { itemId: 2 }]);
    expect(h.router.navigate).not.toHaveBeenCalled();
  });

  it('opens the reader on the readable edition of a book, fetching the full media', async () => {
    const h = setup(book([edition({ id: 1, itemId: 10, format: 'mobi' }), edition({ id: 2, itemId: 11 })]));
    await h.svc.start({ id: 7, type: 'book' } as any);
    expect(h.router.navigate).toHaveBeenCalledWith(['/read', 7, 11]);
    expect(h.playable.play).not.toHaveBeenCalled();
  });

  it('follows the progress: the audio edition last listened to plays with the series queue', async () => {
    const full = book(
      [edition({ id: 1, itemId: 10 }), edition({ id: 2, itemId: 11, family: 'audio', format: 'mp3' })],
      { editionId: 2, itemId: 11, progression: 0.3 },
      [{ id: 4 }],
    );
    const h = setup(full);
    await h.svc.start(full as any);
    expect(h.queue.start).toHaveBeenCalledWith(
      [{ mediaId: 6, title: 'a' }, { mediaId: 7, title: 'b' }],
      1,
      { source: 'series', sourceId: 4, autoplay: true },
    );
    expect(h.audio.play).toHaveBeenCalledWith(expect.objectContaining({ mediaId: 7, itemId: 11 }));
    expect(h.router.navigate).not.toHaveBeenCalled();
  });

  it('opens the detail page of a book with nothing readable or audible', async () => {
    const full = book([edition({ format: 'mobi' })]);
    const h = setup(full);
    await h.svc.start(full as any);
    expect(h.router.navigate).toHaveBeenCalledWith(['/books', '7']);
  });

  it('opens the next unfinished issue of a comic', async () => {
    const full = { id: 8, type: 'comic', comic: { issues: [issue({ itemId: 1, finished: true }), issue({ itemId: 2 })] } };
    const h = setup(full);
    await h.svc.start({ id: 8, type: 'comic' } as any);
    expect(h.router.navigate).toHaveBeenCalledWith(['/read', 8, 2]);
  });

  it('opens the detail page of a comic with no issue file', async () => {
    const full = { id: 8, type: 'comic', comic: { issues: [issue({ mediaFileId: null })] } };
    const h = setup(full);
    await h.svc.start(full as any);
    expect(h.router.navigate).toHaveBeenCalledWith(['/comics', '8']);
  });

  it('reads when text leads, even with an audio edition available', async () => {
    const full = book([edition({ id: 1, itemId: 10 }), edition({ id: 2, itemId: 11, family: 'audio', format: 'mp3' })]);
    const h = setup(full);
    await h.svc.start(full as any);
    expect(h.router.navigate).toHaveBeenCalledWith(['/read', 7, 10]);
    expect(h.audio.play).not.toHaveBeenCalled();
  });

  it('resumes a video row in the player and a book row through start', async () => {
    const full = book([edition({})]);
    const h = setup(full);
    await h.svc.resume({ mediaType: 'movie', mediaId: 3 } as any);
    expect(h.playable.resume).toHaveBeenCalled();
    await h.svc.resume({ mediaType: 'book', mediaId: 7 } as any);
    expect(h.router.navigate).toHaveBeenCalledWith(['/read', 7, 10]);
  });

  it('ignores a start while another runs', async () => {
    const full = book([edition({})]);
    const h = setup(full);
    await Promise.all([h.svc.start({ id: 7, type: 'book' } as any), h.svc.start({ id: 7, type: 'book' } as any)]);
    expect(h.media.getOne).toHaveBeenCalledTimes(1);
  });

  it('does not navigate when the route changed during the fetch', async () => {
    const h = setup(book([edition({})]));
    let url = '/a';
    Object.defineProperty(h.router, 'url', { get: () => url });
    h.media.getOne.mockImplementation(async () => {
      url = '/b';
      return book([edition({})]);
    });
    await h.svc.start({ id: 7, type: 'book' } as any);
    expect(h.router.navigate).not.toHaveBeenCalled();
  });

  it('starts a book playlist item in its own player and keeps books out of the video queue', async () => {
    const h = setup(book([edition({})]));
    const row = (id: number, type: string) => ({ media: { id, type } as any, queue: { mediaId: id, title: 't' } });
    await h.svc.startFromPlaylist(1, [row(7, 'book'), row(3, 'movie')], 0, true);
    expect(h.router.navigate).toHaveBeenCalledWith(['/read', 7, 10]);
    expect(h.playable.playFromPlaylist).not.toHaveBeenCalled();
    await h.svc.startFromPlaylist(1, [row(7, 'book'), row(3, 'movie'), row(4, 'movie')], 2, true);
    expect(h.playable.playFromPlaylist).toHaveBeenCalledWith(1, [{ mediaId: 3, title: 't' }, { mediaId: 4, title: 't' }], 1, true);
  });
});
