import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Media } from '../entities/media.entity';
import { Season } from '../entities/season.entity';
import { Episode } from '../entities/episode.entity';
import { CreateMediaDto } from '../dto/create-media.dto';
import { ImportTmdbDto } from '../dto/import-tmdb.dto';
import { ImportMediaDto } from '../dto/import-media.dto';
import { TmdbProvider } from '../../metadata-providers/providers/tmdb.provider';
import { MetadataProviderRegistry } from '../../metadata-providers/metadata-provider.registry';
import {
  IMetadataProvider,
  MetadataDetails,
  SeasonDetails,
} from '../../metadata-providers/interfaces/metadata-provider.interface';
import { MetadataLanguageOverride } from '../../metadata-providers/metadata-settings-cache.service';
import { MediaType, MediaStatus } from '../../../common/enums';
import { RequestLifecycleService } from '../../requests/request-lifecycle.service';
import { ProfilesService } from '../../profiles/profiles.service';
import { QualityProfile } from '../../profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../../profiles/entities/language-profile.entity';
import { User } from '../../users/entities/user.entity';
import { Library } from '../../libraries/entities/library.entity';
import { LibrariesService } from '../../libraries/libraries.service';
import { NamingService } from '../../scheduler/naming.service';
import { EventsService } from '../../scheduler/events.service';
import { buildMediaFieldsFromTmdb } from './tmdb-mapping.util';
import { MediaMetadataService } from './media-metadata.service';

@Injectable()
export class MediaImportService {
  private readonly log = new Logger(MediaImportService.name);

  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(Season)
    private readonly seasonRepo: Repository<Season>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(Library)
    private readonly libraryRepo: Repository<Library>,
    private readonly dataSource: DataSource,
    private readonly tmdb: TmdbProvider,
    private readonly providerRegistry: MetadataProviderRegistry,
    private readonly config: ConfigService,
    private readonly profiles: ProfilesService,
    private readonly libraries: LibrariesService,
    private readonly naming: NamingService,
    private readonly metadata: MediaMetadataService,
    @Inject(forwardRef(() => RequestLifecycleService))
    private readonly requestLifecycle: RequestLifecycleService,
    private readonly events: EventsService,
  ) {}

  async importFromTmdb(
    dto: ImportTmdbDto,
    addedByUserId: number | null = null,
    monitoredSeasons: number[] | null = null,
  ): Promise<Media> {
    const key = this.config.get<string>('TMDB_API_KEY', '');
    if (!key?.trim()) {
      throw new BadRequestException('TMDB API key is not configured');
    }

    const existing = await this.mediaRepo.findOne({
      where: { tmdbId: dto.tmdbId, type: dto.type },
    });
    if (existing) {
      throw new ConflictException('This title is already in the library');
    }

    const qualityProfileId =
      await this.profiles.resolveQualityProfileIdForImport(
        dto.qualityProfileId,
      );

    const languageProfileId =
      await this.profiles.resolveLanguageProfileIdForImport(
        dto.languageProfileId,
      );

    const { libraryId, library } = await this.resolveImportTarget(dto.type, {
      libraryId: dto.libraryId,
    });
    const override = this.libraryMetadataOverride(library);

    const fmtKeys = [
      'naming_movie_folder_format',
      'naming_series_folder_format',
    ];
    const fmtRows: { key: string; value: string }[] =
      await this.dataSource.query(
        `SELECT key, value FROM app_settings WHERE key = ANY($1)`,
        [fmtKeys],
      );
    const fmtMap = Object.fromEntries(fmtRows.map((r) => [r.key, r.value]));

    if (dto.type === MediaType.MOVIE) {
      const { details } = await this.readForLibrary(
        dto.type,
        this.tmdb,
        String(dto.tmdbId),
        library,
        override,
      );
      const movieFolderFormat =
        fmtMap['naming_movie_folder_format'] ??
        '{Original Title} ({Release Year})';
      const folderName = this.naming.applyMovieFolderFormat(movieFolderFormat, {
        title: details.title,
        originalTitle: details.originalTitle,
        year: details.year,
        tmdbId: details.tmdbId,
      });
      return this.persistImportedMovie(
        details,
        qualityProfileId,
        languageProfileId,
        folderName,
        libraryId,
        addedByUserId,
      );
    }

    const read = await this.readForLibrary(
      dto.type,
      this.tmdb,
      String(dto.tmdbId),
      library,
      override,
    );
    const details = read.details;
    const seasons = await read.provider.getTvShowSeasons(
      read.externalId,
      override,
    );
    const seriesFolderFormat =
      fmtMap['naming_series_folder_format'] ?? '{Series Title}';
    const folderName = this.naming.applySeriesFolderFormat(seriesFolderFormat, {
      seriesTitle: details.title,
      originalTitle: details.originalTitle,
      year: details.year,
      tmdbId: details.tmdbId,
    });
    return this.persistImportedSeries(
      details,
      seasons,
      qualityProfileId,
      languageProfileId,
      folderName,
      libraryId,
      addedByUserId,
      monitoredSeasons,
    );
  }

  /**
   * Import media from any provider (TMDB, TVDB).
   * Cross-references IDs between providers when possible.
   */
  async importMedia(
    dto: ImportMediaDto,
    addedByUserId: number | null = null,
  ): Promise<Media> {
    const provider = this.providerRegistry.resolve(dto.provider ?? null);

    const existingCheck: any[] = [];
    if (dto.provider === 'tmdb' || !dto.provider) {
      existingCheck.push({
        tmdbId: parseInt(dto.externalId, 10),
        type: dto.type,
      });
    }
    if (dto.provider === 'tvdb') {
      existingCheck.push({
        tvdbId: parseInt(dto.externalId, 10),
        type: dto.type,
      });
    }
    if (existingCheck.length) {
      const existing = await this.mediaRepo.findOne({ where: existingCheck });
      if (existing) {
        throw new ConflictException('This title is already in the library');
      }
    }

    const qualityProfileId =
      await this.profiles.resolveQualityProfileIdForImport(
        dto.qualityProfileId,
      );
    const languageProfileId =
      await this.profiles.resolveLanguageProfileIdForImport(
        dto.languageProfileId,
      );

    const { libraryId, library } = await this.resolveImportTarget(dto.type, {
      libraryId: dto.libraryId,
    });
    const override = this.libraryMetadataOverride(library);

    const fmtKeys = [
      'naming_movie_folder_format',
      'naming_series_folder_format',
    ];
    const fmtRows: { key: string; value: string }[] =
      await this.dataSource.query(
        `SELECT key, value FROM app_settings WHERE key = ANY($1)`,
        [fmtKeys],
      );
    const fmtMap = Object.fromEntries(fmtRows.map((r) => [r.key, r.value]));

    if (dto.type === MediaType.MOVIE) {
      const { details } = await this.readForLibrary(
        dto.type,
        provider,
        dto.externalId,
        library,
        override,
      );
      if (!details.tmdbId && details.tvdbId && this.tmdb.findByExternalId) {
        const cross = await this.tmdb.findByExternalId(
          'tvdb',
          String(details.tvdbId),
        );
        if (cross) details.tmdbId = parseInt(cross.id, 10);
      }
      const movieFolderFormat =
        fmtMap['naming_movie_folder_format'] ??
        '{Original Title} ({Release Year})';
      const folderName = this.naming.applyMovieFolderFormat(movieFolderFormat, {
        title: details.title,
        originalTitle: details.originalTitle,
        year: details.year,
        tmdbId: details.tmdbId,
      });
      return this.persistImportedMovie(
        details,
        qualityProfileId,
        languageProfileId,
        folderName,
        libraryId,
        addedByUserId,
      );
    }

    const read = await this.readForLibrary(
      dto.type,
      provider,
      dto.externalId,
      library,
      override,
    );
    const details = read.details;
    const seasons = await read.provider.getTvShowSeasons(
      read.externalId,
      override,
    );
    if (!details.tmdbId && details.tvdbId && this.tmdb.findByExternalId) {
      const cross = await this.tmdb.findByExternalId(
        'tvdb',
        String(details.tvdbId),
      );
      if (cross) details.tmdbId = parseInt(cross.id, 10);
    }
    const seriesFolderFormat =
      fmtMap['naming_series_folder_format'] ?? '{Series Title}';
    const folderName = this.naming.applySeriesFolderFormat(seriesFolderFormat, {
      seriesTitle: details.title,
      originalTitle: details.originalTitle,
      year: details.year,
      tmdbId: details.tmdbId,
    });
    return this.persistImportedSeries(
      details,
      seasons,
      qualityProfileId,
      languageProfileId,
      folderName,
      libraryId,
      addedByUserId,
    );
  }

  /**
   * Read a title through the provider the destination library prefers.
   *
   * A search answers from whichever provider is configured globally, and the library is only
   * picked afterwards, so importing what the search returned wrote TMDB rows into a TVDB
   * library — episode lists from one provider, titles from the other. The ids the first
   * provider knew are kept, so nothing loses its cross-reference.
   *
   * Falls back to the provider that found the title (with a warning) when the preferred one
   * is unavailable or holds no id for this work: an import that still happens beats none.
   */
  private async readForLibrary(
    type: MediaType,
    found: IMetadataProvider,
    externalId: string,
    library: Library | null,
    override?: MetadataLanguageOverride,
  ): Promise<{
    provider: IMetadataProvider;
    externalId: string;
    details: MetadataDetails;
  }> {
    const details =
      type === MediaType.MOVIE
        ? await found.getMovieDetails(externalId, override)
        : await found.getTvShowDetails(externalId, override);
    const keep = { provider: found, externalId, details };

    const pref = library?.preferredProvider;
    if (!pref || pref === found.name) return keep;
    if (!this.providerRegistry.isAvailable(pref)) {
      this.log.warn(
        `import: library prefers ${pref} but it is not available (no API key?) — ` +
          `importing "${details.title}" from ${found.name}`,
      );
      return keep;
    }

    const target = this.providerRegistry.get(pref)!;
    const targetId = await this.crossReferenceId(target, details, override);
    if (!targetId) {
      this.log.warn(
        `import: no ${pref} id for "${details.title}" (cross-reference failed) — ` +
          `importing from ${found.name}`,
      );
      return keep;
    }

    const preferred =
      type === MediaType.MOVIE
        ? await target.getMovieDetails(targetId, override)
        : await target.getTvShowDetails(targetId, override);
    this.log.log(
      `import: "${details.title}" read from ${pref} (id=${targetId}) — library preference`,
    );
    return {
      provider: target,
      externalId: targetId,
      details: {
        ...preferred,
        tmdbId: preferred.tmdbId || details.tmdbId,
        tvdbId: preferred.tvdbId ?? details.tvdbId,
        imdbId: preferred.imdbId ?? details.imdbId,
      },
    };
  }

  /** The id `target` knows this work by: its own id off the details, else an IMDB lookup. */
  private async crossReferenceId(
    target: IMetadataProvider,
    details: MetadataDetails,
    override?: MetadataLanguageOverride,
  ): Promise<string | null> {
    if (target.name === 'tmdb' && details.tmdbId) return String(details.tmdbId);
    if (target.name === 'tvdb' && details.tvdbId) return String(details.tvdbId);
    if (details.imdbId && target.findByExternalId) {
      const cross = await target.findByExternalId(
        'imdb',
        details.imdbId,
        override,
      );
      if (cross) return cross.id;
    }
    return null;
  }

  /**
   * Create a title no metadata provider matched, straight from the orphan scan's guessed title.
   * No provider call, no images, no cast: an Identify later fills those in.
   */
  async createUnmatched(
    dto: {
      title: string;
      year?: number | null;
      type: MediaType;
      libraryId: number;
      folderName: string;
      qualityProfileId?: number;
      languageProfileId?: number;
    },
    addedByUserId: number | null = null,
  ): Promise<Media> {
    const qualityProfileId =
      await this.profiles.resolveQualityProfileIdForImport(
        dto.qualityProfileId,
      );
    const languageProfileId =
      await this.profiles.resolveLanguageProfileIdForImport(
        dto.languageProfileId,
      );

    const row = this.mediaRepo.create({
      title: dto.title,
      originalTitle: dto.title,
      year: dto.year ?? undefined,
      type: dto.type,
      status: MediaStatus.RELEASED,
      monitored: false,
      alternativeTitles: [],
      genres: [],
      library: { id: dto.libraryId } as Library,
      folderName: dto.folderName,
      ...(qualityProfileId != null
        ? { qualityProfile: { id: qualityProfileId } as QualityProfile }
        : {}),
      ...(languageProfileId != null
        ? { languageProfile: { id: languageProfileId } as LanguageProfile }
        : {}),
      ...(addedByUserId ? { addedBy: { id: addedByUserId } as User } : {}),
    });
    const saved = await this.mediaRepo.save(row);
    await this.metadata.updateSearchVector(saved.id);
    this.events.emitDomain({
      type: 'media.imported',
      mediaId: saved.id,
      tmdbId: null,
      mediaType: dto.type,
      libraryId: dto.libraryId,
      addedByUserId: addedByUserId ?? null,
    });
    const year = dto.year ? ` (${dto.year})` : '';
    this.log.log(
      `Library: added unidentified ${dto.type} "${dto.title}"${year}, id=${saved.id}`,
    );
    const reloaded = await this.mediaRepo.findOne({ where: { id: saved.id } });
    if (!reloaded) throw new Error(`Media #${saved.id} not found after save`);
    return reloaded;
  }

  async create(dto: CreateMediaDto): Promise<Media> {
    const media = this.mediaRepo.create(dto);
    const saved = await this.mediaRepo.save(media);
    await this.metadata.updateSearchVector(saved.id);
    const reloaded = await this.mediaRepo.findOne({ where: { id: saved.id } });
    if (!reloaded) throw new Error(`Media #${saved.id} not found after save`);
    this.events.emitDomain({
      type: 'media.imported',
      mediaId: saved.id,
      tmdbId: dto.tmdbId ?? null,
      mediaType: dto.type,
      libraryId: null,
      addedByUserId: null,
    });
    return reloaded;
  }

  /**
   * Resolve the destination library for an import.
   *  - Explicit `libraryId` from DTO wins (validated against media type).
   *  - Otherwise we fall back to the default library for the media type
   *    (`isDefaultForMovies` / `isDefaultForSeries` flag).
   *
   * The library is also required to have a configured `path` — every
   * import flow needs to know where to drop files.
   */
  async resolveImportTarget(
    type: MediaType,
    dto: { libraryId?: number },
  ): Promise<{ libraryId: number; library: Library }> {
    let library: Library | null = null;

    if (dto.libraryId) {
      library = await this.libraryRepo.findOne({
        where: { id: dto.libraryId },
      });
      if (!library) {
        throw new BadRequestException(`Library #${dto.libraryId} not found`);
      }
    }

    if (!library) {
      library = await this.libraries.getDefaultForType(type);
    }

    if (!library) {
      throw new BadRequestException(
        'No compatible library found. Set a default library for this media type in settings.',
      );
    }
    if (!library.mediaTypes?.includes(type)) {
      throw new BadRequestException(
        `Library "${library.name}" does not accept ${type}`,
      );
    }
    if (!library.path) {
      throw new BadRequestException(
        `Library "${library.name}" has no root path configured`,
      );
    }

    return { libraryId: library.id, library };
  }

  /** Metadata language/region override for a library's media (null fields =
   *  inherit the global setting). */
  private libraryMetadataOverride(library: Library): MetadataLanguageOverride {
    return {
      language: library.metadataLanguage,
      region: library.metadataRegion,
    };
  }

  private async persistImportedMovie(
    details: MetadataDetails,
    qualityProfileId: number | null,
    languageProfileId: number | null,
    folderName?: string,
    libraryId?: number,
    addedByUserId?: number | null,
  ): Promise<Media> {
    const row = this.mediaRepo.create({
      ...buildMediaFieldsFromTmdb(details, MediaType.MOVIE),
      monitored: true,
      metadataRefreshedAt: new Date(),
      ...(qualityProfileId != null
        ? { qualityProfile: { id: qualityProfileId } as QualityProfile }
        : {}),
      ...(languageProfileId != null
        ? { languageProfile: { id: languageProfileId } as LanguageProfile }
        : {}),
      ...(libraryId ? { library: { id: libraryId } as Library } : {}),
      ...(folderName ? { folderName } : {}),
      ...(addedByUserId ? { addedBy: { id: addedByUserId } as User } : {}),
    });
    const saved = await this.mediaRepo.save(row);
    this.logLibraryAdded('movie', saved);
    this.metadata.downloadMediaImagesInBackground(saved.id, details);
    await this.metadata.updateSearchVector(saved.id);
    await this.requestLifecycle.onMediaImported(saved, addedByUserId ?? null);
    this.events.emitDomain({
      type: 'media.imported',
      mediaId: saved.id,
      tmdbId: details.tmdbId ?? null,
      mediaType: MediaType.MOVIE,
      libraryId: libraryId ?? null,
      addedByUserId: addedByUserId ?? null,
    });
    const reloaded = await this.mediaRepo.findOne({ where: { id: saved.id } });
    if (!reloaded) throw new Error(`Media #${saved.id} not found after save`);
    // Cast/crew + per-person enrichment is detail-page data the badge,
    // monitoring and auto-grab never read; its per-person TMDB fan-out is the
    // bulk of an import's latency, so it lands after approval returns.
    this.metadata.persistMediaMetadataInBackground(saved, details);
    return reloaded;
  }

  private logLibraryAdded(
    kind: 'movie' | 'series',
    media: Media,
    extra?: string,
  ): void {
    const year = media.year ? ` (${media.year})` : '';
    const tail = extra ? `, ${extra}` : '';
    this.log.log(
      `Library: added ${kind} "${media.title}"${year} — id=${media.id}, tmdbId=${media.tmdbId ?? '?'}${tail}`,
    );
  }

  private async persistImportedSeries(
    details: MetadataDetails,
    seasons: SeasonDetails[],
    qualityProfileId: number | null,
    languageProfileId: number | null,
    folderName?: string,
    libraryId?: number,
    addedByUserId?: number | null,
    monitoredSeasons?: number[] | null,
  ): Promise<Media> {
    const row = this.mediaRepo.create({
      ...buildMediaFieldsFromTmdb(details, MediaType.SERIES),
      monitored: true,
      metadataRefreshedAt: new Date(),
      ...(qualityProfileId != null
        ? { qualityProfile: { id: qualityProfileId } as QualityProfile }
        : {}),
      ...(languageProfileId != null
        ? { languageProfile: { id: languageProfileId } as LanguageProfile }
        : {}),
      ...(libraryId ? { library: { id: libraryId } as Library } : {}),
      ...(folderName ? { folderName } : {}),
      ...(addedByUserId ? { addedBy: { id: addedByUserId } as User } : {}),
    });
    const saved = await this.mediaRepo.save(row);
    this.logLibraryAdded('series', saved, `seasons=${seasons.length}`);
    this.metadata.downloadMediaImagesInBackground(saved.id, details);

    // A season-scoped request only monitors the seasons it asked for; the rest
    // import unmonitored so the auto-grab leaves them alone. An empty/absent
    // scope (whole-series request or admin add) monitors every season but the
    // specials, which are only monitored when asked for by number.
    const inScope = (n: number) =>
      monitoredSeasons?.length ? monitoredSeasons.includes(n) : n > 0;

    for (const sd of seasons) {
      const sSaved = await this.seasonRepo.save(
        this.seasonRepo.create({
          media: saved,
          seasonNumber: sd.seasonNumber,
          monitored: inScope(sd.seasonNumber),
        }),
      );
      // Reuse the same per-season routine the metadata refresh uses so import
      // and refresh produce identical episode rows, stills and season posters.
      // deferImages pushes the still/poster CDN GETs to the background — the
      // episode rows (which the auto-grab reads) are still written inline.
      await this.metadata.applySeasonDetails(sSaved, sd, { deferImages: true });
    }

    await this.metadata.updateSearchVector(saved.id);
    await this.requestLifecycle.onMediaImported(saved, addedByUserId ?? null);
    this.events.emitDomain({
      type: 'media.imported',
      mediaId: saved.id,
      tmdbId: details.tmdbId ?? null,
      mediaType: MediaType.SERIES,
      libraryId: libraryId ?? null,
      addedByUserId: addedByUserId ?? null,
    });
    const reloaded = await this.mediaRepo.findOne({ where: { id: saved.id } });
    if (!reloaded) throw new Error(`Media #${saved.id} not found after save`);
    // See persistImportedMovie: cast/crew enrichment is deferred. Season and
    // episode rows above stay synchronous because the auto-grab reads them.
    this.metadata.persistMediaMetadataInBackground(saved, details);
    return reloaded;
  }
}
