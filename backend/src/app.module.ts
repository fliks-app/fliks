import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { MediaModule } from './modules/media/media.module';
import { ProfilesModule } from './modules/profiles/profiles.module';
import { MetadataProvidersModule } from './modules/metadata-providers/metadata-providers.module';
import { RequestsModule } from './modules/requests/requests.module';
import { FliksSchedulerModule } from './modules/scheduler/scheduler.module';
import { EventsModule } from './modules/scheduler/events.module';
import { LibrariesModule } from './modules/libraries/libraries.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SettingsModule } from './modules/settings/settings.module';
import { SubtitlesModule } from './modules/subtitles/subtitles.module';
import { MediaServersModule } from './modules/media-servers/media-servers.module';
import { RolesModule } from './modules/roles/roles.module';
import { StreamingModule } from './modules/streaming/streaming.module';
import { PlaybackModule } from './modules/playback/playback.module';
import { MarkersModule } from './modules/markers/markers.module';
import { PersonsModule } from './modules/persons/persons.module';
import { ImageModule } from './modules/images/image.module';
import { ImportsModule } from './modules/imports/imports.module';
import { SetupChecklistModule } from './modules/setup-checklist/setup-checklist.module';
import { CountsModule } from './modules/counts/counts.module';
import { PluginsModule } from './modules/plugins/plugins.module';
import { PluginHostModule } from './modules/plugins/host/plugin-host.module';
import { LiveTvModule } from './modules/livetv/livetv.module';
import { CommonModule } from './common/common.module';
import { EngineModule } from './modules/engine/engine.module';
import { BridgeModule } from './modules/bridge/bridge.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        return {
          type: 'postgres',
          host: config.get('DB_HOST', 'localhost'),
          port: config.get<number>('DB_PORT', 5432),
          username: config.get('DB_USERNAME', 'fliks'),
          password: config.get('DB_PASSWORD', 'fliks'),
          database: config.get('DB_NAME', 'fliks'),
          autoLoadEntities: true,
          // Schema is owned by server/migrations (fliks-server), never by Nest.
          synchronize: false,
          migrationsRun: false,
          extra: { max: 30 },
        };
      },
    }),
    CommonModule,
    EngineModule,
    BridgeModule,
    EventsModule,
    AuthModule,
    UsersModule,
    MediaModule,
    PersonsModule,
    ProfilesModule,
    MetadataProvidersModule,
    RequestsModule,
    FliksSchedulerModule,
    LibrariesModule,
    NotificationsModule,
    SettingsModule,
    SubtitlesModule,
    MediaServersModule,
    RolesModule,
    StreamingModule,
    PlaybackModule,
    ImageModule,
    MarkersModule,
    ImportsModule,
    SetupChecklistModule,
    CountsModule,
    PluginsModule,
    // @Global(): registered once here so PluginProcessService (in PluginsModule) can
    // inject PluginHostBindingService without an import edge back into this module.
    PluginHostModule,
    LiveTvModule,
  ],
})
export class AppModule {}
