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
import { SubtitleProviderService } from './subtitle-provider.service';
import { CreateSubtitleProviderDto } from './dto/create-subtitle-provider.dto';
import { UpdateSubtitleProviderDto } from './dto/update-subtitle-provider.dto';
import { TestSubtitleProviderDto } from './dto/test-subtitle-provider.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { SubtitleProvider } from './entities/subtitle-provider.entity';
import { SubtitleProviderStat } from './entities/subtitle-provider-stat.entity';

@Controller('subtitles/providers')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class SubtitlesController {
  constructor(
    private readonly providerService: SubtitleProviderService,
    @InjectRepository(SubtitleProviderStat)
    private readonly statRepo: Repository<SubtitleProviderStat>,
  ) {}

  @Post('test-connection')
  @CheckPolicies((ability) => ability.can(Action.Read, SubtitleProvider))
  testConnection(@Body() dto: TestSubtitleProviderDto) {
    return this.providerService.testConnection(dto.type, dto.settings ?? {});
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Create, SubtitleProvider))
  create(@Body() dto: CreateSubtitleProviderDto) {
    return this.providerService.create(dto);
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, SubtitleProvider))
  findAll() {
    return this.providerService.findAll();
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, SubtitleProvider))
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.providerService.findOne(id);
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Update, SubtitleProvider))
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSubtitleProviderDto,
  ) {
    return this.providerService.update(id, dto);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Delete, SubtitleProvider))
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.providerService.remove(id);
  }

  @Post(':id/test')
  @CheckPolicies((ability) => ability.can(Action.Read, SubtitleProvider))
  testProvider(@Param('id', ParseIntPipe) id: number) {
    return this.providerService.testProvider(id);
  }

  @Get(':id/stats')
  @CheckPolicies((ability) => ability.can(Action.Read, SubtitleProvider))
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
      .where('s.providerId = :id', { id })
      .andWhere('s.queryDate >= :since', { since })
      .groupBy('DATE(s.queryDate)')
      .orderBy('date', 'DESC')
      .getRawMany();

    return rows;
  }
}
