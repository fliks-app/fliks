import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { TranslationProviderService } from './translation-provider.service';
import { CreateTranslationProviderDto } from './dto/create-translation-provider.dto';
import { UpdateTranslationProviderDto } from './dto/update-translation-provider.dto';
import { TestTranslationProviderDto } from './dto/test-translation-provider.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { TranslationProvider } from './entities/translation-provider.entity';
import { SubtitleFile } from './entities/subtitle-file.entity';

@Controller('subtitles/translation-providers')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class TranslationProvidersController {
  constructor(private readonly service: TranslationProviderService) {}

  /** Enabled providers without secrets — the list a user picks from when
   *  triggering a translation. Guarded by the *translate* capability so a user
   *  who can list can also submit (no 403-after-pick). */
  @Get('available')
  @CheckPolicies((ability) => ability.can(Action.Create, SubtitleFile))
  listAvailable() {
    return this.service.listAvailable();
  }

  @Post('test-connection')
  @CheckPolicies((ability) => ability.can(Action.Read, TranslationProvider))
  testConnection(@Body() dto: TestTranslationProviderDto) {
    return this.service.testConnection(dto.engine, dto.settings ?? {});
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Create, TranslationProvider))
  create(@Body() dto: CreateTranslationProviderDto) {
    return this.service.create(dto);
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, TranslationProvider))
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, TranslationProvider))
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Update, TranslationProvider))
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTranslationProviderDto,
  ) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Delete, TranslationProvider))
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }

  @Post(':id/test')
  @CheckPolicies((ability) => ability.can(Action.Read, TranslationProvider))
  testProvider(@Param('id', ParseIntPipe) id: number) {
    return this.service.testProvider(id);
  }
}
