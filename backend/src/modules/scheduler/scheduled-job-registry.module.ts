import { Module } from '@nestjs/common';
import { ScheduledJobRegistry } from './scheduled-job-registry.service';

/** Standalone so a detachable bundle can register into it without importing
 *  `FliksSchedulerModule` — the module that bundle wiring must stay outside of. */
@Module({
  providers: [ScheduledJobRegistry],
  exports: [ScheduledJobRegistry],
})
export class ScheduledJobRegistryModule {}
