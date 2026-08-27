import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Media } from '../entities/media.entity';
import { Season } from '../entities/season.entity';
import { Episode } from '../entities/episode.entity';
import { MediaMetadata } from '../entities/media-metadata.entity';
import { Person } from '../entities/person.entity';
import { MediaCast } from '../entities/media-cast.entity';
import { MediaCrew } from '../entities/media-crew.entity';
import { Library } from '../../libraries/entities/library.entity';
import { TmdbProvider } from '../../metadata-providers/providers/tmdb.provider';
import { MetadataProviderRegistry } from '../../metadata-providers/metadata-provider.registry';
import {
  IMetadataProvider,
  MetadataDetails,
  SeasonDetails,
} from '../../metadata-providers/interfaces/metadata-provider.interface';
import { MetadataLanguageOverride } from '../../metadata-providers/metadata-settings-cache.service';
import { MediaType } from '../../../common/enums';
import { ImageService } from '../../images/image.service';
import { EventsService } from '../../scheduler/events.service';
import { mapWithConcurrency } from '../../../common/utils/concurrency';
import { buildMediaFieldsFromTmdb } from './tmdb-mapping.util';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

@Injectable()
export class MediaMetadataService {
  private readonly log = new Logger(MediaMetadataService.name);

  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(Season)
    private readonly seasonRepo: Repository<Season>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(MediaMetadata)
    private readonly metadataRepo: Repository<MediaMetadata>,
    @InjectRepository(Person)
    private readonly personRepo: Repository<Person>,
    @InjectRepository(Library)
    private readonly libraryRepo: Repository<Library>,
    private readonly dataSource: DataSource,
    private readonly tmdb: TmdbProvider,
    private readonly providerRegistry: MetadataProviderRegistry,
    private readonly imageService: ImageService,
    private readonly events: EventsService,
  ) {}

  /** Metadata language/region override for a media's library, or undefined when
   *  the media has no library (falls back to the global setting). Null fields on
   *  the library inherit the global setting per field. */
  private async loadLibraryOverride(
    media: Media,
  ): Promise<MetadataLanguageOverride | undefined> {
    if (!media.libraryId) return undefined;
    const lib = await this.libraryRepo.findOne({
      where: { id: media.libraryId },
    });
    if (!lib) return undefined;
    return { language: lib.metadataLanguage, region: lib.metadataRegion };
  }

  /**
   * Point a media at a different work: write the external ids the caller
   * picked, re-pull everything from the provider, then drop the seasons and
   * episodes the new work does not have.
   *
   * What survives is the point. `refreshSeriesEpisodes` upserts, so an episode
   * whose season/episode numbers exist in the new work keeps its row — and with
   * it every file, playback state, marker, like and playlist entry that points
   * at it. Only the surplus is deleted, and there the file rows survive too:
   * `media_files.episodeId` and `subtitle_files.episodeId` are ON DELETE SET
   * NULL, so the files go back to unmatched rather than away. Playback states
   * and markers on those episodes do go — they described content this title no
   * longer contains.
   */
  async identify(
    id: number,
    // The supplied ids ARE the new identity: what the caller omits is cleared,
    // never carried over from the work this media used to point at.
    target: {
      tmdbId?: number;
      tvdbId?: number;
      imdbId?: string;
      preferredProvider?: string;
    },
  ): Promise<Media> {
    const media = await this.mediaRepo.findOne({ where: { id } });
    if (!media) throw new NotFoundException(`Media #${id} not found`);

    if (target.tmdbId == null && target.tvdbId == null && !target.imdbId) {
      throw new BadRequestException(
        'Provide at least one external id to identify this media against',
      );
    }

    // `UQ_media_type_tmdbId` would fail mid-operation, after the ids were
    // written and before the refresh — refuse up front and say which title.
    if (target.tmdbId != null && target.tmdbId !== media.tmdbId) {
      const clash = await this.mediaRepo.findOne({
        where: { tmdbId: target.tmdbId, type: media.type },
      });
      if (clash && clash.id !== id) {
        throw new ConflictException(
          `"${clash.title}" (#${clash.id}) already uses TMDB id ${target.tmdbId} in this library`,
        );
      }
    }

    const before = `"${media.title}" tmdb=${media.tmdbId ?? '-'} tvdb=${media.tvdbId ?? '-'}`;

    // The refresh below re-reads the whole work — every season, episode and
    // image — so without this line a long identify looks like nothing happened.
    this.log.log(
      `identify: media#${id} ${before} -> tmdb=${target.tmdbId ?? '-'} ` +
        `tvdb=${target.tvdbId ?? '-'} imdb=${target.imdbId ?? '-'}, refreshing`,
    );

    // Keeping an id the caller did not supply would leave this media pointing at
    // the previous work on that provider, and `resolveProviderForMedia` falls
    // back to whichever id is set — the old identity would silently return.
    // Cross-referencing during the refresh below repopulates the rest.
    // The cast clears the three ids: the columns are nullable, the entity types
    // them as non-null.
    await this.mediaRepo.update(id, {
      tmdbId: target.tmdbId ?? null,
      tvdbId: target.tvdbId ?? null,
      imdbId: target.imdbId ?? null,
      ...(target.preferredProvider !== undefined
        ? { preferredProvider: target.preferredProvider }
        : {}),
    } as QueryDeepPartialEntity<Media>);

    const refreshed = await this.refreshMetadata(id);

    if (refreshed.type === MediaType.SERIES) {
      await this.dropSeasonsAbsentFromProvider(refreshed);
    }

    this.log.log(
      `identify: media#${id} done — "${refreshed.title}" tmdb=${refreshed.tmdbId ?? '-'} ` +
        `tvdb=${refreshed.tvdbId ?? '-'} imdb=${refreshed.imdbId ?? '-'}`,
    );
    return (await this.mediaRepo.findOne({ where: { id } })) ?? refreshed;
  }

  /**
   * Deletes the seasons and episodes the provider does not list, which after an
   * identification is precisely what the previous work left behind: the refresh
   * upserts everything the new work has, so whatever it did not touch is old.
   */
  private async dropSeasonsAbsentFromProvider(media: Media): Promise<void> {
    const seasons = await this.seasonRepo.find({
      where: { media: { id: media.id } },
      relations: ['episodes'],
    });
    const { provider, externalId } = await this.resolveProviderForMedia(media);
    const override = await this.loadLibraryOverride(media);
    const live = await provider.getTvShowSeasons(externalId, override);
    const liveSeasons = new Map(
      live.map((sd) => [
        sd.seasonNumber,
        new Set((sd.episodes ?? []).map((e) => e.episodeNumber)),
      ]),
    );

    for (const season of seasons) {
      const liveEpisodes = liveSeasons.get(season.seasonNumber);
      if (!liveEpisodes) {
        await this.seasonRepo.remove(season);
        this.log.log(
          `identify: dropped S${season.seasonNumber} of media#${media.id} — absent from the new work`,
        );
        continue;
      }
      const surplus = (season.episodes ?? []).filter(
        (ep) => !liveEpisodes.has(ep.episodeNumber),
      );
      if (surplus.length) {
        await this.episodeRepo.remove(surplus);
        this.log.log(
          `identify: dropped ${surplus.length} episode(s) of S${season.seasonNumber} on media#${media.id} — absent from the new work`,
        );
      }
    }
  }

  async refreshMetadata(id: number): Promise<Media> {
    const media = await this.mediaRepo.findOne({ where: { id } });
    if (!media) throw new NotFoundException(`Media #${id} not found`);

    const override = await this.loadLibraryOverride(media);
    const { provider, externalId } = await this.resolveProviderForMedia(media);

    this.log.log(
      `refreshMetadata: "${media.title}" using provider=${provider.name} externalId=${externalId}`,
    );

    if (media.type === MediaType.MOVIE) {
      const details = await provider.getMovieDetails(externalId, override);
      if (!media.tvdbId && details.tvdbId)
        await this.mediaRepo.update(media.id, { tvdbId: details.tvdbId });
      if (!media.tmdbId && details.tmdbId)
        await this.mediaRepo.update(media.id, { tmdbId: details.tmdbId });
      await this.mediaRepo.update(media.id, {
        ...buildMediaFieldsFromTmdb(details, MediaType.MOVIE),
      });
      // Refresh keeps images synchronous: a full-library refresh processes one
      // media at a time, so awaiting here bounds concurrency and lets the UI
      // track real per-item progress (vs the import path, which defers images).
      await this.downloadMediaImages(media.id, details);
      await this.persistMediaMetadata(media, details);
    } else {
      const details = await provider.getTvShowDetails(externalId, override);
      if (!media.tvdbId && details.tvdbId)
        await this.mediaRepo.update(media.id, { tvdbId: details.tvdbId });
      if (!media.tmdbId && details.tmdbId)
        await this.mediaRepo.update(media.id, { tmdbId: details.tmdbId });
      await this.mediaRepo.update(media.id, {
        ...buildMediaFieldsFromTmdb(details, MediaType.SERIES),
      });
      // Refresh keeps images synchronous — see the movie branch above.
      await this.downloadMediaImages(media.id, details);
      await this.persistMediaMetadata(media, details);
      const { insertedCount } = await this.refreshSeriesEpisodes(media, {
        provider,
        externalId,
      });
      // New episodes appeared on the provider (typically a fresh season
      // drop): kick the auto-grab pipeline now instead of waiting up to 6 h
      // for the next scheduler tick. Mirrors the post-approval kick.
      if (insertedCount > 0) {
        this.events.emitDomain({
          type: 'media.acquisition.requested',
          mediaIds: [media.id],
          reason: 'metadata-refresh',
        });
      }
    }

    await this.updateSearchVector(media.id);

    await this.mediaRepo.update(media.id, {
      metadataRefreshedAt: new Date(),
    });

    const refreshed = await this.mediaRepo.findOne({ where: { id: media.id } });
    if (!refreshed) throw new NotFoundException(`Media #${id} not found`);
    return refreshed;
  }

  async refreshEpisodeMetadata(
    mediaId: number,
    episodeId: number,
  ): Promise<void> {
    const episode = await this.episodeRepo.findOne({
      where: { id: episodeId },
      relations: ['season'],
    });
    if (!episode)
      throw new NotFoundException(`Episode #${episodeId} not found`);

    const media = await this.mediaRepo.findOne({ where: { id: mediaId } });
    if (!media) throw new NotFoundException(`Media #${mediaId} not found`);

    const { provider, externalId } = await this.resolveProviderForMedia(media, {
      season: episode.season,
    });
    const override = await this.loadLibraryOverride(media);

    const seasonData = await this.fetchSingleSeason(
      provider,
      externalId,
      episode.season.seasonNumber,
      undefined,
      override,
    );
    const tmdbEp = seasonData?.episodes.find(
      (e) => e.episodeNumber === episode.episodeNumber,
    );

    if (tmdbEp) {
      const updates: Partial<Episode> = {};
      if (tmdbEp.title && tmdbEp.title !== episode.title)
        updates.title = tmdbEp.title;
      if (tmdbEp.overview && tmdbEp.overview !== episode.overview)
        updates.overview = tmdbEp.overview;
      if (tmdbEp.airDate && tmdbEp.airDate !== episode.airDate)
        updates.airDate = tmdbEp.airDate;
      if (tmdbEp.runtime != null && tmdbEp.runtime !== episode.runtime)
        updates.runtime = tmdbEp.runtime;
      if (Object.keys(updates).length > 0) {
        await this.episodeRepo.update(episode.id, updates);
      }
      if (tmdbEp.stillUrl) {
        await this.downloadEpisodeStill(episode.id, tmdbEp.stillUrl);
      }
    }
  }

  async refreshSeriesEpisodes(
    media: Media,
    preResolved?: { provider: IMetadataProvider; externalId: string },
  ): Promise<{ insertedCount: number }> {
    // 1. Media-level provider enumerates all seasons and provides defaults.
    //    `refreshMetadata` has already resolved the provider — accept it
    //    so we don't re-emit the `resolveProvider:` log and skip the DB
    //    lookup. Cron / non-refreshMetadata callers omit `preResolved`
    //    and we resolve on their behalf.
    const mediaResolve =
      preResolved ?? (await this.resolveProviderForMedia(media));
    const override = await this.loadLibraryOverride(media);
    const mediaSeasons = await mediaResolve.provider.getTvShowSeasons(
      mediaResolve.externalId,
      override,
    );
    const dbSeasons = await this.seasonRepo.find({
      where: { media: { id: media.id } },
      relations: ['episodes'],
    });
    const dbSeasonMap = new Map(dbSeasons.map((s) => [s.seasonNumber, s]));

    let insertedCount = 0;

    // 2. Upsert seasons + apply media-level episode data, skipping seasons
    //    whose override points elsewhere (handled in the second pass).
    for (const sd of mediaSeasons) {
      let dbSeason = dbSeasonMap.get(sd.seasonNumber);
      if (!dbSeason) {
        dbSeason = await this.seasonRepo.save(
          this.seasonRepo.create({
            media,
            seasonNumber: sd.seasonNumber,
            monitored: true,
          }),
        );
        dbSeason.episodes = [];
        dbSeasonMap.set(sd.seasonNumber, dbSeason);
      }
      if (
        dbSeason.preferredProvider &&
        dbSeason.preferredProvider !== mediaResolve.provider.name
      ) {
        continue;
      }
      insertedCount += (await this.applySeasonDetails(dbSeason, sd)).insertedCount;
    }

    // 3. Second pass: re-fetch overridden seasons from their own provider.
    //    Cached by (providerName, externalId) so N overrides to the same
    //    non-TMDB provider only trigger one getTvShowSeasons call.
    const overridden = dbSeasons.filter(
      (s) =>
        s.preferredProvider &&
        s.preferredProvider !== mediaResolve.provider.name,
    );
    if (!overridden.length) return { insertedCount };
    const cache = new Map<string, SeasonDetails[]>();
    for (const dbSeason of overridden) {
      let overrideResolve: {
        provider: IMetadataProvider;
        externalId: string;
      };
      try {
        overrideResolve = await this.resolveProviderForMedia(media, {
          season: dbSeason,
        });
      } catch (err) {
        this.log.warn(
          `refreshSeriesEpisodes: season S${dbSeason.seasonNumber} override ` +
            `"${dbSeason.preferredProvider}" failed — ${err instanceof Error ? err.message : 'unknown error'}. ` +
            `Falling back to media-level data.`,
        );
        const fallback = mediaSeasons.find(
          (s) => s.seasonNumber === dbSeason.seasonNumber,
        );
        if (fallback) {
          insertedCount += (await this.applySeasonDetails(dbSeason, fallback)).insertedCount;
        }
        continue;
      }
      const seasonData = await this.fetchSingleSeason(
        overrideResolve.provider,
        overrideResolve.externalId,
        dbSeason.seasonNumber,
        cache,
        override,
      );
      if (!seasonData) {
        this.log.warn(
          `refreshSeriesEpisodes: season S${dbSeason.seasonNumber} override ` +
            `"${dbSeason.preferredProvider}" returned no matching season ` +
            `(numbering mismatch?). Falling back to media-level data.`,
        );
        const fallback = mediaSeasons.find(
          (s) => s.seasonNumber === dbSeason.seasonNumber,
        );
        if (fallback) {
          insertedCount += (await this.applySeasonDetails(dbSeason, fallback)).insertedCount;
        }
        continue;
      }
      insertedCount += (await this.applySeasonDetails(dbSeason, seasonData)).insertedCount;
    }
    return { insertedCount };
  }

  /** Upsert episodes of one DB season from provider season details, download
   *  per-episode stills and the season poster. Shared by the metadata refresh
   *  flow and the initial library import so both end up with the same set of
   *  artwork — diverging here meant stills were missing right after import.
   *  Returns the number of fresh episode rows it created so the caller can
   *  decide whether to kick the auto-grab pipeline. */
  async applySeasonDetails(
    dbSeason: Season,
    sd: SeasonDetails,
    opts: { deferImages?: boolean } = {},
  ): Promise<{ insertedCount: number }> {
    const dbEpMap = new Map(
      (dbSeason.episodes ?? []).map((e) => [e.episodeNumber, e]),
    );

    const seasonUpdates: Partial<Season> = {};
    if (sd.overview && sd.overview !== dbSeason.overview) {
      seasonUpdates.overview = sd.overview;
    }
    if (sd.airDate && sd.airDate.slice(0, 10) !== dbSeason.airDate) {
      seasonUpdates.airDate = sd.airDate.slice(0, 10);
    }
    if (Object.keys(seasonUpdates).length) {
      await this.seasonRepo.update(dbSeason.id, seasonUpdates);
      Object.assign(dbSeason, seasonUpdates);
    }

    // 1. Partition into INSERTs and UPDATEs in a single pass.
    type UpdateJob = {
      id: number;
      updates: Partial<Episode>;
      stillUrl?: string | null;
    };
    type InsertEntry = (typeof sd.episodes)[number];
    const updateJobs: UpdateJob[] = [];
    const inserts: InsertEntry[] = [];
    for (const ep of sd.episodes) {
      const existing = dbEpMap.get(ep.episodeNumber);
      if (existing) {
        const updates: Partial<Episode> = {};
        if (ep.title && ep.title !== existing.title) updates.title = ep.title;
        if (ep.overview && ep.overview !== existing.overview)
          updates.overview = ep.overview;
        if (ep.airDate && ep.airDate !== existing.airDate)
          updates.airDate = ep.airDate;
        if (ep.runtime != null && ep.runtime !== existing.runtime)
          updates.runtime = ep.runtime;
        if (ep.stillUrl || Object.keys(updates).length > 0) {
          updateJobs.push({ id: existing.id, updates, stillUrl: ep.stillUrl });
        }
      } else {
        inserts.push(ep);
      }
    }

    // 2. Batch INSERT new episodes in one save() call.
    const insertedRows = inserts.length
      ? await this.episodeRepo.save(
          inserts.map((ep) =>
            this.episodeRepo.create({
              season: dbSeason,
              episodeNumber: ep.episodeNumber,
              title: ep.title || undefined,
              overview: ep.overview || undefined,
              airDate: ep.airDate || undefined,
              runtime: ep.runtime ?? undefined,
              monitored: true,
            }),
          ),
        )
      : [];

    // 3. Parallelize UPDATEs + still downloads (concurrency 8). On a long
    //    season (~20 ep × 2 image variants) this collapses ~40 sequential
    //    HTTPs into ~5 batches.
    type Job = {
      id: number;
      updates?: Partial<Episode>;
      stillUrl?: string | null;
    };
    const jobs: Job[] = [
      ...updateJobs,
      ...insertedRows.map((row, i) => ({
        id: row.id,
        stillUrl: inserts[i].stillUrl,
      })),
    ];
    const deferredStills: { episodeId: number; stillUrl: string }[] = [];
    await mapWithConcurrency(jobs, 8, async ({ id, updates, stillUrl }) => {
      if (updates && Object.keys(updates).length > 0) {
        await this.episodeRepo.update(id, updates);
      }
      if (stillUrl) {
        if (opts.deferImages) deferredStills.push({ episodeId: id, stillUrl });
        else await this.downloadEpisodeStill(id, stillUrl);
      }
    });

    if (opts.deferImages) {
      this.downloadSeasonImagesInBackground(
        dbSeason.id,
        deferredStills,
        sd.posterUrl ?? null,
      );
      return { insertedCount: insertedRows.length };
    }

    if (sd.posterUrl) {
      await this.downloadSeasonPoster(dbSeason.id, sd.posterUrl);
    }
    return { insertedCount: insertedRows.length };
  }

  /**
   * Fetch one season from the given provider. Uses TMDB's fast single-season
   * endpoint when possible; otherwise falls back to a full `getTvShowSeasons`
   * fetch (memoized via `cache` so sibling overrides don't re-fetch it).
   */
  private async fetchSingleSeason(
    provider: IMetadataProvider,
    externalId: string,
    seasonNumber: number,
    cache?: Map<string, SeasonDetails[]>,
    override?: MetadataLanguageOverride,
  ): Promise<SeasonDetails | undefined> {
    if (provider.name === 'tmdb') {
      return this.tmdb.getTvSeason(externalId, seasonNumber, override);
    }
    const key = `${provider.name}:${externalId}`;
    let all = cache?.get(key);
    if (!all) {
      all = await provider.getTvShowSeasons(externalId, override);
      cache?.set(key, all);
    }
    return all.find((s) => s.seasonNumber === seasonNumber);
  }

  /**
   * Resolve which metadata provider + external ID to use for a media.
   *
   * Priority: season override → media override → library preference → fallback.
   *
   * Explicit overrides (season, media) are strict: if the preferred provider
   * is configured but its external ID can't be resolved (missing cross-ref),
   * this throws instead of silently falling back — so a user's "use TVDB for
   * this" choice never degrades to TMDB without them knowing. The library-
   * level preference stays soft (logs a warning, falls back) since it's a
   * hint across many medias rather than a per-item contract.
   */
  private async resolveProviderForMedia(
    media: Media,
    opts?: { season?: Season },
  ): Promise<{ provider: IMetadataProvider; externalId: string }> {
    const label = `"${media.title}" (#${media.id})`;

    // 1. Season override (strict)
    const seasonPref = opts?.season?.preferredProvider;
    if (seasonPref) {
      const resolved = await this.tryPreferred(media, seasonPref, 'season');
      if (resolved) return resolved;
      throw new BadRequestException(
        `Season override "${seasonPref}" cannot be resolved for ${label}: ` +
          `no matching external ID available (check API key + cross-reference).`,
      );
    }

    // 2. Media override (strict)
    if (media.preferredProvider) {
      const resolved = await this.tryPreferred(
        media,
        media.preferredProvider,
        'media',
      );
      if (resolved) return resolved;
      throw new BadRequestException(
        `Media override "${media.preferredProvider}" cannot be resolved for ` +
          `${label}: no matching external ID available.`,
      );
    }

    // 3. Library preference (soft)
    if (media.libraryId) {
      const lib = await this.libraryRepo.findOne({
        where: { id: media.libraryId },
      });
      const pref = lib?.preferredProvider;
      if (pref) {
        const resolved = await this.tryPreferred(media, pref, 'library');
        if (resolved) return resolved;
        this.log.warn(
          `resolveProvider: ${label} — library preferred ${pref} but no matching ID found, falling back`,
        );
      }
    }

    // 4. Fallback: use whichever ID + provider is available
    if (media.tmdbId && this.providerRegistry.isAvailable('tmdb')) {
      this.log.log(
        `resolveProvider: ${label} — fallback to tmdb (tmdbId=${media.tmdbId})`,
      );
      return { provider: this.tmdb, externalId: String(media.tmdbId) };
    }
    if (media.tvdbId && this.providerRegistry.isAvailable('tvdb')) {
      this.log.log(
        `resolveProvider: ${label} — fallback to tvdb (tvdbId=${media.tvdbId})`,
      );
      return {
        provider: this.providerRegistry.get('tvdb')!,
        externalId: String(media.tvdbId),
      };
    }
    if (media.tmdbId) {
      this.log.log(
        `resolveProvider: ${label} — fallback to tmdb (tmdbId=${media.tmdbId}, unchecked availability)`,
      );
      return { provider: this.tmdb, externalId: String(media.tmdbId) };
    }
    throw new BadRequestException('No provider ID available for this media');
  }

  /**
   * Try to resolve a preferred provider by name. Returns null if the provider
   * is not configured (missing API key) or if cross-referencing to its ID
   * fails. Caller decides whether to throw (strict) or fall through (soft).
   */
  private async tryPreferred(
    media: Media,
    pref: string,
    origin: 'season' | 'media' | 'library',
  ): Promise<{ provider: IMetadataProvider; externalId: string } | null> {
    const label = `"${media.title}" (#${media.id})`;
    this.log.log(`resolveProvider: ${label} — ${origin} prefers ${pref}`);
    if (!this.providerRegistry.isAvailable(pref)) {
      this.log.warn(
        `resolveProvider: ${label} — ${origin} preferred ${pref} but not available (no API key?)`,
      );
      return null;
    }
    const provider = this.providerRegistry.get(pref)!;
    const externalId = await this.resolveExternalIdForProvider(
      media,
      provider,
      pref,
    );
    if (!externalId) return null;
    this.log.log(
      `resolveProvider: ${label} — using ${pref} with id=${externalId} (${origin})`,
    );
    return { provider, externalId };
  }

  /**
   * Find the external ID for a given provider on a media.
   * If the media doesn't have the matching ID, cross-reference via other providers.
   */
  private async resolveExternalIdForProvider(
    media: Media,
    provider: IMetadataProvider,
    providerName: string,
  ): Promise<string | null> {
    const label = `"${media.title}" (#${media.id})`;

    // Direct match
    if (providerName === 'tmdb' && media.tmdbId) return String(media.tmdbId);
    if (providerName === 'tvdb' && media.tvdbId) return String(media.tvdbId);

    const override = await this.loadLibraryOverride(media);

    this.log.log(
      `crossRef: ${label} — need ${providerName} ID, attempting cross-reference`,
    );

    // Cross-reference: need to find the missing ID
    if (providerName === 'tvdb' && !media.tvdbId) {
      if (media.imdbId && provider.findByExternalId) {
        this.log.log(
          `crossRef: ${label} — trying TVDB lookup via imdbId=${media.imdbId}`,
        );
        const cross = await provider.findByExternalId(
          'imdb',
          media.imdbId,
          override,
        );
        if (cross) {
          this.log.log(
            `crossRef: ${label} — found tvdbId=${cross.id} via IMDB`,
          );
          await this.mediaRepo.update(media.id, {
            tvdbId: parseInt(cross.id, 10),
          });
          return cross.id;
        }
      }
      if (media.tmdbId) {
        this.log.log(
          `crossRef: ${label} — trying TMDB external_ids for tvdbId (tmdbId=${media.tmdbId})`,
        );
        const details =
          media.type === MediaType.MOVIE
            ? await this.tmdb.getMovieDetails(String(media.tmdbId), override)
            : await this.tmdb.getTvShowDetails(String(media.tmdbId), override);
        if (details.tvdbId) {
          this.log.log(
            `crossRef: ${label} — found tvdbId=${details.tvdbId} via TMDB`,
          );
          await this.mediaRepo.update(media.id, { tvdbId: details.tvdbId });
          return String(details.tvdbId);
        }
      }
    }

    if (providerName === 'tmdb' && !media.tmdbId) {
      if (media.imdbId && this.tmdb.findByExternalId) {
        this.log.log(
          `crossRef: ${label} — trying TMDB find via imdbId=${media.imdbId}`,
        );
        const cross = await this.tmdb.findByExternalId(
          'imdb',
          media.imdbId,
          override,
        );
        if (cross) {
          this.log.log(
            `crossRef: ${label} — found tmdbId=${cross.id} via IMDB`,
          );
          await this.mediaRepo.update(media.id, {
            tmdbId: parseInt(cross.id, 10),
          });
          return cross.id;
        }
      }
      if (media.tvdbId && this.tmdb.findByExternalId) {
        this.log.log(
          `crossRef: ${label} — trying TMDB find via tvdbId=${media.tvdbId}`,
        );
        const cross = await this.tmdb.findByExternalId(
          'tvdb',
          String(media.tvdbId),
          override,
        );
        if (cross) {
          this.log.log(
            `crossRef: ${label} — found tmdbId=${cross.id} via TVDB`,
          );
          await this.mediaRepo.update(media.id, {
            tmdbId: parseInt(cross.id, 10),
          });
          return cross.id;
        }
      }
    }

    this.log.warn(
      `crossRef: ${label} — cross-reference failed for ${providerName}`,
    );
    return null;
  }

  /**
   * Fire-and-forget variant of {@link downloadMediaImages} for the import path.
   * The media row is persisted with the source CDN image URLs (displayable
   * as-is) before this runs, so an import — and the request approval that
   * awaits it — isn't blocked on the CDN GETs, the slowest part of an import;
   * the local copies replace the CDN URLs once downloaded. Metadata refresh
   * keeps images synchronous so its per-item progress stays accurate.
   */
  downloadMediaImagesInBackground(
    mediaId: number,
    details: MetadataDetails,
  ): void {
    void this.downloadMediaImages(mediaId, details).catch((e) =>
      this.log.warn(
        `media #${mediaId} image download failed: ${
          e instanceof Error ? e.message : e
        }`,
      ),
    );
  }

  /**
   * Download poster + fanart from TMDB and update the media row with local paths.
   */
  async downloadMediaImages(
    mediaId: number,
    details: MetadataDetails,
  ): Promise<void> {
    const updates: Partial<Media> = {};

    if (details.posterUrl) {
      const local = await this.imageService.downloadAndStore(
        details.posterUrl,
        'media',
        mediaId,
        'poster',
      );
      if (local) updates.posterUrl = local;
    }
    if (details.fanartUrl) {
      const local = await this.imageService.downloadAndStore(
        details.fanartUrl,
        'media',
        mediaId,
        'fanart',
      );
      if (local) updates.fanartUrl = local;
    }
    if (details.logoUrl) {
      const local = await this.imageService.downloadAndStore(
        details.logoUrl,
        'media',
        mediaId,
        'logo',
      );
      if (local) updates.logoUrl = local;
    }

    // Extra fanarts (variants fanart-1..N). Downloaded in parallel
    // since each entry is an independent CDN GET. Slots are
    // 1-indexed so the on-disk filename mirrors the variant string
    // a frontend caller passes back (`/api/images/media/X/fanart-1`).
    if (details.additionalFanartUrls?.length) {
      const downloaded = await Promise.all(
        details.additionalFanartUrls.map((url: string, i: number) =>
          this.imageService.downloadAndStore(
            url,
            'media',
            mediaId,
            `fanart-${i + 1}`,
          ),
        ),
      );
      updates.additionalFanartUrls = downloaded.filter(
        (p): p is string => !!p,
      );
    } else {
      // Provider returned no extras → clear stale entries from a
      // previous refresh that did. Keeps the column consistent
      // with provider reality.
      updates.additionalFanartUrls = [];
    }

    if (Object.keys(updates).length > 0) {
      await this.mediaRepo.update(mediaId, updates);
    }
  }

  /**
   * Download a person avatar from TMDB and update the person row.
   */
  async downloadPersonAvatar(
    personId: number,
    avatarUrl: string,
  ): Promise<string | null> {
    const local = await this.imageService.downloadAndStore(
      avatarUrl,
      'person',
      personId,
    );
    if (local) {
      await this.personRepo.update(personId, { avatarUrl: local });
    }
    return local;
  }

  /**
   * Download an episode still from TMDB and update the episode row.
   */
  async downloadEpisodeStill(
    episodeId: number,
    stillUrl: string,
  ): Promise<void> {
    const local = await this.imageService.downloadAndStore(
      stillUrl,
      'episode',
      episodeId,
    );
    if (local) {
      await this.episodeRepo.update(episodeId, { stillUrl: local });
    }
  }

  /**
   * Download a season poster from TMDB / TVDB and persist the local
   * API path on the Season row. Best-effort: a failed download leaves
   * `posterUrl` null on the DB row and the UI falls back to the
   * series poster.
   */
  async downloadSeasonPoster(
    seasonId: number,
    posterUrl: string,
  ): Promise<void> {
    const local = await this.imageService.downloadAndStore(
      posterUrl,
      'season',
      seasonId,
    );
    if (local) {
      await this.seasonRepo.update(seasonId, { posterUrl: local });
    }
  }

  /**
   * Fire-and-forget the deferred episode stills and season poster for the
   * import path. The episode and season rows they attach to are already
   * persisted, so the auto-grab and the monitored badge never wait on these
   * CDN GETs; refresh downloads them inline so its per-item progress stays
   * accurate. Concurrency is capped so a many-episode season doesn't open a
   * download per still.
   */
  downloadSeasonImagesInBackground(
    seasonId: number,
    stills: { episodeId: number; stillUrl: string }[],
    posterUrl: string | null,
  ): void {
    void (async () => {
      await mapWithConcurrency(stills, 8, ({ episodeId, stillUrl }) =>
        this.downloadEpisodeStill(episodeId, stillUrl),
      );
      if (posterUrl) await this.downloadSeasonPoster(seasonId, posterUrl);
    })().catch((e) =>
      this.log.warn(
        `season #${seasonId} image download failed: ${
          e instanceof Error ? e.message : e
        }`,
      ),
    );
  }

  /**
   * Fire-and-forget variant of {@link persistMediaMetadata} for the import
   * path. Cast, crew and per-person enrichment (biographies, avatars) are
   * detail-page data that the monitored badge, the library link and the
   * auto-grab never read, yet the per-person TMDB fan-out below dominates an
   * import's latency — so an import (and the request approval awaiting it)
   * isn't blocked on it. Metadata refresh keeps it synchronous.
   */
  persistMediaMetadataInBackground(
    media: Media,
    details: MetadataDetails,
  ): void {
    void this.persistMediaMetadata(media, details).catch((e) =>
      this.log.warn(
        `media #${media.id} metadata persist failed: ${
          e instanceof Error ? e.message : e
        }`,
      ),
    );
  }

  async persistMediaMetadata(
    media: Media,
    details: MetadataDetails,
  ): Promise<void> {
    // Upsert MediaMetadata
    const existing = await this.metadataRepo.findOne({
      where: { media: { id: media.id } },
    });
    const metaFields = {
      budget: details.budget ?? undefined,
      revenue: details.revenue ?? undefined,
      tagline: details.tagline ?? undefined,
      popularity: details.popularity ?? undefined,
      voteCount: details.voteCount ?? undefined,
      originalLanguage: details.originalLanguage ?? undefined,
      productionCountries: details.productionCountries,
      productionCompanies: details.productionCompanies,
      videos: details.videos,
      keywords: details.keywords,
    };
    if (existing) {
      await this.metadataRepo.update(existing.id, metaFields);
    } else {
      await this.metadataRepo.save(
        this.metadataRepo.create({ media, ...metaFields } as MediaMetadata),
      );
    }

    // Upsert Persons + replace cast/crew
    const personMap = new Map<number, Person>();
    const allExternalIds = [
      ...details.cast.map((c) => c.externalId),
      ...details.crew.map((c) => c.externalId),
    ];
    const uniqueIds = [...new Set(allExternalIds)];

    if (uniqueIds.length > 0) {
      const existingPersons = await this.personRepo
        .createQueryBuilder('p')
        .where('p.tmdbId IN (:...ids)', { ids: uniqueIds })
        .getMany();
      for (const p of existingPersons) personMap.set(p.tmdbId, p);

      const allCredits = [...details.cast, ...details.crew];

      // Batch INSERT new persons in a single save() call instead of one
      // round-trip per missing person.
      const missingIds = uniqueIds.filter((id) => !personMap.has(id));
      const newRows = missingIds
        .map((id) => allCredits.find((c) => c.externalId === id))
        .filter((c): c is (typeof allCredits)[number] => !!c)
        .map((c) =>
          this.personRepo.create({ tmdbId: c.externalId, name: c.name }),
        );
      const inserted = newRows.length
        ? await this.personRepo.save(newRows)
        : [];
      for (const p of inserted) personMap.set(p.tmdbId, p);

      // Parallelize avatar downloads + name updates across new AND existing
      // persons (concurrency 8). Each job: download avatar (best-effort),
      // then UPDATE the row with whatever fields actually changed. This is
      // the dominant cost on series with large casts.
      type PersonJob = {
        id: number;
        updates: Partial<Person>;
        avatarUrl: string | null;
      };
      const jobs: PersonJob[] = [];
      for (const p of inserted) {
        const credit = allCredits.find((c) => c.externalId === p.tmdbId);
        if (credit?.avatarUrl) {
          jobs.push({ id: p.id, updates: {}, avatarUrl: credit.avatarUrl });
        }
      }
      for (const p of existingPersons) {
        const credit = allCredits.find((c) => c.externalId === p.tmdbId);
        if (!credit) continue;
        const updates: Partial<Person> = {};
        if (credit.name !== p.name) updates.name = credit.name;
        if (credit.avatarUrl || Object.keys(updates).length > 0) {
          jobs.push({ id: p.id, updates, avatarUrl: credit.avatarUrl ?? null });
        }
      }
      await mapWithConcurrency(jobs, 8, async ({ id, updates, avatarUrl }) => {
        const final = { ...updates };
        if (avatarUrl) {
          const local = await this.imageService.downloadAndStore(
            avatarUrl,
            'person',
            id,
          );
          if (local) final.avatarUrl = local;
        }
        if (Object.keys(final).length > 0) {
          await this.personRepo.update(id, final);
        }
      });
    }

    // Replace cast + crew atomically — without a transaction, a refresh that
    // crashes between DELETE and INSERT would leave the media with an empty
    // cast/crew section in the UI until the next successful refresh.
    await this.dataSource.transaction(async (manager) => {
      const castMgr = manager.getRepository(MediaCast);
      await castMgr.delete({ media: { id: media.id } });
      if (details.cast.length > 0) {
        await castMgr.insert(
          details.cast.map((c) => ({
            media: { id: media.id },
            person: { id: personMap.get(c.externalId)?.id },
            // TMDB returns null character for some cast entries (archival
            // footage, uncredited roles). Columns are NOT NULL — coerce.
            character: c.character ?? '',
            order: c.order ?? 0,
          })),
        );
      }
      const crewMgr = manager.getRepository(MediaCrew);
      await crewMgr.delete({ media: { id: media.id } });
      if (details.crew.length > 0) {
        await crewMgr.insert(
          details.crew.map((c) => ({
            media: { id: media.id },
            person: { id: personMap.get(c.externalId)?.id },
            job: c.job ?? '',
            department: c.department ?? '',
          })),
        );
      }
    });

    // Update search vectors + departments for persons
    if (uniqueIds.length > 0) {
      const personIds = [...personMap.values()].map((p) => p.id);
      await this.dataSource.query(
        `UPDATE persons SET "searchVector" = to_tsvector('simple', name) WHERE id = ANY($1)`,
        [personIds],
      );

      // Compute departments from current details and merge with existing
      const deptMap = new Map<number, Set<string>>();
      for (const c of details.cast) {
        if (!deptMap.has(c.externalId)) deptMap.set(c.externalId, new Set());
        deptMap.get(c.externalId)!.add('Acting');
      }
      for (const c of details.crew) {
        if (!deptMap.has(c.externalId)) deptMap.set(c.externalId, new Set());
        deptMap.get(c.externalId)!.add(c.department);
      }
      for (const [tmdbId, person] of personMap) {
        const newDepts = deptMap.get(tmdbId);
        if (!newDepts) continue;
        const merged = new Set(person.departments ?? []);
        for (const d of newDepts) merged.add(d);
        const sorted = [...merged].sort();
        await this.personRepo.update(person.id, { departments: sorted });
      }
    }

    // Refresh stale person details (biography, birthday, etc.)
    const refreshThreshold = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const person of personMap.values()) {
      const needsRefresh =
        !person.metadataRefreshedAt ||
        person.metadataRefreshedAt.getTime() < refreshThreshold;
      if (!needsRefresh) continue;
      try {
        const pd = await this.tmdb.getPersonDetails(String(person.tmdbId));
        let localAvatar: string | undefined;
        if (pd.avatarUrl) {
          const dl = await this.downloadPersonAvatar(person.id, pd.avatarUrl);
          if (dl) localAvatar = dl;
        }
        await this.personRepo.update(person.id, {
          name: pd.name,
          ...(localAvatar ? { avatarUrl: localAvatar } : {}),
          biography: pd.biography,
          birthday: pd.birthday ?? undefined,
          deathday: pd.deathday ?? undefined,
          placeOfBirth: pd.placeOfBirth ?? undefined,
          knownForDepartment: pd.knownForDepartment,
          metadataRefreshedAt: new Date(),
        });
      } catch {
        // Skip failed person detail fetches
      }
    }
  }

  async updateSearchVector(mediaId: number): Promise<void> {
    await this.dataSource.query(
      `UPDATE media SET "searchVector" =
        setweight(to_tsvector('french', COALESCE(title, '')), 'A') ||
        setweight(to_tsvector('french', COALESCE("originalTitle", '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(overview, '')), 'C')
      WHERE id = $1`,
      [mediaId],
    );
  }
}
