import { Module } from '@nestjs/common';
import { PluginCountsCacheService } from './plugin-counts-cache.service';

/** Split out of `PluginHostModule` so a lean consumer (e.g. `CountsModule`) can
 *  reach the cache without importing that module's `MediaModule`-sized graph. */
@Module({
  providers: [PluginCountsCacheService],
  exports: [PluginCountsCacheService],
})
export class PluginCountsCacheModule {}
