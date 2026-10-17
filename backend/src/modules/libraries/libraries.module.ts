import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Library } from './entities/library.entity';
import { LibraryUserAccess } from './entities/library-user-access.entity';
import { Media } from '../media/entities/media.entity';
import { MediaMetadata } from '../media/entities/media-metadata.entity';
import { MediaCast } from '../media/entities/media-cast.entity';
import { MediaCrew } from '../media/entities/media-crew.entity';
import { Person } from '../media/entities/person.entity';
import { Season } from '../media/entities/season.entity';
import { LanguageProfile } from '../profiles/entities/language-profile.entity';
import { QualityProfile } from '../profiles/entities/quality-profile.entity';
import { LibrariesService } from './libraries.service';

@Module({
  imports: [TypeOrmModule.forFeature([
      Library,
      LibraryUserAccess,
      Media,
      MediaMetadata,
      MediaCast,
      MediaCrew,
      Person,
      Season,
      LanguageProfile,
      QualityProfile,
    ])],
  providers: [LibrariesService],
  exports: [LibrariesService, TypeOrmModule],
})
export class LibrariesModule {}
