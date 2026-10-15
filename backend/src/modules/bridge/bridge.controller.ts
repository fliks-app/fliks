import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { EngineService } from '../engine/engine.service';
import {
  ENGINE_TOKEN_KEY,
  ENGINE_URL_KEY,
} from '../engine/engine-remote-config';
import { BridgeAuthGuard } from './bridge-auth.guard';
import { SettingsChangedDto } from './bridge.dto';

/** Rust to Nest strangler endpoints (server/docs/bridge.md); outside the `api` prefix, bridge-token auth only. */
@Controller('internal/bridge')
@UseGuards(BridgeAuthGuard)
export class BridgeController {
  constructor(
    private readonly settings: SettingsService,
    private readonly engine: EngineService,
  ) {}

  @Post('settings-changed')
  @HttpCode(204)
  async settingsChanged(@Body() dto: SettingsChangedDto): Promise<void> {
    for (const key of dto.keys) this.settings.notifyChange(key, dto.origin);
    if (dto.keys.some((k) => k === ENGINE_URL_KEY || k === ENGINE_TOKEN_KEY)) {
      await this.engine.reconfigure();
    }
  }
}
