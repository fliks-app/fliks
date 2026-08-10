import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PluginPackage } from './entities/plugin-package.entity';
import { PluginSource } from './entities/plugin-source.entity';
import { PluginRegistration } from './entities/plugin-registration.entity';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginWebhookDispatcherService } from './plugin-webhook-dispatcher.service';
import { PluginProcessService } from './plugin-process.service';
import { PluginProcessEventDispatcherService } from './plugin-process-event-dispatcher.service';
import { PluginCatalogClientService } from './plugin-catalog-client.service';
import { PluginStagingService } from './plugin-staging.service';
import { PluginInstallService } from './plugin-install.service';
import { PluginDatabaseService } from './plugin-database.service';
import { PluginLogoController } from './plugin-logo.controller';
import { PluginIndexerDescriptorsController } from './plugin-indexer-descriptors.controller';
import { PluginSourcesController } from './plugin-sources.controller';
import { PluginImportController } from './plugin-import.controller';
import { PluginsController } from './plugins.controller';
import { PluginObjectGuardsService } from './proxy/plugin-object-guards.service';
import { PluginRouteGuard } from './proxy/plugin-route.guard';
import { PluginProxyController } from './proxy/plugin-proxy.controller';
import { AuthModule } from '../auth/auth.module';
import { EventsModule } from '../scheduler/events.module';
import { LogBufferModule } from '../scheduler/log-buffer.module';
import { SettingsModule } from '../settings/settings.module';
import { LibrariesModule } from '../libraries/libraries.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([PluginPackage, PluginSource, PluginRegistration]),
    AuthModule,
    EventsModule,
    LogBufferModule,
    SettingsModule,
    LibrariesModule,
  ],
  controllers: [
    PluginLogoController,
    PluginIndexerDescriptorsController,
    PluginSourcesController,
    PluginImportController,
    PluginsController,
    // Last: its `*splat` wildcard must never shadow the concrete routes above.
    PluginProxyController,
  ],
  providers: [
    PluginRegistryService,
    PluginWebhookDispatcherService,
    PluginProcessService,
    PluginProcessEventDispatcherService,
    PluginCatalogClientService,
    PluginStagingService,
    PluginInstallService,
    PluginDatabaseService,
    PluginObjectGuardsService,
    PluginRouteGuard,
  ],
  exports: [TypeOrmModule, PluginRegistryService, PluginDatabaseService],
})
export class PluginsModule {}
