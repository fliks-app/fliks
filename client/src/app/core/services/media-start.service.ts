import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { mediaDetailLink } from '../media-kinds';
import { asComicMedia, nextIssue } from '../../features/media-detail/comic/comic-media';
import { AudioPlayerService } from './audio-player/audio-player.service';
import { asBookMedia, readable, type BookMedia } from './api/book-media';
import { BooksApiService } from './api/books-api.service';
import type { BookDetail, BookEdition, BookFormatFamily } from './api/books.models';
import { Media, MediaService } from './api/media.service';
import { StreamingApiService } from './api/streaming-api.service';
import { kindOf } from '../media-kinds';
import { nextUp, type NextUp } from '../../shared/utils/media-play.util';
import { MusicDownloadsService } from './music-downloads.service';
import type { ContinueWatchingItem } from './api/streaming-api.service';
import type { QueueItem } from './playback-queue.service';
import { PlayableMediaService } from './playable-media.service';
import { PlaybackQueueService } from './playback-queue.service';

export const readRoute = (mediaId: number, itemId: number) => ['/read', mediaId, itemId];

const emptyBook = { editions: [], progress: null, series: [] } as unknown as Pick<BookDetail, 'editions' | 'progress' | 'series'>;

/** The text edition last read, else the first readable one. */
export function readEdition(book: BookDetail | null): BookEdition | null {
  const { editions, progress } = book ?? emptyBook;
  const open = editions.filter(readable);
  return open.find((x) => x.id === progress?.editionId) ?? open[0] ?? null;
}

/** The audio edition last listened to, else the first one with a file. */
function listenEdition(book: BookDetail | null): BookEdition | null {
  const { editions, progress } = book ?? emptyBook;
  const playable = editions.filter((e) => e.family === 'audio' && e.hasFile && e.itemId != null);
  return playable.find((e) => e.id === progress?.editionId) ?? playable[0] ?? null;
}

/** The family last read or listened to, else the first edition that has a file. */
export function leadFamily(book: BookDetail | null): BookFormatFamily | undefined {
  const { editions, progress } = book ?? emptyBook;
  return (editions.find((e) => e.id === progress?.editionId) ?? editions.find((e) => e.hasFile) ?? editions[0])?.family;
}

const isVideo = (m: Media) => m.type !== 'book' && m.type !== 'comic' && m.type !== 'album';

/** Starts any media by kind: the video player, the audio player, the reader, else the detail page. */
/** A list row is enough: the book/comic details and the video files are fetched when missing. */
export type StartTarget = Pick<Media, 'id' | 'type'> & { files?: Media['files'] };

@Injectable({ providedIn: 'root' })
export class MediaStartService {
  private readonly router = inject(Router);
  private readonly mediaService = inject(MediaService);
  private readonly booksApi = inject(BooksApiService);
  private readonly playable = inject(PlayableMediaService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly audio = inject(AudioPlayerService);
  private readonly queue = inject(PlaybackQueueService);
  private readonly musicTracks = inject(MusicDownloadsService);

  private starting = false;

  /** Resumes a continue-watching row: the video player, or the book/comic from its own saved state. */
  resume(item: ContinueWatchingItem): Promise<void> {
    return item.mediaType === 'book' || item.mediaType === 'comic'
      ? this.start({ id: item.mediaId, type: item.mediaType })
      : this.playable.resume(item);
  }

  /** Starts a playlist at `startIndex`: a book/comic start opens its reader or audio player; the video queue skips them. */
  async startFromPlaylist(playlistId: number, items: { media: Media; queue: QueueItem }[], startIndex: number, autoplay: boolean): Promise<boolean> {
    const at = items[startIndex];
    if (!at) return false;
    if (!isVideo(at.media)) {
      await this.start(at.media);
      return true;
    }
    const video = items.filter((i) => isVideo(i.media));
    return this.playable.playFromPlaylist(playlistId, video.map((i) => i.queue), video.indexOf(at), autoplay);
  }

  /** `media` may be a list row: the book/comic details are fetched when missing. A start in flight ignores another. */
  async start(media: StartTarget, opts: { backdropUrl?: string | null } = {}): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    try {
      await this.startNow(media, opts);
    } finally {
      this.starting = false;
    }
  }

  private async startNow(media: StartTarget, opts: { backdropUrl?: string | null }): Promise<void> {
    const url = this.router.url;
    if (media.type === 'book') return this.startBook(media, url);
    if (media.type === 'comic') return this.startComic(media, url);
    if (media.type === 'album') return this.startAlbum(media, url);
    if (kindOf(media.type).hasSeasons) return this.startSeries(media, opts);
    const full = media.files?.length ? (media as Media) : await this.mediaService.getOne(media.id);
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

  /** The episode a series' Play launches (see {@link nextUp}), with the loaded series; `next` is null when no episode is on disk. */
  async nextUpOf(media: StartTarget): Promise<{ media: Media; next: NextUp | null; resuming: boolean }> {
    const [full, resume, watched] = await Promise.all([
      this.mediaService.getOne(media.id),
      this.streamingApi.getMediaResumeInfo(media.id).catch(() => null),
      this.streamingApi.getWatchedEpisodeIds(media.id).catch(() => [] as number[]),
    ]);
    const next = nextUp(full, resume, new Set(watched));
    return { media: full, next, resuming: !!next && next.episode.id === resume?.episodeId };
  }

  private async startSeries(media: StartTarget, opts: { backdropUrl?: string | null }): Promise<void> {
    const { media: full, next } = await this.nextUpOf(media);
    if (!next) return void this.openDetail(full);
    await this.playNext(full, next, opts);
  }

  /** Plays an episode a caller already resolved with {@link nextUpOf}, so what it labelled is what plays. */
  playNext(series: Media, next: NextUp, opts: { backdropUrl?: string | null } = {}): Promise<void> {
    return this.playable.play(
      {
        fileId: next.file.id,
        mediaId: series.id,
        episodeId: next.episode.id,
        media: series,
        backdropUrl: opts.backdropUrl ?? next.episode.stillUrl ?? series.fanartUrl ?? series.posterUrl ?? null,
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

  private async startBook(media: StartTarget, url: string): Promise<void> {
    const full = asBookMedia(media as Media) ?? asBookMedia(await this.mediaService.getOne(media.id));
    if (this.router.url !== url) return;
    if (!full) return void this.openDetail(media);
    const lead = leadFamily(full.book);
    const read = readEdition(full.book);
    const audible = listenEdition(full.book);
    if (read && (lead !== 'audio' || !audible)) return void this.router.navigate(readRoute(full.id, read.itemId!));
    if (audible) return this.listen(full);
    this.openDetail(full);
  }

  private async startAlbum(media: StartTarget, url: string): Promise<void> {
    const tracks = await this.musicTracks.albumTracks(media.id);
    if (tracks.length) return this.audio.playTracks(tracks);
    if (this.router.url === url) this.openDetail(media);
  }

  private async startComic(media: StartTarget, url: string): Promise<void> {
    const full = asComicMedia(media as Media) ?? asComicMedia(await this.mediaService.getOne(media.id));
    const issue = full && nextIssue(full.comic.issues);
    if (this.router.url !== url) return;
    if (!full || !issue) return void this.openDetail(media);
    void this.router.navigate(readRoute(full.id, issue.itemId));
  }

  private openDetail(media: StartTarget): void {
    void this.router.navigate(mediaDetailLink(media.type, media.id));
  }
}
