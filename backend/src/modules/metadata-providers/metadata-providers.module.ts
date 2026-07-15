import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TmdbProvider } from './providers/tmdb.provider';
import { TvdbProvider } from './providers/tvdb.provider';
import { MetadataProviderRegistry } from './metadata-provider.registry';
import { MetadataSettingsCache } from './metadata-settings-cache.service';
import { MetadataProvidersController } from './metadata-providers.controller';
import { Media } from '../media/entities/media.entity';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Media]),
    AuthModule,
    forwardRef(() => SettingsModule),
  ],
  controllers: [MetadataProvidersController],
  providers: [
    TmdbProvider,
    TvdbProvider,
    MetadataProviderRegistry,
    MetadataSettingsCache,
  ],
  exports: [TmdbProvider, TvdbProvider, MetadataProviderRegistry],
})
export class MetadataProvidersModule {}
