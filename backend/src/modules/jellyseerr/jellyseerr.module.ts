import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { Media } from '../media/entities/media.entity';
import { FliksRequest } from '../requests/entities/request.entity';
import { LibraryUserAccess } from '../libraries/entities/library-user-access.entity';
import { Role } from '../roles/entities/role.entity';
import { JellyseerrService } from './jellyseerr.service';
import { JellyseerrRequestImportService } from './jellyseerr-request-import.service';
import { JellyseerrController } from './jellyseerr.controller';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Media,
      FliksRequest,
      LibraryUserAccess,
      Role,
    ]),
    AuthModule,
    SettingsModule,
  ],
  controllers: [JellyseerrController],
  providers: [JellyseerrService, JellyseerrRequestImportService],
})
export class JellyseerrModule {}
