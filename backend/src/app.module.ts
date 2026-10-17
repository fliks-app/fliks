import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { RequestsModule } from './modules/requests/requests.module';
import { FliksSchedulerModule } from './modules/scheduler/scheduler.module';
import { EventsModule } from './modules/scheduler/events.module';
import { LibrariesModule } from './modules/libraries/libraries.module';
import { SettingsModule } from './modules/settings/settings.module';
import { StreamingModule } from './modules/streaming/streaming.module';
import { PlaybackModule } from './modules/playback/playback.module';
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
    EngineModule,
    BridgeModule,
    EventsModule,
    AuthModule,
    UsersModule,
    RequestsModule,
    FliksSchedulerModule,
    LibrariesModule,
    SettingsModule,
    StreamingModule,
    PlaybackModule,
    // @Global(): registered once here so PluginProcessService (in PluginsModule) can
    // inject PluginHostBindingService without an import edge back into this module.
  ],
})
export class AppModule {}
