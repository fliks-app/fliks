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
import { SubtitleProviderService } from './subtitle-provider.service';
import { CreateSubtitleProviderDto } from './dto/create-subtitle-provider.dto';
import { UpdateSubtitleProviderDto } from './dto/update-subtitle-provider.dto';
import { TestSubtitleProviderDto } from './dto/test-subtitle-provider.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { SubtitleProvider } from './entities/subtitle-provider.entity';

@Controller('subtitles/providers')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class SubtitlesController {
  constructor(private readonly providerService: SubtitleProviderService) {}

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
}
