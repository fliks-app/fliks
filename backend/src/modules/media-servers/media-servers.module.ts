import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaServer } from '../users/entities/media-server.entity';
import { MediaServersService } from './media-servers.service';
import { MediaServersController } from './media-servers.controller';
import { EmbyProvider } from './providers/emby.provider';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TypeOrmModule.forFeature([MediaServer]), AuthModule],
  controllers: [MediaServersController],
  providers: [MediaServersService, EmbyProvider],
  exports: [MediaServersService],
})
export class MediaServersModule {}
