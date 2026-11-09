import { Injectable, computed, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { translatePlural } from '../pipes/translate-plural.pipe';
import { artistLine, toTrackRequest } from '../../features/music/music-utils';
import { asAlbumMedia, defaultEditionId } from '../../features/media-detail/album/album-media';
import type { MusicTrackRequest } from './audio-player/music-queue';
import { MediaService } from './api/media.service';
import { BookDownloadRefused, DownloadManagerService } from './download-manager.service';
import { ToastService } from './toast.service';
import { TvService } from './tv.service';

export type TracksOnDevice = 'none' | 'some' | 'all';

/** Keeps music on the device: single tracks, and whole albums, playlists or artists as the tracks they hold. */
@Injectable({ providedIn: 'root' })
export class MusicDownloadsService {
  private readonly manager = inject(DownloadManagerService);
  private readonly media = inject(MediaService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly tv = inject(TvService);

  readonly available = computed(() => !this.tv.isTv());

  /** Item ids of the tracks on the device or on their way. */
  readonly itemIds = computed(
    () => new Set(this.manager.tasks().filter((t) => t.book?.track && t.status !== 'failed').map((t) => t.book!.itemId)),
  );

  state(itemIds: readonly number[]): TracksOnDevice {
    const have = this.itemIds();
    const n = itemIds.filter((id) => have.has(id)).length;
    return n === 0 ? 'none' : n === itemIds.length ? 'all' : 'some';
  }

  /** The playable tracks of an album's edition, as the player takes them. */
  async albumTracks(mediaId: number): Promise<MusicTrackRequest[]> {
    const m = await this.media.getOne(mediaId);
    const album = asAlbumMedia(m)?.album;
    if (!album) return [];
    const editionId = defaultEditionId(album);
    const edition = album.editions.find((e) => e.id === editionId);
    const facts = {
      mediaId,
      title: m.title,
      coverUrl: edition?.coverUrl ?? m.posterUrl ?? null,
      artists: artistLine(album.artists),
      albumGain: edition?.albumGain ?? null,
      albumPeak: edition?.albumPeak ?? null,
    };
    return album.tracks.filter((t) => t.editionId === editionId && t.hasFile).map((t) => toTrackRequest(t, facts));
  }

  /** The tracks of several albums, in the order given. */
  async albumsTracks(mediaIds: readonly number[]): Promise<MusicTrackRequest[]> {
    return (await Promise.all(mediaIds.map((id) => this.albumTracks(id)))).flat();
  }

  /** Starts the tracks not yet on the device and tells the viewer how it went. */
  async download(tracks: readonly MusicTrackRequest[]): Promise<void> {
    if (!tracks.length) return;
    try {
      const { started, failed } = await this.manager.createTracks(tracks);
      if (failed) this.toast.error(translatePlural(this.translate, 'downloads.tracks_failed', failed));
      else if (started) this.toast.success(translatePlural(this.translate, 'downloads.tracks_added', started));
      else this.toast.info(this.translate.instant('downloads.tracks_already'));
    } catch (err) {
      this.toast.error(err instanceof BookDownloadRefused ? err.message : this.translate.instant('downloads.failed'));
    }
  }

  async remove(itemIds: readonly number[]): Promise<void> {
    const ids = new Set(itemIds);
    for (const task of this.manager.tasks().filter((t) => t.book?.track && ids.has(t.book.itemId))) {
      await this.manager.deleteDownload(task);
    }
  }
}
