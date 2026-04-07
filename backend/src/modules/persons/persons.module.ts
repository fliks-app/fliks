import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Person } from '../media/entities/person.entity';
import { MediaCast } from '../media/entities/media-cast.entity';
import { MediaCrew } from '../media/entities/media-crew.entity';
import { MetadataProvidersModule } from '../metadata-providers/metadata-providers.module';
import { PersonsService } from './persons.service';
import { PersonsController } from './persons.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Person, MediaCast, MediaCrew]),
    MetadataProvidersModule,
  ],
  controllers: [PersonsController],
  providers: [PersonsService],
  exports: [PersonsService],
})
export class PersonsModule {}
