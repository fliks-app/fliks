import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QualityProfile } from './entities/quality-profile.entity';
import { QualityDefinition } from './entities/quality-definition.entity';
import { LanguageProfile } from './entities/language-profile.entity';
import { CustomFormat } from './entities/custom-format.entity';
import { ProfilesService } from './profiles.service';
import { ProfilesController } from './profiles.controller';
import { QualityDefinitionsService } from './quality-definitions.service';
import { QualityDefinitionsController } from './quality-definitions.controller';
import { CustomFormatsService } from './custom-formats.service';
import { CustomFormatsController } from './custom-formats.controller';
import { DelayProfile } from './entities/delay-profile.entity';
import { DelayProfilesController } from './delay-profiles.controller';
import { Tag } from '../tags/entities/tag.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([QualityProfile, QualityDefinition, LanguageProfile, CustomFormat, DelayProfile, Tag]),
    AuthModule,
  ],
  controllers: [ProfilesController, CustomFormatsController, DelayProfilesController, QualityDefinitionsController],
  providers: [ProfilesService, QualityDefinitionsService, CustomFormatsService],
  exports: [ProfilesService, QualityDefinitionsService, CustomFormatsService],
})
export class ProfilesModule implements OnModuleInit {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly qualityDefs: QualityDefinitionsService,
  ) {}

  onModuleInit() {
    void this.profiles.ensureDefaultQualityProfiles();
    void this.qualityDefs.ensureDefaults();
  }
}
