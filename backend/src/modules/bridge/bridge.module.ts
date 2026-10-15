import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { BridgeController } from './bridge.controller';
import { EngineLivetvConfigClient } from './engine-livetv-config.client';
import { StreamTokenClient } from './stream-token.client';

@Module({
  imports: [SettingsModule],
  controllers: [BridgeController],
  providers: [StreamTokenClient, EngineLivetvConfigClient],
  exports: [StreamTokenClient, EngineLivetvConfigClient],
})
export class BridgeModule {}
