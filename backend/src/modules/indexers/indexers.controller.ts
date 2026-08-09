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
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { Indexer } from './entities/indexer.entity';
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
  @CheckPolicies((ability) => ability.can(Action.Read, Indexer))
  testConnection(@Body() dto: TestIndexerConnectionDto) {
    return this.indexersService.testConnection(dto);
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Create, Indexer))
  create(@Body() dto: CreateIndexerDto) {
    return this.indexersService.create(dto);
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, Indexer))
  findAll() {
    return this.indexersService.findAll();
  }

  /** Declared before `:id` routes — `cooldowns` would otherwise hit ParseIntPipe. */
  @Delete('cooldowns')
  @CheckPolicies((ability) => ability.can(Action.Update, Indexer))
  clearAllCooldowns() {
    return this.indexersService.clearAllCooldowns();
  }

  @Delete(':id/cooldown')
  @CheckPolicies((ability) => ability.can(Action.Update, Indexer))
  clearCooldown(@Param('id', ParseIntPipe) id: number) {
    return this.indexersService.clearCooldown(id);
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, Indexer))
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.indexersService.redact(await this.indexersService.findOne(id));
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Update, Indexer))
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateIndexerDto) {
    return this.indexersService.update(id, dto);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Delete, Indexer))
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.indexersService.remove(id);
  }

  @Get(':id/stats')
  @CheckPolicies((ability) => ability.can(Action.Read, Indexer))
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
