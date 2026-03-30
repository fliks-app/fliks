import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TmdbProvider } from './providers/tmdb.provider';
import { MetadataProvidersController } from './metadata-providers.controller';
import { Media } from '../media/entities/media.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TypeOrmModule.forFeature([Media]), AuthModule],
  controllers: [MetadataProvidersController],
  providers: [TmdbProvider],
  exports: [TmdbProvider],
})
export class MetadataProvidersModule {}
