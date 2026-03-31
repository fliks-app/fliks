import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RemotePathMapping } from './entities/remote-path-mapping.entity';
import { CreateRemotePathMappingDto } from './dto/create-remote-path-mapping.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';

@Controller('settings/remote-path-mappings')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class RemotePathMappingsController {
  constructor(
    @InjectRepository(RemotePathMapping)
    private readonly repo: Repository<RemotePathMapping>,
  ) {}

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  create(@Body() dto: CreateRemotePathMappingDto) {
    return this.repo.save(this.repo.create(dto));
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  findAll() {
    return this.repo.find({ order: { id: 'ASC' } });
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.repo.delete(id);
    return { ok: true };
  }
}
