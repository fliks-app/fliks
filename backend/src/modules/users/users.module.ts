import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { MediaServer } from './entities/media-server.entity';
import { Role } from '../roles/entities/role.entity';
import { LibraryUserAccess } from '../libraries/entities/library-user-access.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, MediaServer, Role, LibraryUserAccess]),
  ],
  exports: [TypeOrmModule],
})
export class UsersModule {}
