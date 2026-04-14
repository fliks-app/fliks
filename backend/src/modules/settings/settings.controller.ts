import {
  Controller,
  Get,
  Put,
  Body,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { IsString, IsOptional, IsObject } from 'class-validator';
import { SettingsService } from './settings.service';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';

class SetSettingDto {
  @IsString()
  @IsOptional()
  value: string | null;
}

class SetBulkDto {
  @IsObject()
  data: Record<string, string | null>;
}

@Controller('settings')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class SettingsController {
  constructor(private readonly service: SettingsService) {}

  /** Get all settings (admin reads; values may contain API keys — admin only) */
  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  getAll() {
    return this.service.getAll();
  }

  /** Return the client's IP as seen by the server. */
  @Get('my-ip')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  getMyIp(@Req() req: Request) {
    const raw = req.ip ?? '';
    const ipv4 = raw.replace(/^::ffff:/, '');
    return { ip: ipv4, ipv6: raw !== ipv4 ? raw : undefined };
  }

  @Get(':key')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  getOne(@Param('key') key: string) {
    return this.service.get(key).then((value) => ({ key, value }));
  }

  @Put(':key')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  setOne(@Param('key') key: string, @Body() dto: SetSettingDto) {
    return this.service.set(key, dto.value ?? null);
  }

  /** Upsert multiple settings in one call */
  @Put()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  setBulk(@Body() dto: SetBulkDto) {
    return this.service.setBulk(dto.data).then(() => ({ ok: true }));
  }
}
