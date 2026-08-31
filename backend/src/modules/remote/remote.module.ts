import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { AuthModule } from '../auth/auth.module';
import { StreamingModule } from '../streaming/streaming.module';
import { RemoteController } from './remote.controller';
import { RemoteService } from './remote.service';
import { RemoteGrantService } from './remote-grant.service';
import { RemoteControlGrant } from './entities/remote-control-grant.entity';

// A dedicated module rather than folding into SchedulerModule: this feature
// needs the User and grant repos SchedulerModule doesn't carry.
@Module({
  imports: [
    TypeOrmModule.forFeature([User, RemoteControlGrant]),
    AuthModule,
    StreamingModule,
  ],
  controllers: [RemoteController],
  providers: [RemoteService, RemoteGrantService],
})
export class RemoteModule {}
