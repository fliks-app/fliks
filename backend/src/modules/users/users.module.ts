import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { MediaServer } from './entities/media-server.entity';
import { Role } from '../roles/entities/role.entity';
import { LibraryUserAccess } from '../libraries/entities/library-user-access.entity';
import { UsersService } from './users.service';
import { UsersStatsService } from './users-stats.service';
import { UsersController } from './users.controller';
import { AuthModule } from '../auth/auth.module';
import { PlaybackState } from '../streaming/entities/playback-state.entity';
import { FliksRequest } from '../requests/entities/request.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      MediaServer,
      Role,
      LibraryUserAccess,
      // Read-only repos for the stats endpoint — these tables are owned by
      // their own modules, we just consume them here for aggregation.
      PlaybackState,
      FliksRequest,
    ]),
    AuthModule,
  ],
  controllers: [UsersController],
  providers: [UsersService, UsersStatsService],
  exports: [TypeOrmModule, UsersService],
})
export class UsersModule {}
