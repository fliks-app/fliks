import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DownloadHistory } from '../../plugins/download/entities/download-history.entity';
import { FliksRequest } from '../requests/entities/request.entity';
import { CountsService } from './counts.service';
import { CountsController } from './counts.controller';
import { AuthModule } from '../auth/auth.module';
import { MediaModule } from '../media/media.module';
import { LibrariesModule } from '../libraries/libraries.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DownloadHistory, FliksRequest]),
    AuthModule,
    MediaModule,
    LibrariesModule,
  ],
  controllers: [CountsController],
  providers: [CountsService],
})
export class CountsModule {}
