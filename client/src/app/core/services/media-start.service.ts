import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { mediaDetailLink } from '../media-kinds';
import { asComicMedia, nextIssue } from '../../features/media-detail/comic/comic-media';
import { AudioPlayerService } from './audio-player/audio-player.service';
import { asBookMedia, type BookMedia } from './api/book-media';
import { BooksApiService } from './api/books-api.service';
import type { BookDetail, BookEdition } from './api/books.models';
import { Media, MediaService } from './api/media.service';
import { PlayableMediaService } from './playable-media.service';
import { PlaybackQueueService } from './playback-queue.service';

export const readRoute = (mediaId: number, itemId: number) => ['/read', mediaId, itemId];

const emptyBook = { editions: [], progress: null, series: [] } as unknown as Pick<BookDetail, 'editions' | 'progress' | 'series'>;

/** The text edition last read, else the first readable one. */
export function readEdition(book: BookDetail | null): BookEdition | null {
  const { editions, progress } = book ?? emptyBook;
  const readable = editions.filter(
    (e) => e.family === 'text' && e.itemId != null && e.fileIds.length && ['epub', 'pdf'].includes(e.format ?? ''),
  );
  return readable.find((x) => x.id === progress?.editionId) ?? readable[0] ?? null;
}

/** The audio edition last listened to, else the first one with a file. */
export function listenEdition(book: BookDetail | null): BookEdition | null {
  const { editions, progress } = book ?? emptyBook;
  const playable = editions.filter((e) => e.family === 'audio' && e.hasFile && e.itemId != null);
  return playable.find((e) => e.id === progress?.editionId) ?? playable[0] ?? null;
}

/** Whether starting the book opens something: a readable or listenable edition. */
export const bookStartable = (book: BookDetail | null): boolean => !!(readEdition(book) || listenEdition(book));

/** Starts any media by kind: the video player, the audio player, the reader, else the detail page. */
@Injectable({ providedIn: 'root' })
export class MediaStartService {
  private readonly router = inject(Router);
  private readonly mediaService = inject(MediaService);
  private readonly booksApi = inject(BooksApiService);
  private readonly playable = inject(PlayableMediaService);
  private readonly audio = inject(AudioPlayerService);
  private readonly queue = inject(PlaybackQueueService);

  /** `media` may be a list row: the book/comic details are fetched when missing. */
  async start(media: Media, opts: { backdropUrl?: string | null } = {}): Promise<void> {
    if (media.type === 'book') return this.startBook(media);
    if (media.type === 'comic') return this.startComic(media);
    const full = media.files?.length ? media : await this.mediaService.getOne(media.id);
    const file = full.files?.[0];
    if (!file) return void this.openDetail(full);
    await this.playable.play(
      {
        fileId: file.id,
        mediaId: full.id,
        episodeId: file.episodeId ?? undefined,
        media: full === media ? undefined : full,
        backdropUrl: opts.backdropUrl ?? full.fanartUrl ?? full.posterUrl ?? null,
        streamInfo: (file as any).streamInfo,
      },
      false,
    );
  }

  /** Plays the audio edition of a loaded book; the series volumes queue behind it (fetched unless given). */
  async listen(media: BookMedia, volumes?: { id: number; title: string }[]): Promise<void> {
    const book = media.book;
    const edition = listenEdition(book);
    if (!edition?.itemId) return;
    const series = book.series[0];
    const list = volumes ?? (series ? await this.booksApi.collection(series.id).then((c) => c.entries.map((e) => e.media), () => []) : []);
    const at = list.findIndex((v) => v.id === media.id);
    if (at >= 0 && series) {
      this.queue.start(
        list.map((v) => ({ mediaId: v.id, title: v.title })),
        at,
        { source: 'series', sourceId: series.id, autoplay: true },
      );
    } else {
      this.queue.clear();
    }
    void this.audio.play({
      mediaId: media.id,
      itemId: edition.itemId,
      title: media.title,
      artist: book.authors.map((a) => a.name).join(', '),
      coverUrl: edition.coverUrl ?? media.posterUrl,
    });
  }

  private async startBook(media: Media): Promise<void> {
    const full = asBookMedia(media) ?? asBookMedia(await this.mediaService.getOne(media.id));
    if (!full) return void this.openDetail(media);
    const { editions, progress } = full.book;
    const lead = (editions.find((e) => e.id === progress?.editionId) ?? editions.find((e) => e.hasFile) ?? editions[0])?.family;
    const read = readEdition(full.book);
    const audible = listenEdition(full.book);
    if (read && (lead !== 'audio' || !audible)) return void this.router.navigate(readRoute(full.id, read.itemId!));
    if (audible) return this.listen(full);
    this.openDetail(full);
  }

  private async startComic(media: Media): Promise<void> {
    const full = asComicMedia(media) ?? asComicMedia(await this.mediaService.getOne(media.id));
    const issue = full && nextIssue(full.comic.issues);
    if (!full || !issue) return void this.openDetail(media);
    void this.router.navigate(readRoute(full.id, issue.itemId));
  }

  private openDetail(media: Media): void {
    void this.router.navigate(mediaDetailLink(media.type, media.id));
  }
}
