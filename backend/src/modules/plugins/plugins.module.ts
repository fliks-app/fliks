import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PluginPackage } from './entities/plugin-package.entity';
import { PluginSource } from './entities/plugin-source.entity';
import { PluginRegistration } from './entities/plugin-registration.entity';

@Module({
  imports: [TypeOrmModule.forFeature([PluginPackage, PluginSource, PluginRegistration])],
  exports: [TypeOrmModule],
})
export class PluginsModule {}
