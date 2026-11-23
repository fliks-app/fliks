import { computed, type Signal } from '@angular/core';
import type { TranslateService } from '@ngx-translate/core';
import type { Episode, Media, Season } from '../../core/services/api/media.service';
import type { MediaResumeInfo } from '../../core/services/api/streaming-api.service';
import type { SpoilerService } from '../../core/services/spoiler.service';
import { episodeBadgeLabel, filesForEpisode, hideShadowedEpisodes } from './media-detail.utils';
import type { MediaFileRow } from './media-detail.utils';
import { nextUp, type NextUp } from '../../shared/utils/media-play.util';

export interface EpisodeViewHost {
  media(): Media | null;
  focusedEpisode(): Episode | null;
  focusedSeason(): Season | null;
  selectedFileId(): number | null;
  resumeInfo(): MediaResumeInfo | null;
}

export interface EpisodeViewDeps {
  spoilers: SpoilerService;
  translate: TranslateService;
  watchedEpisodeIds: Signal<Set<number>>;
}

/** What the episode page and the series header derive from the loaded tree: the focused
 *  episode's files, labels and runtime, the season rows, and the episode Play launches. */
export class EpisodeViewController {
  readonly episodeFiles = computed<MediaFileRow[]>(() => {
    const ep = this.host.focusedEpisode();
    const m = this.host.media();
    if (!ep || !m?.files) return [];
    return filesForEpisode(m.files, ep.id);
  });

  /** `selectedFileId` starts as the show-level resume file; keep it only if it is one of the
   *  focused episode's files, else fall back to the first. */
  readonly episodeActiveFileId = computed(() => {
    const files = this.episodeFiles();
    const current = this.host.selectedFileId();
    if (current != null && files.some((f) => f.id === current)) return current;
    return files[0]?.id ?? null;
  });

  readonly episodeActiveFile = computed(() => {
    const id = this.episodeActiveFileId();
    return this.episodeFiles().find((f) => f.id === id) ?? null;
  });

  readonly episodeLabel = computed(() => {
    const ep = this.host.focusedEpisode();
    const s = this.host.focusedSeason();
    if (!ep || !s) return null;
    const sn = String(s.seasonNumber).padStart(2, '0');
    const start = String(ep.episodeNumber).padStart(2, '0');
    const epPart =
      ep.endEpisodeNumber != null && ep.endEpisodeNumber > ep.episodeNumber
        ? `E${start}-E${String(ep.endEpisodeNumber).padStart(2, '0')}`
        : `E${start}`;
    const code = `S${sn}:${epPart}`;
    if (!ep.title) return code;
    const title = this.deps.spoilers.title(
      this.deps.watchedEpisodeIds().has(ep.id),
      episodeBadgeLabel(ep),
      ep.title,
    );
    return `${code} - ${title}`;
  });

  readonly episodeDateLabel = computed(() => {
    const ep = this.host.focusedEpisode();
    if (!ep?.airDate) return null;
    return new Date(ep.airDate).toLocaleDateString(this.deps.translate.currentLang() || undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  });

  /** Episode runtime in minutes: ffprobe file duration (TMDB understates multi-episode files),
   *  else the summed range runtimes, else `ep.runtime`. */
  readonly episodeDisplayRuntime = computed<number | null>(() => {
    const ep = this.host.focusedEpisode();
    if (!ep) return null;

    const file = this.episodeActiveFile();
    const fileDur = file?.streamInfo?.durationSeconds;
    if (fileDur && fileDur > 0) return Math.round(fileDur / 60);

    const end = ep.endEpisodeNumber;
    if (end != null && end > ep.episodeNumber) {
      const season = this.host.focusedSeason();
      let total = 0;
      for (let n = ep.episodeNumber; n <= end; n++) {
        const e = season?.episodes?.find((x) => x.episodeNumber === n);
        if (e?.runtime) total += e.runtime;
      }
      if (total > 0) return total;
    }

    return ep.runtime ?? null;
  });

  readonly episodeSeriesRoute = computed(() => {
    const m = this.host.media();
    return m ? ['/series', String(m.id)] : ['/series'];
  });

  /** Episodes of the focused season for the "Plus de saison X" block; includes the current one, which the rail centres on. */
  readonly currentSeasonEpisodes = computed<Episode[]>(() => {
    const s = this.host.focusedSeason();
    return hideShadowedEpisodes(s?.episodes ?? []);
  });

  /** Season cards under "more from season N"; the focused season stays in place, empty seasons drop out. */
  readonly seasonsRow = computed<Season[]>(() => {
    const m = this.host.media();
    if (!m?.seasons || !this.host.focusedSeason()) return [];
    return m.seasons
      .filter((s) => (s.episodes?.length ?? 0) > 0)
      .slice()
      .sort((a, b) => a.seasonNumber - b.seasonNumber);
  });

  /** Episode the header's Play launches: see {@link nextUp}. */
  readonly nextPlayEpisode = computed<NextUp | null>(() => {
    const m = this.host.media();
    return m ? nextUp(m, this.host.resumeInfo(), this.deps.watchedEpisodeIds()) : null;
  });

  /** Resume episode label for series header (e.g. "S01:E03 - Title") */
  readonly resumeEpisodeLabel = computed(() => {
    const ctx = this.nextPlayEpisode();
    if (!ctx) return null;
    const sn = String(ctx.season.seasonNumber).padStart(2, '0');
    const en = String(ctx.episode.episodeNumber).padStart(2, '0');
    const code = `S${sn}:E${en}`;
    return ctx.episode.title ? `${code} - ${ctx.episode.title}` : code;
  });

  readonly nextPlayEpisodeId = computed(() => this.nextPlayEpisode()?.episode.id);
  readonly nextPlayMediaFileId = computed(() => this.nextPlayEpisode()?.file.id);

  constructor(
    private readonly host: EpisodeViewHost,
    private readonly deps: EpisodeViewDeps,
  ) {}

  /** Route to the first episode of `season` so a click jumps the user
   *  into that season's context without an intermediate landing page. */
  seasonLink(m: Media, season: Season): string[] | null {
    const first = season.episodes?.[0];
    if (!first) return null;
    return ['/series', String(m.id), 'episode', String(first.id)];
  }
}
