import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PluginPackage } from './entities/plugin-package.entity';
import { PluginSource } from './entities/plugin-source.entity';
import { PluginRegistration } from './entities/plugin-registration.entity';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginWebhookDispatcherService } from './plugin-webhook-dispatcher.service';
import { PluginLogoController } from './plugin-logo.controller';
import { PluginIndexerDescriptorsController } from './plugin-indexer-descriptors.controller';
import { AuthModule } from '../auth/auth.module';
import { EventsModule } from '../scheduler/events.module';

@Module({
  imports: [TypeOrmModule.forFeature([PluginPackage, PluginSource, PluginRegistration]), AuthModule, EventsModule],
  controllers: [PluginLogoController, PluginIndexerDescriptorsController],
  providers: [PluginRegistryService, PluginWebhookDispatcherService],
  exports: [TypeOrmModule, PluginRegistryService],
})
export class PluginsModule {}
