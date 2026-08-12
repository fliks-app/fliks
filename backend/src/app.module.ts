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
import { PlaylistsModule } from './modules/playlists/playlists.module';
import { SocialModule } from './modules/social/social.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SettingsModule } from './modules/settings/settings.module';
import { SubtitlesModule } from './modules/subtitles/subtitles.module';
import { MediaServersModule } from './modules/media-servers/media-servers.module';
import { RolesModule } from './modules/roles/roles.module';
import { StreamingModule } from './modules/streaming/streaming.module';
import { MarkersModule } from './modules/markers/markers.module';
import { PersonsModule } from './modules/persons/persons.module';
import { ImageModule } from './modules/images/image.module';
import { ImportsModule } from './modules/imports/imports.module';
import { FilesystemModule } from './modules/filesystem/filesystem.module';
import { SetupChecklistModule } from './modules/setup-checklist/setup-checklist.module';
import { CountsModule } from './modules/counts/counts.module';
import { PluginsModule } from './modules/plugins/plugins.module';
import { PluginLegacyAliasModule } from './modules/plugins/proxy/plugin-legacy-alias.module';
import { PluginHostModule } from './modules/plugins/host/plugin-host.module';
import { CommonModule } from './common/common.module';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ServeStaticModule.forRoot(
      {
        rootPath: join(__dirname, '..', 'public'),
        serveRoot: '/cast',
        serveStaticOptions: { index: false },
      },
      // Serve the Angular frontend in production (when SERVE_STATIC_PATH is set)
      ...(process.env.SERVE_STATIC_PATH
        ? [
            {
              rootPath: process.env.SERVE_STATIC_PATH,
              exclude: ['/api/{*path}', '/cast/{*path}'],
            },
          ]
        : []),
    ),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isDev = config.get('NODE_ENV', 'development') !== 'production';
        return {
          type: 'postgres',
          host: config.get('DB_HOST', 'localhost'),
          port: config.get<number>('DB_PORT', 5432),
          username: config.get('DB_USERNAME', 'fliks'),
          password: config.get('DB_PASSWORD', 'fliks'),
          database: config.get('DB_NAME', 'fliks'),
          autoLoadEntities: true,
          // Dev: auto-sync the schema from entity metadata so a column
          // rename takes effect on the next restart without writing a
          // migration. Prod: migrations are the only sanctioned schema
          // mechanism — see `src/data-source.ts` and the
          // `db:migration:*` scripts.
          synchronize: isDev,
          migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
          migrationsRun: !isDev,
          extra: { max: 30 },
        };
      },
    }),
    CommonModule,
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
    PlaylistsModule,
    SocialModule,
    NotificationsModule,
    SettingsModule,
    SubtitlesModule,
    MediaServersModule,
    RolesModule,
    StreamingModule,
    ImageModule,
    MarkersModule,
    ImportsModule,
    FilesystemModule,
    SetupChecklistModule,
    CountsModule,
    PluginsModule,
    // @Global(): registered once here so PluginProcessService (in PluginsModule) can
    // inject PluginHostBindingService without an import edge back into this module.
    PluginHostModule,
    // Dead last, and it must stay there: it owns an app-wide `*splat` catch-all, which
    // Express matches ahead of every route registered after it.
    PluginLegacyAliasModule,
  ],
})
export class AppModule {}
