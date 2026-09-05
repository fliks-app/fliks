import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Media } from './entities/media.entity';
import { Season } from './entities/season.entity';
import { Episode } from './entities/episode.entity';
import { MediaFile } from './entities/media-file.entity';
import { MediaMetadata } from './entities/media-metadata.entity';
import { Person } from './entities/person.entity';
import { MediaCast } from './entities/media-cast.entity';
import { MediaCrew } from './entities/media-crew.entity';
import { RequestsModule } from '../requests/requests.module';
import { MediaService } from './media.service';
import { MediaController } from './media.controller';
import { AuthModule } from '../auth/auth.module';
import { MetadataProvidersModule } from '../metadata-providers/metadata-providers.module';
import { ProfilesModule } from '../profiles/profiles.module';
import { SubtitlesModule } from '../subtitles/subtitles.module';
import { MediaServersModule } from '../media-servers/media-servers.module';
import { AutoGrabPipelineService } from './auto-grab-pipeline.service';
import { AcquisitionCandidatesService } from './acquisition-candidates.service';
import { NamingService } from '../scheduler/naming.service';
import { MediaImportService } from './media-service/media-import.service';
import { MediaMetadataService } from './media-service/media-metadata.service';
import { MediaQueryService } from './media-service/media-query.service';
import { MediaRelatedService } from './media-service/media-related.service';
import { MediaMutationService } from './media-service/media-mutation.service';
import { MediaRescanService } from './media-service/media-rescan.service';
import { Library } from '../libraries/entities/library.entity';
import { LibrariesModule } from '../libraries/libraries.module';
import { MEDIA_SERVICE } from './media-service.token';
import { FliksSchedulerModule } from '../scheduler/scheduler.module';
import { ImageModule } from '../images/image.module';
import { StreamingModule } from '../streaming/streaming.module';
import { LibraryIngestModule } from '../../common/library-ingest/library-ingest.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Media,
      Season,
      Episode,
      MediaFile,
      MediaMetadata,
      Person,
      MediaCast,
      MediaCrew,
      Library,
    ]),
    AuthModule,
    MetadataProvidersModule,
    ProfilesModule,
    SubtitlesModule,
    MediaServersModule,
    forwardRef(() => FliksSchedulerModule),
    forwardRef(() => RequestsModule),
    forwardRef(() => LibraryIngestModule),
    ImageModule,
    StreamingModule,
    LibrariesModule,
  ],
  controllers: [MediaController],
  providers: [
    { provide: MEDIA_SERVICE, useExisting: MediaService },
    MediaService,
    MediaImportService,
    MediaMetadataService,
    MediaQueryService,
    MediaRelatedService,
    MediaMutationService,
    MediaRescanService,
    AutoGrabPipelineService,
    AcquisitionCandidatesService,
    NamingService,
  ],
  exports: [
    MediaService,
    MEDIA_SERVICE,
    MediaMetadataService,
    MediaRescanService,
    AutoGrabPipelineService,
    AcquisitionCandidatesService,
  ],
})
export class MediaModule {}
