import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { PlaybackQoeEvent } from './entities/playback-qoe-event.entity';
import { PlaybackQoeSession } from './entities/playback-qoe-session.entity';
import { QoeAdminController } from './qoe-admin.controller';
import { QoeService } from './qoe.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([PlaybackQoeSession, PlaybackQoeEvent]),
    forwardRef(() => AuthModule),
    SettingsModule,
  ],
  controllers: [QoeAdminController],
  providers: [QoeService],
  exports: [QoeService],
})
export class QoeModule {}
