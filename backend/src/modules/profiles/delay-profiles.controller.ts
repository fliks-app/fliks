import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  ParseIntPipe,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DelayProfile } from './entities/delay-profile.entity';
import { CreateDelayProfileDto } from './dto/create-delay-profile.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';

@Controller('profiles/delay')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class DelayProfilesController {
  constructor(
    @InjectRepository(DelayProfile)
    private readonly repo: Repository<DelayProfile>,
  ) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  findAll() {
    return this.repo.find({ order: { order: 'ASC', id: 'ASC' } });
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Create, 'Settings'))
  async create(@Body() dto: CreateDelayProfileDto) {
    const row = this.repo.create({
      torrentDelay: dto.torrentDelay,
      order: dto.order ?? 1,
    });
    return this.repo.save(row);
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Update, 'Settings'))
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateDelayProfileDto,
  ) {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`DelayProfile #${id} not found`);
    row.torrentDelay = dto.torrentDelay;
    row.order = dto.order ?? row.order;
    return this.repo.save(row);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Delete, 'Settings'))
  async remove(@Param('id', ParseIntPipe) id: number) {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`DelayProfile #${id} not found`);
    await this.repo.remove(row);
  }
}
