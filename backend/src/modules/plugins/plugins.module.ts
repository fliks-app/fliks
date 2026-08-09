import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PluginPackage } from './entities/plugin-package.entity';
import { PluginSource } from './entities/plugin-source.entity';
import { PluginRegistration } from './entities/plugin-registration.entity';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginLogoController } from './plugin-logo.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TypeOrmModule.forFeature([PluginPackage, PluginSource, PluginRegistration]), AuthModule],
  controllers: [PluginLogoController],
  providers: [PluginRegistryService],
  exports: [TypeOrmModule, PluginRegistryService],
})
export class PluginsModule {}
