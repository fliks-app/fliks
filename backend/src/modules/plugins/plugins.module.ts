import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PluginPackage } from './entities/plugin-package.entity';
import { PluginSource } from './entities/plugin-source.entity';
import { PluginRegistration } from './entities/plugin-registration.entity';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginWebhookDispatcherService } from './plugin-webhook-dispatcher.service';
import { PluginCatalogClientService } from './plugin-catalog-client.service';
import { PluginStagingService } from './plugin-staging.service';
import { PluginInstallService } from './plugin-install.service';
import { PluginLogoController } from './plugin-logo.controller';
import { PluginIndexerDescriptorsController } from './plugin-indexer-descriptors.controller';
import { PluginSourcesController } from './plugin-sources.controller';
import { PluginImportController } from './plugin-import.controller';
import { PluginsController } from './plugins.controller';
import { AuthModule } from '../auth/auth.module';
import { EventsModule } from '../scheduler/events.module';

@Module({
  imports: [TypeOrmModule.forFeature([PluginPackage, PluginSource, PluginRegistration]), AuthModule, EventsModule],
  controllers: [
    PluginLogoController,
    PluginIndexerDescriptorsController,
    PluginSourcesController,
    PluginImportController,
    PluginsController,
  ],
  providers: [
    PluginRegistryService,
    PluginWebhookDispatcherService,
    PluginCatalogClientService,
    PluginStagingService,
    PluginInstallService,
  ],
  exports: [TypeOrmModule, PluginRegistryService],
})
export class PluginsModule {}
