import { Injectable, computed, inject, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import type { Media } from '../../core/services/api/media.service';
import { MediaService } from '../../core/services/api/media.service';
import { StreamingApiService } from '../../core/services/api/streaming-api.service';
import { LikesApiService } from '../../core/services/api/likes-api.service';
import { CastService } from '../../core/services/cast.service';
import { DeviceService } from '../../core/services/device.service';
import { NavbarService } from '../../core/services/navbar.service';
import { NotificationLike } from '../../core/services/notification-like';
import { PlayerSettingsService } from '../../core/services/player-settings.service';
import { PlayerStateService } from '../../core/services/player-state.service';
import { PlaybackQueueService, type QueueItem } from '../../core/services/playback-queue.service';
import { ToastService } from '../../core/services/toast.service';
import { PlaybackSession } from '../../core/services/playback/playback-session';
import { PartyService } from '../../core/services/party/party.service';
import { NativePlayer } from '../../core/plugins/native-player.plugin';
import { buildSeriesQueueItems, resolvePlayableFile } from '../../shared/utils/media-play.util';

export interface QueueHost {
  media(): Media | null;
  mediaId(): number;
  mediaFileId(): number;
  episodeId(): number | undefined;
  /** Read in computeds and effects to re-run them when the media record is replaced. */
  mediaLoadedTick(): number;
  preRollActive(): boolean;
  hasEngine(): boolean;
  engineDuration(): number | undefined;
  duration(): number;
  isOfflinePlayback(): boolean;
  reloadingStream(): boolean;
  clearEdlEnded(): void;
  setBackdropUrl(url: string): void;
  reloadForEpisode(mediaFileId: number, mediaId: number, episodeId: number | undefined): Promise<void>;
}

/** What plays next: the playback queue (playlist or series), the notification controls,
 *  auto-advance at the end of a stream, and the in-place switch to another item. */
@Injectable()
export class QueueController {
  private readonly queue = inject(PlaybackQueueService);
  private readonly session = inject(PlaybackSession);
  private readonly state = inject(PlayerStateService);
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly castService = inject(CastService);
  private readonly device = inject(DeviceService);
  private readonly mediaService = inject(MediaService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly navbar = inject(NavbarService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly party = inject(PartyService);
  private readonly translate = inject(TranslateService);
  private host!: QueueHost;

  readonly notificationLike = new NotificationLike(inject(LikesApiService));

  /** Next episode of the current series with its file; null for movies or the last episode. */
  readonly nextEpisodeContext = computed<{
    episodeId: number;
    mediaFileId: number;
  } | null>(() => {
    this.host.mediaLoadedTick();
    const m = this.host.media();
    const currentEpId = this.host.episodeId();
    if (!m || m.type !== 'series' || !currentEpId || !m.seasons?.length) return null;
    // Flatten episodes in S/E order (skip specials: seasonNumber <= 0).
    const flat: { seasonNumber: number; episodeNumber: number; id: number }[] = [];
    for (const s of m.seasons) {
      if ((s.seasonNumber ?? 0) <= 0) continue;
      for (const ep of s.episodes ?? []) {
        flat.push({
          seasonNumber: s.seasonNumber,
          episodeNumber: ep.episodeNumber ?? 0,
          id: ep.id,
        });
      }
    }
    flat.sort(
      (a, b) =>
        a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber,
    );
    const idx = flat.findIndex((e) => e.id === currentEpId);
    if (idx < 0 || idx >= flat.length - 1) return null;
    const next = flat[idx + 1];
    const file = (m.files ?? []).find((f) => f.episodeId === next.id);
    if (!file) return null;
    return { episodeId: next.id, mediaFileId: file.id };
  });

  /** The queue's next entry; null when nothing follows or there is no queue (a standalone film). */
  readonly upNext = computed<QueueItem | null>(() =>
    this.host.preRollActive() ? null : this.queue.active() ? this.queue.peekNext() : null,
  );

  /** The per-playlist flag for a playlist queue, else the global setting (series episodes). */
  readonly autoplayEnabled = computed<boolean>(() =>
    this.queue.source() === 'playlist'
      ? this.queue.autoplay()
      : this.playerSettings.settings().autoPlayNext,
  );

  /** An episode reads "next episode"; a queue that moves to a movie reads the generic "play next". */
  readonly nextLabelKey = computed(() =>
    this.upNext()?.episodeId != null ? 'player.next_episode' : 'player.play_next',
  );

  readonly queueItems = computed(() => this.queue.items());
  readonly queueIndex = computed(() => this.queue.index());

  /** Guards {@link advance} against re-entry while a switch resolves. */
  private advancing = false;

  attach(host: QueueHost): void {
    this.host = host;
  }

  trackNotificationLike(): void {
    this.host.mediaLoadedTick();
    if (!this.device.isAndroidNative() || !this.playerSettings.settings().backgroundAudio) return;
    untracked(() => void this.notificationLike.track(this.host.mediaId(), this.host.episodeId()));
  }

  syncNotificationNav(): void {
    const hasNext = this.upNext() !== null;
    const hasPrevious = !this.host.preRollActive() && this.queue.active() && this.queue.index() > 0;
    const liked = this.notificationLike.liked();
    // Nothing to step through outside a queue (a film): ±10 s instead.
    const seekButtons = !this.queue.active();
    if (this.device.isAndroidNative() || this.device.isIosNative()) {
      NativePlayer.setQueueNav({ hasPrevious, hasNext, liked, seekButtons }).catch(() => {});
    }
  }

  /** Advances at the natural end of a stream. Never while an error card is up: a mid-stream
   *  failure must not be mistaken for an end and skip the item. */
  autoAdvance(): void {
    if (!this.state.ended()) return;
    if (this.state.error()) return;
    if (!this.autoplayEnabled()) return;
    if (!this.upNext()) return;
    void this.advance(true);
  }

  /** Fills the queue with the series' episodes that have a file, so the list and auto-advance
   *  work outside a playlist. No-op while a playlist or a party owns the queue. */
  syncSeriesQueue(): void {
    if (this.queue.source() === 'playlist' || this.queue.source() === 'party') return;
    const m = this.host.media();
    const episodeId = this.host.episodeId();
    if (!m || !episodeId) {
      this.queue.clear();
      return;
    }
    const items = buildSeriesQueueItems(m);
    const idx = items.findIndex((it) => it.episodeId === episodeId);
    if (idx < 0 || items.length <= 1) {
      this.queue.clear();
      return;
    }
    this.queue.start(items, idx, { source: 'series', sourceId: m.id, autoplay: false });
  }

  /** Marks the playing item completed server-side, so advancing past it counts as watched. */
  async markCurrentComplete(): Promise<void> {
    if (!this.host.mediaId() || this.host.preRollActive()) return;
    const dur =
      (this.castService.isConnected()
        ? this.castService.duration()
        : this.host.engineDuration()) ||
      this.host.duration() ||
      0;
    if (dur <= 0) return;
    try {
      await this.streamingApi.updatePlaybackState(this.host.mediaId(), {
        positionSeconds: dur,
        durationSeconds: dur,
        mediaFileId: this.host.mediaFileId(),
        episodeId: this.host.episodeId(),
      });
    } catch {
      /* non-blocking — advance even if the update fails */
    }
  }

  /** Plays {@link upNext} in place, skipping playlist items whose file is unavailable.
   *  Offline and Cast remount instead: their source is not a re-negotiable local stream. */
  async advance(auto = false): Promise<void> {
    // In a party the server owns what plays next: only a manual press asks it.
    if (this.session.partyActive()) {
      if (!auto) this.session.command({ type: 'next' });
      return;
    }
    // Don't move the queue cursor while a quality/audio reload is still settling.
    if (this.advancing || this.host.reloadingStream()) return;
    if (!this.upNext()) {
      console.warn('[player] advance: no next item in the queue');
      return;
    }
    this.advancing = true;
    try {
      await this.markCurrentComplete();

      // Pick the next playable item. For a queue, walk the cursor forward over
      // any unavailable items; series-next always resolves to a stored file.
      let item: QueueItem | null;
      let mediaFileId: number | null;
      let skipped = 0;
      if (this.queue.active()) {
        item = this.queue.advance();
        mediaFileId = item ? await this.resolveItemFileId(item) : null;
        while (item && mediaFileId == null) {
          skipped++;
          item = this.queue.advance();
          mediaFileId = item ? await this.resolveItemFileId(item) : null;
        }
      } else {
        item = this.upNext();
        mediaFileId = item?.mediaFileId ?? null;
      }

      if (!item || mediaFileId == null) {
        if (skipped > 0) {
          this.toast.error(this.translate.instant('player.next_unavailable'));
        }
        return;
      }

      await this.loadItem(item, mediaFileId);
    } finally {
      this.advancing = false;
    }
  }

  /** Loads the item a party switched to, counting the one it ends as watched; false when it cannot be opened. */
  async openPartyItem(item: { mediaId: number; mediaFileId: number | null; episodeId: number | null }): Promise<boolean> {
    this.queue.syncTo(item.mediaId, item.episodeId ?? undefined);
    const queueItem: QueueItem = {
      mediaId: item.mediaId,
      mediaFileId: item.mediaFileId ?? undefined,
      episodeId: item.episodeId ?? undefined,
      title: '',
    };
    const mediaFileId = await this.resolveItemFileId(queueItem);
    if (mediaFileId == null) {
      this.toast.error(this.translate.instant('player.next_unavailable'));
      return false;
    }
    if (this.state.ended()) await this.markCurrentComplete();
    if (!this.session.isLocal()) {
      // A remount would close the player: switch the output in place.
      await this.session.play(
        {
          fileId: mediaFileId,
          mediaId: item.mediaId,
          episodeId: item.episodeId ?? undefined,
        },
        { fromStart: true, expand: false },
      );
      return true;
    }
    await this.loadItem(queueItem, mediaFileId);
    return true;
  }

  /** The previous queue item, or the party's. */
  async playPrevious(): Promise<void> {
    if (this.session.partyActive()) this.session.command({ type: 'prev' });
    else await this.playQueueItem(this.queue.index() - 1);
  }

  /** Jumps to a queue item the user picked: unlike {@link advance} it does not mark the
   *  current item watched and does not skip. */
  async playQueueItem(index: number): Promise<void> {
    if (this.session.partyActive()) {
      this.session.command({ type: 'item', index });
      return;
    }
    if (this.advancing || this.host.reloadingStream() || this.host.preRollActive()) return;
    if (index === this.queue.index()) return; // already playing it
    const item = this.queue.items()[index];
    if (!item) return;
    this.advancing = true;
    try {
      const mediaFileId = await this.resolveItemFileId(item);
      if (mediaFileId == null) {
        this.toast.error(this.translate.instant('player.next_unavailable'));
        return;
      }
      this.queue.setIndex(index);
      await this.loadItem(item, mediaFileId);
    } finally {
      this.advancing = false;
    }
  }

  /** Series-next items carry their file id; playlist items resolve it lazily from the media. */
  private async resolveItemFileId(item: QueueItem): Promise<number | null> {
    if (item.mediaFileId != null) return item.mediaFileId;
    const media = await this.mediaService.getOne(item.mediaId).catch(() => null);
    return media ? (resolvePlayableFile(media, item.episodeId)?.id ?? null) : null;
  }

  /** Loads a resolved item in place, or through a full remount for offline / Cast.
   *  The queue cursor is expected to already point at `item`. */
  private async loadItem(item: QueueItem, mediaFileId: number): Promise<void> {
    // Clear the end-of-stream latch so a reload that no-ops can't re-trigger auto-advance.
    this.state.ended.set(false);
    this.host.clearEdlEnded();

    const qp: Record<string, number> = { mediaId: item.mediaId };
    if (item.episodeId) qp['episodeId'] = item.episodeId;
    const partyId = this.party.party()?.id;
    if (partyId != null) qp['party'] = partyId;
    const sourceId = this.queue.sourceId();
    // Only a playlist queue is re-established from the URL; a series queue is
    // rebuilt from the loaded media, so it needs no param.
    if (this.queue.source() === 'playlist' && sourceId != null) {
      qp['playlistId'] = sourceId;
    }

    const canReloadInPlace =
      this.host.hasEngine() && !this.host.isOfflinePlayback() && this.session.isLocal();
    if (canReloadInPlace) {
      // Match the incoming item's backdrop during the brief reload (the episode
      // still, else the media fanart) so it's not the outgoing frame.
      const backdrop = item.stillUrl ?? item.fanartUrl;
      if (backdrop) this.host.setBackdropUrl(backdrop);
      // replaceUrl + markAsBackNavigation keep both histories clear of the old
      // item so Back never reopens the player. Route reuse → no remount.
      this.navbar.markAsBackNavigation();
      void this.router.navigate(['/watch', mediaFileId], {
        queryParams: qp,
        replaceUrl: true,
      });
      await this.host.reloadForEpisode(mediaFileId, item.mediaId, item.episodeId);
      return;
    }

    // Offline / Cast fallback: detour through `/` to force a remount, as the router would reuse the component.
    void this.router
      .navigateByUrl('/', { skipLocationChange: true })
      .then(() =>
        this.router.navigate(['/watch', mediaFileId], {
          queryParams: qp,
          replaceUrl: true,
        }),
      );
  }
}
