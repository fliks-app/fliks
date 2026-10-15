import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { BridgeController } from './bridge.controller';
import { StreamTokenClient } from './stream-token.client';

@Module({
  imports: [SettingsModule],
  controllers: [BridgeController],
  providers: [StreamTokenClient],
  exports: [StreamTokenClient],
})
export class BridgeModule {}
