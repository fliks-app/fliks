import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { BlocklistService } from './blocklist.service';
import { CreateBlocklistEntryDto } from './dto/create-blocklist-entry.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';

@Controller('blocklist')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class BlocklistController {
  constructor(private readonly service: BlocklistService) {}

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  create(@Body() dto: CreateBlocklistEntryDto) {
    return this.service.create(dto);
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.findAll(page ? Number(page) : 1, limit ? Number(limit) : 25);
  }

  @Delete('all')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  clear() {
    return this.service.clear();
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
