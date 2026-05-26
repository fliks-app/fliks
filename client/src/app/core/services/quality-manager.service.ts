import { Injectable, signal } from '@angular/core';
import type { PlaybackEngine } from './playback-engine/playback-engine';
import { bucketResolutionLabel, widthForProfile } from '../utils/player.utils';

export interface QualityOption {
  id: string;      // 'auto' | 'original' | '2160p' | '1080p' | '720p' | '480p' | ...
  label: string;   // "Auto", "1080p", "4K", ...
  height: number;  // 0 for auto, source height for original, profile height
  /** Reduced transcode rung shown alongside `original` at source resolution. */
  lowBandwidth?: boolean;
}

/** Persisted user choice for quality (same key across sessions). */
const PLAYER_QUALITY_STORAGE_KEY = 'player.qualityId';

/**
 * ABR: prefer starting at 720p+ and staying there when possible; below 720 only
 * when no variant meets the restriction (very slow network / low source res).
 */
// Seed the ABR bandwidth estimator high so Shaka picks the top variant on
// the first segment instead of probing low→high (which fetches a throw-away
// low-quality init+seg-0 before upgrading). Once the first segment's real
// bandwidth is observed, ABR recalibrates within seconds.
const ABR_DEFAULT_BANDWIDTH_ESTIMATE = 100_000_000;

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
   * The backend sends an authoritative, device-aware list in `qualities` — we
   * only prepend "Auto" and hand it to the UI.
   */
  buildQualityOptions(playbackInfo: {
    playMethod: string;
    videoCopyStream: boolean;
    source: { width?: number; height?: number };
    qualities?: { id: string; label: string; height: number; lowBandwidth?: boolean }[];
  }): void {
    const options: QualityOption[] = [
      { id: 'auto', label: 'Auto', height: 0 },
    ];
    for (const q of playbackInfo.qualities ?? []) {
      options.push({
        id: q.id,
        label: q.label,
        height: q.height,
        lowBandwidth: q.lowBandwidth,
      });
    }
    this.availableQualities.set(options);
  }

  /**
   * Read persisted quality preference from localStorage and apply it if valid.
   * IDs differ across media (`'original'` for the source-rung remux/DirectPlay
   * vs `'1080p'` for a transcode rung) — when an exact id match fails, fall
   * back to height matching so a "1080p" saved on one show maps cleanly to
   * the equivalent rung on another (which may carry a different id).
   */
  applySavedPreference(): void {
    const saved = this.readFromStorage();
    if (!saved) {
      this.activeQualityId.set('auto');
      return;
    }
    const opts = this.availableQualities();
    const direct = opts.find((q) => q.id === saved.id);
    if (direct) {
      this.activeQualityId.set(direct.id);
      return;
    }
    if (saved.height > 0) {
      const exactHeight = opts.find((q) => q.height === saved.height);
      if (exactHeight) {
        this.activeQualityId.set(exactHeight.id);
        return;
      }
      // No exact-height match — pick the largest rung still ≤ saved height
      // (don't auto-upgrade beyond the user's intent).
      const below = opts
        .filter((q) => q.height > 0 && q.height <= saved.height)
        .sort((a, b) => b.height - a.height);
      if (below.length) {
        this.activeQualityId.set(below[0].id);
        return;
      }
    }
    this.activeQualityId.set('auto');
  }

  /**
   * Select a quality option: configure ABR or lock to a specific variant.
   *
   * @param option        Quality option to apply
   * @param engine        Playback engine (Shaka/Native/Cast)
   * @param playbackMode  Current playback mode ('direct' | 'remux' | 'transcode')
   * @param force         If true, apply even if already the active quality
   * @param persist       If true, write the choice to localStorage. False for
   *                      internal restore / fallback calls so a media that
   *                      lacks the user's preferred rung doesn't silently
   *                      overwrite the app-level preference with "auto".
   */
  selectQuality(
    option: QualityOption,
    engine: PlaybackEngine | null,
    playbackMode: 'direct' | 'remux' | 'transcode',
    force = false,
    persist = false,
  ): void {
    if (!force && option.id === this.activeQualityId()) return;
    this.activeQualityId.set(option.id);
    if (persist) this.persistPreference(option);

    if (!engine) return;

    if (option.id === 'auto') {
      if (playbackMode !== 'direct') {
        // ABR for HLS: enable + trim buffer to 5s so ABR can switch quality quickly.
        // The server restarts FFmpeg at the new quality from the current segment.
        engine.configure({
          abr: {
            enabled: true,
            defaultBandwidthEstimate: ABR_DEFAULT_BANDWIDTH_ESTIMATE,
            // useNetworkInformation: navigator.connection values are usually
            // conservative (and unsupported on some browsers), which drags
            // ABR toward low variants at startup. Seed from our estimate and
            // let Shaka measure actual throughput from real segments.
            useNetworkInformation: false,
            switchInterval: 5,              // Re-evaluate every 5s (default: 8)
            bandwidthUpgradeTarget: 0.7,    // Upgrade at 70% headroom (default: 0.85 = more conservative)
            bandwidthDowngradeTarget: 0.95, // Downgrade only when nearly saturated
            advanced: {
              // Require 5 MB of observed data before ABR makes decisions.
              // FFmpeg transcode startup makes the first segment arrive 10-30s
              // after request on 4K/HDR sources; with the default 128 KB
              // threshold Shaka treats that single slow seg as network
              // saturation and downgrades before playback even starts.
              minTotalBytes: 5_000_000,
              // Smooth the bandwidth estimator over a longer window (default
              // slowHalfLife is ~9s). 30s means one slow segment has less
              // weight on the overall estimate — protects against the
              // transcode-warmup outlier dragging ABR down.
              slowHalfLife: 30,
            } as any,
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
      // No variant tracks (native player) — use profile maxWidth to set
      // resolution constraint. Must match backend PROFILES exactly to
      // avoid off-by-one with ExoPlayer track selection.
      const isOriginal = option.id === 'original';
      const w = isOriginal
        ? 99999
        : (widthForProfile(option.id) ?? Math.round(option.height * 16 / 9));
      const h = isOriginal ? 99999 : option.height;
      engine.selectVariantTrack({ height: h, width: w }, true);
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

    const wasPaused = engine.paused;

    const target = option.id === 'original'
      ? candidates.reduce((a: any, b: any) => ((a.height ?? 0) >= (b.height ?? 0) ? a : b))
      : findVariantByProfileName(candidates, option.id)
        ?? findBestVariantForHeight(candidates, option.height);

    // Skip if already on the target variant, only one video resolution exists,
    // or no active track yet (just loaded) — avoids clearBuffer which cancels
    // in-flight segment requests (init.mp4).
    if (target && activeTrack && target.id === activeTrack.id) return;
    // Deduplicate by video height — multi-audio creates N variants per resolution.
    const uniqueHeights = new Set(candidates.map((t: any) => t.height));
    if (uniqueHeights.size <= 1) return;

    engine.selectVariantTrack(target, true);

    // Restore pause state — clearBuffer can trigger autoplay
    if (wasPaused) engine.pause();
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
   * Persist quality preference to localStorage. Stores both id and height
   * so a follow-up media with different id naming (e.g. `'original'` instead
   * of `'1080p'` for the same resolution) can still match by height.
   */
  persistPreference(option: QualityOption): void {
    try {
      localStorage.setItem(
        PLAYER_QUALITY_STORAGE_KEY,
        JSON.stringify({ id: option.id, height: option.height }),
      );
    } catch {
      /* private mode / quota */
    }
  }

  /**
   * Human-readable resolution label from width/height. Delegates to
   * the shared bucketing helper so anamorphic / scope crops bucket the
   * same way the file badge does (e.g. 1918×872 → 1080p, not 720p).
   */
  resolutionLabel(w?: number, h?: number): string {
    return bucketResolutionLabel(w, h) ?? (w && h ? `${w}x${h}` : '?');
  }

  /**
   * Map a variant track's dimensions to its transcode profile name. Uses
   * the shared {@link bucketResolutionLabel} so a letterboxed 1918×872
   * variant maps to "1080p" instead of falling through to "720p" — same
   * fix as the file-badge bucketing.
   *
   * Accepts width as well as height because Shaka variants for cropped
   * sources expose their cropped dimensions; height alone is misleading
   * for anamorphic / scope tracks.
   */
  transcodeTierFromVariantHeight(h: number, w?: number): string | null {
    if (h <= 0) return null;
    const label = bucketResolutionLabel(w, h);
    if (!label) return null;
    return label === '4K' ? '2160p' : label;
  }

  // ── Private helpers ──

  private readFromStorage(): { id: string; height: number } | null {
    try {
      const raw = localStorage.getItem(PLAYER_QUALITY_STORAGE_KEY);
      if (!raw) return null;
      // New JSON format
      if (raw.startsWith('{')) {
        const parsed = JSON.parse(raw) as { id?: string; height?: number };
        if (typeof parsed.id !== 'string') return null;
        return { id: parsed.id, height: parsed.height ?? 0 };
      }
      // Legacy plain-string format — derive height from the id when possible
      // (e.g. "1080p" → 1080). Unknown ids ('auto', 'original') get 0.
      const m = raw.match(/^(\d+)p$/);
      return { id: raw, height: m ? parseInt(m[1], 10) : 0 };
    } catch {
      return null;
    }
  }
}
