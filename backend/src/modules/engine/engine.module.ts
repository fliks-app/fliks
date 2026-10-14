import { Global, Module } from '@nestjs/common';
import { EngineService } from './engine.service';

@Global()
@Module({
  providers: [EngineService],
  exports: [EngineService],
})
export class EngineModule {}
