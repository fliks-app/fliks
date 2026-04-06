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
import { ProfilesService } from './profiles.service';
import { CreateQualityProfileDto } from './dto/create-quality-profile.dto';
import { CreateLanguageProfileDto } from './dto/create-language-profile.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { QualityProfile } from './entities/quality-profile.entity';
import { LanguageProfile } from './entities/language-profile.entity';
import { APP_LANGUAGES } from '../../common/constants/app-languages';

@Controller('profiles')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Post('quality')
  @CheckPolicies((ability) => ability.can(Action.Create, QualityProfile))
  createQuality(@Body() dto: CreateQualityProfileDto) {
    return this.profilesService.createQualityProfile(dto);
  }

  @Get('quality')
  @CheckPolicies((ability) => ability.can(Action.Read, QualityProfile))
  findAllQuality() {
    return this.profilesService.findAllQualityProfiles();
  }

  @Get('quality/:id')
  @CheckPolicies((ability) => ability.can(Action.Read, QualityProfile))
  findOneQuality(@Param('id', ParseIntPipe) id: number) {
    return this.profilesService.findOneQualityProfile(id);
  }

  @Put('quality/:id')
  @CheckPolicies((ability) => ability.can(Action.Update, QualityProfile))
  updateQuality(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateQualityProfileDto,
  ) {
    return this.profilesService.updateQualityProfile(id, dto);
  }

  @Delete('quality/:id')
  @CheckPolicies((ability) => ability.can(Action.Delete, QualityProfile))
  removeQuality(@Param('id', ParseIntPipe) id: number) {
    return this.profilesService.removeQualityProfile(id);
  }

  @Get('language-definitions')
  @CheckPolicies((ability) => ability.can(Action.Read, LanguageProfile))
  languageDefinitions() {
    return APP_LANGUAGES;
  }

  @Post('language')
  @CheckPolicies((ability) => ability.can(Action.Create, LanguageProfile))
  createLanguage(@Body() dto: CreateLanguageProfileDto) {
    return this.profilesService.createLanguageProfile(dto);
  }

  @Get('language')
  @CheckPolicies((ability) => ability.can(Action.Read, LanguageProfile))
  findAllLanguage() {
    return this.profilesService.findAllLanguageProfiles();
  }

  @Get('language/:id')
  @CheckPolicies((ability) => ability.can(Action.Read, LanguageProfile))
  findOneLanguage(@Param('id', ParseIntPipe) id: number) {
    return this.profilesService.findOneLanguageProfile(id);
  }

  @Put('language/:id')
  @CheckPolicies((ability) => ability.can(Action.Update, LanguageProfile))
  updateLanguage(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateLanguageProfileDto,
  ) {
    return this.profilesService.updateLanguageProfile(id, dto);
  }

  @Delete('language/:id')
  @CheckPolicies((ability) => ability.can(Action.Delete, LanguageProfile))
  removeLanguage(@Param('id', ParseIntPipe) id: number) {
    return this.profilesService.removeLanguageProfile(id);
  }
}
