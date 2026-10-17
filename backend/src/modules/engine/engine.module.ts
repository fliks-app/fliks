import { Global, Module } from '@nestjs/common';
import { EngineService } from './engine.service';
import { SettingsModule } from '../settings/settings.module';

@Global()
@Module({
  imports: [SettingsModule],
  providers: [EngineService],
  exports: [EngineService],
})
export class EngineModule {}
