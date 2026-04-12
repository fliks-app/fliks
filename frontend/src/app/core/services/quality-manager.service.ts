import { Injectable, signal } from '@angular/core';
import type { PlaybackEngine } from './playback-engine/playback-engine';

export interface QualityOption {
  id: string;      // 'auto' | 'original' | '2160p' | '1080p' | '720p' | '480p' | ...
  label: string;   // "Auto", "Original (4K)", "1080p", "720p", "480p"
  height: number;  // 0 for auto, source height for original, profile height
}

/** Persisted user choice for quality (same key across sessions). */
const PLAYER_QUALITY_STORAGE_KEY = 'player.qualityId';

/**
 * ABR: prefer starting at 720p+ and staying there when possible; below 720 only
 * when no variant meets the restriction (very slow network / low source res).
 */
const ABR_DEFAULT_BANDWIDTH_ESTIMATE = 4_500_000;

/**
 * Find a variant track by profile name in the variant URL (e.g. '480p' matches '/480p/').
 * Returns null if no match found.
 */
export function findVariantByProfileName(tracks: any[], profileName: string): any | null {
  const path = `/${profileName}/`;
  return tracks.find((t: any) => t.originalVideoId?.includes(path)) ?? null;
}

/**
 * Find the best variant track for a target height:
 * pick the largest height that is ≤ targetHeight.
 * If none fits (all tracks are above target), pick the smallest.
 */
export function findBestVariantForHeight(tracks: any[], targetHeight: number): any {
  const below = tracks.filter((t: any) => (t.height ?? 0) <= targetHeight);
  if (below.length) {
    return below.reduce((a: any, b: any) => ((a.height ?? 0) >= (b.height ?? 0) ? a : b));
  }
  return tracks.reduce((a: any, b: any) => ((a.height ?? 0) <= (b.height ?? 0) ? a : b));
}

@Injectable({ providedIn: 'root' })
export class QualityManagerService {
  readonly activeQualityId = signal('auto');
  readonly availableQualities = signal<QualityOption[]>([]);
  readonly activeResolution = signal('');

  /**
   * Build the quality options list from playback info.
   * Generates: Auto + Original (if videoCopy) + transcode profiles filtered by source width.
   */
  buildQualityOptions(playbackInfo: {
    playMethod: string;
    videoCopyStream: boolean;
    source: { width?: number; height?: number };
  }): void {
    const options: QualityOption[] = [];
    const srcH = playbackInfo.source.height ?? 0;
    const srcW = playbackInfo.source.width ?? 0;

    // Auto is always first
    options.push({ id: 'auto', label: 'Auto', height: 0 });

    if (playbackInfo.playMethod === 'DirectPlay') {
      // Only original quality
      const resLabel = this.resolutionLabel(srcW, srcH);
      options.push({ id: 'original', label: resLabel, height: srcH });
    } else {
      // Original (remux) if video can be copied
      if (playbackInfo.videoCopyStream) {
        const resLabel = this.resolutionLabel(srcW, srcH);
        options.push({ id: 'original', label: resLabel, height: srcH });
      }
      // Transcode profiles: use width to match (stable across cinema aspect ratios)
      const profiles = [
        { id: '2160p', label: '4K', height: 2160, minWidth: 3800 },
        { id: '1080p', label: '1080p', height: 1080, minWidth: 1900 },
        { id: '720p', label: '720p', height: 720, minWidth: 1260 },
        { id: '480p', label: '480p', height: 480, minWidth: 0 },
        { id: '360p', label: '360p', height: 360, minWidth: 0 },
        { id: '240p', label: '240p', height: 240, minWidth: 0 },
        { id: '144p', label: '144p', height: 144, minWidth: 0 },
      ];
      const originalLabel = playbackInfo.videoCopyStream ? this.resolutionLabel(srcW, srcH) : null;
      for (const p of profiles) {
        if (srcW >= p.minWidth && p.label !== originalLabel) {
          options.push(p);
        }
      }
    }

    this.availableQualities.set(options);
  }

  /**
   * Read persisted quality preference from localStorage and apply it if valid.
   */
  applySavedPreference(): void {
    const saved = this.readFromStorage();
    const ids = new Set(this.availableQualities().map(q => q.id));
    if (saved && ids.has(saved)) {
      this.activeQualityId.set(saved);
    } else {
      this.activeQualityId.set('auto');
    }
  }

  /**
   * Select a quality option: configure ABR or lock to a specific variant.
   *
   * @param option        Quality option to apply
   * @param engine        Playback engine (Shaka/Native/Cast)
   * @param playbackMode  Current playback mode ('direct' | 'remux' | 'transcode')
   * @param force         If true, apply even if already the active quality
   */
  selectQuality(
    option: QualityOption,
    engine: PlaybackEngine | null,
    playbackMode: 'direct' | 'remux' | 'transcode',
    force = false,
  ): void {
    if (!force && option.id === this.activeQualityId()) return;
    this.activeQualityId.set(option.id);
    this.persistPreference(option.id);

    if (!engine) return;

    if (option.id === 'auto') {
      if (playbackMode !== 'direct') {
        // ABR for HLS: enable + trim buffer to 5s so ABR can switch quality quickly.
        // The server restarts FFmpeg at the new quality from the current segment.
        engine.configure({
          abr: {
            enabled: true,
            defaultBandwidthEstimate: ABR_DEFAULT_BANDWIDTH_ESTIMATE,
            useNetworkInformation: true,
          },
          streaming: { bufferBehind: 5 },
        });
      } else {
        engine.configure({ abr: { enabled: true } });
      }
      return;
    }

    // Disable ABR and lock to a specific variant
    engine.configure({ abr: { enabled: false } });
    const allTracks = engine.getVariantTracks();

    if (!allTracks.length) {
      // No variant tracks (native player) — use synthetic track with target height
      const h = option.id === 'original' ? 9999 : option.height;
      engine.selectVariantTrack({ height: h, width: Math.round(h * 16 / 9) }, true);
      return;
    }

    // Preserve current audio track: filter variants to those matching the active audioId
    const activeTrack = allTracks.find((t: any) => t.active);
    const activeAudioId = activeTrack?.audioId;
    const tracks =
      activeAudioId != null
        ? allTracks.filter((t: any) => t.audioId === activeAudioId)
        : allTracks;
    const candidates = tracks.length ? tracks : allTracks;

    if (option.id === 'original') {
      const best = candidates.reduce((a: any, b: any) => ((a.height ?? 0) >= (b.height ?? 0) ? a : b));
      engine.selectVariantTrack(best, true);
    } else {
      // Match by variant URL (e.g. "/480p/" in originalVideoId) to avoid crop/alignment issues
      const match = findVariantByProfileName(candidates, option.id)
        ?? findBestVariantForHeight(candidates, option.height);
      engine.selectVariantTrack(match, true);
    }
  }

  /**
   * After buildQualityOptions + applySavedPreference: restore last choice with force=true.
   */
  applyQualityPreferenceAfterLoad(
    engine: PlaybackEngine | null,
    playbackMode: 'direct' | 'remux' | 'transcode',
  ): void {
    const option = this.availableQualities().find(q => q.id === this.activeQualityId())
      ?? this.availableQualities().find(q => q.id === 'auto');
    if (!option) return;
    this.selectQuality(option, engine, playbackMode, true);
  }

  /**
   * Persist quality preference to localStorage.
   */
  persistPreference(id: string): void {
    try {
      localStorage.setItem(PLAYER_QUALITY_STORAGE_KEY, id);
    } catch {
      /* private mode / quota */
    }
  }

  /**
   * Human-readable resolution label from width/height.
   */
  resolutionLabel(w?: number, h?: number): string {
    if (!w || !h) return '?';
    if (w >= 3840 || h >= 2160) return '4K';
    if (w >= 2560 || h >= 1440) return '1440p';
    if (w >= 1920 || h >= 1080) return '1080p';
    if (w >= 1280 || h >= 720) return '720p';
    if (w >= 854 || h >= 480) return '480p';
    return `${w}x${h}`;
  }

  /**
   * Map variant track height to transcode profile name.
   */
  transcodeTierFromVariantHeight(h: number): string | null {
    if (h <= 0) return null;
    if (h >= 2160) return '2160p';
    if (h >= 1080) return '1080p';
    if (h >= 720) return '720p';
    if (h >= 480) return '480p';
    if (h >= 360) return '360p';
    if (h >= 240) return '240p';
    return '144p';
  }

  // ── Private helpers ──

  private readFromStorage(): string | null {
    try {
      return localStorage.getItem(PLAYER_QUALITY_STORAGE_KEY);
    } catch {
      return null;
    }
  }
}
