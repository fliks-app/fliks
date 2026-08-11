import { Module } from '@nestjs/common';
import { LogBufferService } from './log-buffer.service';

/** Split out of `FliksSchedulerModule` — that module reaches `PluginsModule` directly,
 *  so a plugin service importing it for this alone would cycle back on itself. */
@Module({
  providers: [LogBufferService],
  exports: [LogBufferService],
})
export class LogBufferModule {}
