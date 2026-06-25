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
  MetadataDetails,
  SeasonDetails,
} from '../../metadata-providers/interfaces/metadata-provider.interface';
import { MediaType } from '../../../common/enums';
import { RequestLifecycleService } from '../../requests/request-lifecycle.service';
import { ProfilesService } from '../../profiles/profiles.service';
import { QualityProfile } from '../../profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../../profiles/entities/language-profile.entity';
import { User } from '../../users/entities/user.entity';
import { Library } from '../../libraries/entities/library.entity';
import { LibrariesService } from '../../libraries/libraries.service';
import { NamingService } from '../../scheduler/naming.service';
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

    const { libraryId } = await this.resolveImportTarget(dto.type, {
      libraryId: dto.libraryId,
    });

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
      const details = await this.tmdb.getMovieDetails(String(dto.tmdbId));
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

    const details = await this.tmdb.getTvShowDetails(String(dto.tmdbId));
    const seasons = await this.tmdb.getTvShowSeasons(String(dto.tmdbId));
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

    const { libraryId } = await this.resolveImportTarget(dto.type, {
      libraryId: dto.libraryId,
    });

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
      const details = await provider.getMovieDetails(dto.externalId);
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

    const details = await provider.getTvShowDetails(dto.externalId);
    const seasons = await provider.getTvShowSeasons(dto.externalId);
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

  async create(dto: CreateMediaDto): Promise<Media> {
    const media = this.mediaRepo.create(dto);
    const saved = await this.mediaRepo.save(media);
    await this.metadata.updateSearchVector(saved.id);
    const reloaded = await this.mediaRepo.findOne({ where: { id: saved.id } });
    if (!reloaded) throw new Error(`Media #${saved.id} not found after save`);
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
  ): Promise<{ libraryId: number }> {
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

    return { libraryId: library.id };
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
    // scope (whole-series request or admin add) monitors every season.
    const inScope = (n: number) =>
      !monitoredSeasons?.length || monitoredSeasons.includes(n);

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
    const reloaded = await this.mediaRepo.findOne({ where: { id: saved.id } });
    if (!reloaded) throw new Error(`Media #${saved.id} not found after save`);
    // See persistImportedMovie: cast/crew enrichment is deferred. Season and
    // episode rows above stay synchronous because the auto-grab reads them.
    this.metadata.persistMediaMetadataInBackground(saved, details);
    return reloaded;
  }
}
