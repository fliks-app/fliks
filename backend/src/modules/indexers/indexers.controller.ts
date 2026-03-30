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
import { IndexersService } from './indexers.service';
import { CreateIndexerDto } from './dto/create-indexer.dto';
import { UpdateIndexerDto } from './dto/update-indexer.dto';
import { TestIndexerConnectionDto } from './dto/test-indexer-connection.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { Indexer } from './entities/indexer.entity';

@Controller('indexers')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class IndexersController {
  constructor(private readonly indexersService: IndexersService) {}

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

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, Indexer))
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.indexersService.findOne(id);
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
}
