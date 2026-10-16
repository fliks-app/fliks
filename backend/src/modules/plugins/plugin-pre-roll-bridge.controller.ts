import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsObject,
  IsOptional,
  Min,
  ValidateNested,
} from 'class-validator';
import type { PreRollItem } from '../../common/plugin-contract';
import { BridgeAuthGuard } from '../bridge/bridge-auth.guard';
import { PluginPreRollService } from './plugin-pre-roll.service';

class PrincipalDto {
  @IsInt()
  @Min(1)
  userId!: number;

  @IsOptional()
  kind?: string;
}

export class PreRollAskDto {
  @IsInt()
  mediaFileId!: number;

  @IsInt()
  mediaId!: number;

  @IsOptional()
  @IsInt()
  episodeId?: number | null;

  @IsObject()
  @ValidateNested()
  @Type(() => PrincipalDto)
  principal!: PrincipalDto;
}

/** fliks-server asks the plugin host for pre-roll candidates (server/docs/bridge.md); bridge-token auth only. */
@Controller('internal/plugins')
@UseGuards(BridgeAuthGuard)
export class PreRollBridgeController {
  constructor(private readonly preRoll: PluginPreRollService) {}

  @Post('pre-roll')
  @HttpCode(200)
  ask(@Body() dto: PreRollAskDto): Promise<PreRollItem[]> {
    return this.preRoll.ask({
      mediaFileId: dto.mediaFileId,
      mediaId: dto.mediaId,
      episodeId: dto.episodeId ?? undefined,
      principal: { kind: 'delegated', userId: dto.principal.userId },
    });
  }
}
