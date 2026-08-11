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
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IndexersService } from './indexers.service';
import { CreateIndexerDto } from './dto/create-indexer.dto';
import { UpdateIndexerDto } from './dto/update-indexer.dto';
import { TestIndexerConnectionDto } from './dto/test-indexer-connection.dto';
import { JwtOrApiKeyGuard } from '../../../modules/auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../../../modules/auth/casl/policies.guard';
import { CheckPolicies } from '../../../modules/auth/casl/check-policies.decorator';
import { Action } from '../../../modules/auth/casl/actions.enum';
import { IndexerStat } from './entities/indexer-stat.entity';

@Controller('indexers')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class IndexersController {
  constructor(
    private readonly indexersService: IndexersService,
    @InjectRepository(IndexerStat)
    private readonly statRepo: Repository<IndexerStat>,
  ) {}

  @Post('test-connection')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  testConnection(@Body() dto: TestIndexerConnectionDto) {
    return this.indexersService.testConnection(dto);
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  create(@Body() dto: CreateIndexerDto) {
    return this.indexersService.create(dto);
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  findAll() {
    return this.indexersService.findAll();
  }

  /** Declared before `:id` routes — `cooldowns` would otherwise hit ParseIntPipe. */
  @Delete('cooldowns')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  clearAllCooldowns() {
    return this.indexersService.clearAllCooldowns();
  }

  @Delete(':id/cooldown')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  clearCooldown(@Param('id', ParseIntPipe) id: number) {
    return this.indexersService.clearCooldown(id);
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.indexersService.redact(await this.indexersService.findOne(id));
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateIndexerDto) {
    return this.indexersService.update(id, dto);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.indexersService.remove(id);
  }

  @Get(':id/stats')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async getStats(@Param('id', ParseIntPipe) id: number) {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const rows = await this.statRepo
      .createQueryBuilder('s')
      .select('DATE(s.queryDate)', 'date')
      .addSelect('COUNT(*)', 'queries')
      .addSelect('AVG(s.responseTimeMs)::int', 'avgResponseMs')
      .addSelect('SUM(s.resultCount)::int', 'totalResults')
      .addSelect(
        'SUM(CASE WHEN s.errorMessage IS NOT NULL THEN 1 ELSE 0 END)::int',
        'errors',
      )
      .where('s.indexerId = :id', { id })
      .andWhere('s.queryDate >= :since', { since })
      .groupBy('DATE(s.queryDate)')
      .orderBy('date', 'DESC')
      .getRawMany();

    return rows;
  }
}
