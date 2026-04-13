import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Library } from './entities/library.entity';
import { LibraryUserAccess } from './entities/library-user-access.entity';
import { RootFolder } from '../root-folders/entities/root-folder.entity';
import { Media } from '../media/entities/media.entity';
import { User } from '../users/entities/user.entity';
import { Role } from '../roles/entities/role.entity';
import { LibrariesService } from './libraries.service';
import { LibrariesController } from './libraries.controller';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Library,
      LibraryUserAccess,
      RootFolder,
      Media,
      User,
      Role,
    ]),
    forwardRef(() => AuthModule),
    SettingsModule,
  ],
  controllers: [LibrariesController],
  providers: [LibrariesService],
  exports: [LibrariesService, TypeOrmModule],
})
export class LibrariesModule {}
