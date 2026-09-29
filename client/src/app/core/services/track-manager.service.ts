import { Injectable, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import {
  PlayerSettingsService,
  matchRememberedAudio,
  rememberedAudioKey,
  type AudioStreamChoice,
  type HearingImpairedPreference,
} from './player-settings.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { StreamingApiService } from './api/streaming-api.service';
import { AppSettingsService } from './app-settings.service';
import { BrowserDeviceProfileService } from './browser-device-profile.service';
import { formatSubtitleLabel, formatSubtitleParts } from '../utils/player.utils';
import { isImageBasedSubtitleCodec } from '../utils/subtitle-codecs';
import { buildSubtitleTracks } from '../utils/subtitle-tracks';
import { normalizeLangCode } from '../utils/language.utils';
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

  /** Maps a `streams`-order index to its engine track: by position when the lists align,
   *  else by language (webOS folds same-language streams into one track). */
  private trackForStreamIndex<T extends { id: string; language: string }>(
    idx: number,
    streams: AudioStreamChoice[],
    tracks: T[],
  ): T | undefined {
    if (streams.length === tracks.length) return tracks[idx];
    const lang = normalizeLangCode(streams[idx]?.language);
    return tracks.find((t) => normalizeLangCode(t.language) === lang);
  }

  /**
   * Auto-select audio track based on user preferences.
   *
   * @param tracks        Available audio tracks
   * @param mediaId       Media ID (series/movie)
   * @param mediaFileId   Media file ID
   * @param activeAudioTrackId  Currently active audio track ID
   * @param onSelect      Callback invoked with the track ID to select
   * @param originalLanguage The title's original language, for `original` mode
   */
  autoSelectAudioTrack(
    tracks: { id: string; language: string }[],
    mediaId: number,
    mediaFileId: number,
    activeAudioTrackId: string | null,
    onSelect: (trackId: string) => void,
    originalLanguage?: string | null,
    streams?: AudioStreamChoice[],
  ): void {
    const settings = this.playerSettings.get();
    const key = mediaId;

    // Priority 1: the remembered selection, matched on `streams` (the tracks'
    // stream info) when given, else on the tracks' languages alone.
    if (settings.rememberAudioSelections) {
      const saved = this.playerSettings.getRememberedAudioTrack(key);
      const source = streams?.length ? streams : tracks;
      const idx = saved ? matchRememberedAudio(saved, source) : undefined;
      const match = idx != null ? this.trackForStreamIndex(idx, source, tracks) : undefined;
      if (match && match.id !== activeAudioTrackId) {
        onSelect(match.id);
        return;
      }
    }

    // Priority 2: the mode's target language.
    const lang = this.playerSettings.audioLanguage(originalLanguage);
    const match = lang
      ? tracks.find((t) => normalizeLangCode(t.language) === normalizeLangCode(lang))
      : undefined;
    if (match && match.id !== activeAudioTrackId) onSelect(match.id);
  }

  /** Remember a track by language, role and channel count (from `streams`, in track
   *  order, when the tracks lack them): episodes order their tracks differently. */
  saveAudioSelection(
    trackId: string,
    tracks: (AudioStreamChoice & { id: string })[],
    mediaId: number,
    streams?: AudioStreamChoice[],
  ): void {
    if (!this.playerSettings.get().rememberAudioSelections) return;
    const pos = tracks.findIndex((t) => t.id === trackId);
    if (pos < 0) return;
    const track = tracks[pos];
    // Position only matches `streams` when the lists align; some engines
    // (webOS) fold streamInfo entries that share a language into one track.
    const streamInfo = !streams?.length
      ? undefined
      : streams.length === tracks.length
        ? streams[pos]
        : streams.find((s) => normalizeLangCode(s.language) === normalizeLangCode(track.language));
    this.playerSettings.saveRememberedAudioTrack(
      mediaId,
      rememberedAudioKey(streamInfo ?? track),
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
            language: normalizeLangCode(emb.language),
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
        const savedLang = normalizeLangCode(parts[0]);
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

    const activeAudio = audioTracks.find((t) => t.id === activeAudioTrackId);
    const audioLang = activeAudio?.language ?? 'und';
    const prefLang = settings.preferredSubtitleLanguage;
    const hi = settings.subtitleHearingImpaired;

    // A forced track translates the foreign lines of dialogue the viewer already
    // understands, so with no preferred language it belongs to the audio's.
    if (settings.subtitleMode === 'onlyForced') {
      const lang = prefLang || (audioLang === 'und' ? '' : audioLang);
      const match = lang ? pickSubtitle(subs, lang, { forced: true, hi, only: true }) : undefined;
      if (match) await onSelect(match);
      return;
    }

    if (!prefLang) {
      // Fallback: try old localStorage key for migration
      const oldLang = localStorage.getItem('player.subtitleLang');
      if (oldLang) {
        const want = normalizeLangCode(oldLang);
        const match = subs.find((s) => s.language === want);
        if (match) await onSelect(match);
      }
      return;
    }

    if (settings.subtitleMode === 'always') {
      const match = pickSubtitle(subs, prefLang, { forced: false, hi });
      if (match) await onSelect(match);
      return;
    }

    if (settings.subtitleMode === 'intelligent') {
      // Dialogue already in the viewer's language: only its foreign lines need a
      // sub. Untagged audio counts as foreign: nothing says it isn't.
      const forcedOnly = audioLang === prefLang;
      const match = pickSubtitle(subs, prefLang, { forced: forcedOnly, hi, only: forcedOnly });
      if (match) await onSelect(match);
    }
  }
}

/** Machine-made subs (translated / OCR) read worse than a real track, so they
 *  lose every tie. */
function isMachine(s: SubtitleOption): boolean {
  return s.providerType === 'translated' || s.providerType === 'ocr';
}

/**
 * The track auto-selection settles on, in one preference order: the wanted
 * forced-ness first, then the viewer's hearing-impaired preference, then a real
 * track over a machine-made one. Every criterion is a preference, not a filter
 * (a language with nothing but an SDH track still gets subtitles), except
 * `only`, which drops non-forced tracks outright for the modes that mean it.
 */
export function pickSubtitle(
  subs: SubtitleOption[],
  language: string,
  want: { forced: boolean; hi: HearingImpairedPreference; only?: boolean },
): SubtitleOption | undefined {
  const hiPenalty = (s: SubtitleOption) => {
    if (want.hi === 'prefer') return s.hearingImpaired ? 0 : 1;
    if (want.hi === 'avoid') return s.hearingImpaired ? 1 : 0;
    return 0;
  };
  const rank = (s: SubtitleOption) =>
    (!!s.forced === want.forced ? 0 : 4) + hiPenalty(s) * 2 + (isMachine(s) ? 1 : 0);
  return subs
    .filter((s) => s.language === language && (!want.only || !!s.forced))
    .sort((a, b) => rank(a) - rank(b))[0];
}
