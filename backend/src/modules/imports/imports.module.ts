import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { Season } from '../media/entities/season.entity';
import { Episode } from '../media/entities/episode.entity';
import { RootFolder } from '../root-folders/entities/root-folder.entity';
import { QualityProfile } from '../profiles/entities/quality-profile.entity';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { User } from '../users/entities/user.entity';
import { FliksRequest } from '../requests/entities/request.entity';
import { LibraryUserAccess } from '../libraries/entities/library-user-access.entity';
import { Role } from '../roles/entities/role.entity';
import { ImportRadarrService } from './radarr.service';
import { ImportSonarrService } from './sonarr.service';
import { SeerrService } from './seerr.service';
import { SeerrRequestImportService } from './seerr-request-import.service';
import { DiskImportService } from './disk-import.service';
import { ImportsController } from './imports.controller';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { LibrariesModule } from '../libraries/libraries.module';
import { MediaModule } from '../media/media.module';
import { FliksSchedulerModule } from '../scheduler/scheduler.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Media,
      MediaFile,
      Season,
      Episode,
      RootFolder,
      QualityProfile,
      SubtitleFile,
      User,
      FliksRequest,
      LibraryUserAccess,
      Role,
    ]),
    AuthModule,
    SettingsModule,
    LibrariesModule,
    forwardRef(() => MediaModule),
    forwardRef(() => FliksSchedulerModule),
  ],
  controllers: [ImportsController],
  providers: [
    ImportRadarrService,
    ImportSonarrService,
    SeerrService,
    SeerrRequestImportService,
    DiskImportService,
  ],
})
export class ImportsModule {}
