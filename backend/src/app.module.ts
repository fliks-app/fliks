import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { MediaModule } from './modules/media/media.module';
import { ProfilesModule } from './modules/profiles/profiles.module';
import { TagsModule } from './modules/tags/tags.module';
import { MetadataProvidersModule } from './modules/metadata-providers/metadata-providers.module';
import { IndexersModule } from './modules/indexers/indexers.module';
import { DownloadClientsModule } from './modules/download-clients/download-clients.module';
import { RequestsModule } from './modules/requests/requests.module';
import { SuitarrSchedulerModule } from './modules/scheduler/scheduler.module';
import { EventsModule } from './modules/scheduler/events.module';
import { RootFoldersModule } from './modules/root-folders/root-folders.module';
import { BlocklistModule } from './modules/blocklist/blocklist.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SettingsModule } from './modules/settings/settings.module';
import { SubtitlesModule } from './modules/subtitles/subtitles.module';
import { MediaServersModule } from './modules/media-servers/media-servers.module';
import { RolesModule } from './modules/roles/roles.module';
import { StreamingModule } from './modules/streaming/streaming.module';
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
        ? [{
            rootPath: process.env.SERVE_STATIC_PATH,
            exclude: ['/api/{*path}', '/cast/{*path}'],
          }]
        : []),
    ),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 5432),
        username: config.get('DB_USERNAME', 'suitarr'),
        password: config.get('DB_PASSWORD', 'suitarr'),
        database: config.get('DB_NAME', 'suitarr'),
        autoLoadEntities: true,
        synchronize: true,
        extra: { max: 20 },
      }),
    }),
    EventsModule,
    AuthModule,
    UsersModule,
    MediaModule,
    ProfilesModule,
    TagsModule,
    MetadataProvidersModule,
    IndexersModule,
    DownloadClientsModule,
    RequestsModule,
    SuitarrSchedulerModule,
    RootFoldersModule,
    BlocklistModule,
    NotificationsModule,
    SettingsModule,
    SubtitlesModule,
    MediaServersModule,
    RolesModule,
    StreamingModule,
  ],
})
export class AppModule {}
