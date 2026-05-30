import { Injectable, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { PlayerSettingsService, normalizeLang } from './player-settings.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { StreamingApiService } from './api/streaming-api.service';
import { formatSubtitleLabel } from '../utils/player.utils';
import type { PlaybackEngine, AudioTrack } from './playback-engine/playback-engine';

export interface SubtitleOption {
  id: string;
  label: string;
  url: string;
  language: string;
  /** True for bitmap subs (PGS/VOBSUB) that need server-side burn-in */
  burnIn: boolean;
  /** Database subtitle ID (for burn-in request) */
  subtitleDbId?: number;
  /** True if this is a forced subtitle track */
  forced?: boolean;
}

@Injectable({ providedIn: 'root' })
export class TrackManagerService {
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly translate = inject(TranslateService);

  // ── Audio track methods ──

  /**
   * Auto-select audio track based on user preferences.
   *
   * @param tracks        Available audio tracks
   * @param mediaId       Media ID (series/movie)
   * @param mediaFileId   Media file ID
   * @param activeAudioTrackId  Currently active audio track ID
   * @param onSelect      Callback invoked with the track ID to select
   */
  autoSelectAudioTrack(
    tracks: { id: string; language: string }[],
    mediaId: number,
    mediaFileId: number,
    activeAudioTrackId: string | null,
    onSelect: (trackId: string) => void,
  ): void {
    const settings = this.playerSettings.get();

    // "Use default audio stream" only applies when no remembered selection exists
    // (i.e. first time watching). On refresh, the saved choice takes priority.
    const key = mediaId;
    const hasSavedSelection = settings.rememberAudioSelections &&
      !!this.playerSettings.getRememberedAudioTrack(key);
    if (settings.useDefaultAudioStream && !hasSavedSelection) return;

    // Priority 1: remembered selection for this media (saved as "language" or
    // "language:ordinal" — see saveAudioSelection). The ordinal picks the Nth
    // same-language rendition; it falls back to the first if the layout drifted.
    if (settings.rememberAudioSelections) {
      const saved = this.playerSettings.getRememberedAudioTrack(key);
      if (saved) {
        const [savedLang, ordStr] = saved.split(':');
        const ordinal = ordStr ? parseInt(ordStr, 10) : 0;
        const sameLang = tracks.filter((t) => t.language === savedLang);
        const match = sameLang[ordinal] ?? sameLang[0];
        if (match && match.id !== activeAudioTrackId) {
          onSelect(match.id);
          return;
        }
      }
    }

    // Priority 2: preferred language
    if (settings.preferredAudioLanguage) {
      const match = tracks.find(
        (t) => t.language === settings.preferredAudioLanguage,
      );
      if (match && match.id !== activeAudioTrackId) {
        onSelect(match.id);
      }
    }
  }

  /**
   * Save the user's audio track selection (by language) so it carries across episodes.
   */
  saveAudioSelection(
    trackId: string,
    tracks: { id: string; language?: string }[],
    mediaId: number,
    mediaFileId?: number,
  ): void {
    if (!this.playerSettings.get().rememberAudioSelections) return;
    const track = tracks.find((t) => t.id === trackId);
    const lang = track?.language ?? trackId;
    // Disambiguate multiple same-language renditions (e.g. 5.1 vs stereo) by
    // their ordinal among same-language tracks — language alone can never reach
    // the 2nd one. Reproducible across episodes when the audio layout is
    // consistent. The ":n" suffix is only added past the first, so single-track
    // languages stay a plain code; the language-keyed pre-load paths strip it.
    const sameLang = tracks.filter((t) => (t.language ?? '') === lang);
    const ordinal = sameLang.findIndex((t) => t.id === trackId);
    const key = mediaId;
    this.playerSettings.saveRememberedAudioTrack(
      key,
      ordinal > 0 ? `${lang}:${ordinal}` : lang,
    );
  }

  /** Save subtitle selection for this media. Pass null = user explicitly disabled.
   *  Stores "language:forced:embedded", or "off" when disabled. */
  saveSubtitleSelection(mediaId: number, language: string | null, forced = false, embedded = false): void {
    if (!this.playerSettings.get().rememberSubtitleSelections || !mediaId) return;
    const flags = [forced ? 'forced' : '', embedded ? 'embedded' : ''].filter(Boolean).join(':');
    const value = language ? `${language}${flags ? ':' + flags : ''}` : 'off';
    this.playerSettings.saveRememberedSubtitleTrack(mediaId, value);
  }

  // ── Subtitle methods ──

  /**
   * Load subtitle options from the API and embedded stream info.
   *
   * @param mediaId       Media ID
   * @param mediaFileId   Media file ID
   * @param streamingApi  StreamingApiService for building subtitle URLs
   * @param media         Media object (needs `files[].streamInfo`)
   * @returns Array of subtitle options
   */
  async loadSubtitles(
    mediaId: number,
    mediaFileId: number,
    streamingApi: StreamingApiService,
    media: { files?: { id: number; streamInfo?: any }[] } | null,
  ): Promise<SubtitleOption[]> {
    if (!mediaId) return [];

    try {
      const options: SubtitleOption[] = [];
      const subs = await this.subtitlesApi.getForMedia(mediaId);
      const bitmapCodecs = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle']);
      const seen = new Set<string>();

      for (const sub of subs) {
        if (sub.mediaFileId !== mediaFileId) continue;
        const isBitmap = bitmapCodecs.has(sub.codec ?? '');

        if (sub.relativePath) {
          const key = `ext-${sub.language}-${sub.forced}-${sub.hearingImpaired}`;
          if (seen.has(key)) continue;
          seen.add(key);
          options.push({
            id: `ext-${sub.id}`,
            label: formatSubtitleLabel(sub, this.translate),
            url: streamingApi.getSubtitleUrl(mediaFileId, sub.id),
            language: sub.language,
            burnIn: false,
            subtitleDbId: sub.id,
            forced: sub.forced ?? false,
          });
        } else if (sub.streamIndex != null) {
          const key = `emb-${sub.streamIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          options.push({
            id: key,
            label: formatSubtitleLabel(sub, this.translate),
            url: isBitmap ? '' : streamingApi.getEmbeddedSubtitleUrl(mediaFileId, sub.streamIndex!),
            language: sub.language,
            burnIn: isBitmap,
            subtitleDbId: sub.id,
            forced: sub.forced ?? false,
          });
        }
      }

      // Also check streamInfo for embedded subs not yet in DB
      const file = media?.files?.find((f) => f.id === mediaFileId);
      const si = file?.streamInfo as any;
      if (si?.subtitles?.length) {
        for (const emb of si.subtitles) {
          const key = `emb-${emb.streamIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const isBitmap = bitmapCodecs.has(emb.codec);
          if (isBitmap) continue; // Bitmap from streamInfo only (no DB ID for burn-in)
          options.push({
            id: key,
            label: formatSubtitleLabel(emb, this.translate),
            url: streamingApi.getEmbeddedSubtitleUrl(mediaFileId, emb.streamIndex),
            language: emb.language,
            burnIn: false,
            forced: emb.forced ?? false,
          });
        }
      }

      return options;
    } catch {
      // Ignore subtitle loading errors
      return [];
    }
  }

  /**
   * Auto-select subtitle based on user preferences (mode: off/intelligent/always).
   * Burn-in subtitles are excluded to avoid triggering a stream reload during init.
   *
   * @param subtitles          All available subtitle options
   * @param audioTracks        Available audio tracks
   * @param activeAudioTrackId Currently active audio track ID
   * @param mediaFileId        Media file ID (for remembered selections)
   * @param onSelect           Callback to apply the selected subtitle (or null for none)
   */
  async autoSelectSubtitle(
    subtitles: SubtitleOption[],
    audioTracks: { id: string; language: string }[],
    activeAudioTrackId: string | null,
    mediaFileId: number,
    onSelect: (sub: SubtitleOption | null) => Promise<void>,
    mediaId = 0,
  ): Promise<void> {
    const settings = this.playerSettings.get();

    // Exclude burn-in subs (PGS, DVD, etc.) — selecting them calls reloadStream() to bake
    // the subtitle into the video server-side, which kills the active transcode session.
    // During init the transcode just started (possibly with a seek), so reloading would
    // spawn a 3rd ffmpeg process and cause Shaka error 1003. Users can still pick burn-in
    // subs manually from the subtitle menu.
    const subs = subtitles.filter((s) => !s.burnIn);
    if (!subs.length && !subtitles.length) return;

    // Priority 1: remembered selection by "language[:forced][:embedded]" or "off"
    if (settings.rememberSubtitleSelections) {
      const saved = this.playerSettings.getRememberedSubtitleTrack(mediaId);
      if (saved === 'off') return; // User explicitly disabled subtitles
      if (saved) {
        const parts = saved.split(':');
        const savedLang = parts[0];
        const wantForced = parts.includes('forced');
        const wantEmbedded = parts.includes('embedded');
        const isEmbedded = (s: SubtitleOption) => s.id.startsWith('emb-');
        // Best match: same language + same type (embedded/external) + same forced flag
        const match =
          subs.find((s) => s.language === savedLang && !!s.forced === wantForced && isEmbedded(s) === wantEmbedded)
          ?? subs.find((s) => s.language === savedLang && !!s.forced === wantForced)
          ?? subs.find((s) => s.language === savedLang && !s.forced);
        if (match) { await onSelect(match); return; }
      }
    }

    if (settings.subtitleMode === 'off') return;

    const prefLang = settings.preferredSubtitleLanguage;
    if (!prefLang) {
      // Fallback: try old localStorage key for migration
      const oldLang = localStorage.getItem('player.subtitleLang');
      if (oldLang) {
        const match = subs.find((s) => s.language === oldLang);
        if (match) await onSelect(match);
      }
      return;
    }

    const findMatch = () =>
      subs.find((s) => s.language === prefLang && !s.forced)
      ?? subs.find((s) => s.language === prefLang);

    if (settings.subtitleMode === 'always') {
      const match = findMatch();
      if (match) await onSelect(match);
      return;
    }

    // Intelligent mode: show subtitles only when audio language differs from preferred
    if (settings.subtitleMode === 'intelligent') {
      const activeAudio = audioTracks.find((t) => t.id === activeAudioTrackId);
      const audioLang = activeAudio?.language ?? 'und';

      if (audioLang !== prefLang && audioLang !== 'und') {
        const match = findMatch();
        if (match) await onSelect(match);
      }
    }
  }
}
