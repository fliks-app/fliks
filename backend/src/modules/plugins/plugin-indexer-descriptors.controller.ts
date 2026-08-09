import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { PluginRegistryService } from './plugin-registry.service';

/** Read-only catalog of indexer descriptors from registered plugins, for the "add indexer" admin UI. */
@Controller('plugins')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class PluginIndexerDescriptorsController {
  constructor(private readonly registry: PluginRegistryService) {}

  @Get('indexer-descriptors')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  list() {
    return this.registry.listIndexerDescriptors();
  }
}
