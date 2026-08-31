import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { UserFollow } from '../social/entities/user-follow.entity';
import { AuthModule } from '../auth/auth.module';
import { SocialModule } from '../social/social.module';
import { StreamingModule } from '../streaming/streaming.module';
import { RemoteController } from './remote.controller';
import { RemoteService } from './remote.service';

// A dedicated module rather than folding into SchedulerModule: this feature
// needs the User/UserFollow repos SchedulerModule doesn't carry.
@Module({
  imports: [
    TypeOrmModule.forFeature([User, UserFollow]),
    AuthModule,
    SocialModule,
    StreamingModule,
  ],
  controllers: [RemoteController],
  providers: [RemoteService],
})
export class RemoteModule {}
