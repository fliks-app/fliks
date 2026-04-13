import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CleanupProfile } from './entities/cleanup-profile.entity';
import { CleanupProfilesService } from './cleanup-profiles.service';
import { CleanupProfilesController } from './cleanup-profiles.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TypeOrmModule.forFeature([CleanupProfile]), AuthModule],
  controllers: [CleanupProfilesController],
  providers: [CleanupProfilesService],
  exports: [CleanupProfilesService, TypeOrmModule],
})
export class CleanupProfilesModule {}
