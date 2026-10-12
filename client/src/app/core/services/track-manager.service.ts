import { Injectable, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import {
  PlayerSettingsService,
  matchRememberedAudio,
  parseRememberedSubtitle,
  pickAudioStreamForLanguage,
  rememberedAudioKey,
  rememberedSubtitleValue,
  type AudioStreamChoice,
  type HearingImpairedPreference,
} from './player-settings.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { StreamingApiService } from './api/streaming-api.service';
import { AppSettingsService } from './app-settings.service';
import { formatSubtitleLabel, formatSubtitleParts, type SubtitleLabelSource } from '../utils/player.utils';
import { isImageBasedSubtitleCodec } from '../utils/subtitle-codecs';
import { buildSubtitleTracks } from '../utils/subtitle-tracks';
import { normalizeLangCode, normalizeLangTag } from '../utils/language.utils';
import type { PlaybackEngine, AudioTrack } from './playback-engine/playback-engine';

export interface SubtitleOption {
  id: string;
  label: string;
  url: string;
  language: string;
  /** BCP-47 tag of an embedded track (`pt-PT`): the variant a remembered pick pins down. */
  languageTag?: string | null;
  /** True for bitmap subs (PGS/VOBSUB), regardless of how they're shown. */
  isImage?: boolean;
  /** True for a bitmap sub, embedded or external: it is burned in server-side
   *  unless the engine renders it from the playback in hand (the player decides
   *  per playback, see `PlayerComponent.burnsIn`). */
  burnIn: boolean;
  /** Database subtitle ID (for burn-in request) */
  subtitleDbId?: number;
  /** The track's online id (`emb-<streamIndex>` / `ext-<id>`) when `id` is a local one (offline copies). */
  trackKey?: string;
  /** True if this is a forced subtitle track */
  forced?: boolean;
  hearingImpaired?: boolean;
  /** Origin: `translated`, `ocr`, `embedded`, or a download provider name. */
  providerType?: string | null;
  /** Player-menu two-line label: language head + details subline ("SRT • …"). */
  menuHead?: string;
  menuSub?: string;
}

/** What a viewer picked before pressing play, for one file. A one-shot launch intent: it wins over
 *  the remembered and automatic rules, and is never written to the remembered store by itself. */
export interface LaunchTracks {
  fileId: number;
  audioStreamIndex?: number;
  /** `null` is an explicit Off. */
  subtitleId?: string | null;
}

/** The launch intent, for the file it was made on only: a pick never carries over to another file. */
export function launchPickFor(tracks: LaunchTracks | null | undefined, fileId: number): LaunchTracks | null {
  return tracks?.fileId === fileId ? tracks : null;
}

@Injectable({ providedIn: 'root' })
export class TrackManagerService {
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly appSettings = inject(AppSettingsService);
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
      const match = idx != null ? trackForStreamIndex(idx, source, tracks) : undefined;
      if (match) {
        if (match.id !== activeAudioTrackId) onSelect(match.id);
        return;
      }
    }

    // Priority 2: the mode's target language, picked by the rule
    // resolveAudioStreamIndex applies before load.
    const lang = this.playerSettings.audioLanguage(originalLanguage);
    const source = streams?.length ? streams : tracks;
    const idx = lang ? pickAudioStreamForLanguage(source, lang) : undefined;
    const match = idx != null ? trackForStreamIndex(idx, source, tracks) : undefined;
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
   *  Stores "language[:forced][:embedded][:image][:hi][:variant]", or "off" when disabled. */
  saveSubtitleSelection(
    mediaId: number,
    language: string | null,
    forced = false,
    embedded = false,
    image = false,
    hearingImpaired = false,
    languageTag?: string | null,
  ): void {
    if (!this.playerSettings.get().rememberSubtitleSelections || !mediaId) return;
    const value = language ? rememberedSubtitleValue(language, { forced, embedded, image, hearingImpaired }, languageTag) : 'off';
    this.playerSettings.saveRememberedSubtitleTrack(mediaId, value);
  }

  // ── Subtitle methods ──

  /** Menu labels for a subtitle: the one-line label and the two-line head/sub. */
  describeSubtitle(
    sub: SubtitleLabelSource,
    trackNumber: number,
  ): Pick<SubtitleOption, 'label' | 'menuHead' | 'menuSub'> {
    const opts = { showFormat: this.appSettings.showSubtitleFormat() };
    const parts = formatSubtitleParts(sub, this.translate, trackNumber, opts);
    return { label: formatSubtitleLabel(sub, this.translate, trackNumber, opts), menuHead: parts.head, menuSub: parts.sub };
  }

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
      const subs = await this.subtitlesApi.getForMedia(mediaId);
      const file = media?.files?.find((f) => f.id === mediaFileId);
      const si = file?.streamInfo as any;
      const tracks = buildSubtitleTracks(subs, mediaFileId, { hideBurnIn, streams: si?.subtitles });
      const options: SubtitleOption[] = tracks.map((t, i) => ({
        id: t.key,
        ...this.describeSubtitle(t, i + 1),
        url:
          t.kind === 'external'
            ? streamingApi.getSubtitleUrl(mediaFileId, t.subtitleId)
            : t.isImage
              ? ''
              : streamingApi.getEmbeddedSubtitleUrl(mediaFileId, t.streamIndex!),
        language: t.language,
        languageTag: t.languageTag,
        isImage: t.isImage,
        burnIn: t.isImage,
        subtitleDbId: t.subtitleId,
        forced: t.forced,
        hearingImpaired: t.hearingImpaired,
        providerType: t.providerType,
      }));
      const seen = new Set(tracks.map((t) => t.key));

      // Also check streamInfo for embedded subs not yet in DB
      if (si?.subtitles?.length) {
        for (const emb of si.subtitles) {
          const key = `emb-${emb.streamIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (isImageBasedSubtitleCodec(emb.codec)) continue; // Bitmap from streamInfo only (no DB ID for burn-in)
          // Numbering continues the list, so a track keeps the position the
          // menu shows it at.
          options.push({
            id: key,
            ...this.describeSubtitle(emb, options.length + 1),
            url: streamingApi.getEmbeddedSubtitleUrl(mediaFileId, emb.streamIndex),
            language: normalizeLangCode(emb.language),
            languageTag: emb.languageTag,
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
   * @param mediaId            Media ID the remembered selection is keyed by
   * @param audioLanguage      Language of the audio stream that will play, when known
   *                           before any engine lists a track: it wins over `audioTracks`
   * @param picked             The viewer's pick for this launch (`null`: Off), honoured before
   *                           any rule; an id not in `subtitles` is ignored
   */
  async autoSelectSubtitle(
    subtitles: SubtitleOption[],
    audioTracks: { id: string; language: string }[],
    activeAudioTrackId: string | null,
    mediaFileId: number,
    onSelect: (sub: SubtitleOption | null) => Promise<unknown>,
    mediaId = 0,
    audioLanguage?: string,
    picked?: string | null,
  ): Promise<void> {
    const settings = this.playerSettings.get();

    const pick = picked == null ? picked : subtitles.find((s) => s.id === picked);
    if (pick !== undefined) {
      if (pick) await onSelect(pick);
      return;
    }

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
        const {
          language: savedLang, forced: wantForced, embedded: wantEmbedded, image: wantImage,
          hearingImpaired: wantHi, variant,
        } = parseRememberedSubtitle(saved);
        const isEmbedded = (s: SubtitleOption) => s.id.startsWith('emb-');
        const sameImage = (s: SubtitleOption) => !!s.isImage === wantImage;
        const sameHi = (s: SubtitleOption) => !!s.hearingImpaired === wantHi;
        // Forced-ness is never relaxed: a full track doesn't stand in for a forced
        // one (it translates dialogue the viewer follows), nor the reverse.
        const sameKind = (s: SubtitleOption) => s.language === savedLang && !!s.forced === wantForced;
        // Restore image picks too — selectSubtitle renders them natively
        // (direct play) or burns them in (web / transcode).
        const pool = wantImage ? subtitles : subs;
        // Best match: language + forced + image-ness + hearing-impaired + type (embedded/external).
        const find = (ok: (s: SubtitleOption) => boolean) =>
          pool.find((s) => ok(s) && sameKind(s) && sameImage(s) && sameHi(s) && isEmbedded(s) === wantEmbedded)
          ?? pool.find((s) => ok(s) && sameKind(s) && sameImage(s) && sameHi(s))
          ?? pool.find((s) => ok(s) && sameKind(s) && sameImage(s))
          ?? subs.find((s) => ok(s) && sameKind(s));
        // The remembered variant wins; another track of the language stands in when it is gone.
        const match = (variant ? find((s) => normalizeLangTag(s.languageTag) === variant) : undefined) ?? find(() => true);
        if (match) { await onSelect(match); return; }
      }
    }

    if (settings.subtitleMode === 'off') return;

    const activeAudio = audioTracks.find((t) => t.id === activeAudioTrackId);
    const audioLang = audioLanguage
      ? normalizeLangCode(audioLanguage)
      : (activeAudio?.language ?? 'und');
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

/** Maps a `streams`-order index to its engine track: by position when the lists align,
 *  else by language (webOS folds same-language streams into one track). */
export function trackForStreamIndex<T extends { id: string; language: string }>(
  idx: number,
  streams: AudioStreamChoice[],
  tracks: T[],
): T | undefined {
  if (!streams[idx]) return undefined;
  if (streams.length === tracks.length) return tracks[idx];
  const lang = normalizeLangCode(streams[idx].language);
  return tracks.find((t) => normalizeLangCode(t.language) === lang);
}

/** The reverse of {@link trackForStreamIndex}: the `streams` index an engine track plays.
 *  A folded track stands for several streams of its language; `hint` (the index already
 *  targeted) wins when it is one of them, so a report of the folded track keeps a pick of
 *  its commentary rendition. Undefined when the track or the streams are unknown. */
export function streamIndexForTrack(
  trackId: string,
  tracks: { id: string; language: string }[],
  streams: AudioStreamChoice[],
  hint?: number,
): number | undefined {
  const pos = tracks.findIndex((t) => t.id === trackId);
  if (pos < 0 || !streams.length) return undefined;
  if (streams.length === tracks.length) return pos;
  const lang = normalizeLangCode(tracks[pos].language);
  const same = streams
    .map((s, i) => (normalizeLangCode(s.language) === lang ? i : -1))
    .filter((i) => i >= 0);
  return hint != null && same.includes(hint) ? hint : same[0];
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
