import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Library } from './entities/library.entity';
import { LibraryUserAccess } from './entities/library-user-access.entity';
import { Media } from '../media/entities/media.entity';
import { LibrariesService } from './libraries.service';
import { LibrariesController } from './libraries.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Library, LibraryUserAccess, Media]),
    forwardRef(() => AuthModule),
  ],
  controllers: [LibrariesController],
  providers: [LibrariesService],
  exports: [LibrariesService, TypeOrmModule],
})
export class LibrariesModule {}
