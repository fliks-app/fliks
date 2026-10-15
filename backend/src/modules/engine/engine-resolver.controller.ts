import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard } from '../bridge/bridge-auth.guard';
import {
  EngineResolverService,
  LiveResolveDto,
  type LiveResolveResult,
} from './engine-resolver.service';

/** Outside the `/api` prefix (see main.ts). fliks-server owns `/engine/resolve` for the engine; this
 *  is its `live` delegate on Nest's loopback port, bridge-token auth only (removed with live TV, S7). */
@Controller('engine')
@UseGuards(BridgeAuthGuard)
export class EngineResolverController {
  constructor(private readonly resolver: EngineResolverService) {}

  @Post('resolve')
  @HttpCode(200)
  resolve(@Body() dto: LiveResolveDto): Promise<LiveResolveResult> {
    return this.resolver.resolveLive(dto);
  }
}
