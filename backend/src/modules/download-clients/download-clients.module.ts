import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DownloadClient } from './entities/download-client.entity';
import { DownloadHistory } from '../media/entities/download-history.entity';
import { QbittorrentService } from './qbittorrent.service';
import { DownloadClientsService } from './download-clients.service';
import { DownloadClientsController } from './download-clients.controller';
import { AuthModule } from '../auth/auth.module';
import { TorrentHistoryMatcher } from '../media/torrent-history-matcher.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([DownloadClient, DownloadHistory]),
    AuthModule,
  ],
  controllers: [DownloadClientsController],
  providers: [QbittorrentService, DownloadClientsService, TorrentHistoryMatcher],
  exports: [TypeOrmModule, QbittorrentService, TorrentHistoryMatcher],
})
export class DownloadClientsModule {}
