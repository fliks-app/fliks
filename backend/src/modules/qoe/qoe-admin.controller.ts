import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import type { QoeVerdict } from './core/types';
import { QoeService } from './qoe.service';

const VERDICTS = new Set(['ok', 'network', 'device', 'server', 'error', 'unknown']);

const days = (v?: string): number =>
  Math.min(Math.max(int(v) ?? 7, 1), 3650);

const int = (v?: string): number | undefined => {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) ? Math.trunc(n) : undefined;
};

@Controller('system/qoe')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class QoeAdminController {
  constructor(private readonly qoe: QoeService) {}

  @Get('sessions')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  sessions(
    @Query('days') daysRaw?: string,
    @Query('verdict') verdict?: string,
    @Query('userId') userId?: string,
    @Query('device') device?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.qoe.listSessions({
      days: days(daysRaw),
      verdict: verdict && VERDICTS.has(verdict) ? (verdict as QoeVerdict) : undefined,
      userId: int(userId),
      device: device || undefined,
      limit: int(limit),
      offset: int(offset),
    });
  }

  @Get('sessions/:id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async session(@Param('id') id: string) {
    const row = await this.qoe.getSession(id);
    if (!row) throw new NotFoundException('qoe_session_not_found');
    return row;
  }

  @Get('summary')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  summary(@Query('days') daysRaw?: string) {
    return this.qoe.summary(days(daysRaw));
  }
}
