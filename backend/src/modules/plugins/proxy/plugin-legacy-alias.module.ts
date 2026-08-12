import { Module } from '@nestjs/common';
import { PluginsModule } from '../plugins.module';
import { AuthModule } from '../../auth/auth.module';
import { LibrariesModule } from '../../libraries/libraries.module';
import { PluginObjectGuardsService } from './plugin-object-guards.service';
import { PluginLegacyAliasMatchGuard, PluginLegacyAliasPolicyGuard } from './plugin-legacy-alias.guard';
import { PluginLegacyAliasController } from './plugin-legacy-alias.controller';

/**
 * Holds the app-wide `*splat` catch-all on its own, so that it can be the very last
 * module `AppModule` imports and its route the very last one Express registers.
 *
 * It cannot live in `PluginsModule`: `FliksSchedulerModule` imports that module for the
 * merged job listing, which inserts it early in the scan and would register the catch-all
 * ahead of every controller scanned later — silently 404ing real core routes.
 * Nothing else may import this module. `plugin-legacy-alias-registration-order.spec.ts`
 * fails if anything does.
 */
@Module({
  imports: [PluginsModule, AuthModule, LibrariesModule],
  controllers: [PluginLegacyAliasController],
  providers: [PluginObjectGuardsService, PluginLegacyAliasMatchGuard, PluginLegacyAliasPolicyGuard],
})
export class PluginLegacyAliasModule {}
