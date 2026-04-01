import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppSetting } from './entities/app-setting.entity';
import { RemotePathMapping } from './entities/remote-path-mapping.entity';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { RemotePathMappingsController } from './remote-path-mappings.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AppSetting, RemotePathMapping]),
    AuthModule,
  ],
  controllers: [SettingsController, RemotePathMappingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
