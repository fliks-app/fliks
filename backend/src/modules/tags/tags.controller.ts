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
import { TagsService } from './tags.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { Tag } from './entities/tag.entity';

@Controller('tags')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Create, Tag))
  create(@Body() dto: CreateTagDto) {
    return this.tagsService.create(dto);
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, Tag))
  findAll() {
    return this.tagsService.findAll();
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, Tag))
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.tagsService.findOne(id);
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Update, Tag))
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateTagDto) {
    return this.tagsService.update(id, dto);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Delete, Tag))
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.tagsService.remove(id);
  }
}
