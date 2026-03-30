import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QualityProfile } from './entities/quality-profile.entity';
import { LanguageProfile } from './entities/language-profile.entity';
import { CustomFormat } from './entities/custom-format.entity';
import { ProfilesService } from './profiles.service';
import { ProfilesController } from './profiles.controller';
import { CustomFormatsService } from './custom-formats.service';
import { CustomFormatsController } from './custom-formats.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([QualityProfile, LanguageProfile, CustomFormat]),
    AuthModule,
  ],
  controllers: [ProfilesController, CustomFormatsController],
  providers: [ProfilesService, CustomFormatsService],
  exports: [ProfilesService, CustomFormatsService],
})
export class ProfilesModule implements OnModuleInit {
  constructor(private readonly profiles: ProfilesService) {}

  onModuleInit() {
    void this.profiles.ensureDefaultQualityProfiles();
  }
}
