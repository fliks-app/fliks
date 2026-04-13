import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { MediaServer } from './entities/media-server.entity';
import { Role } from '../roles/entities/role.entity';
import { LibraryUserAccess } from '../libraries/entities/library-user-access.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, MediaServer, Role, LibraryUserAccess]),
    AuthModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [TypeOrmModule, UsersService],
})
export class UsersModule {}
