import { Injectable, computed, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import type { ReloadWhy } from './player-qoe';
import type { PlaybackEngine } from '../../core/services/playback-engine/playback-engine';
import type { PlaybackMode } from '../../core/utils/player.utils';
import { subtitleManifestRank } from '../../core/utils/subtitle-tracks';
import { AuthService } from '../../core/services/auth.service';
import { BrowserDeviceProfileService } from '../../core/services/browser-device-profile.service';
import { CastService } from '../../core/services/cast.service';
import { SubtitleOption, TrackManagerService } from '../../core/services/track-manager.service';
import { ToastService } from '../../core/services/toast.service';
import { ControlsVisibilityService } from './controls/controls-visibility';

const HLS_SUBTITLE_REQUEST_FEATURE = 'hlsSubtitleRequest';

export interface SubtitleHost {
  engine(): PlaybackEngine | null;
  isOfflinePlayback(): boolean;
  mediaId(): number;
  mediaFileId(): number;
  playbackMode(): PlaybackMode;
  /** ExoPlayer and AVPlayer read subtitles at load(); false on desktop mpv. */
  readsSubtitlesAtLoad(): boolean;
  reloadStream(at: number | undefined, why: ReloadWhy): Promise<void>;
  doReloadStream(position: number): Promise<void>;
}

/** Subtitle selection on the local engine: what is on screen, whether it is burned in or
 *  served as an HLS rendition, and the resync panel. */
@Injectable()
export class SubtitleController {
  private readonly castService = inject(CastService);
  private readonly authService = inject(AuthService);
  private readonly deviceProfileService = inject(BrowserDeviceProfileService);
  private readonly trackManager = inject(TrackManagerService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly chrome = inject(ControlsVisibilityService);
  private host!: SubtitleHost;

  readonly activeSubtitleId = signal<string | null>(null);
  readonly availableSubtitles = signal<SubtitleOption[]>([]);
  /** The burned-in subtitle the stream is negotiated with. */
  activeBurnInId: number | null = null;
  /** Whether the text subtitle in use reaches this engine as an HLS rendition. */
  needsHlsSubtitles = false;
  /** Bumped by every request and by a track reset, so a stale async result can tell. */
  subtitleRequest = 0;

  readonly subtitleSyncOpen = signal(false);
  /** The panel takes the controls' place: none are shown, a tap plays or pauses. */
  readonly syncHidesControls = this.subtitleSyncOpen.asReadonly();
  subtitleSyncOpener: HTMLElement | null = null;
  readonly syncSubtitle = computed(
    () => this.availableSubtitles().find((s) => s.id === this.activeSubtitleId()) ?? null,
  );
  readonly syncTextTracks = computed(() => this.availableSubtitles().filter((s) => !s.isImage && !s.burnIn));
  readonly subtitleTime = () => this.host.engine()?.currentTime ?? 0;

  attach(host: SubtitleHost): void {
    this.host = host;
  }

  /** Whether a text subtitle reaches this engine in DirectPlay only as an HLS rendition,
   *  and the server can be asked for one. */
  textNeedsHls(): boolean {
    return (
      !this.deviceProfileService.engineTraits().sideloadsDirectPlaySubtitles &&
      this.authService.hasServerFeature(HLS_SUBTITLE_REQUEST_FEATURE)
    );
  }

  manifestRank(s: SubtitleOption): number {
    return subtitleManifestRank(s.trackKey ?? s.id);
  }

  /** 0-based ordinal of a soft subtitle among tracks sharing its (language, forced); the engines pick the Nth. */
  subtitleOrdinal(sub: SubtitleOption): number {
    const peers = this.availableSubtitles()
      .filter(
        (s) =>
          !s.isImage &&
          !s.burnIn &&
          s.language === sub.language &&
          !!s.forced === !!sub.forced,
      )
      .sort((a, b) => this.manifestRank(a) - this.manifestRank(b));
    const idx = peers.findIndex((s) => s.id === sub.id);
    return idx < 0 ? 0 : idx;
  }

  async selectById(id: string | null): Promise<void> {
    if (id === null) {
      await this.selectSubtitle(null);
      return;
    }
    const sub = this.availableSubtitles().find(s => s.id === id) ?? null;
    if (!sub) {
      // Falling through to selectSubtitle(null) would persist "off" for this media.
      console.warn('[player] onSelectSubtitleById: id not found, tracks may not be enumerated yet', id);
      return;
    }
    await this.selectSubtitle(sub);
  }

  /** A viewer's pick (menu, remote command): applied, then remembered. Automatic picks
   *  use {@link applySubtitle} alone, so they never harden into the viewer's choice. */
  async selectSubtitle(sub: SubtitleOption | null): Promise<void> {
    if (!(await this.applySubtitle(sub))) return;
    const image = !!sub?.isImage;
    this.trackManager.saveSubtitleSelection(
      this.host.mediaId(),
      sub?.language ?? null,
      sub?.forced,
      !!sub?.id.startsWith('emb-'),
      image,
      sub?.hearingImpaired,
      sub?.languageTag,
    );
  }

  /** Puts `sub` on screen (null: Off) and moves the active id. False when it did
   *  not take effect: no engine, casting, a load failure, or a newer request. */
  async applySubtitle(sub: SubtitleOption | null): Promise<boolean> {
    if (!this.host.engine()) return false;
    // Cast owns subtitle selection once connected (via CastPlayerService.selectSubtitle):
    // an auto-select racing in from the local engine must not reload it instead.
    if (this.castService.isConnected()) return false;
    const request = ++this.subtitleRequest;
    this.chrome.resetHideTimer();

    if (!sub) {
      this.hideSoftSubtitle();
      this.needsHlsSubtitles = false;
      this.activeSubtitleId.set(null);
      if (!this.host.isOfflinePlayback() && this.activeBurnInId) {
        this.activeBurnInId = null;
        await this.host.reloadStream(undefined, { reason: 'subtitles' });
      }
      return request === this.subtitleRequest;
    }

    // A bitmap sub the engine can't render from this playback is burned in: the
    // reload re-negotiates with it, and the server answers with a transcode.
    if (this.burnsIn(sub) && sub.subtitleDbId) {
      // The reload doesn't touch the engine's own selection: without this the
      // soft track would show under the burned-in one.
      this.hideSoftSubtitle();
      this.needsHlsSubtitles = false;
      this.activeBurnInId = sub.subtitleDbId;
      this.activeSubtitleId.set(sub.id);
      await this.host.reloadStream(undefined, { reason: 'subtitles', to: sub.language });
      return request === this.subtitleRequest;
    }

    const previousNeedsHls = this.needsHlsSubtitles;
    try {
      this.needsHlsSubtitles = !sub.burnIn && this.textNeedsHls();
      // A text sub on an engine that can't sideload it into a raw file needs the
      // HLS master's renditions: renegotiate once, before the track is selected.
      const leavesDirectPlay =
        this.needsHlsSubtitles && this.host.playbackMode() === 'direct' && !this.host.isOfflinePlayback();
      const burnedIn = this.activeBurnInId != null;
      this.activeBurnInId = null;
      // The burned-in pick is replaced: the restore after the reload must not bring it back.
      if (burnedIn) this.activeSubtitleId.set(null);
      if ((burnedIn || leavesDirectPlay) && !this.host.isOfflinePlayback()) {
        await this.host.reloadStream(undefined, {
          reason: 'subtitles',
          ...(leavesDirectPlay && { from: 'hls', to: sub.language }),
        });
      }
      if (!(await this.showSoftSubtitle(sub, request))) return false;
    } catch (e) {
      // Leave the prior selection and the picker in place so the user can pick another.
      console.error('[Player] Failed to load subtitle:', e);
      this.needsHlsSubtitles = previousNeedsHls;
      this.toast.error(this.translate.instant('player.subtitle_load_failed'));
      return false;
    }
    this.activeSubtitleId.set(sub.id);
    return true;
  }

  /** Re-selects the active subtitle after a reload (engines drop it across load()); a reload that changed the
   *  play mode can change how a bitmap sub is shown: engine-rendered in DirectPlay, burned in on HLS. */
  async restoreSubtitle(position: number): Promise<void> {
    const id = this.activeSubtitleId();
    const sub = id ? this.availableSubtitles().find((s) => s.id === id) : undefined;
    if (!sub) return;
    if (this.burnsIn(sub)) {
      if (!sub.subtitleDbId || this.activeBurnInId === sub.subtitleDbId) return;
      this.hideSoftSubtitle();
      this.activeBurnInId = sub.subtitleDbId;
      await this.host.doReloadStream(position);
      return;
    }
    try {
      await this.showSoftSubtitle(sub, this.subtitleRequest);
    } catch (e) {
      console.error('[Player] re-apply subtitle after reload failed:', e);
    }
  }

  hideSoftSubtitle(): void {
    try { this.host.engine()?.setTextVisibility(false); } catch {}
  }

  onOpenSubtitleSync(opener: HTMLElement | null) {
    this.subtitleSyncOpener = opener;
    this.subtitleSyncOpen.set(true);
    this.hideSoftSubtitle();
    const tracks = this.syncTextTracks();
    if (!tracks.some((s) => s.id === this.activeSubtitleId()) && tracks.length) void this.selectById(tracks[0].id);
  }

  onCloseSubtitleSync() {
    this.subtitleSyncOpen.set(false);
    const sub = this.syncSubtitle();
    if (!sub || this.burnsIn(sub)) return;
    this.showSoftSubtitle(sub, this.subtitleRequest).catch((e) => console.error('[Player] restore subtitle failed:', e));
  }

  /** A new URL makes engines (Shaka caches sideloaded tracks by URL) load the edited file. */
  onSubtitleContentChanged(id: string) {
    const rev = `rev=${Date.now()}`;
    this.availableSubtitles.update((list) =>
      list.map((s) => (s.id === id ? { ...s, url: s.url.replace(/[?&]rev=\d+/, '') + (s.url.includes('?') ? '&' : '?') + rev } : s)),
    );
    // ExoPlayer reads subtitles at load(), so a new file needs a stream reload.
    if (this.host.readsSubtitlesAtLoad()) void this.host.reloadStream(undefined, { reason: 'other' });
  }

  /** Whether `sub` is burned into the video: a bitmap sub is engine-rendered only when it can be and the
   *  playback carries the track, which only a DirectPlay container does. */
  private burnsIn(sub: SubtitleOption): boolean {
    if (!sub.burnIn) return false;
    if (!sub.isImage) return true;
    const rendersFromContainer =
      this.deviceProfileService.engineTraits().supportsImageSubtitles === true &&
      this.host.playbackMode() === 'direct' &&
      sub.id.startsWith('emb-');
    return !rendersFromContainer;
  }

  /** Loads `sub` into the engine and selects it unless a newer request took over;
   *  every engine gets the same descriptor (ordinal, embedded index, image flag). */
  private async showSoftSubtitle(sub: SubtitleOption, request: number): Promise<boolean> {
    const engine = this.host.engine();
    if (!engine) return false;
    const track = await engine.addTextTrack(
      sub.url, sub.language, sub.label, sub.forced, this.subtitleOrdinal(sub),
    );
    if (request !== this.subtitleRequest || engine !== this.host.engine()) return false;
    // Keep the engine track's own id: Shaka matches the rendition by it; the
    // other engines key off language/forced/embIndex.
    engine.selectTextTrack({
      ...track,
      embIndex: sub.id.startsWith('emb-') ? Number(sub.id.slice(4)) : null,
      image: sub.isImage,
    });
    // The resync panel previews the cues itself, so the engine stays hidden meanwhile.
    if (this.subtitleSyncOpen()) this.hideSoftSubtitle();
    else try { engine.setTextVisibility(true); } catch {}
    return true;
  }
}
