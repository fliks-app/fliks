import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FliksRequest } from '../requests/entities/request.entity';
import { CountsService } from './counts.service';
import { CountsController } from './counts.controller';
import { AuthModule } from '../auth/auth.module';
import { MediaModule } from '../media/media.module';
import { LibrariesModule } from '../libraries/libraries.module';
import { PluginCountsCacheModule } from '../plugins/host/plugin-counts-cache.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([FliksRequest]),
    AuthModule,
    MediaModule,
    LibrariesModule,
    PluginCountsCacheModule,
  ],
  controllers: [CountsController],
  providers: [CountsService],
})
export class CountsModule {}
