import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { AudioPlayerService } from './audio-player/audio-player.service';
import { BooksApiService } from './api/books-api.service';
import { MediaService } from './api/media.service';
import { MediaStartService } from './media-start.service';
import { PlayableMediaService } from './playable-media.service';
import { PlaybackQueueService } from './playback-queue.service';

const edition = (o: Record<string, unknown>) => ({
  id: 1, itemId: 10, family: 'text', format: 'epub', hasFile: true, fileIds: [1], coverUrl: null, narrators: [], ...o,
});
const book = (editions: unknown[], progress: unknown = null, series: unknown[] = []) => ({
  id: 7, type: 'book', title: 'T', posterUrl: null, book: { editions, progress, series, authors: [{ name: 'A' }] },
});
const issue = (o: Record<string, unknown>) => ({ itemId: 1, mediaFileId: 1, kind: 'issue', finished: false, progression: null, ...o });

function setup(full?: unknown) {
  const router = { navigate: vi.fn().mockResolvedValue(true) };
  const playable = { play: vi.fn().mockResolvedValue(undefined) };
  const audio = { play: vi.fn().mockResolvedValue(undefined) };
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
      { provide: BooksApiService, useValue: books },
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

  it('opens the detail page of a video with no file', async () => {
    const h = setup({ id: 3, type: 'movie', files: [] });
    await h.svc.start({ id: 3, type: 'movie' } as any);
    expect(h.router.navigate).toHaveBeenCalledWith(['/movies', '3']);
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
});
