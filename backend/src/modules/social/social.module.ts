import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserFollow } from './entities/user-follow.entity';
import { User } from '../users/entities/user.entity';
import { SocialService } from './social.service';
import { SocialController } from './social.controller';
import { PlaylistsModule } from '../playlists/playlists.module';
import { StreamingModule } from '../streaming/streaming.module';
import { LibrariesModule } from '../libraries/libraries.module';
import { EventsModule } from '../scheduler/events.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserFollow, User]),
    PlaylistsModule,
    StreamingModule,
    LibrariesModule,
    EventsModule,
    AuthModule,
  ],
  controllers: [SocialController],
  providers: [SocialService],
})
export class SocialModule {}
