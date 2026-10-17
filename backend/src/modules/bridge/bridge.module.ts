import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { BridgeController } from './bridge.controller';

@Module({
  imports: [SettingsModule],
  controllers: [BridgeController],
})
export class BridgeModule {}
