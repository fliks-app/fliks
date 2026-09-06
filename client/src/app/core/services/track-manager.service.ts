import { Injectable, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { PlayerSettingsService, normalizeLang } from './player-settings.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { StreamingApiService } from './api/streaming-api.service';
import { AppSettingsService } from './app-settings.service';
import { BrowserDeviceProfileService } from './browser-device-profile.service';
import { formatSubtitleLabel, formatSubtitleParts } from '../utils/player.utils';
import { isImageBasedSubtitleCodec } from '../utils/subtitle-codecs';
import { buildSubtitleTracks } from '../utils/subtitle-tracks';
import type { PlaybackEngine, AudioTrack } from './playback-engine/playback-engine';

export interface SubtitleOption {
  id: string;
  label: string;
  url: string;
  language: string;
  /** True for bitmap subs (PGS/VOBSUB), regardless of how they're shown. */
  isImage?: boolean;
  /** True when this bitmap sub must be burned in server-side (the device can't
   *  render image subtitles natively). */
  burnIn: boolean;
  /** Database subtitle ID (for burn-in request) */
  subtitleDbId?: number;
  /** True if this is a forced subtitle track */
  forced?: boolean;
  hearingImpaired?: boolean;
  /** Origin: `translated`, `ocr`, `embedded`, or a download provider name. */
  providerType?: string | null;
  /** Player-menu two-line label: language head + details subline ("SRT • …"). */
  menuHead?: string;
  menuSub?: string;
}

@Injectable({ providedIn: 'root' })
export class TrackManagerService {
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly appSettings = inject(AppSettingsService);
  private readonly deviceProfile = inject(BrowserDeviceProfileService);
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
   *  Stores "language[:forced][:embedded][:image][:hi]", or "off" when disabled. */
  saveSubtitleSelection(mediaId: number, language: string | null, forced = false, embedded = false, image = false, hearingImpaired = false): void {
    if (!this.playerSettings.get().rememberSubtitleSelections || !mediaId) return;
    const flags = [forced ? 'forced' : '', embedded ? 'embedded' : '', image ? 'image' : '', hearingImpaired ? 'hi' : ''].filter(Boolean).join(':');
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
      const hideBurnIn = this.appSettings.hideBurnInSubtitles();
      // Devices whose player renders bitmap subs itself (ExoPlayer, mpv) show
      // them natively; others burn them into the video server-side.
      const rendersImageNatively =
        !!this.deviceProfile.getProfile().supportsImageSubtitles;
      const labelOpts = { showFormat: this.appSettings.showSubtitleFormat() };
      const subs = await this.subtitlesApi.getForMedia(mediaId);
      const tracks = buildSubtitleTracks(subs, mediaFileId, { hideBurnIn });
      const options: SubtitleOption[] = tracks.map((t, i) => {
        const parts = formatSubtitleParts(t, this.translate, i + 1, labelOpts);
        return {
        id: t.key,
        label: formatSubtitleLabel(t, this.translate, i + 1, labelOpts),
        menuHead: parts.head,
        menuSub: parts.sub,
        url:
          t.kind === 'external'
            ? streamingApi.getSubtitleUrl(mediaFileId, t.subtitleId)
            : t.isImage
              ? ''
              : streamingApi.getEmbeddedSubtitleUrl(mediaFileId, t.streamIndex!),
        language: t.language,
        isImage: t.isImage,
        burnIn: t.kind === 'embedded' && t.isImage && !rendersImageNatively,
        subtitleDbId: t.subtitleId,
        forced: t.forced,
        hearingImpaired: t.hearingImpaired,
        providerType: t.providerType,
        };
      });
      const seen = new Set(tracks.map((t) => t.key));

      // Also check streamInfo for embedded subs not yet in DB
      const file = media?.files?.find((f) => f.id === mediaFileId);
      const si = file?.streamInfo as any;
      if (si?.subtitles?.length) {
        for (const emb of si.subtitles) {
          const key = `emb-${emb.streamIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (isImageBasedSubtitleCodec(emb.codec)) continue; // Bitmap from streamInfo only (no DB ID for burn-in)
          // Numbering continues the list, so a track keeps the position the
          // menu shows it at.
          const trackNumber = options.length + 1;
          const embParts = formatSubtitleParts(emb, this.translate, trackNumber, labelOpts);
          options.push({
            id: key,
            label: formatSubtitleLabel(emb, this.translate, trackNumber, labelOpts),
            menuHead: embParts.head,
            menuSub: embParts.sub,
            url: streamingApi.getEmbeddedSubtitleUrl(mediaFileId, emb.streamIndex),
            language: emb.language,
            burnIn: false,
            forced: emb.forced ?? false,
            hearingImpaired: emb.hearingImpaired ?? false,
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
    const subs = subtitles.filter((s) => !s.isImage);
    if (!subs.length && !subtitles.length) return;

    // Priority 1: remembered selection by "language[:forced][:embedded][:image][:hi]" or "off"
    if (settings.rememberSubtitleSelections) {
      const saved = this.playerSettings.getRememberedSubtitleTrack(mediaId);
      if (saved === 'off') return; // User explicitly disabled subtitles
      if (saved) {
        const parts = saved.split(':');
        const savedLang = parts[0];
        const wantForced = parts.includes('forced');
        const wantEmbedded = parts.includes('embedded');
        const wantImage = parts.includes('image');
        const wantHi = parts.includes('hi');
        const isEmbedded = (s: SubtitleOption) => s.id.startsWith('emb-');
        const sameImage = (s: SubtitleOption) => !!s.isImage === wantImage;
        const sameHi = (s: SubtitleOption) => !!s.hearingImpaired === wantHi;
        // Restore image picks too — selectSubtitle renders them natively
        // (direct play) or burns them in (web / transcode).
        const pool = wantImage ? subtitles : subs;
        // Best match: language + image-ness + forced + hearing-impaired + type (embedded/external).
        const match =
          pool.find((s) => s.language === savedLang && sameImage(s) && !!s.forced === wantForced && sameHi(s) && isEmbedded(s) === wantEmbedded)
          ?? pool.find((s) => s.language === savedLang && sameImage(s) && !!s.forced === wantForced && sameHi(s))
          ?? pool.find((s) => s.language === savedLang && sameImage(s) && !!s.forced === wantForced)
          ?? pool.find((s) => s.language === savedLang && sameImage(s))
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

    // Prefer a real (downloaded / embedded) track over a machine-generated one
    // (translated / OCR) for the same language, so auto-select doesn't silently
    // land on a machine translation when a native sub exists.
    const isMachine = (s: SubtitleOption) =>
      s.providerType === 'translated' || s.providerType === 'ocr';
    const findMatch = () =>
      subs.find((s) => s.language === prefLang && !s.forced && !isMachine(s))
      ?? subs.find((s) => s.language === prefLang && !s.forced)
      ?? subs.find((s) => s.language === prefLang && !isMachine(s))
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
