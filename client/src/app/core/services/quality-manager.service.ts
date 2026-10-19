import { Injectable, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import type { PlaybackEngine, VariantTrack } from './playback-engine/playback-engine';
import { bucketResolutionLabel, widthForProfile, type PlaybackMode } from '../utils/player.utils';
import { PlayerSettingsService } from './player-settings.service';

export interface QualityOption {
  id: string;      // 'auto' | 'original' | '2160p' | '1080p' | 'eco-1080p' | ...
  label: string;   // "Auto", "1080p", "4K", ...
  height: number;  // 0 for auto, source height for original, profile height
  width?: number;  // target width (from the backend; avoids re-deriving from id)
  /** Total (video+audio) target bitrate in bps for this rung, from the
   *  backend — the authoritative per-rung bitrate for the stats overlay. */
  totalBitrateBps?: number;
  /** Low-consumption ("faible consommation") rung. */
  lowBandwidth?: boolean;
}

/** Persisted user choice for quality (same key across sessions). */
const PLAYER_QUALITY_STORAGE_KEY = 'player.qualityId';

/** ABR: prefer starting at 720p+ and staying there; go below only when no variant meets the restriction. */
// Seed high so Shaka picks the top variant on the first segment; ABR recalibrates once real bandwidth is observed.
const ABR_DEFAULT_BANDWIDTH_ESTIMATE = 100_000_000;

/** Find a variant track by profile name in its URL (e.g. '480p' matches '/480p/'), or null. */
export function findVariantByProfileName(tracks: VariantTrack[], profileName: string): VariantTrack | null {
  const path = `/${profileName}/`;
  return tracks.find((t) => t.originalVideoId?.includes(path)) ?? null;
}

/** Largest variant height ≤ targetHeight; the smallest if none fits. */
export function findBestVariantForHeight(tracks: VariantTrack[], targetHeight: number): VariantTrack {
  const below = tracks.filter((t) => (t.height ?? 0) <= targetHeight);
  if (below.length) {
    return below.reduce((a, b) => ((a.height ?? 0) >= (b.height ?? 0) ? a : b));
  }
  return tracks.reduce((a, b) => ((a.height ?? 0) <= (b.height ?? 0) ? a : b));
}

/** Id of the highest-resolution rung excluding 'auto'; undefined for an empty or auto-only list. */
export function highestRungId(options: QualityOption[]): string | undefined {
  const rungs = options.filter((q) => q.id !== 'auto');
  if (!rungs.length) return undefined;
  return rungs.reduce((a, b) => (b.height > a.height ? b : a)).id;
}

@Injectable({ providedIn: 'root' })
export class QualityManagerService {
  private readonly translate = inject(TranslateService);
  private readonly playerSettings = inject(PlayerSettingsService);
  readonly activeQualityId = signal('auto');
  readonly availableQualities = signal<QualityOption[]>([]);
  readonly activeResolution = signal('');

  /** Build the quality options from playback info: the backend's authoritative `qualities` list plus "Auto". */
  buildQualityOptions(playbackInfo: {
    playMethod: string;
    videoCopyStream: boolean;
    source: { width?: number; height?: number };
    qualities?: {
      id: string;
      label: string;
      height: number;
      width?: number;
      totalBitrateBps?: number;
      lowBandwidth?: boolean;
    }[];
  }): void {
    const prefs = this.playerSettings.get();
    const all: QualityOption[] = [
      { id: 'auto', label: this.translate.instant('player.auto'), height: 0 },
    ];
    for (const q of playbackInfo.qualities ?? []) {
      all.push({
        id: q.id,
        label: q.label,
        height: q.height,
        width: q.width,
        totalBitrateBps: q.totalBitrateBps,
        lowBandwidth: q.lowBandwidth,
      });
    }
    // Hide the eco rungs entirely when the player setting says so.
    const visible = prefs.showEcoQualities
      ? all
      : all.filter((q) => !q.lowBandwidth);
    this.availableQualities.set(visible);
  }

  /** Id of the highest rung offered (excluding 'auto'); pins a no-ABR engine (desktop mpv) to one variant. */
  topRungId(): string | undefined {
    return highestRungId(this.availableQualities());
  }

  /** Restore the persisted rung BEFORE negotiating playback; applied verbatim since the backend resolves rungs minted on another ladder. */
  restorePreference(): void {
    this.activeQualityId.set(this.readFromStorage() ?? 'auto');
  }

  /** Adopt the rung the backend reports for the negotiated session, so the selector names what is served. */
  adoptNegotiatedQuality(id: string | undefined): void {
    if (id) this.activeQualityId.set(id);
  }

  /** Select a quality option: configure ABR or lock to a variant. `persist` false for internal restore/fallback calls so they don't overwrite the preference. */
  selectQuality(
    option: QualityOption,
    engine: PlaybackEngine | null,
    playbackMode: PlaybackMode,
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
        engine.configure?.({
          abr: {
            enabled: true,
            defaultBandwidthEstimate: ABR_DEFAULT_BANDWIDTH_ESTIMATE,
            // useNetworkInformation is conservative or unsupported; seed from our estimate and let Shaka measure real segments.
            useNetworkInformation: false,
            switchInterval: 5,              // Re-evaluate every 5s (default: 8)
            bandwidthUpgradeTarget: 0.7,    // Upgrade at 70% headroom (default: 0.85 = more conservative)
            bandwidthDowngradeTarget: 0.95, // Downgrade only when nearly saturated
            // Don't fetch a rung larger than the player element (DPR-aware):
            // a 4K rung on a 1080p view only wastes bandwidth and stalls slow links.
            restrictToElementSize: true,
            advanced: {
              // 5 MB observed before ABR decides: a slow FFmpeg first segment would otherwise read as saturation at the 128 KB default.
              minTotalBytes: 5_000_000,
              // Longer window (default ~9s) so a transcode-warmup outlier weighs less.
              slowHalfLife: 30,
            },
          },
          streaming: { bufferBehind: 5 },
        });
      } else {
        engine.configure?.({ abr: { enabled: true } });
      }
      return;
    }

    // Disable ABR and lock to a specific variant
    engine.configure?.({ abr: { enabled: false } });
    const allTracks = engine.getVariantTracks?.() ?? [];

    if (!allTracks.length) {
      // No variant tracks (native player): use profile maxWidth; must match backend PROFILES exactly (ExoPlayer off-by-one).
      const isOriginal = option.id === 'original';
      const w = isOriginal
        ? 99999
        : (option.width ??
          widthForProfile(option.id) ??
          Math.round((option.height * 16) / 9));
      const h = isOriginal ? 99999 : option.height;
      engine.selectVariantTrack?.({ height: h, width: w }, true);
      return;
    }

    // Preserve current audio track: filter variants to those matching the active audioId
    const activeTrack = allTracks.find((t) => t.active);
    const activeAudioId = activeTrack?.audioId;
    const tracks =
      activeAudioId != null
        ? allTracks.filter((t) => t.audioId === activeAudioId)
        : allTracks;
    const candidates = tracks.length ? tracks : allTracks;

    const wasPaused = engine.paused;

    const target = option.id === 'original'
      ? candidates.reduce((a, b) => ((a.height ?? 0) >= (b.height ?? 0) ? a : b))
      : findVariantByProfileName(candidates, option.id)
        ?? findBestVariantForHeight(candidates, option.height);

    // Skip when already on the target, one resolution exists or no active track yet: avoids clearBuffer cancelling init.mp4.
    if (target && activeTrack && target.id === activeTrack.id) return;
    // Deduplicate by video height — multi-audio creates N variants per resolution.
    const uniqueHeights = new Set(candidates.map((t) => t.height));
    if (uniqueHeights.size <= 1) return;

    engine.selectVariantTrack?.(target, true);

    // Restore pause state — clearBuffer can trigger autoplay
    if (wasPaused) engine.pause();
  }

  /** After buildQualityOptions + adoptNegotiatedQuality: re-apply the active rung to the engine with force=true. */
  applyQualityPreferenceAfterLoad(
    engine: PlaybackEngine | null,
    playbackMode: PlaybackMode,
  ): void {
    const option = this.availableQualities().find(q => q.id === this.activeQualityId())
      ?? this.availableQualities().find(q => q.id === 'auto')
      ?? this.availableQualities()[0];
    if (!option) return;
    this.selectQuality(option, engine, playbackMode, true);
  }

  /** Persist the chosen rung id. Re-sent on the next negotiation, where the
   *  backend maps it onto the ladder it serves. */
  persistPreference(option: QualityOption): void {
    try {
      localStorage.setItem(
        PLAYER_QUALITY_STORAGE_KEY,
        JSON.stringify({ id: option.id }),
      );
    } catch {
      /* private mode / quota */
    }
  }

  /** Resolution label from width/height via the shared bucketing helper (anamorphic/scope crops, e.g. 1918×872 → 1080p). */
  resolutionLabel(w?: number, h?: number): string {
    return bucketResolutionLabel(w, h) ?? (w && h ? `${w}x${h}` : '?');
  }

  /** Map a variant's dimensions to its transcode profile name via {@link bucketResolutionLabel}; width matters since cropped sources expose cropped dimensions. */
  transcodeTierFromVariantHeight(h: number, w?: number): string | null {
    if (h <= 0) return null;
    const label = bucketResolutionLabel(w, h);
    if (!label) return null;
    return label === '4K' ? '2160p' : label;
  }

  // ── Private helpers ──

  private readFromStorage(): string | null {
    try {
      const raw = localStorage.getItem(PLAYER_QUALITY_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { id?: string };
      return typeof parsed.id === 'string' ? parsed.id : null;
    } catch {
      return null;
    }
  }
}
